/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");

function normalizeGitPath(filePath) {
  const raw = String(filePath || "").replace(/\0/g, "");
  let normalized = raw.replace(/\\/g, "/").replace(/\/+/g, "/");

  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  return normalized;
}

function uniqueSortedPaths(paths) {
  return [...new Set(paths.map(normalizeGitPath).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function parseGitStatusPorcelain(output) {
  const entries = [];
  const parts = String(output || "").split("\0").filter(Boolean);

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    const parsed = parseGitStatusRecord(record);

    if (!parsed) {
      continue;
    }

    const { status, filePath, rawStatusLine } = parsed;

    if (status[0] === "R" || status[0] === "C") {
      const originalPath = normalizeGitPath(parts[index + 1] || "");
      index += 1;

      entries.push(
        withRawStatusLine(
          {
            status,
            path: filePath,
            originalPath,
            paths: [filePath],
            line: rawStatusLine,
            raw: record,
          },
          rawStatusLine
        )
      );
      continue;
    }

    entries.push(
      withRawStatusLine(
        {
          status,
          path: filePath,
          originalPath: null,
          paths: [filePath],
          line: rawStatusLine,
          raw: record,
        },
        rawStatusLine
      )
    );
  }

  return entries;
}

function parseGitStatusRecord(record) {
  const rawStatusLine = String(record || "").replace(/\0/g, "").replace(/\r?\n$/, "");

  if (!rawStatusLine) {
    return null;
  }

  const match = rawStatusLine.match(/^([ MTADRCU?!]{1,2}) (.*)$/);

  if (!match) {
    return null;
  }

  const rawPath = match[2].replace(/^"|"$/g, "");
  const filePath = normalizeGitPath(
    rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath
  );

  if (!filePath) {
    return null;
  }

  return {
    status: match[1],
    filePath,
    rawStatusLine,
  };
}

function withRawStatusLine(entry, rawStatusLine) {
  Object.defineProperty(entry, "rawStatusLine", {
    value: rawStatusLine,
    enumerable: false,
  });

  return entry;
}

function unquoteGitShortPath(value) {
  const text = String(value || "").trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

function parseGitStatusShort(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const parsed = parseGitStatusRecord(line);

      if (!parsed) {
        return null;
      }

      return {
        status: parsed.status,
        path: parsed.filePath,
        originalPath: null,
        paths: [parsed.filePath],
        line: parsed.rawStatusLine,
        raw: line,
      };
    })
    .filter(Boolean);
}

const AUTOMATION_TASK_MARKERS = [
  /BATCH-30/i,
  /BATCH-37/i,
  /BATCH-38/i,
  /Windows Worker/i,
  /local_worker/i,
  /worker-recovery/i,
  /git-safety/i,
  /GIT_ADD_PATH_RESOLUTION/i,
  /NO_FIX_APPLIED/i,
  /running_job_not_found/i,
  /Worker\s*\/\s*Codex/i,
  /heartbeat/i,
  /report API/i,
  /automation system/i,
  /自动化系统/i,
  /飞书总经理/i,
  /项目总管/i,
  /总管.*路由/i,
  /路由.*修复/i,
  /自动化系统/,
  /任务正文串线/,
  /飞书最终报告/,
];

const FROZEN_BUSINESS_PAGE_PREFIXES = [
  "app/page.tsx",
  "app/post",
  "app/partners",
  "src/app/page.tsx",
  "src/app/post",
  "src/app/partners",
];

function isAutomationSystemTaskText(requestText) {
  const text = String(requestText || "");
  return AUTOMATION_TASK_MARKERS.some((pattern) => pattern.test(text));
}

function isFrozenBusinessPagePath(filePath) {
  const normalized = normalizeGitPath(filePath);
  return FROZEN_BUSINESS_PAGE_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}

function validateAutomationTaskBoundaries(paths, options = {}) {
  if (!options.enforce && !isAutomationSystemTaskText(options.requestText)) {
    return;
  }

  const forbiddenPaths = uniqueSortedPaths(paths).filter(isFrozenBusinessPagePath);

  if (forbiddenPaths.length === 0) {
    return;
  }

  const error = new Error(
    [
      "自动化系统任务触碰了冻结业务页面，Worker 已停止 git add/commit。",
      "本批次只允许修复 Worker / Codex / report / heartbeat 链路，不允许修改同城搭子网站业务页面。",
      "禁止路径：",
      ...forbiddenPaths.map((filePath) => `- ${filePath}`),
      "建议修复动作：撤回业务页面改动，只保留本批次允许范围内的自动化系统文件。",
    ].join("\n")
  );

  error.code = "BUSINESS_PAGE_BOUNDARY_VIOLATION";
  error.failureStage = "自动化任务范围边界检查";
  error.forbiddenPaths = forbiddenPaths;
  throw error;
}

function formatPathList(paths) {
  return uniqueSortedPaths(paths).map((filePath) => `- ${filePath}`).join("\n");
}

function formatStatusList(entries) {
  return entries
    .flatMap((entry) =>
      entry.paths.map((filePath) => `- ${entry.status} ${normalizeGitPath(filePath)}`)
    )
    .join("\n");
}

function getStatusPaths(entries) {
  return uniqueSortedPaths(entries.flatMap((entry) => entry.paths || []));
}

function getTrackedStatusPaths(entries) {
  return uniqueSortedPaths(
    entries
      .filter((entry) => entry.status !== "??")
      .flatMap((entry) => entry.paths || [])
  );
}

function getUntrackedStatusPaths(entries) {
  return uniqueSortedPaths(
    entries
      .filter((entry) => entry.status === "??")
      .flatMap((entry) => entry.paths || [])
  );
}

function comparePathSets(expectedPaths, actualPaths) {
  const expected = uniqueSortedPaths(expectedPaths);
  const actual = uniqueSortedPaths(actualPaths);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  return {
    ok:
      expected.length === actual.length &&
      expected.every((filePath) => actualSet.has(filePath)),
    expected,
    actual,
    missing: expected.filter((filePath) => !actualSet.has(filePath)),
    extra: actual.filter((filePath) => !expectedSet.has(filePath)),
  };
}

function assertCleanStatusEntries(entries) {
  if (!entries || entries.length === 0) {
    return;
  }

  throw new Error(
    [
      "任务开始前 Git 工作区不干净，本次任务拒绝执行。",
      "请先手工处理以下文件后再重试；以下仅列出文件路径和状态，不包含文件内容：",
      formatStatusList(entries),
    ].join("\n")
  );
}

function isSensitivePath(filePath) {
  const normalized = normalizeGitPath(filePath);
  const lower = normalized.toLowerCase();
  const baseName = lower.split("/").filter(Boolean).pop() || lower;
  const parts = lower.split("/").filter(Boolean);

  if (baseName === ".env.example") {
    return false;
  }

  if (
    baseName === ".env" ||
    baseName.startsWith(".env.") ||
    baseName.endsWith(".env")
  ) {
    return true;
  }

  if (parts.includes("logs")) {
    return true;
  }

  return baseName.endsWith(".bak");
}

const sensitiveContentRules = [
  {
    name: "WORKER_TOKEN",
    pattern: /\bWORKER_TOKEN\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    pattern: /\bSUPABASE_SERVICE_ROLE_KEY\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  {
    name: "FEISHU_APP_SECRET",
    pattern: /\bFEISHU_APP_SECRET\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  {
    name: "GITHUB_TOKEN",
    pattern: /\bGITHUB_TOKEN\b\s*[:=]\s*["']?[^\s"']{8,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}/i,
  },
  {
    name: "password",
    pattern: /\bpassword\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  {
    name: "private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bprivate[_-]?key\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
];

function scanSensitiveContent(content) {
  const text = String(content || "");
  return sensitiveContentRules
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.name);
}

function resolveInsideRoot(projectRoot, filePath) {
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(root, normalizeGitPath(filePath));

  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  return absolutePath;
}

function createPathResolutionFailure({
  filePath,
  line,
  projectRoot,
  absolutePath = null,
  reason = "path does not exist",
  stage = "git add path resolution",
}) {
  const normalizedPath = normalizeGitPath(filePath);
  const root = path.resolve(projectRoot || process.cwd());
  const error = new Error(
    [
      "GIT_ADD_PATH_RESOLUTION",
      "git add path resolution failed; refusing to stage parsed path.",
      `rawStatusLine: ${line || "(unavailable)"}`,
      `parsedPath: ${normalizedPath || "(empty)"}`,
      `cwd: ${process.cwd()}`,
      `projectRoot: ${root}`,
      absolutePath ? `absolutePath: ${absolutePath}` : null,
      `reason: ${reason}`,
    ]
      .filter(Boolean)
      .join("\n")
  );

  error.code = "GIT_ADD_PATH_RESOLUTION";
  error.failureStage = stage;
  error.badPath = normalizedPath;
  error.parsedPath = normalizedPath;
  error.rawStatusLine = line || "";
  error.projectRoot = root;
  error.cwd = process.cwd();
  error.reason = reason;

  return error;
}

function isDeletedStatus(status) {
  const value = String(status || "");
  return value !== "??" && value.includes("D");
}

function validateGitAddPathsExist(projectRoot, entriesOrPaths) {
  const root = path.resolve(projectRoot || process.cwd());
  const entries = (entriesOrPaths || []).map((item) =>
    typeof item === "string"
      ? {
          status: "",
          path: normalizeGitPath(item),
          line: item,
          rawStatusLine: item,
        }
      : item
  );

  for (const entry of entries) {
    const filePath = normalizeGitPath(entry.path);
    const absolutePath = resolveInsideRoot(root, filePath);
    const rawStatusLine =
      entry.rawStatusLine || entry.line || entry.raw || `${entry.status || ""} ${filePath}`.trim();

    if (!absolutePath) {
      throw createPathResolutionFailure({
        filePath,
        line: rawStatusLine,
        projectRoot: root,
        reason: "path resolves outside project root",
      });
    }

    if (fs.existsSync(absolutePath) || isDeletedStatus(entry.status)) {
      continue;
    }

    throw createPathResolutionFailure({
      filePath,
      line: rawStatusLine,
      projectRoot: root,
      absolutePath,
      reason: "path does not exist",
    });
  }
}
function scanFileForSensitiveContent(projectRoot, filePath) {
  const absolutePath = resolveInsideRoot(projectRoot, filePath);

  if (!absolutePath) {
    return ["outside project root"];
  }

  if (!fs.existsSync(absolutePath)) {
    return [];
  }

  const stat = fs.statSync(absolutePath);

  if (!stat.isFile()) {
    return [];
  }

  const maxBytesToScan = 1024 * 1024;
  const buffer = Buffer.alloc(Math.min(stat.size, maxBytesToScan));
  const fd = fs.openSync(absolutePath, "r");

  try {
    fs.readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  return scanSensitiveContent(buffer.toString("utf8"));
}

function validateCommittablePaths(paths, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const findings = [];

  for (const filePath of uniqueSortedPaths(paths)) {
    if (isSensitivePath(filePath)) {
      findings.push({
        path: normalizeGitPath(filePath),
        rule: "sensitive path",
      });
      continue;
    }

    for (const rule of scanFileForSensitiveContent(projectRoot, filePath)) {
      findings.push({
        path: normalizeGitPath(filePath),
        rule,
      });
    }
  }

  if (findings.length > 0) {
    throw new Error(
      [
        "检测到禁止提交的文件，本次任务拒绝提交。",
        "以下仅列出文件路径和规则名称，不包含文件内容：",
        ...findings.map((finding) => `- ${finding.path} (${finding.rule})`),
      ].join("\n")
    );
  }
}

function validateStagedPaths(taskPaths, stagedPaths) {
  const normalizeForCompare = (value) =>
    String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");

  const uniqueSorted = (values) =>
    Array.from(new Set((values || []).map(normalizeForCompare).filter(Boolean))).sort();

  const expectedPaths = uniqueSorted(taskPaths);
  const actualPaths = uniqueSorted(stagedPaths);

  const isSameOrInside = (expected, actual) => {
    const parent = normalizeForCompare(expected);
    const child = normalizeForCompare(actual);

    if (!parent || !child) return false;
    if (child === parent) return true;
    return child.startsWith(parent + "/");
  };

  const extraStagedPaths = actualPaths.filter(
    (actualPath) => !expectedPaths.some((expectedPath) => isSameOrInside(expectedPath, actualPath))
  );

  const missingStagedPaths = expectedPaths.filter(
    (expectedPath) => !actualPaths.some((actualPath) => isSameOrInside(expectedPath, actualPath))
  );

  if (extraStagedPaths.length > 0 || missingStagedPaths.length > 0) {
    const details = [
      "Git 暂存结果与本次任务文件不一致，已取消本次暂存。",
      "以下仅列出文件路径，不包含文件内容：",
    ];

    if (extraStagedPaths.length > 0) {
      details.push("额外暂存文件：");
      for (const path of extraStagedPaths) {
        details.push("- " + path);
      }
    }

    if (missingStagedPaths.length > 0) {
      details.push("缺少暂存文件：");
      for (const path of missingStagedPaths) {
        details.push("- " + path);
      }
    }

    throw new Error(details.join("\n"));
  }

  return actualPaths;
}

module.exports = {
  assertCleanStatusEntries,
  comparePathSets,
  formatPathList,
  formatStatusList,
  getStatusPaths,
  getTrackedStatusPaths,
  getUntrackedStatusPaths,
  isSensitivePath,
  normalizeGitPath,
  parseGitStatusRecord,
  parseGitStatusPorcelain,
  parseGitStatusShort,
  scanSensitiveContent,
  isAutomationSystemTaskText,
  isFrozenBusinessPagePath,
  uniqueSortedPaths,
  validateAutomationTaskBoundaries,
  validateCommittablePaths,
  validateGitAddPathsExist,
  validateStagedPaths,
};
