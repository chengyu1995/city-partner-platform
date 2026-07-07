/* eslint-disable @typescript-eslint/no-require-imports */
require("dotenv").config();

const { spawn, execFile } = require("child_process");
const os = require("os");
const {
  assertCleanStatusEntries,
  getStatusPaths,
  getTrackedStatusPaths,
  getUntrackedStatusPaths,
  parseGitStatusPorcelain,
  uniqueSortedPaths,
  validateCommittablePaths,
  validateGitAddPathsExist,
  validateStagedPaths,
} = require("./git-safety");
const {
  classifyLocalError,
  recoverLocalPreview,
  runPreflight,
  sanitizeWindowsEnv,
} = require("./worker-recovery");

const WORKER_API_URL = String(process.env.WORKER_API_URL || "").replace(/\/+$/, "");
const WORKER_AUTH_ENV_KEY = "WORKER_" + "TOKEN";
const WORKER_AUTH = process.env[WORKER_AUTH_ENV_KEY];
const WORKER_NAME = process.env.WORKER_NAME || os.hostname();
const PROJECT_DIR = process.env.PROJECT_DIR;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 900000);
const CODEX_IDLE_TIMEOUT_MS = Number(process.env.CODEX_IDLE_TIMEOUT_MS || 60000);
const CODEX_PROGRESS_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const CODEX_EXE = process.env.CODEX_EXE || "C:/Users/admin/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe";
const WORKER_PREVIEW_SMOKE =
  String(process.env.WORKER_PREVIEW_SMOKE || "false").toLowerCase() === "true";

const required = {
  WORKER_API_URL,
  [WORKER_AUTH_ENV_KEY]: WORKER_AUTH,
  PROJECT_DIR,
};

const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([key]) => key);

function assertRequiredEnv() {
  if (missing.length > 0) {
    console.error(`缺少环境变量: ${missing.join(", ")}`);
    process.exit(1);
  }
}

let stopping = false;
let working = false;
let currentAttemptId = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`${WORKER_API_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${WORKER_AUTH}`,
      "Content-Type": "application/json",
      "X-Worker-Id": WORKER_NAME,
      "X-Worker-Name": WORKER_NAME,
      ...(options.headers || {}),
    },
  });

  return response;
}

async function sendHeartbeat(jobId, attemptId = null) {
  const response = await request("/api/worker/heartbeat", {
    method: "POST",
    body: JSON.stringify({
      job_id: jobId,
      attempt_id: attemptId,
      worker_id: WORKER_NAME,
      worker_name: WORKER_NAME,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `心跳上报失败 HTTP ${response.status}: ${text}`
    );
  }
}

function startHeartbeat(jobId, attemptId = null) {
  let stopped = false;

  const send = async () => {
    if (stopped) {
      return;
    }

    try {
      await sendHeartbeat(jobId, attemptId);
    } catch (error) {
      console.error(
        `任务 ${jobId} 心跳失败：`,
        error instanceof Error ? error.message : error
      );
    }
  };

  send();

  const timer = setInterval(send, 60 * 1000);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
const GIT_AUTO_COMMIT =
  String(process.env.GIT_AUTO_COMMIT || "true").toLowerCase() === "true";

const GIT_ROLLBACK_ON_FAILURE =
  String(process.env.GIT_ROLLBACK_ON_FAILURE || "true").toLowerCase() === "true";

const GIT_AUTO_PUSH =
  String(process.env.GIT_AUTO_PUSH || "false").toLowerCase() === "true";

const GIT_REMOTE_NAME =
  String(process.env.GIT_REMOTE_NAME || "origin").trim();

const GIT_PUSH_BRANCH =
  String(process.env.GIT_PUSH_BRANCH || "master").trim();

const REQUIRED_GIT_PUSH_REMOTE = "origin";
const REQUIRED_GIT_PUSH_BRANCH = "master";

function runCommand(command, args, cwd = PROJECT_DIR) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
        env: sanitizeWindowsEnv(process.env),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              [
                `命令执行失败：${command} ${args.join(" ")}`,
                String(stderr || "").trim(),
                String(stdout || "").trim(),
                error.message,
              ]
                .filter(Boolean)
                .join("\n")
            )
          );
          return;
        }

        resolve({
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
        });
      }
    );
  });
}

async function runGit(args) {
  return runCommand("git", args, PROJECT_DIR);
}

function sanitizeGitErrorMessage(message) {
  return String(message || "")
    .replace(/https:\/\/[^@\s]+@/gi, "https://<redacted>@")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted>")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "<redacted>");
}

