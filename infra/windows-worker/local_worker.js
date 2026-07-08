try {
  require("dotenv").config();
} catch (error) {
  if (!error || error.code !== "MODULE_NOT_FOUND") {
    throw error;
  }
}

const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  assertCleanStatusEntries,
  classifyGitPath,
  formatPathList,
  getProtectedBusinessPathPatterns,
  getStatusPaths,
  getTrackedStatusPaths,
  getUntrackedStatusPaths,
  isProtectedBusinessPath,
  normalizeGitPath,
  pathMatchesGitPattern,
  parseGitStatusPorcelain,
  resolveInsideRoot,
  uniqueSortedPaths,
  validateCommittablePaths,
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

function readRecord(value) {
  return value && typeof value === "object" ? value : null;
}

function readJobString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBatchCode(value) {
  const raw = readJobString(value);
  if (!raw) {
    return null;
  }

  const match = raw.match(/\bBATCH-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?\b/i);
  return match ? match[0].toUpperCase() : null;
}

function findBatchCodeInText(text) {
  return normalizeBatchCode(String(text || ""));
}

function getJobPayload(job) {
  return readRecord(job?.payload) || {};
}

function getJobBatchCode(job) {
  const payload = getJobPayload(job);

  return (
    normalizeBatchCode(job?.batch_code) ||
    normalizeBatchCode(payload.batch_code) ||
    normalizeBatchCode(job?.dispatch_batch) ||
    normalizeBatchCode(payload.dispatch_batch) ||
    normalizeBatchCode(job?.task_code) ||
    findBatchCodeInText(job?.request_text) ||
    findBatchCodeInText(job?.title) ||
    null
  );
}

function getJobTaskTitle(job) {
  const payload = getJobPayload(job);

  return (
    readJobString(job?.title) ||
    readJobString(payload.task_title) ||
    readJobString(payload.title) ||
    readJobString(job?.task_title) ||
    readJobString(job?.job_id) ||
    "untitled"
  );
}

function getBossOriginalText(job) {
  const payload = getJobPayload(job);

  return (
    readJobString(job?.boss_original_text) ||
    readJobString(job?.bossOriginalText) ||
    readJobString(payload.boss_original_text) ||
    readJobString(payload.bossOriginalText) ||
    readJobString(payload.original_demand) ||
    readJobString(payload.raw_message_text) ||
    readJobString(job?.original_demand) ||
    readJobString(job?.request_text) ||
    ""
  );
}

function compactText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function previewText(text, maxLength = 200) {
  return compactText(text).slice(0, maxLength);
}

function getExplicitlyApprovedBatch(bossOriginalText) {
  const text = compactText(bossOriginalText);
  const patterns = [
    /(?:仅|只)\s*批准\s*(?:的是|为|:|：)?\s*(BATCH-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)/i,
    /(?:仅|只)\s*(?:允许|执行|领取|处理)\s*(?:的是|为|:|：)?\s*(BATCH-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)/i,
    /only\s+(?:approve|approved|allow|execute|run)\s+(BATCH-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return normalizeBatchCode(match[1]);
    }
  }

  return null;
}

function validateJobBatchConsistency(job) {
  const bossOriginalText = getBossOriginalText(job);
  const approvedBatch = getExplicitlyApprovedBatch(bossOriginalText);
  const jobBatch = getJobBatchCode(job);

  if (!approvedBatch) {
    return {
      ok: true,
      errorCode: null,
      approvedBatch: null,
      jobBatch,
      message: "no explicit single-batch approval found",
    };
  }

  if (jobBatch === approvedBatch) {
    return {
      ok: true,
      errorCode: null,
      approvedBatch,
      jobBatch,
      message: "job batch matches boss approval",
    };
  }

  return {
    ok: false,
    errorCode: "TASK_BATCH_MISMATCH",
    approvedBatch,
    jobBatch,
    message: [
      "TASK_BATCH_MISMATCH",
      `approved_batch=${approvedBatch}`,
      `job_batch=${jobBatch || "missing"}`,
      `job_id=${job?.id || "missing"}`,
      `title=${getJobTaskTitle(job)}`,
      `boss_original_text_preview=${previewText(bossOriginalText)}`,
    ].join("\n"),
  };
}

