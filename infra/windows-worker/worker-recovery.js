/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const {
  getStatusPaths,
  getTrackedStatusPaths,
  getUntrackedStatusPaths,
  parseGitStatusPorcelain,
} = require("./git-safety");

const NEXT_ENV_CONTENT = [
  '/// <reference types="next" />',
  '/// <reference types="next/image-types/global" />',
  'import "./.next/types/routes.d.ts";',
  "",
  "// NOTE: This file should not be edited",
  "// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.",
  "",
].join("\r\n");

const EXT_ENV_CONTENT = [
  '/// <reference types="next" />',
  "",
  "// NOTE: This file is managed by the Windows Worker preflight.",
  "",
].join("\r\n");

const GENERATED_FILE_PATHS = new Set([
  "next-env.d.ts",
  "ext-env.d.ts",
  "tsconfig.tsbuildinfo",
]);

const STATIC_PREVIEW_ROUTE_FILES = [
  "src/app/page.tsx",
  "src/app/post/page.tsx",
  "src/app/partners/page.tsx",
];

function sanitizeWindowsEnv(env = process.env) {
  const sanitized = {};
  let pathValue = null;
  let fallbackPathValue = null;

  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "path") {
      if (key === "Path" && value) {
        pathValue = value;
      }

      if (fallbackPathValue === null && value) {
        fallbackPathValue = value;
      }
      continue;
    }

    sanitized[key] = value;
  }

  const resolvedPathValue = pathValue || fallbackPathValue;

  if (resolvedPathValue !== null) {
    sanitized.Path = resolvedPathValue;
  }

  return sanitized;
}

function writeJsonReportSafe(filePath, payload) {
  try {
    fs.mkdirSync(path.dirname(filePath), {
      recursive: true,
    });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function resolveProjectDir(projectDir) {
  const resolved = path.resolve(projectDir || process.env.PROJECT_DIR || process.cwd());

  if (!fs.existsSync(resolved)) {
    throw new Error(`项目目录不存在：${resolved}`);
  }

  return resolved;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd || process.cwd(),
        windowsHide: true,
        maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
        env: sanitizeWindowsEnv(options.env || process.env),
      },
      (error, stdout, stderr) => {
        const result = {
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        };

        if (error && !options.allowFailure) {
          reject(
            new Error(
              [
                `命令执行失败：${command} ${args.join(" ")}`,
                result.stderr,
                result.stdout,
                error.message,
              ]
                .filter(Boolean)
                .join("\n")
            )
          );
          return;
        }

        resolve(result);
      }
    );
  });
}

async function runGit(projectDir, args, options = {}) {
  return runCommand("git", args, {
    cwd: projectDir,
    allowFailure: options.allowFailure,
  });
}

function isGeneratedPath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
  const lower = normalized.toLowerCase();

  if (GENERATED_FILE_PATHS.has(normalized)) {
    return true;
  }

  return (
    lower.startsWith(".next/") ||
    lower.startsWith(".turbo/") ||
    lower.startsWith("node_modules/.cache/") ||
    lower.startsWith(".codex-build-check/")
  );
}

async function getGitStatusEntries(projectDir) {
  const status = await runGit(projectDir, ["status", "--porcelain=v1", "-z"]);
  return parseGitStatusPorcelain(status.stdout);
}

async function restoreGeneratedEnvFiles(projectDir, options = {}) {
  const restored = [];
  const nextEnvPath = path.join(projectDir, "next-env.d.ts");
  const extEnvPath = path.join(projectDir, "ext-env.d.ts");

  if (options.restoreNextEnv !== false) {
    fs.writeFileSync(nextEnvPath, NEXT_ENV_CONTENT, "utf8");
    restored.push("next-env.d.ts");
  }

  if (fs.existsSync(extEnvPath) || options.createExtEnv === true) {
    fs.writeFileSync(extEnvPath, EXT_ENV_CONTENT, "utf8");
    restored.push("ext-env.d.ts");
  }

  return restored;
}

async function removePathSafe(projectDir, relativePath) {
  const target = path.resolve(projectDir, relativePath);
  const root = path.resolve(projectDir);

  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`拒绝清理项目目录外路径：${relativePath}`);
  }

  if (!fs.existsSync(target)) {
    return false;
  }

  fs.rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 500,
  });

  return true;
}