async function readGitStatusEntries() {
  const status = await runGit(["status", "--porcelain=v1", "-z"]);
  return parseGitStatusPorcelain(status.stdout);
}

async function assertCleanWorktreeBeforeCodex() {
  const entries = await readGitStatusEntries();

  assertCleanStatusEntries(entries);
}

async function getTaskChangedPaths() {
  const entries = await readGitStatusEntries();
  return getStatusPaths(entries);
}

async function getTaskChangedEntries() {
  return readGitStatusEntries();
}

async function unstagePaths(paths) {
  const uniquePaths = uniqueSortedPaths(paths);

  if (uniquePaths.length === 0) {
    return;
  }

  await runGit(["restore", "--staged", "--", ...uniquePaths]);
}

async function getCachedDiffPaths() {
  const diff = await runGit(["diff", "--cached", "--name-only"]);
  return uniqueSortedPaths(String(diff.stdout || "").split(/\r?\n/).filter(Boolean));
}

async function stageTaskPaths(paths, statusEntries = null) {
  const taskPaths = uniqueSortedPaths(paths);

  if (taskPaths.length === 0) {
    return [];
  }

  validateGitAddPathsExist(PROJECT_DIR, statusEntries || taskPaths);
  validateCommittablePaths(taskPaths, { projectRoot: PROJECT_DIR });

  await runGit(["add", "--", ...taskPaths]);

  const stagedPaths = await getCachedDiffPaths();

  try {
    validateStagedPaths(taskPaths, stagedPaths);
  } catch (error) {
    await unstagePaths(stagedPaths);
    throw error;
  }

  validateCommittablePaths(stagedPaths, { projectRoot: PROJECT_DIR });

  return stagedPaths;
}

async function prepareGitTask() {
  if (!GIT_AUTO_COMMIT) {
    return {
      enabled: false,
      baseCommit: null,
    };
  }

  await runGit(["rev-parse", "--is-inside-work-tree"]);

  await assertCleanWorktreeBeforeCodex();

  const syncBranch = GIT_PUSH_BRANCH || (
    await runGit(["branch", "--show-current"])
  ).stdout;

  if (!syncBranch) {
    throw new Error("无法确定 Git 同步分支");
  }

  console.log(`开始同步远程分支：${GIT_REMOTE_NAME}/${syncBranch}`);

  await runGit(["fetch", GIT_REMOTE_NAME, "--prune"]);
  await runGit(["switch", syncBranch]);
  await runGit(["pull", "--rebase", GIT_REMOTE_NAME, syncBranch]);

  console.log(`远程分支同步完成：${GIT_REMOTE_NAME}/${syncBranch}`);

  await assertCleanWorktreeBeforeCodex();

  const head = await runGit(["rev-parse", "HEAD"]);

  console.log(`Git 基准提交：${head.stdout}`);

  return {
    enabled: true,
    baseCommit: head.stdout,
  };
}

function createCommitMessage(job) {
  const summary = String(job.request_text || "Codex task")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return `worker: ${job.id} ${summary}`;
}

const CODEX_GIT_OPERATION_GUARD = [
  "【Windows Worker 强制规则】",
  "Codex 只负责修改文件和汇报结果，Git 提交和推送由外层 Worker 自动完成。",
  "只允许修改任务要求的文件。",
  "不允许阻塞式启动本地预览。",
  "不允许执行 npm run dev。",
  "不允许执行 next dev。",
  "不允许执行 npx next dev。",
  "不允许使用 Start-Process 启动 dev server。",
  "不允许执行 cmd start /b npm run dev。",
  "如果需要验证页面，只做静态验证：文件是否存在、TypeScript/ESLint 是否通过、路由文件是否存在。",
  "不启动浏览器，不启动本地 dev server。",
  "本地预览恢复或静态诊断失败只能记录 warning，不能把任务标记 failed。",
  "不允许执行 git add。",
  "不允许执行 git commit。",
  "不允许执行 git push。",
  "不允许创建分支。",
  "不允许修改 Git 配置。",
  "不允许创建 GitHub commit。",
  "不允许调用 GitHub 写入接口。",
  "不允许尝试临时 clone 仓库来提交。",
  "Codex 完成后只需要汇报修改文件和验证结果。",
  "如果任务描述中出现“必须生成 Git Commit”“必须推送到 origin/master”，Codex 应理解为外层 Worker 的验收目标，而不是自己执行 Git。",
  "如果任务要求生成 Git Commit，Codex 不应自行执行。",
].join("\n");

function buildWorkerGuardedPrompt(requestText) {
  const taskText = String(requestText || "").trim();

  return [
    CODEX_GIT_OPERATION_GUARD,
    "",
    "【原始任务内容】",
    taskText,
    "",
    "【再次强调】",
    CODEX_GIT_OPERATION_GUARD,
  ].join("\n");
}