function getJobSearchText(job) {
  const payload = getJobPayload(job);
  return [
    job?.id,
    job?.title,
    job?.request_text,
    job?.description,
    job?.prompt,
    payload.task_title,
    payload.original_demand,
    payload.boss_original_text,
    payload.raw_message_text,
  ]
    .filter(Boolean)
    .join("\n");
}

function hasExplicitAllowedFileModification(text) {
  return (
    /允许修改|允许变更|允许写入|allowed\s+(?:files|paths|changes|modifications)|permitted\s+(?:files|paths|changes)/i.test(
      text
    ) && /\b(?:infra|src|docs|app)\//i.test(text.replace(/\\/g, "/"))
  );
}

function hasReadOnlyDirective(text) {
  const compacted = compactText(text);

  return (
    /只读(?:任务|验证|工作区|盘点|模式)?/.test(compacted) ||
    /验证任务|只读验证/.test(compacted) ||
    /不修改文件|禁止修改文件|不得修改文件|不提交|禁止提交|不得提交|不推送|禁止推送|不得推送/.test(
      compacted
    ) ||
    /\b(?:read[-\s]?only|validation[-\s]?only|verify[-\s]?only)\b/i.test(compacted) ||
    /\b(?:do not|don't|no)\s+(?:modify files|commit|push)\b/i.test(compacted)
  );
}

function isReadOnlyJob(job) {
  const text = getJobSearchText(job);

  if (hasReadOnlyDirective(text)) {
    if (hasExplicitAllowedFileModification(text) && /修复|修改|实现|开发|write|modify|fix|implement/i.test(text)) {
      return false;
    }

    return true;
  }

  const hasReadOnlySignal =
    /git\s+status\s+--short/i.test(text) ||
    /git\s+diff\s+--name-only/i.test(text) ||
    /工作区盘点/.test(text) ||
    /项目分类盘点/.test(text) ||
    (/只读/.test(text) && /\bBATCH-22A\b/i.test(text));

  if (!hasReadOnlySignal) {
    return false;
  }

  const writeIntentText = text.replace(
    /(?:禁止|不得|不允许|不可|不能)[^\n。；;]*(?:修复|修改|创建|删除|实现|开发|写入|生成|变更|提交|推送|commit|push|stash|reset|add|restore|clean|write|modify|delete|create|fix)[^\n。；;]*/gi,
    ""
  );
  const hasWriteIntent =
    /修复|修改|创建|删除|实现|开发|写入|生成|变更|提交|推送/i.test(writeIntentText) ||
    /\b(?:commit|push|stash|reset|add|restore|clean|write|modify|delete|create|fix)\b/i.test(writeIntentText);

  return !hasWriteIntent;
}

const SYSTEM_DEFAULT_ALLOWED_PATH_PATTERNS = [
  "agents/**",
  "infra/windows-worker/**",
  "src/lib/worker-jobs.ts",
];

function isProductDevelopmentBatch(batchCode) {
  return /^BATCH-P[A-Z0-9-]*$/i.test(String(batchCode || ""));
}

function classifyWorkerTask(job) {
  const batchCode = getJobBatchCode(job);
  const text = getJobSearchText(job);

  if (isProductDevelopmentBatch(batchCode)) {
    return "product_development";
  }

  if (isReadOnlyJob(job)) {
    return "read_only_validation";
  }

  if (/worker|windows-worker|local_worker|git-safety|codex|路径解析|工作区盘点/i.test(text)) {
    return "worker_system";
  }

  if (/飞书|总经理|项目总管|hermes|boss|feishu|project director/i.test(text)) {
    return "feishu_gm";
  }

  if (/运维|配置|部署|自动化|system|automation|ops|vercel|网关|gateway/i.test(text)) {
    return "automation_system";
  }

  if (/^BATCH-\d+/i.test(String(batchCode || ""))) {
    return "automation_system";
  }

  return "automation_system";
}

function isSystemGuardedTask(job) {
  return classifyWorkerTask(job) !== "product_development";
}

function extractPathPatternsFromLine(line) {
  const normalizedLine = String(line || "").replace(/\\/g, "/");
  const patterns = [];
  const regex = /(?:^|[\s`'"])((?:agents|infra|src|docs|app)\/[A-Za-z0-9_./\-[\]*]+)(?=$|[\s`'",，。；;:：])/g;
  let match = regex.exec(normalizedLine);

  while (match) {
    patterns.push(normalizeGitPath(match[1]).replace(/[.,，。；;:：]+$/, ""));
    match = regex.exec(normalizedLine);
  }

  return patterns;
}

function extractExplicitAllowedPathPatterns(job) {
  const text = [getBossOriginalText(job), job?.request_text, job?.description, job?.prompt]
    .filter(Boolean)
    .join("\n");
  const lines = String(text || "").split(/\r?\n/);
  const patterns = [];
  let inAllowedSection = false;

  for (const line of lines) {
    if (/允许修改|允许变更|允许写入|allowed\s+(?:files|paths|changes|modifications)|permitted\s+(?:files|paths|changes)/i.test(line)) {
      inAllowedSection = true;
      patterns.push(...extractPathPatternsFromLine(line));
      continue;
    }

    if (/禁止修改|禁止|不得|不允许|验证要求|完成后|当前问题|修复目标|forbidden|validation|must not/i.test(line)) {
      inAllowedSection = false;
    }

    if (inAllowedSection) {
      patterns.push(...extractPathPatternsFromLine(line));
    }
  }

  return uniqueSortedPaths(patterns);
}

function buildTaskBoundaryPolicy(job) {
  const taskType = classifyWorkerTask(job);
  const productDevelopment = taskType === "product_development";
  const readOnly = isReadOnlyJob(job);
  const systemGuarded = !productDevelopment;
  const explicitAllowedPaths = extractExplicitAllowedPathPatterns(job);
  const allowedPathPatterns = readOnly
    ? []
    : explicitAllowedPaths.length > 0
      ? explicitAllowedPaths
      : systemGuarded
        ? SYSTEM_DEFAULT_ALLOWED_PATH_PATTERNS
        : null;

  return {
    taskType,
    batchCode: getJobBatchCode(job) || "unknown",
    productDevelopment,
    readOnly,
    systemGuarded,
    allowedPathPatterns,
    explicitAllowedPaths,
    protectedBusinessPathPatterns: systemGuarded ? getProtectedBusinessPathPatterns() : [],
  };
}

function matchesAnyPathPattern(filePath, patterns) {
  return (patterns || []).some((pattern) => pathMatchesGitPattern(filePath, pattern));
}

function formatAllowedScope(policy) {
  if (policy.readOnly) {
    return ["read-only task: no file changes, no git add, no git commit, no git push"];
  }

  if (policy.allowedPathPatterns === null) {
    return ["product development batch: product paths are allowed by product task policy"];
  }

  return policy.allowedPathPatterns.length > 0
    ? policy.allowedPathPatterns
    : ["no writable paths"];
}

function buildOutOfScopeBusinessChangeReport(policy, paths, reason) {
  return [
    "OUT_OF_SCOPE_BUSINESS_CHANGE",
    `batch_code: ${policy.batchCode}`,
    `task_type: ${policy.taskType}`,
    "",
    "out_of_scope_files:",
    formatPathList(paths) || "- (none)",
    "",
    "allowed_scope:",
    ...formatAllowedScope(policy).map((item) => `- ${item}`),
    "",
    "why_stopped:",
    reason,
    "",
    "next_step:",
    "Boss should either send an explicit product development batch such as BATCH-P3/BATCH-P4 for product pages, or resend a system task with a narrower allowed system-file scope.",
  ].join("\n");
}

function createOutOfScopeBusinessChangeError(policy, paths, reason) {
  const error = new Error(buildOutOfScopeBusinessChangeReport(policy, paths, reason));
  error.code = "OUT_OF_SCOPE_BUSINESS_CHANGE";
  error.paths = uniqueSortedPaths(paths);
  error.allowedPathPatterns = policy.allowedPathPatterns;
  error.taskType = policy.taskType;
  return error;
}

function assertChangedPathsAllowedForJob(job, changedPaths) {
  const policy = buildTaskBoundaryPolicy(job);
  const paths = uniqueSortedPaths(changedPaths);

  if (paths.length === 0) {
    return policy;
  }

  if (policy.readOnly) {
    throw createOutOfScopeBusinessChangeError(
      policy,
      paths,
      "This job is read-only/validation-only, so any file change must stop before git add or commit."
    );
  }

  const protectedBusinessPaths = policy.systemGuarded
    ? paths.filter((filePath) => isProtectedBusinessPath(filePath))
    : [];

  if (protectedBusinessPaths.length > 0) {
    throw createOutOfScopeBusinessChangeError(
      policy,
      protectedBusinessPaths,
      "A system/Worker/ops task attempted to modify protected product business paths."
    );
  }

  if (policy.allowedPathPatterns !== null) {
    const outOfScopePaths = paths.filter(
      (filePath) => !matchesAnyPathPattern(filePath, policy.allowedPathPatterns)
    );

    if (outOfScopePaths.length > 0) {
      throw createOutOfScopeBusinessChangeError(
        policy,
        outOfScopePaths,
        "Changed files are outside the paths explicitly allowed by the boss/system policy."
      );
    }
  }

  return policy;
}

function assertGitWriteAllowedForJob(job, operation) {
  if (!isReadOnlyJob(job)) {
    return;
  }

  const error = new Error(
    [
      "READ_ONLY_GIT_OPERATION_BLOCKED",
      `operation: ${operation}`,
      "This job is read-only/validation-only. git add, git commit, and git push are forbidden.",
    ].join("\n")
  );
  error.code = "READ_ONLY_GIT_OPERATION_BLOCKED";
  throw error;
}

function bossExplicitlyAllowsAutoPush(job) {
  const text = compactText(getBossOriginalText(job));

  if (/不推送|禁止推送|不得推送|不允许推送|no push|do not push|don't push/i.test(text)) {
    return false;
  }

  return /(?:明确|显式|允许|批准|可以|同意)[^。；;\n]*(?:自动)?(?:推送|push)|(?:auto[-\s]?push|git push)[^。；;\n]*(?:allowed|approved|explicitly allowed)/i.test(
    text
  );
}

function shouldAutoPushJob(job, autoPushEnabled = GIT_AUTO_PUSH) {
  if (!autoPushEnabled) {
    return {
      allowed: false,
      message: "Git auto push is disabled",
    };
  }

  if (isReadOnlyJob(job)) {
    return {
      allowed: false,
      message: "Read-only task: git push is forbidden",
    };
  }

  const policy = buildTaskBoundaryPolicy(job);

  if (policy.systemGuarded && !bossExplicitlyAllowsAutoPush(job)) {
    return {
      allowed: false,
      message: "System/Worker task has no explicit boss approval for auto push; skipping git push",
    };
  }

  return {
    allowed: true,
    message: "Git auto push allowed",
  };
}

function isNegatedProductTaskCardLine(line) {
  return /不得|禁止|不允许|不要|不能|must\s+not|do\s+not|don't|forbid/i.test(line);
}

function referencesProductTaskCardAsExecutionText(job) {
  const lines = getJobSearchText(job).split(/\r?\n/);

  return lines.some((line) => {
    if (!/docs[\\/]NEXT_TASK_CARD\.md|NEXT_TASK_CARD\.md/i.test(line)) {
      return false;
    }

    if (isNegatedProductTaskCardLine(line)) {
      return false;
    }

    return /读取|使用|执行|打开|根据|按|read|use|execute|open|load/i.test(line);
  });
}

function assertProductTaskCardAccessAllowed(job) {
  const policy = buildTaskBoundaryPolicy(job);

  if (policy.productDevelopment || !referencesProductTaskCardAsExecutionText(job)) {
    return policy;
  }

  const error = new Error(
    [
      "OUT_OF_SCOPE_PRODUCT_TASK_CARD",
      `batch_code: ${policy.batchCode}`,
      `task_type: ${policy.taskType}`,
      "System/Worker tasks must not read docs/NEXT_TASK_CARD.md as execution text.",
      "Only product development batches such as BATCH-P3/BATCH-P4 may use the product task card.",
    ].join("\n")
  );
  error.code = "OUT_OF_SCOPE_PRODUCT_TASK_CARD";
  throw error;
}

function buildJobExecutionContext(job, attemptId = null) {
  const bossOriginalText = getBossOriginalText(job);

  return {
    jobId: job?.id || "missing",
    batchCode: getJobBatchCode(job) || "unknown",
    title: getJobTaskTitle(job),
    bossOriginalTextPreview: previewText(bossOriginalText),
    createdAt: readJobString(job?.created_at) || "unknown",
    attemptId: attemptId || "legacy-no-attempt-id",
  };
}

function logClaimedJob(job, attemptId = null) {
  const context = buildJobExecutionContext(job, attemptId);

  console.log(`领取任务： ${context.jobId}`);
  console.log(`任务批次： ${context.batchCode}`);
  console.log(`任务标题： ${context.title}`);
  console.log(`老板原文前200字： ${context.bossOriginalTextPreview || "(empty)"}`);
  console.log(`任务创建时间： ${context.createdAt}`);
  console.log(`执行尝试： ${context.attemptId}`);
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

function runCommand(command, args, cwd = PROJECT_DIR, options = {}) {
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
          stdout:
            options.trimOutput === false
              ? String(stdout || "")
              : String(stdout || "").trim(),
          stderr:
            options.trimOutput === false
              ? String(stderr || "")
              : String(stderr || "").trim(),
        });
      }
    );
  });
}