async function cleanBuildCaches(projectDir) {
  const removed = [];

  for (const relativePath of [".next", ".turbo", "node_modules/.cache"]) {
    if (await removePathSafe(projectDir, relativePath)) {
      removed.push(relativePath);
    }
  }

  return removed;
}

async function cleanGitStatusPaths(projectDir, entries, options = {}) {
  const paths = getStatusPaths(entries);
  const trackedPaths = getTrackedStatusPaths(entries);
  const untrackedPaths = getUntrackedStatusPaths(entries);

  if (trackedPaths.length > 0) {
    await runGit(projectDir, ["restore", "--staged", "--worktree", "--", ...trackedPaths]);
  }

  for (const filePath of untrackedPaths) {
    if (options.useGitClean === true) {
      await runGit(projectDir, ["clean", "-f", "--", filePath], {
        allowFailure: true,
      });
    } else {
      await removePathSafe(projectDir, filePath);
    }
  }

  return {
    paths,
    trackedPaths,
    untrackedPaths,
  };
}

async function cleanKnownGeneratedGitChanges(projectDir, entries) {
  const generatedEntries = entries.filter((entry) => isGeneratedPath(entry.path));
  const result = await cleanGitStatusPaths(projectDir, generatedEntries);
  return result.paths;
}

function sanitizeProcessList(processes) {
  return processes.map((processInfo) => ({
    processId: processInfo.ProcessId,
    name: processInfo.Name,
    commandLine: String(processInfo.CommandLine || "")
      .replace(/https:\/\/[^@\s]+@/gi, "https://<redacted>@")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted>")
      .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "<redacted>"),
  }));
}

async function listWindowsProcesses() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Get-CimInstance Win32_Process |",
    "  Select-Object ProcessId,Name,CommandLine |",
    "  ConvertTo-Json -Depth 3 -Compress",
  ].join("\n");
  const result = await runCommand("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);

  if (!result.stdout) {
    return [];
  }

  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function isResidualDevProcess(processInfo, options = {}) {
  const commandLine = String(processInfo.CommandLine || "").toLowerCase();
  const name = String(processInfo.Name || "").toLowerCase();
  const currentPid = process.pid;

  if (Number(processInfo.ProcessId) === currentPid) {
    return false;
  }

  if (options.includeWorker && commandLine.includes("local_worker.js")) {
    return true;
  }

  if (commandLine.includes("next dev") || commandLine.includes("next-server")) {
    return true;
  }

  if (commandLine.includes("turbopack") || commandLine.includes("npm run dev")) {
    return true;
  }

  if (commandLine.includes("codex.exe") || name === "codex.exe") {
    return true;
  }

  return false;
}

async function killProcessTree(pid) {
  await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], {
    allowFailure: true,
  });
}

async function stopResidualProcesses(options = {}) {
  const processes = await listWindowsProcesses();
  const targets = processes.filter((processInfo) =>
    isResidualDevProcess(processInfo, options)
  );

  for (const target of targets) {
    await killProcessTree(target.ProcessId);
  }

  return sanitizeProcessList(targets);
}

async function runPreflight(projectDir, options = {}) {
  const root = resolveProjectDir(projectDir);
  const stoppedProcesses = await stopResidualProcesses({
    includeWorker: options.includeWorker === true,
  });
  const removedCaches = await cleanBuildCaches(root);
  const restoredEnvFiles = await restoreGeneratedEnvFiles(root, {
    createExtEnv: options.createExtEnv === true,
  });

  const beforeGeneratedClean = await getGitStatusEntries(root);
  const cleanedGeneratedPaths = await cleanKnownGeneratedGitChanges(root, beforeGeneratedClean);
  const finalEntries = await getGitStatusEntries(root);
  const unknownEntries = finalEntries.filter((entry) => !isGeneratedPath(entry.path));

  if (unknownEntries.length > 0) {
    const error = new Error(
      [
        "发现未确认业务修改，项目总管已停止执行。",
        "请选择：A. 保留这些修改并重新派单；B. 先由 Worker 自动备份后再执行。",
        "文件清单：",
        ...unknownEntries.map((entry) => `- ${entry.line}`),
      ].join("\n")
    );
    error.code = "UNKNOWN_BUSINESS_CHANGES";
    error.entries = unknownEntries;
    throw error;
  }

  return {
    stoppedProcesses,
    removedCaches,
    restoredEnvFiles,
    cleanedGeneratedPaths,
    gitStatusShort: finalEntries.map((entry) => entry.line),
  };
}