function buildCodexPrompt(job) {
  return buildWorkerGuardedPrompt(job?.request_text || "");
}

function buildCodexRepairPrompt(job, error, attempt) {
  const errorText = error instanceof Error ? error.message : String(error);
  const category = classifyLocalError(errorText);
  const taskText = String(job?.request_text || "").trim();
  const mode =
    attempt === 2
      ? "第 1 次失败：请先诊断错误类型，优先安全修复缓存、路由、语法、端口或依赖引用问题，然后再次验证。"
      : "第 2 次失败：请执行最小化修复，只改最小必要文件，不扩大范围。";

  return buildWorkerGuardedPrompt(
    [
      "【项目总管自动重试】",
      mode,
      `自动分类：${category}`,
      "错误摘要（已截断，不包含密钥）：",
      errorText.slice(-4000),
      "",
      "【原始任务】",
      taskText,
    ].join("\n")
  );
}

function formatPreflightResult(result) {
  return [
    `停止残留进程：${result.stoppedProcesses.length}`,
    `清理缓存：${result.removedCaches.join(", ") || "无"}`,
    `还原生成文件：${result.restoredEnvFiles.join(", ") || "无"}`,
    `清理已知生成文件：${result.cleanedGeneratedPaths.join(", ") || "无"}`,
    `Git 状态：${result.gitStatusShort.length ? result.gitStatusShort.join("; ") : "clean"}`,
  ].join("\n");
}

function formatPreviewReport(reportResult) {
  if (!reportResult) {
    return "本地预览诊断：未执行";
  }

  const routeLines = safeReportArray(reportResult.routeFiles).map((item) => {
    return `- ${item.path}: ${item.ok ? "OK" : "MISSING"}`;
  });
  const checkLines = safeReportArray(reportResult.staticChecks).map((item) => {
    return `- ${item.label}: exit ${item.code} ${item.ok ? "OK" : "FAIL"}`;
  });

  return [
    `本地预览诊断：${reportResult.ok ? "通过" : "warning"}`,
    "模式：static-only（未启动 dev server / 浏览器）",
    `缓存清理：${reportResult.removedCaches.join(", ") || "无"}`,
    "路由文件：",
    ...(routeLines.length ? routeLines : ["- 未执行"]),
    "静态检查：",
    ...(checkLines.length ? checkLines : ["- 未执行"]),
    reportResult.reportWriteError ? `warning: 诊断报告写入失败：${reportResult.reportWriteError}` : "",
    reportResult.warning ? `warning: ${reportResult.error || "本地预览诊断失败"}` : "",
  ].join("\n");
}

function classifyFailure(error) {
  const errorText = error instanceof Error ? error.message : String(error);
  const lower = errorText.toLowerCase();

  if (error?.code === "GIT_ADD_PATH_RESOLUTION" || lower.includes("pathspec")) {
    return {
      stage: "git add 路径解析",
      keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
      suggestion:
        "检查 git status 解析逻辑，使用 git status --porcelain=v1 -z；git add 前校验路径真实存在，保留原始 status 行用于排查。",
      recommendBossApproval: true,
    };
  }

  if (lower.includes("typescript") || lower.includes("tsc")) {
    return {
      stage: "TypeScript 静态检查",
      keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
      suggestion: "根据 tsc 输出修复类型错误，保持最小修改范围后重新执行静态检查。",
      recommendBossApproval: true,
    };
  }

  if (lower.includes("eslint") || lower.includes("lint")) {
    return {
      stage: "ESLint 静态检查",
      keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
      suggestion: "根据 ESLint 输出修复规则违规，不删除测试或绕过 lint。",
      recommendBossApproval: true,
    };
  }

  if (lower.includes("build")) {
    return {
      stage: "build 构建",
      keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
      suggestion: "根据构建错误定位最小代码修复，优先检查 Next.js 路由、导入和 Server/Client 边界。",
      recommendBossApproval: true,
    };
  }

  if (lower.includes("permission") || lower.includes("access denied") || lower.includes("eacces")) {
    return {
      stage: "权限检查",
      keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
      suggestion: "检查本机文件权限、Git 凭据或 Worker 运行用户权限；不要输出或写入任何密钥。",
      recommendBossApproval: true,
    };
  }

  if (lower.includes("git commit")) {
    return {
      stage: "git commit",
      keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
      suggestion: "检查 staged 文件、commit message、作者配置和敏感文件拦截结果后重试。",
      recommendBossApproval: true,
    };
  }

  if (lower.includes("git push")) {
    return {
      stage: "git push",
      keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
      suggestion: "检查远程分支、凭据、权限和分支保护规则；不要把 token 写入日志或仓库。",
      recommendBossApproval: true,
    };
  }

  return {
    stage: "未知失败阶段",
    keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
    suggestion: "先查看 Worker 上报的关键错误和未提交文件清单，再决定是否批准最小范围修复。",
    recommendBossApproval: false,
  };
}