async function runGit(args, options = {}) {
  return runCommand("git", args, PROJECT_DIR, options);
}

async function runReadOnlyJob(job) {
  const status = await runGit(["status", "--short"]);
  const porcelain = await runGit(["status", "--porcelain=v1", "-z"], {
    trimOutput: false,
  });
  const diff = await runGit(["diff", "--name-only"]);
  const statusPaths = getStatusPaths(parseGitStatusPorcelain(porcelain.stdout));
  const diffPaths = uniqueSortedPaths(
    String(diff.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map(normalizeGitPath)
  );
  const classifiedPaths = uniqueSortedPaths([...statusPaths, ...diffPaths]).map((filePath) => ({
    path: filePath,
    classification: classifyGitPath(filePath),
  }));
  const context = buildJobExecutionContext(job, currentAttemptId);

  return [
    "READ_ONLY_WORKSPACE_INVENTORY",
    `job_id: ${context.jobId}`,
    `attempt_id: ${context.attemptId}`,
    `batch_code: ${context.batchCode}`,
    `task_title: ${context.title}`,
    `created_at: ${context.createdAt}`,
    `boss_original_text_preview: ${context.bossOriginalTextPreview || "(empty)"}`,
    "",
    "git status --short:",
    status.stdout || "(clean)",
    "",
    "git diff --name-only:",
    diff.stdout || "(none)",
    "",
    "project classification:",
    ...(classifiedPaths.length
      ? classifiedPaths.map((item) => `- ${item.path}: ${item.classification}`)
      : ["- no changed paths"]),
  ].join("\n");
}

function sanitizeGitErrorMessage(message) {
  return String(message || "")
    .replace(/https:\/\/[^@\s]+@/gi, "https://<redacted>@")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted>")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "<redacted>");
}

async function readGitStatusEntries() {
  const status = await runGit(["status", "--porcelain=v1", "-z"], {
    trimOutput: false,
  });
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

async function unstagePaths(paths) {
  const uniquePaths = uniqueSortedPaths(paths);

  if (uniquePaths.length === 0) {
    return;
  }

  await runGit(["restore", "--staged", "--", ...uniquePaths]);
}

async function getCachedDiffPaths() {
  const diff = await runGit(["diff", "--cached", "--name-only"]);
  return uniqueSortedPaths(
    String(diff.stdout || "").split(/\r?\n/).filter(Boolean).map(normalizeGitPath)
  );
}

function getStatusEntryPathRecords(entry) {
  const paths = Array.isArray(entry?.paths) ? entry.paths : [entry?.path];

  return paths.filter(Boolean).map((filePath) => ({
    parsedPath: normalizeGitPath(filePath),
    status: entry?.status || null,
    rawStatusLine: entry?.rawStatusLine || null,
  }));
}

function getStagePathRecords(pathsOrEntries) {
  const records = [];

  for (const item of pathsOrEntries || []) {
    if (typeof item === "string") {
      records.push({
        parsedPath: normalizeGitPath(item),
        status: null,
        rawStatusLine: null,
      });
      continue;
    }

    if (item && typeof item === "object") {
      records.push(...getStatusEntryPathRecords(item));
    }
  }

  const byPath = new Map();

  for (const record of records) {
    if (!record.parsedPath || byPath.has(record.parsedPath)) {
      continue;
    }

    byPath.set(record.parsedPath, record);
  }

  return [...byPath.values()].sort((a, b) => a.parsedPath.localeCompare(b.parsedPath));
}

function isDeletedStatus(status) {
  const value = String(status || "");
  return value !== "??" && value.includes("D");
}

function createGitAddPathResolutionError(record, details = {}) {
  const projectRoot = path.resolve(PROJECT_DIR || process.cwd());
  const error = new Error(
    [
      "GIT_ADD_PATH_RESOLUTION",
      "git add 前路径解析失败，拒绝继续暂存。",
      `rawStatusLine: ${record.rawStatusLine || "(unavailable)"}`,
      `parsedPath: ${record.parsedPath || "(empty)"}`,
      `cwd: ${process.cwd()}`,
      `projectRoot: ${projectRoot}`,
      details.absolutePath ? `absolutePath: ${details.absolutePath}` : null,
      details.reason ? `reason: ${details.reason}` : null,
    ]
      .filter(Boolean)
      .join("\n")
  );

  error.code = "GIT_ADD_PATH_RESOLUTION";
  return error;
}

function assertGitAddPathsExist(pathRecords) {
  const projectRoot = path.resolve(PROJECT_DIR || process.cwd());

  for (const record of pathRecords) {
    const absolutePath = resolveInsideRoot(projectRoot, record.parsedPath);

    if (!absolutePath) {
      throw createGitAddPathResolutionError(record, {
        reason: "path resolves outside project root",
      });
    }

    if (fs.existsSync(absolutePath) || isDeletedStatus(record.status)) {
      continue;
    }

    throw createGitAddPathResolutionError(record, {
      absolutePath,
      reason: "path does not exist",
    });
  }
}

async function stageTaskPaths(pathsOrEntries, options = {}) {
  if (options.job) {
    assertGitWriteAllowedForJob(options.job, "git add");
  }

  const pathRecords = getStagePathRecords(pathsOrEntries);
  const taskPaths = uniqueSortedPaths(pathRecords.map((record) => record.parsedPath));

  if (taskPaths.length === 0) {
    return [];
  }

  assertGitAddPathsExist(pathRecords);
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

function buildTaskBoundaryPrompt(policy) {
  if (!policy) {
    return "";
  }

  const lines = [
    "【Task Boundary Guard】",
    `batch_code: ${policy.batchCode}`,
    `task_type: ${policy.taskType}`,
  ];

  if (policy.systemGuarded) {
    lines.push(
      "This is a system/Worker/ops/read-only guarded task, not a product-page task.",
      "Do not read docs/NEXT_TASK_CARD.md or docs/product/** as execution text.",
      "If a requested change touches protected business paths, stop and report OUT_OF_SCOPE_BUSINESS_CHANGE.",
      "Protected business paths:",
      ...policy.protectedBusinessPathPatterns.map((pattern) => `- ${pattern}`)
    );
  }

  lines.push(
    "Allowed write scope:",
    ...formatAllowedScope(policy).map((item) => `- ${item}`)
  );

  return lines.join("\n");
}

function buildWorkerGuardedPrompt(requestText, policy = null) {
  const taskText = String(requestText || "").trim();
  const boundaryPrompt = buildTaskBoundaryPrompt(policy);

  return [
    CODEX_GIT_OPERATION_GUARD,
    boundaryPrompt,
    "",
    "【原始任务内容】",
    taskText,
    "",
    "【再次强调】",
    CODEX_GIT_OPERATION_GUARD,
  ].join("\n");
}

function buildCodexPrompt(job) {
  const policy = assertProductTaskCardAccessAllowed(job);
  return buildWorkerGuardedPrompt(job?.request_text || "", policy);
}

function buildCodexRepairPrompt(job, error, attempt) {
  const errorText = error instanceof Error ? error.message : String(error);
  const category = classifyLocalError(errorText);
  const taskText = String(job?.request_text || "").trim();
  const policy = assertProductTaskCardAccessAllowed(job);
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
    ].join("\n"),
    policy
  );
}

function formatPreflightResult(result) {
  return [
    `停止残留进程：${result.stoppedProcesses.length}`,
    `清理缓存：${result.removedCaches.join(", ") || "无"}`,
    `还原生成文件：${result.restoredEnvFiles.join(", ") || "无"}`,
    `清理已知生成文件：${result.cleanedGeneratedPaths.join(", ") || "无"}`,
    `系统改动放行：${safeReportArray(result.allowedSystemChanges).join("; ") || "无"}`,
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

  const taskChangedEntries = await readGitStatusEntries();
  const taskChangedPaths = getStatusPaths(taskChangedEntries);

  if (isReadOnlyJob(job)) {
    if (taskChangedPaths.length > 0) {
      assertChangedPathsAllowedForJob(job, taskChangedPaths);
    }

    return {
      committed: false,
      message: "Read-only task: skipped git add and git commit",
    };
  }

  if (taskChangedPaths.length === 0) {
    return {
      committed: false,
      message: "Codex 没有产生文件变更",
    };
  }

  assertChangedPathsAllowedForJob(job, taskChangedPaths);

  const stagedPaths = await stageTaskPaths(taskChangedEntries, { job });

  if (stagedPaths.length === 0) {
    return {
      committed: false,
      message: "Codex 没有产生可提交的文件变更",
    };
  }

  assertGitWriteAllowedForJob(job, "git commit");

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
  };
}

async function pushGitTask(commitSha, job) {
  const pushDecision = shouldAutoPushJob(job);

  if (!pushDecision.allowed) {
    return {
      pushed: false,
      message: pushDecision.message,
    };
  }

  assertGitWriteAllowedForJob(job, "git push");

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

  logClaimedJob(job, attemptId);

  await updateProgress(
    job.id,
    5,
    "已领取任务",
    "任务已被 Worker 领取"
  );

  const stopHeartbeat = startHeartbeat(job.id, attemptId);
  let gitCheckpoint = null;

  try {
    const batchCheck = validateJobBatchConsistency(job);

    if (!batchCheck.ok) {
      const mismatchError = new Error(batchCheck.message);
      mismatchError.code = batchCheck.errorCode;
      await updateProgress(
        job.id,
        100,
        "任务批次不匹配",
        batchCheck.message
      );
      throw mismatchError;
    }

    if (isReadOnlyJob(job)) {
      await updateProgress(
        job.id,
        10,
        "只读任务确认",
        "检测到只读盘点任务，将跳过自检清理、Git 同步、Codex、stash/reset/commit/push"
      );

      const result = await runReadOnlyJob(job);

      await updateProgress(
        job.id,
        100,
        "只读任务完成",
        "只读工作区盘点已完成，未修改文件"
      );

      await report(
        job.id,
        "succeeded",
        result,
        {
          attempt_id: attemptId,
          read_only: true,
        }
      );
      return;
    }

    assertProductTaskCardAccessAllowed(job);

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
      const pushDecision = shouldAutoPushJob(job);

      if (pushDecision.allowed) {
        await updateProgress(
          job.id,
          90,
          "推送 GitHub",
          "正在推送代码到远程仓库"
        );

        pushResult = await pushGitTask(
          gitResult.commitSha,
          job
        );
      } else {
        pushResult = {
          pushed: false,
          message: pushDecision.message,
        };
      }
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

    await report(
      job.id,
      "failed",
      `${
      error instanceof Error ? error.message : String(error)
      }${rollbackMessage}`,
      {
        attempt_id: attemptId,
        error_code:
          error && typeof error === "object" && error.code
            ? String(error.code)
            : undefined,
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
  assertChangedPathsAllowedForJob,
  assertCleanWorktreeBeforeCodex,
  assertGitWriteAllowedForJob,
  assertProductTaskCardAccessAllowed,
  buildJobExecutionContext,
  buildCodexPrompt,
  buildTaskBoundaryPolicy,
  buildWorkerGuardedPrompt,
  classifyWorkerTask,
  commitGitTask,
  extractExplicitAllowedPathPatterns,
  getBossOriginalText,
  getExplicitlyApprovedBatch,
  getJobBatchCode,
  getJobTaskTitle,
  getTaskChangedPaths,
  isReadOnlyJob,
  isProductDevelopmentBatch,
  referencesProductTaskCardAsExecutionText,
  main,
  prepareGitTask,
  rollbackGitTask,
  runReadOnlyJob,
  shouldAutoPushJob,
  stageTaskPaths,
  validateJobBatchConsistency,
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


function safeReportJoin(value, separator = "\n") {
  // SAFE_REPORT_JOIN_FOR_UNDEFINED_VALUES
  if (Array.isArray(value)) return value.join(separator);
  if (value == null) return "";
  return String(value);
}