async function checkRouteFiles(projectDir, routes = STATIC_PREVIEW_ROUTE_FILES) {
  return routes.map((routePath) => ({
    path: String(routePath || "").replace(/\\/g, "/").replace(/^\.\/+/, "").trim(),
    ok: fs.existsSync(path.join(projectDir, routePath)),
  }));
}

async function runStaticCheck(projectDir, label, command, args) {
  const result = await runCommand(command, args, {
    cwd: projectDir,
    allowFailure: true,
    maxBuffer: 30 * 1024 * 1024,
  });

  return {
    label,
    command: [command, ...args].join(" "),
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout.slice(-4000),
    stderr: result.stderr.slice(-4000),
  };
}

async function recoverLocalPreview(projectDir, options = {}) {
  const root = resolveProjectDir(projectDir);
  await stopResidualProcesses();
  const removedCaches = await cleanBuildCaches(root);
  await restoreGeneratedEnvFiles(root);

  const logDir = path.join(__dirname, "logs");
  const routeFiles = await checkRouteFiles(root, options.routeFiles);
  const staticChecks = [
    await runStaticCheck(root, "eslint", "npm.cmd", ["run", "lint"]),
    await runStaticCheck(root, "typecheck", "npx.cmd", ["tsc", "--noEmit"]),
  ];

  const report = {
    mode: "static-only",
    baseUrl: null,
    port: null,
    removedCaches,
    routeFiles,
    staticChecks,
    skippedDevServer: true,
    skippedBrowser: true,
    ok: routeFiles.every((item) => item.ok) && staticChecks.every((item) => item.ok),
  };
  report.warning = !report.ok;

  const reportWriteError = writeJsonReportSafe(
    path.join(logDir, "local-preview-recovery-report.json"),
    report
  );

  if (reportWriteError) {
    report.ok = false;
    report.warning = true;
    report.reportWriteError = reportWriteError;
  }

  return report;
}

function classifyLocalError(errorText) {
  const text = String(errorText || "").toLowerCase();

  if (text.includes("[turbopack]_runtime") || text.includes("cannot find module './chunks/ssr")) {
    return "turbopack-cache";
  }

  if (text.includes("eaddrinuse") || (text.includes("port") && text.includes("3000"))) {
    return "port-conflict";
  }

  if (text.includes("internal server error") || text.includes("http 500")) {
    return "runtime-500";
  }

  if (text.includes("http 404") || text.includes("not found")) {
    return "route-404";
  }

  if (text.includes("syntaxerror") || text.includes("typescript") || text.includes("eslint")) {
    return "code-syntax";
  }

  if (text.includes("module not found") || text.includes("cannot find module")) {
    return "dependency-or-import";
  }

  if (text.includes("spawn einval") || text.includes("key in dictionary")) {
    return "windows-env-path-conflict";
  }

  return "unknown";
}

async function runCli() {
  const command = process.argv[2];
  const projectDir = resolveProjectDir(process.argv[3] || process.env.PROJECT_DIR);

  if (command === "preflight") {
    const result = await runPreflight(projectDir, {
      includeWorker: process.argv.includes("--include-worker"),
      createExtEnv: process.argv.includes("--create-ext-env"),
    });
    process.stdout.write(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "recover-preview") {
    const result = await recoverLocalPreview(projectDir);
    process.stdout.write(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.warn("\n[worker] local preview static diagnostics produced warnings; continuing");
    }
    process.exitCode = 0;
    return;
  }

  throw new Error(`未知 worker-recovery 命令：${command || "(empty)"}`);
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  classifyLocalError,
  cleanBuildCaches,
  cleanGitStatusPaths,
  recoverLocalPreview,
  restoreGeneratedEnvFiles,
  runPreflight,
  sanitizeWindowsEnv,
  stopResidualProcesses,
};