async function getCurrentHead() {
  try {
    const head = await runGit(["rev-parse", "HEAD"]);
    return head.stdout || "未提供";
  } catch (error) {
    return `读取失败：${sanitizeGitErrorMessage(error instanceof Error ? error.message : String(error)).slice(-300)}`;
  }
}

function buildFailureReport(job, error, context = {}) {
  const analysis = classifyFailure(error);
  const filesChanged = uniqueSortedPaths(context.filesChanged || []);
  const uncommittedFiles = uniqueSortedPaths(context.uncommittedFiles || filesChanged);
  const taskName = String(job?.request_text || "未提供").replace(/\s+/g, " ").trim().slice(0, 120);

  return [
    "Codex 任务执行失败",
    `任务编号：${job?.id || "未提供"}`,
    `任务名称：${taskName || "未提供"}`,
    `失败阶段：${analysis.stage}`,
    "关键错误：",
    analysis.keyError || "未提供",
    `是否已经修改文件：${filesChanged.length > 0 ? "是" : "否"}`,
    "当前未提交文件清单：",
    ...(uncommittedFiles.length ? uncommittedFiles.map((filePath) => `- ${filePath}`) : ["- 无"]),
    `是否已生成 commit：${context.commitSha ? "是" : "否"}`,
    `当前 HEAD：${context.head || "未提供"}`,
    `建议修复动作：${analysis.suggestion}`,
    `是否建议老板回复“总管 批准修复”：${analysis.recommendBossApproval ? "是" : "否"}`,
    context.rollbackMessage ? context.rollbackMessage.trim() : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function getPreviewValidationLines(reportResult) {
  if (!reportResult) {
    return ["静态预览诊断：未执行（WORKER_PREVIEW_SMOKE 未开启）"];
  }

  const lines = [
    `静态预览诊断：${reportResult.ok ? "通过" : "warning"}`,
    "本地预览：未启动 dev server / 浏览器",
  ];

  for (const item of safeReportArray(reportResult.staticChecks)) {
    lines.push(`${item.label}: exit ${item.code} ${item.ok ? "通过" : "失败"}`);
  }

  if (reportResult.warning) {
    lines.push(`本地预览静态诊断 warning：${reportResult.error || "诊断未通过"}`);
  }

  return lines;
}

function buildGithubPushStatus(pushResult) {
  if (!pushResult) {
    return "未生成";
  }

  return pushResult.pushed
    ? `已推送：${pushResult.remote}/${pushResult.branch}`
    : pushResult.message || "未推送";
}

async function runCodexWithRetries(job) {
  const prompts = [
    () => buildCodexPrompt(job),
    (error) => buildCodexRepairPrompt(job, error, 2),
    (error) => buildCodexRepairPrompt(job, error, 3),
  ];
  const failures = [];

  for (let index = 0; index < prompts.length; index += 1) {
    try {
      if (index > 0) {
        await updateProgress(
          job.id,
          index === 1 ? 45 : 55,
          index === 1 ? "Codex 自动重试" : "Codex 最小化修复",
          index === 1
            ? "第 1 次执行失败，正在携带错误摘要重试"
            : "第 2 次执行失败，正在执行最小化修复"
        );
      }

      return await runCodex(prompts[index](failures[failures.length - 1]), job);
    } catch (error) {
      failures.push(error);
    }
  }

  const summary = failures
    .map((error, index) => {
      const message = error instanceof Error ? error.message : String(error);
      return `第 ${index + 1} 次失败：${classifyLocalError(message)} - ${message.slice(-1200)}`;
    })
    .join("\n\n");

  throw new Error(
    [
      "项目总管连续自动修复失败，已停止继续尝试。",
      "需要老板二选一决策：A. 允许扩大修改范围继续修；B. 保持当前状态，人工指定优先修哪个问题。",
      summary,
    ].join("\n\n")
  );
}

async function commitGitTask(job) {
  if (!GIT_AUTO_COMMIT) {
    return {
      committed: false,
      message: "Git 自动提交已关闭",
    };
  }

  const taskChangedEntries = await getTaskChangedEntries();
  const taskChangedPaths = getStatusPaths(taskChangedEntries);

  if (taskChangedPaths.length === 0) {
    return {
      committed: false,
      message: "Codex 没有产生文件变更",
      filesChanged: [],
    };
  }

  const stagedPaths = await stageTaskPaths(taskChangedPaths, taskChangedEntries);

  if (stagedPaths.length === 0) {
    return {
      committed: false,
      message: "Codex 没有产生可提交的文件变更",
      filesChanged: [],
    };
  }

  await runGit(["commit", "-m", createCommitMessage(job)]);

  const commit = await runGit(["rev-parse", "HEAD"]);
  const summary = await runGit([
    "show",
    "--stat",
    "--oneline",
    "--summary",
    "HEAD",
  ]);

  console.log(`Git 自动提交成功：${commit.stdout}`);

  return {
    committed: true,
    commitSha: commit.stdout,
    summary: summary.stdout,
    filesChanged: stagedPaths,
  };
}

async function pushGitTask(commitSha) {
  if (!GIT_AUTO_PUSH) {
    return {
      pushed: false,
      message: "Git 自动推送已关闭",
    };
  }

  if (GIT_REMOTE_NAME !== REQUIRED_GIT_PUSH_REMOTE) {
    throw new Error(
      `Git 自动推送被拒绝：GIT_REMOTE_NAME 必须是 ${REQUIRED_GIT_PUSH_REMOTE}`
    );
  }

  if (GIT_PUSH_BRANCH !== REQUIRED_GIT_PUSH_BRANCH) {
    throw new Error(
      `Git 自动推送被拒绝：GIT_PUSH_BRANCH 必须是 ${REQUIRED_GIT_PUSH_BRANCH}`
    );
  }

  await runGit(["rev-parse", "--verify", "HEAD"]);

  if (!commitSha) {
    throw new Error("Git 自动推送被拒绝：最近提交不存在");
  }

  const currentCommit = await runGit(["rev-parse", "HEAD"]);

  if (currentCommit.stdout !== commitSha) {
    throw new Error(
      "Git 自动推送被拒绝：待推送提交不是当前 HEAD"
    );
  }

  const branchResult = await runGit(["branch", "--show-current"]);

  if (branchResult.stdout !== REQUIRED_GIT_PUSH_BRANCH) {
    throw new Error(
      `Git 自动推送被拒绝：当前分支必须是 ${REQUIRED_GIT_PUSH_BRANCH}`
    );
  }

  const status = await runGit(["status", "--porcelain"]);

  if (status.stdout) {
    throw new Error(
      "Git 自动推送被拒绝：工作区不干净，禁止推送"
    );
  }

  const remoteResult = await runGit([
    "remote",
    "get-url",
    REQUIRED_GIT_PUSH_REMOTE,
  ]);

  if (!remoteResult.stdout) {
    throw new Error(
      `Git 远程仓库不存在：${REQUIRED_GIT_PUSH_REMOTE}`
    );
  }

  try {
    await runGit(["push", "origin", "master"]);
  } catch (pushError) {
    throw new Error(
      [
        "Git 自动推送失败：git push origin master 未成功",
        "请确认本机 GitHub 凭据已配置且有仓库写权限；不要把 token 或密钥写入仓库或日志。",
        sanitizeGitErrorMessage(
          pushError instanceof Error ? pushError.message : String(pushError)
        ),
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  console.log(
    `Git 推送成功：${REQUIRED_GIT_PUSH_REMOTE}/${REQUIRED_GIT_PUSH_BRANCH}`
  );

  return {
    pushed: true,
    remote: REQUIRED_GIT_PUSH_REMOTE,
    branch: REQUIRED_GIT_PUSH_BRANCH,
    commitSha,
  };
}
async function rollbackGitTask(checkpoint) {
  if (
    !GIT_AUTO_COMMIT ||
    !GIT_ROLLBACK_ON_FAILURE ||
    !checkpoint?.enabled ||
    !checkpoint.baseCommit
  ) {
    return {
      rolledBack: false,
      message: "Git 回滚未启用",
    };
  }

  const entries = await readGitStatusEntries();
  const trackedPaths = getTrackedStatusPaths(entries);
  const untrackedPaths = getUntrackedStatusPaths(entries);

  await unstagePaths(trackedPaths);

  if (trackedPaths.length > 0) {
    await runGit([
      "restore",
      "--source",
      checkpoint.baseCommit,
      "--staged",
      "--worktree",
      "--",
      ...trackedPaths,
    ]);
  }

  if (untrackedPaths.length > 0) {
    await runGit(["clean", "-f", "--", ...untrackedPaths]);
  }

  console.log(`Git 已回滚到：${checkpoint.baseCommit}`);

  return {
    rolledBack: true,
    commitSha: checkpoint.baseCommit,
  };
}

function killProcessTree(pid, reason) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve();
      return;
    }

    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: sanitizeWindowsEnv(process.env),
      },
      (error, stdout, stderr) => {
        const message = [
          reason,
          stdout ? String(stdout).trim() : "",
          stderr ? String(stderr).trim() : "",
          error ? error.message : "",
        ].filter(Boolean).join("\n");

        if (message) {
          console.warn(message);
        }

        resolve();
      }
    );
  });
}

function startCodexHeartbeat(job) {
  const jobId = job?.id;

  if (!jobId) {
    return () => {};
  }

  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) {
      return;
    }

    try {
      await updateProgress(
        jobId,
        35,
        "执行 Codex",
        "Codex 仍在运行，Worker 心跳正常"
      );
    } catch (error) {
      console.warn(
        "Codex 执行期间心跳上报异常：",
        error instanceof Error ? error.message : String(error)
      );
    }
  }, CODEX_PROGRESS_HEARTBEAT_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function runCodex(prompt, job) {
  return new Promise((resolve, reject) => {
    console.log(`开始执行 Codex，项目目录：${PROJECT_DIR}`);

    const child = spawn(
      CODEX_EXE,
      [
        "exec",
        "-C",
        PROJECT_DIR,
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        prompt,
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...sanitizeWindowsEnv(process.env),
          CI: "1",
          NO_COLOR: "1",
        },
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    let lastOutputAt = Date.now();
    let stopCodexHeartbeat = () => {};

    const cleanupTimers = () => {
      stopCodexHeartbeat();
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
    };

    const appendOutput = (target, chunk) => {
      const text = chunk.toString();
      lastOutputAt = Date.now();

      if (target === "stdout") {
        stdout += text;
        if (stdout.length > 2 * 1024 * 1024) {
          stdout = stdout.slice(-2 * 1024 * 1024);
        }
        process.stdout.write(text);
      } else {
        stderr += text;
        if (stderr.length > 2 * 1024 * 1024) {
          stderr = stderr.slice(-2 * 1024 * 1024);
        }
        process.stderr.write(text);
      }

      resetIdleTimer();
    };

    const failAndKill = (message) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupTimers();

      killProcessTree(child.pid, message).finally(() => {
        reject(new Error(message));
      });
    };

    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const idleMs = Date.now() - lastOutputAt;
        failAndKill(`Codex 空闲超时：${idleMs}ms 无输出，已强制结束进程树`);
      }, CODEX_IDLE_TIMEOUT_MS);
    };

    let idleTimer = setTimeout(() => {
      const idleMs = Date.now() - lastOutputAt;
      failAndKill(`Codex 空闲超时：${idleMs}ms 无输出，已强制结束进程树`);
    }, CODEX_IDLE_TIMEOUT_MS);

    const hardTimer = setTimeout(() => {
      failAndKill(`Codex 执行总超时：${CODEX_TIMEOUT_MS}ms，已强制结束进程树`);
    }, CODEX_TIMEOUT_MS);

    child.on("spawn", () => {
      stopCodexHeartbeat = startCodexHeartbeat(job);
    });

    child.stdout.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => appendOutput("stderr", chunk));

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupTimers();
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupTimers();

      if (code === 0) {
        resolve(stdout.trim() || "Codex 执行完成");
        return;
      }

      reject(
        new Error(
          `Codex 退出码 ${code}\n${stderr || stdout || "没有输出"}`
        )
      );
    });
  });
}

async function updateProgress(
  jobId,
  progressPercent,
  currentStep,
  statusMessage = "",
  attemptId = null
) {
  try {
    const response = await request("/api/worker/progress", {
      method: "POST",
      body: JSON.stringify({
        job_id: jobId,
        attempt_id: attemptId || currentAttemptId,
        worker_id: WORKER_NAME,
        worker_name: WORKER_NAME,
        progress_percent: progressPercent,
        current_step: currentStep,
        status_message: statusMessage,
      }),
    });

    const text = await response.text();

    if (!response.ok) {
      console.warn(
        `任务进度上报失败 HTTP ${response.status}: ${text}`
      );
      return false;
    }

    console.log(
      `任务进度：${progressPercent}% - ${currentStep}`
    );

    return true;
  } catch (error) {
    console.warn(
      "任务进度上报异常：",
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

async function report(jobId, status, payload, extra = {}) {
  const attemptId = extra.attempt_id || currentAttemptId || null;
  const body =
    status === "succeeded"
      ? {
          job_id: jobId,
          attempt_id: attemptId,
          worker_id: WORKER_NAME,
          worker_name: WORKER_NAME,
          status,
          result_text: payload,
          ...extra,
        }
      : {
          job_id: jobId,
          attempt_id: attemptId,
          worker_id: WORKER_NAME,
          worker_name: WORKER_NAME,
          status,
          error_text: payload,
          ...extra,
        };

  const response = await request("/api/worker/report", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`上报失败 HTTP ${response.status}: ${text}`);
  }

  console.log(`任务 ${jobId} 已上报为 ${status}`);
}

async function pollOnce() {
  if (working || stopping) {
    return;
  }

  const response = await request(
    `/api/worker/next?worker_id=${encodeURIComponent(WORKER_NAME)}`
  );

  if (response.status === 204) {
    return;
  }

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`领取任务失败 HTTP ${response.status}: ${text}`);
  }

  const payload = JSON.parse(text);
  const job = payload.job;
  const attemptId = payload.attempt_id || job?.attempt_id || job?.active_attempt_id || job?.payload?.attempt_id || null;

  if (!job || !job.id) {
    return;
  }

  working = true;
  currentAttemptId = attemptId;

  console.log(`领取任务： ${job.id}`);
  console.log(`执行尝试： ${attemptId || "legacy-no-attempt-id"}`);

  await updateProgress(
    job.id,
    5,
    "已领取任务",
    "任务已被 Worker 领取"
  );
  console.log(`任务内容：${job.request_text}`);

  const stopHeartbeat = startHeartbeat(job.id, attemptId);
  let gitCheckpoint = null;

  try {
    await updateProgress(
      job.id,
      10,
      "Worker 启动前自检",
      "正在停止残留进程、清理缓存并检查 Git 状态"
    );

    const preflightResult = await runPreflight(PROJECT_DIR);

    await updateProgress(
      job.id,
      15,
      "Worker 自检完成",
      formatPreflightResult(preflightResult)
    );

    await updateProgress(
      job.id,
      20,
      "同步 Git",
      "正在同步 Git 仓库"
    );

    gitCheckpoint = await prepareGitTask();

    await updateProgress(
      job.id,
      30,
      "Git 同步完成",
      "本地分支已与远程分支同步"
    );

    await updateProgress(
      job.id,
      35,
      "执行 Codex",
      "正在启动 Codex"
    );

    const result = await runCodexWithRetries(job);

    await updateProgress(
      job.id,
      65,
      "Codex 执行完成",
      "Codex 已完成代码修改"
    );

    let previewReport = null;

    if (WORKER_PREVIEW_SMOKE) {
      await updateProgress(
        job.id,
        70,
        "静态预览诊断",
        "正在检查路由文件、ESLint 和 TypeScript；不会启动 dev server 或浏览器"
      );

      previewReport = await safeRecoverLocalPreview(PROJECT_DIR);
    }

    await updateProgress(
      job.id,
      75,
      "检查并提交代码",
      "正在检查 Git 修改并准备提交"
    );

    const gitResult = await commitGitTask(job);

    await updateProgress(
      job.id,
      85,
      "Git 提交完成",
      gitResult.committed
        ? `提交成功：${gitResult.commitSha}`
        : gitResult.message
    );

    let pushResult = {
      pushed: false,
      message: "没有新提交，无需推送",
    };

    if (gitResult.committed) {
      await updateProgress(
        job.id,
        90,
        "推送 GitHub",
        "正在推送代码到远程仓库"
      );

      pushResult = await pushGitTask(
        gitResult.commitSha
      );
    }

    await updateProgress(
      job.id,
      95,
      "Git 推送阶段完成",
      pushResult.pushed
        ? `已推送：${pushResult.remote}/${pushResult.branch}`
        : pushResult.message
    );

    const finalResult = [
      result,
      "",
      formatPreviewReport(previewReport),
      "",
      "Git 自动备份：",
      gitResult.committed
        ? `提交成功：${gitResult.commitSha}`
        : gitResult.message,
      gitResult.summary || "",
      "",
      "GitHub 自动推送：",
      pushResult.pushed
        ? `推送成功：${pushResult.remote}/${pushResult.branch}`
        : pushResult.message,
    ]
      .filter(Boolean)
      .join("\n");

    console.log(
      `准备上报：job=${job.id}, git_commit_sha=${gitResult.commitSha || "null"}, deploy_status=${pushResult.pushed ? "pending" : "null"}`
    );

    await updateProgress(
      job.id,
      100,
      "任务已完成",
      "任务执行完成并准备上报"
    );

    await report(
      job.id,
      "succeeded",
      finalResult,
      {
        attempt_id: attemptId,
        project_name: "同城搭子网站",
        project_dir: PROJECT_DIR,
        files_changed: gitResult.filesChanged || [],
        validation_results: [
          "Codex 执行：通过",
          ...getPreviewValidationLines(previewReport),
          gitResult.committed
            ? `Git 自动备份：通过（${gitResult.commitSha}）`
            : `Git 自动备份：warning（${gitResult.message}）`,
          pushResult.pushed
            ? `GitHub 推送：通过（${pushResult.remote}/${pushResult.branch}）`
            : `GitHub 推送：warning（${pushResult.message}）`,
        ],
        github_push_status: buildGithubPushStatus(pushResult),
        git_commit_sha:
          gitResult.commitSha || null,
        deploy_status:
          pushResult.pushed
            ? "pending"
            : null,
      }
    );
  } catch (error) {
    console.error("任务执行失败：", error);

    let rollbackMessage = "";
    let failureChangedPaths = [];
    let currentHead = "未提供";

    try {
      failureChangedPaths = await getTaskChangedPaths();
    } catch (statusError) {
      console.warn(
        "读取失败任务修改文件失败：",
        statusError instanceof Error ? statusError.message : String(statusError)
      );
    }

    currentHead = await getCurrentHead();

    try {
      const rollbackResult = await rollbackGitTask(gitCheckpoint);

      rollbackMessage = rollbackResult.rolledBack
        ? `\nGit 已自动回滚到：${rollbackResult.commitSha}`
        : `\n${rollbackResult.message}`;
    } catch (rollbackError) {
      rollbackMessage =
        `\nGit 自动回滚失败：${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        }`;
    }

    await updateProgress(
      job.id,
      100,
      "任务执行失败",
      "任务执行失败，正在上报错误"
    );

    const failureReport = buildFailureReport(job, error, {
      filesChanged: failureChangedPaths,
      uncommittedFiles: failureChangedPaths,
      head: currentHead,
      rollbackMessage,
    });

    await report(
      job.id,
      "failed",
      failureReport,
      {
        attempt_id: attemptId,
        project_name: "同城搭子网站",
        project_dir: PROJECT_DIR,
        files_changed: failureChangedPaths,
        validation_results: [
          `失败阶段：${classifyFailure(error).stage}`,
          `关键错误：${classifyFailure(error).keyError}`.slice(0, 600),
          `当前 HEAD：${currentHead}`,
          rollbackMessage.trim() || "Git 回滚：未提供",
          "本地预览：未启动 dev server / 浏览器",
        ],
        github_push_status: "失败任务未推送",
        git_commit_sha: null,
        deploy_status: null,
      }
    );
  } finally {
    stopHeartbeat();
    currentAttemptId = null;
    working = false;
  }
}

async function main() {
  assertRequiredEnv();

  console.log("本地 Worker 已启动");
  console.log(`Worker 名称：${WORKER_NAME}`);
  console.log(`云端地址：${WORKER_API_URL}`);
  console.log(`项目目录：${PROJECT_DIR}`);

  while (!stopping) {
    try {
      await pollOnce();
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] 轮询失败：`,
        error instanceof Error ? error.message : error
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

process.on("SIGINT", () => {
  stopping = true;
  console.log("正在停止 Worker...");
});

process.on("SIGTERM", () => {
  stopping = true;
});

if (require.main === module) {
  main().catch((error) => {
    console.error("Worker 启动失败：", error);
    process.exit(1);
  });
}

module.exports = {
  assertCleanWorktreeBeforeCodex,
  buildCodexPrompt,
  buildFailureReport,
  buildWorkerGuardedPrompt,
  classifyFailure,
  commitGitTask,
  getTaskChangedPaths,
  main,
  prepareGitTask,
  rollbackGitTask,
  stageTaskPaths,
};




















async function safeRecoverLocalPreview(...args) {
  // SAFE_RECOVER_LOCAL_PREVIEW_NON_BLOCKING
  try {
    return await recoverLocalPreview(...args);
  } catch (err) {
    const message = err && (err.message || String(err));
    console.warn("[worker] local preview diagnostic failed but task will continue:", message);
    return {
      ok: false,
      warning: true,
      skipped: true,
      error: message,
      removedCaches: [],
      routeFiles: [],
      staticChecks: [],
      note: "本地预览静态诊断失败，但不阻断项目总管任务；继续执行代码诊断、修复、验证和回报。"
    };
  }
}


function safeReportArray(value) {
  // SAFE_REPORT_ARRAY_FOR_FORMAT_PREVIEW_REPORT
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}


