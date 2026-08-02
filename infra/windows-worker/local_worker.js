/* eslint-disable @typescript-eslint/no-require-imports */
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
const crypto = require("crypto");
const {
  assertCleanStatusEntries,
  getStatusPaths,
  getTrackedStatusPaths,
  getUntrackedStatusPaths,
  normalizeGitPath,
  parseGitStatusPorcelain,
  uniqueSortedPaths,
  validateAutomationTaskBoundaries,
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
const {
  runSshCommand: runCanonicalSshCommand,
  shutdownActiveSshProcesses,
} = require("./ssh-execution");

const WORKER_API_URL = String(process.env.WORKER_API_URL || "").replace(/\/+$/, "");
const WORKER_AUTH_ENV_KEY = "WORKER_" + "TOKEN";
const WORKER_AUTH = process.env[WORKER_AUTH_ENV_KEY];
const WORKER_NAME = process.env.WORKER_NAME || os.hostname();
const PROJECT_DIR = process.env.PROJECT_DIR;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const WORKER_REQUEST_TIMEOUT_MS = Number(process.env.WORKER_REQUEST_TIMEOUT_MS || 15000);
const WORKER_POLL_BACKOFF_MAX_MS = Number(process.env.WORKER_POLL_BACKOFF_MAX_MS || 60000);
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 900000);
const CODEX_IDLE_TIMEOUT_MS = Number(process.env.CODEX_IDLE_TIMEOUT_MS || 60000);
const CODEX_PROGRESS_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const LEGACY_CODEX_EXE = "C:/Users/admin/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe";
const EXPLICIT_CODEX_ENV_KEYS = [
  "CODEX_EXE",
  "CODEX_CLI_PATH",
  "CODEX_EXECUTABLE",
  "CODEX_BIN",
  "CODEX_PATH",
];
const CODEX_PREFLIGHT_OK = "CODEX_WORKER_PREFLIGHT_OK";
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
let currentReadOnlyMode = false;
let codexStartupDiagnostics = null;
let codexResolvedExecutableState = null;
const terminalReportState = createTerminalReportState();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPlainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readNullableReportString(value) {
  const text = readString(value);
  return text && !/^(null|none|n\/a|not[_ -]?provided|undefined)$/i.test(text)
    ? text
    : null;
}

function firstReportString(...values) {
  for (const value of values) {
    const text = readNullableReportString(value);
    if (text) return text;
  }
  return null;
}

function readProjectDirectorReportData(value) {
  const record = readPlainRecord(value);
  if (!record) return null;
  return readPlainRecord(record.data) || record;
}

function readAcceptedFinalReportData(responseBody) {
  const body = readPlainRecord(responseBody);
  if (!body) return null;

  return (
    readProjectDirectorReportData(body.project_director_report) ||
    readProjectDirectorReportData(readPlainRecord(body.job)?.result?.project_director_report) ||
    null
  );
}

function readReportPushFlag(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    const booleanValue = readNullableBooleanFlag(value);
    if (booleanValue !== null) return booleanValue;
    const text = readString(value);
    if (/^(success|succeeded|pushed|pending|true|yes)$/i.test(String(text || "").trim())) {
      return true;
    }
  }
  return false;
}

function buildTerminalStatusSnapshot(input = {}) {
  const reportBody = readPlainRecord(input.reportBody) || readPlainRecord(input.body) || {};
  const acceptedResponse =
    readPlainRecord(input.acceptedFinalReportResponse) ||
    readPlainRecord(input.accepted_final_report_response) ||
    readPlainRecord(input.responseBody) ||
    null;
  const acceptedData = readAcceptedFinalReportData(acceptedResponse) || {};
  const explicitSnapshot =
    readPlainRecord(input.terminalStatusSnapshot) ||
    readPlainRecord(input.terminal_status_snapshot) ||
    readPlainRecord(input.effectiveFinalStatusSnapshot) ||
    readPlainRecord(input.effective_final_status_snapshot) ||
    {};
  const sources = [acceptedData, explicitSnapshot, reportBody, input];
  const sourceRawValue = (...keys) => {
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          const value = source[key];
          if (value !== undefined && value !== null) return value;
        }
      }
    }
    return null;
  };
  const sourceValue = (...keys) => {
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          const value = source[key];
          if (value !== undefined && value !== null && String(value).trim() !== "") return value;
        }
      }
    }
    return null;
  };

  const effectiveFinalStatus =
    normalizeTerminalStatus(sourceValue("effective_final_status", "effectiveFinalStatus")) ||
    normalizeTerminalStatus(input.status) ||
    "running";
  const finalReportStatus =
    normalizeTerminalStatus(sourceValue("final_report_status", "finalReportStatus")) ||
    normalizeTerminalStatus(input.status) ||
    null;
  const failureCode =
    effectiveFinalStatus === "failed"
      ? normalizeFailureCodeValue(sourceValue("failure_code", "failureCode", "error_code", "errorCode"))
      : null;
  const failureStage =
    effectiveFinalStatus === "failed"
      ? firstReportString(sourceValue("failure_stage", "failureStage"))
      : null;
  const changedFiles = uniqueSortedPaths(
    readStringList(
      sourceRawValue("committed_files", "committedFiles") ||
        sourceRawValue("changed_files", "changedFiles", "files_changed", "filesChanged")
    )
  );
  const gitCommitSha = firstReportString(
    sourceValue("git_commit_sha", "gitCommitSha"),
    acceptedResponse?.git_commit_sha
  );
  const gitPush = readReportPushFlag(
    sourceValue("git_push", "gitPush", "pushed"),
    sourceValue("github_push_status", "githubPushStatus"),
    sourceValue("deploy_status", "deployStatus")
  );

  return {
    final_report_accepted: readNullableBooleanFlag(input.finalReportAccepted) !== false,
    job_id: firstReportString(sourceValue("job_id", "jobId", "id")),
    worker_execution_status:
      firstReportString(sourceValue("worker_execution_status", "workerExecutionStatus")) ||
      (effectiveFinalStatus === "succeeded"
        ? "succeeded"
        : effectiveFinalStatus === "failed"
        ? "failed"
        : effectiveFinalStatus),
    task_goal_status:
      firstReportString(sourceValue("task_goal_status", "taskGoalStatus")) ||
      (effectiveFinalStatus === "succeeded"
        ? "completed"
        : effectiveFinalStatus === "failed"
        ? "failed"
        : effectiveFinalStatus),
    final_report_status: finalReportStatus,
    effective_final_status: effectiveFinalStatus,
    failure_code: failureCode,
    failure_stage: failureStage,
    changed_files: changedFiles,
    committed_files: uniqueSortedPaths(
      readStringList(sourceRawValue("committed_files", "committedFiles") || changedFiles)
    ),
    codex_changed_files: uniqueSortedPaths(
      readStringList(sourceRawValue("codex_changed_files", "codexChangedFiles"))
    ),
    worktree_changed_files: uniqueSortedPaths(
      readStringList(sourceRawValue("worktree_changed_files", "worktreeChangedFiles"))
    ),
    task_changed_files: uniqueSortedPaths(
      readStringList(sourceRawValue("task_changed_files", "taskChangedFiles") || changedFiles)
    ),
    unexpected_changed_files: uniqueSortedPaths(
      readStringList(sourceRawValue("unexpected_changed_files", "unexpectedChangedFiles"))
    ),
    git_commit_sha: gitCommitSha,
    codex_git_push: firstReportString(sourceValue("codex_git_push", "codexGitPush")),
    worker_git_push: readReportPushFlag(sourceValue("worker_git_push", "workerGitPush")),
    git_push: gitPush,
    pushed: gitPush,
    pushed_branch: firstReportString(sourceValue("pushed_branch", "pushedBranch")),
    remote_contains_commit: readReportPushFlag(
      sourceValue("remote_contains_commit", "remoteContainsCommit")
    ),
    repository_clean_after_push: readBooleanFlag(
      sourceValue("repository_clean_after_push", "repositoryCleanAfterPush")
    ),
    post_completion_transport_warning: readBooleanFlag(
      sourceValue("post_completion_transport_warning", "postCompletionTransportWarning")
    ),
    post_completion_warning_count:
      Number(sourceValue("post_completion_warning_count", "postCompletionWarningCount")) || 0,
  };
}

function createTerminalReportState() {
  return {
    snapshot: null,
    postCompletionWarningCount: 0,
    heartbeatStopper: null,
    progressStopper: null,
  };
}

function resetTerminalReportState(state = terminalReportState) {
  stopTerminalReportTimers(state);
  state.snapshot = null;
  state.postCompletionWarningCount = 0;
  state.heartbeatStopper = null;
  state.progressStopper = null;
}

function registerTerminalTimerStopper(kind, stop, state = terminalReportState) {
  if (typeof stop !== "function") return () => {};

  let stopped = false;
  const stopOnce = () => {
    if (stopped) return;
    stopped = true;
    stop();
  };

  if (kind === "heartbeat") {
    state.heartbeatStopper = stopOnce;
  } else if (kind === "progress") {
    state.progressStopper = stopOnce;
  }

  if (state.snapshot?.final_report_accepted) {
    stopOnce();
  }

  return stopOnce;
}

function stopTerminalReportTimers(state = terminalReportState) {
  const heartbeatStopper = state.heartbeatStopper;
  const progressStopper = state.progressStopper;
  state.heartbeatStopper = null;
  state.progressStopper = null;

  if (heartbeatStopper) heartbeatStopper();
  if (progressStopper) progressStopper();
}

function lockAcceptedTerminalReportSnapshot(snapshotInput = {}, state = terminalReportState) {
  const snapshot = buildTerminalStatusSnapshot({
    ...snapshotInput,
    finalReportAccepted: true,
  });
  state.snapshot = Object.freeze(snapshot);
  stopTerminalReportTimers(state);
  return getTerminalReportSnapshot(state);
}

function getTerminalReportSnapshot(state = terminalReportState) {
  if (!state.snapshot) return null;
  return {
    ...state.snapshot,
    post_completion_transport_warning: state.postCompletionWarningCount > 0 ||
      Boolean(state.snapshot.post_completion_transport_warning),
    post_completion_warning_count: state.postCompletionWarningCount,
  };
}

function isTerminalReportLockedForJob(jobId, state = terminalReportState) {
  const snapshot = state.snapshot;
  if (!snapshot?.final_report_accepted) return false;
  if (!jobId || !snapshot.job_id) return true;
  return String(snapshot.job_id) === String(jobId);
}

function describeTransportError(value) {
  if (value instanceof Error) return value.message;
  const record = readPlainRecord(value);
  if (!record) return String(value || "");
  return [
    record.status ? `HTTP ${record.status}` : "",
    record.text,
    record.message,
    record.error,
  ]
    .filter(Boolean)
    .join(" ");
}

function isRunningJobNotFoundOrNotOwned(value) {
  return /RUNNING_JOB_NOT_FOUND_OR_NOT_OWNED|running_job_not_found|running job not found|not found or not owned/i.test(
    describeTransportError(value)
  );
}

function recordPostCompletionTransportWarning(value, stage, jobId, state = terminalReportState) {
  if (!isTerminalReportLockedForJob(jobId, state) || !isRunningJobNotFoundOrNotOwned(value)) {
    return false;
  }

  state.postCompletionWarningCount += 1;
  state.snapshot = Object.freeze({
    ...state.snapshot,
    post_completion_transport_warning: true,
    post_completion_warning_count: state.postCompletionWarningCount,
  });
  console.warn(
    `[worker] post_completion_transport_warning stage=${stage} job=${jobId || "unknown"} count=${state.postCompletionWarningCount}: ${describeTransportError(value)}`
  );
  return true;
}

function quoteWindowsCmdArg(value) {
  return '"' + String(value).replace(/"/g, '\\"') + '"';
}

function sanitizeSpawnValue(value) {
  return String(value == null ? "" : value)
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|authorization|key|secret)=)[^&\s]+/gi, "$1[redacted]");
}

function sanitizeSpawnArgs(args = []) {
  return args.map((arg) => {
    const text = sanitizeSpawnValue(arg);
    return text.length > 240 ? `${text.slice(0, 240)}...[truncated]` : text;
  });
}

function getCodexFileType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".exe") return "exe";
  if (ext === ".cmd") return "cmd";
  if (ext === ".bat") return "bat";
  if (ext === ".ps1") return "powershell-script";
  if (!ext) return "shim-or-app-alias";
  return ext.slice(1) || "unknown";
}

function readEnvValue(env, key) {
  if (!env || typeof env !== "object") return "";
  if (Object.prototype.hasOwnProperty.call(env, key)) return String(env[key] || "").trim();
  const foundKey = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return foundKey ? String(env[foundKey] || "").trim() : "";
}

function getPathListEnv(env) {
  return readEnvValue(env, "Path") || readEnvValue(env, "PATH");
}

function normalizeCandidateSource(source) {
  return String(source || "unknown").trim() || "unknown";
}

function getFileStatSafe(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function shouldResolveCandidateAsDirectory(requestedPath, source) {
  const text = String(requestedPath || "").trim();
  if (!text) return false;
  if (/env\.CODEX_BIN$/i.test(source)) return true;
  if (/[\\/]$/.test(text)) return true;
  return path.basename(text).toLowerCase() === "bin";
}

function normalizeCodexCandidatePath(requestedPath, source) {
  const rawRequestedPath = String(requestedPath || "").trim();
  const resolutionSource = normalizeCandidateSource(source);
  if (!rawRequestedPath) {
    return {
      source: resolutionSource,
      requestedPath: rawRequestedPath,
      resolvedPath: "",
      exists: false,
      fileType: "missing",
      isWindowsAppAlias: false,
      isShim: false,
    };
  }

  let resolvedPath = path.resolve(rawRequestedPath);
  let stat = getFileStatSafe(resolvedPath);

  if ((stat && stat.isDirectory()) || (!stat && shouldResolveCandidateAsDirectory(rawRequestedPath, resolutionSource))) {
    resolvedPath = path.join(resolvedPath, "codex.exe");
    stat = getFileStatSafe(resolvedPath);
  }

  const exists = Boolean(stat);
  const fileType = exists && stat.isDirectory() ? "directory" : getCodexFileType(resolvedPath);
  const isWindowsAppAlias = /[\\/]WindowsApps[\\/]/i.test(resolvedPath);
  const isShim = ["shim-or-app-alias", "cmd", "bat"].includes(fileType);

  return {
    source: resolutionSource,
    requestedPath: rawRequestedPath,
    resolvedPath,
    exists,
    fileType,
    isWindowsAppAlias,
    isShim,
  };
}

function buildCodexResolution(candidate, reason = null) {
  const base = {
    ok: !reason,
    reason,
    resolutionSource: candidate.source,
    requestedPath: candidate.requestedPath,
    resolvedPath: candidate.resolvedPath,
    exists: candidate.exists,
    fileType: candidate.fileType,
    isWindowsAppAlias: candidate.isWindowsAppAlias,
    isShim: candidate.isShim,
  };

  if (reason) return base;
  return { ...base, reason: null };
}

function validateCodexCandidate(candidate) {
  if (!candidate.exists) return "CODEX_EXE_NOT_FOUND";
  if (candidate.isWindowsAppAlias || candidate.isShim) return "CODEX_EXE_APP_ALIAS_OR_SHIM";
  if (candidate.fileType !== "exe") return "CODEX_EXE_UNSUPPORTED_FILE_TYPE";
  return null;
}

function resolveCodexCandidate(candidate) {
  const normalized = normalizeCodexCandidatePath(candidate.path, candidate.source);
  return buildCodexResolution(normalized, validateCodexCandidate(normalized));
}

function listExplicitCodexCandidates(options = {}) {
  const env = options.env || process.env;
  const candidates = [];
  const optionPath = String(options.codexExe || "").trim();

  if (optionPath) {
    candidates.push({ source: "options.codexExe", path: optionPath, explicit: true });
  }

  for (const key of EXPLICIT_CODEX_ENV_KEYS) {
    const value = readEnvValue(env, key);
    if (value) candidates.push({ source: `env.${key}`, path: value, explicit: true });
  }

  return candidates;
}

function listCodexDesktopCandidates(options = {}) {
  const env = options.env || process.env;
  const roots = Array.isArray(options.codexDesktopRoots)
    ? options.codexDesktopRoots
    : [
        path.join(readEnvValue(env, "LOCALAPPDATA") || path.join(os.homedir(), "AppData", "Local"), "OpenAI", "Codex"),
      ];
  const candidates = [];

  for (const root of roots) {
    if (!root) continue;
    const binRoot = path.join(root, "bin");
    const directBinExe = path.join(binRoot, "codex.exe");

    let entries = [];
    try {
      entries = getFileStatSafe(binRoot)?.isDirectory()
        ? fs
            .readdirSync(binRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
              const executablePath = path.join(binRoot, entry.name, "codex.exe");
              const stat = getFileStatSafe(executablePath);
              return {
                source: "codex_desktop_runtime",
                path: executablePath,
                explicit: false,
                mtimeMs: stat ? stat.mtimeMs : 0,
                name: entry.name,
              };
            })
        : [];
    } catch {
      entries = [];
    }

    entries
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
      .forEach((entry) => candidates.push(entry));

    candidates.push({ source: "codex_desktop_bin", path: directBinExe, explicit: false });
    candidates.push({ source: "codex_desktop_root", path: path.join(root, "codex.exe"), explicit: false });
  }

  return candidates;
}

function listPathCodexCandidates(options = {}) {
  const env = options.env || process.env;
  return getPathListEnv(env)
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({
      source: "path",
      path: path.join(entry, "codex.exe"),
      explicit: false,
    }));
}

function uniqueCodexCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.source}\0${path.resolve(String(candidate.path || ""))}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveCodexExecutable(options = {}) {
  const explicitCandidates = listExplicitCodexCandidates(options);
  if (explicitCandidates.length > 0) {
    return resolveCodexCandidate(explicitCandidates[0]);
  }

  const autoCandidates = uniqueCodexCandidates([
    ...listCodexDesktopCandidates(options),
    ...listPathCodexCandidates(options),
    { source: "legacy_programs", path: LEGACY_CODEX_EXE, explicit: false },
  ]);

  let firstFailure = null;
  for (const candidate of autoCandidates) {
    const resolution = resolveCodexCandidate(candidate);
    if (resolution.ok) return resolution;
    if (!firstFailure) firstFailure = resolution;
  }

  return (
    firstFailure || {
      ok: false,
      reason: "CODEX_EXE_NOT_FOUND",
      resolutionSource: "none",
      requestedPath: "",
      resolvedPath: "",
      exists: false,
      fileType: "missing",
      isWindowsAppAlias: false,
      isShim: false,
    }
  );
}

function getCodexExecutionResolution(options = {}) {
  if (options.codexResolution) return options.codexResolution;
  if (options.codexExe || options.env || options.ignoreCodexStartupCache) {
    return resolveCodexExecutable(options);
  }
  return codexResolvedExecutableState || resolveCodexExecutable(options);
}

function sanitizeCodexDiagnosticValue(value) {
  return sanitizeSpawnValue(value).slice(0, 1000);
}

function buildCodexDiagnostics(codexResolution, extras = {}) {
  const resolution = codexResolution || {};
  const failureCode =
    extras.failureCode ||
    resolution.reason ||
    (extras.preflightStatus === "failed" ? "CODEX_PREFLIGHT_FAILED" : null);
  return {
    codex_resolution_source: sanitizeCodexDiagnosticValue(resolution.resolutionSource || "none"),
    codex_requested_path: sanitizeCodexDiagnosticValue(resolution.requestedPath || ""),
    codex_executable_resolved: sanitizeCodexDiagnosticValue(resolution.resolvedPath || ""),
    codex_executable_exists: Boolean(resolution.exists),
    codex_executable_file_type: sanitizeCodexDiagnosticValue(resolution.fileType || "unknown"),
    codex_executable_version: sanitizeCodexDiagnosticValue(extras.version || ""),
    codex_executable_is_app_alias: Boolean(resolution.isWindowsAppAlias),
    codex_preflight_status: extras.preflightStatus || (resolution.ok ? "not_run" : "failed"),
    failure_code: failureCode,
    failure_stage: failureCode ? "codex_preflight" : null,
  };
}

function getCodexReportDiagnostics(overrides = {}) {
  return {
    ...buildCodexDiagnostics(codexResolvedExecutableState, {
      preflightStatus: codexResolvedExecutableState ? "not_run" : "not_resolved",
    }),
    ...(codexStartupDiagnostics || {}),
    ...overrides,
  };
}

function formatCodexDiagnosticLines(diagnostics = getCodexReportDiagnostics()) {
  return [
    `codex_resolution_source: ${diagnostics.codex_resolution_source || "null"}`,
    `codex_requested_path: ${diagnostics.codex_requested_path || "null"}`,
    `codex_executable_resolved: ${diagnostics.codex_executable_resolved || "null"}`,
    `codex_executable_exists: ${diagnostics.codex_executable_exists ? "true" : "false"}`,
    `codex_executable_file_type: ${diagnostics.codex_executable_file_type || "unknown"}`,
    `codex_executable_version: ${diagnostics.codex_executable_version || "unknown"}`,
    `codex_executable_is_app_alias: ${diagnostics.codex_executable_is_app_alias ? "true" : "false"}`,
    `codex_preflight_status: ${diagnostics.codex_preflight_status || "unknown"}`,
  ];
}

function logCodexStartupDiagnostics(diagnostics) {
  console.log(`Codex executable resolved: ${diagnostics.codex_executable_resolved || "null"}`);
  for (const line of formatCodexDiagnosticLines(diagnostics)) {
    console.log(line);
  }
}

function createCodexPreflightFailure(diagnostics, detail) {
  const code = diagnostics.failure_code || "CODEX_PREFLIGHT_FAILED";
  const error = new Error(
    [
      `${code}: Codex startup preflight failed`,
      detail || null,
      ...formatCodexDiagnosticLines(diagnostics),
    ]
      .filter(Boolean)
      .join("\n")
  );
  error.code = code;
  error.failureStage = "codex_preflight";
  error.codexDiagnostics = diagnostics;
  return error;
}

function buildCodexSpawnCommand(codexResolution, codexArgs) {
  if (!codexResolution || !codexResolution.ok) {
    throw new Error("Codex executable is not resolved");
  }

  if (codexResolution.fileType === "exe") {
    return {
      command: codexResolution.resolvedPath,
      args: codexArgs,
      shell: false,
      fileType: codexResolution.fileType,
    };
  }

  if (codexResolution.fileType === "cmd" || codexResolution.fileType === "bat") {
    const commandLine = [codexResolution.resolvedPath, ...codexArgs]
      .map(quoteWindowsCmdArg)
      .join(" ");
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
      shell: false,
      fileType: codexResolution.fileType,
    };
  }

  throw new Error(`Unsupported Codex executable file type: ${codexResolution.fileType}`);
}

function formatCodexSpawnError(error, commandInfo) {
  const details = {
    failure_code: error && error.code === "EPERM" ? "CODEX_SPAWN_EPERM" : "CODEX_SPAWN_FAILED",
    error_code: error && error.code ? error.code : null,
    errno: error && Object.prototype.hasOwnProperty.call(error, "errno") ? error.errno : null,
    syscall: error && error.syscall ? error.syscall : null,
    resolved_executable:
      commandInfo && commandInfo.codexResolution
        ? sanitizeSpawnValue(commandInfo.codexResolution.resolvedPath)
        : null,
    file_type:
      commandInfo && commandInfo.codexResolution
        ? commandInfo.codexResolution.fileType
        : null,
    command: commandInfo ? sanitizeSpawnValue(commandInfo.command) : null,
    spawnargs: commandInfo ? sanitizeSpawnArgs(commandInfo.args) : [],
  };

  return Object.entries(details)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${Array.isArray(value) ? JSON.stringify(value) : value}`)
    .join(" ");
}

function spawnCodexProcess(codexArgs, options = {}) {
  const codexResolution = getCodexExecutionResolution(options);
  if (!codexResolution.ok) {
    const error = new Error(`Codex preflight failed: ${codexResolution.reason}`);
    error.code = codexResolution.reason;
    error.codexResolution = codexResolution;
    throw error;
  }

  const commandInfo = buildCodexSpawnCommand(codexResolution, codexArgs);
  commandInfo.codexResolution = codexResolution;

  try {
    const spawnFactory = options.spawnFactory || spawn;
    const child = spawnFactory(commandInfo.command, commandInfo.args, {
      shell: false,
      windowsHide: true,
      stdio: options.stdio || ["pipe", "pipe", "pipe"],
      env: {
        ...sanitizeWindowsEnv(process.env),
        CI: "1",
        NO_COLOR: "1",
      },
    });
    child.codexCommandInfo = commandInfo;
    return child;
  } catch (error) {
    error.codexCommandInfo = commandInfo;
    throw error;
  }
}

function createCodexTransportError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.failureStage =
    code === "CODEX_STDIN_TRANSPORT_FAILED"
      ? "codex_stdin_transport"
      : code === "CODEX_TIMEOUT"
      ? "codex_timeout"
      : code === "CODEX_PROCESS_CLOSE_TIMEOUT"
      ? "codex_process_close_timeout"
      : code === "CODEX_PROCESS_EXIT_FAILED"
      ? "codex_process_exit"
      : "codex_spawn";
  Object.assign(error, details);
  return error;
}

function formatCodexStdinDiagnostic(details = {}) {
  return [
    `failure_code=${details.failure_code || "CODEX_STDIN_TRANSPORT_FAILED"}`,
    `failure_stage=${details.failure_stage || "codex_stdin_transport"}`,
    details.error_code ? `error_code=${details.error_code}` : null,
    details.errno !== null && details.errno !== undefined ? `errno=${details.errno}` : null,
    details.syscall ? `syscall=${details.syscall}` : null,
    details.resolved_executable ? `resolved_executable=${sanitizeSpawnValue(details.resolved_executable)}` : null,
    Number.isFinite(details.prompt_bytes) ? `prompt_bytes=${details.prompt_bytes}` : null,
    Number.isFinite(details.retry_number) ? `retry_number=${details.retry_number}` : null,
    "stdin_transport=true",
  ]
    .filter(Boolean)
    .join(" ");
}

function createCodexOutputCapture(label = "codex") {
  const dir = path.join(os.tmpdir(), "city-partner-worker-codex");
  fs.mkdirSync(dir, { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const stdoutPath = path.join(dir, `${label}-${suffix}.out.log`);
  const stderrPath = path.join(dir, `${label}-${suffix}.err.log`);
  const stdoutFd = fs.openSync(stdoutPath, "a+");
  const stderrFd = fs.openSync(stderrPath, "a+");

  return {
    stdoutPath,
    stderrPath,
    stdoutFd,
    stderrFd,
    stdio: ["ignore", stdoutFd, stderrFd],
  };
}

function closeCodexOutputCapture(capture) {
  for (const fd of [capture && capture.stdoutFd, capture && capture.stderrFd]) {
    if (typeof fd === "number") {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
}

function runCodexPreflight(options = {}) {
  return new Promise((resolve) => {
    const codexResolution = options.codexResolution || resolveCodexExecutable(options);
    if (!codexResolution.ok) {
      resolve({
        ok: false,
        codexResolution,
        error: codexResolution.reason,
        code: codexResolution.reason,
      });
      return;
    }

    const mode = String(options.mode || "version").toLowerCase();
    if (mode === "smoke") {
      const timeoutMs = Number(options.timeoutMs || 30000);
      const prompt = [
        `Return exactly ${CODEX_PREFLIGHT_OK}`,
        "Do not modify files.",
        "Do not run Git.",
        "Do not open a browser.",
        "Do not start a dev server.",
      ].join("\n");
      spawnCodexWithStdin(
        prompt,
        {
          request_text: [
            "CODEX_WORKER_PREFLIGHT",
            "project_domain=automation_system",
            "task_mode=read_only",
            "read_only_mode=true",
            "forbidden_scope=file writes, git, browser, dev server",
          ].join("\n"),
        },
        {
          codexResolution,
          spawnFactory: options.spawnFactory,
          timeoutMs,
          idleTimeoutMs: timeoutMs,
          heartbeat: false,
          mirrorOutput: false,
          retryNumber: 0,
        }
      )
        .then((stdout) => {
          const trimmed = String(stdout || "").trim();
          const ok = trimmed === CODEX_PREFLIGHT_OK;
          resolve({
            ok,
            codexResolution,
            exitCode: ok ? 0 : 1,
            stdout: trimmed.slice(0, 500),
            stderr: "",
            error: ok
              ? null
              : `codex smoke preflight expected ${CODEX_PREFLIGHT_OK}`,
            code: ok ? null : "CODEX_PREFLIGHT_FAILED",
          });
        })
        .catch((error) => {
          resolve({
            ok: false,
            codexResolution,
            error: error && error.message ? error.message : String(error),
            code: "CODEX_PREFLIGHT_FAILED",
            raw_code: error && error.code ? error.code : null,
          });
        });
      return;
    }

    const codexArgs = ["--version"];

    let child;
    let capture;
    try {
      capture = createCodexOutputCapture("codex-preflight");
      child = spawnCodexProcess(codexArgs, {
        codexResolution,
        stdio: capture.stdio,
        spawnFactory: options.spawnFactory,
      });
    } catch (error) {
      if (capture) closeCodexOutputCapture(capture);
      resolve({
        ok: false,
        codexResolution,
        error: error && error.message ? error.message : String(error),
        code: "CODEX_PREFLIGHT_FAILED",
        raw_code: error && error.code ? error.code : null,
        diagnostic: formatCodexSpawnError(error, error && error.codexCommandInfo),
      });
      return;
    }

    const timeoutMs = Number(options.timeoutMs || 30000);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      closeCodexOutputCapture(capture);
      resolve({
        ok: false,
        codexResolution,
        error: `codex preflight ${mode} timed out after ${timeoutMs}ms`,
        code: "CODEX_PREFLIGHT_FAILED",
      });
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      closeCodexOutputCapture(capture);
      resolve({
        ok: false,
        codexResolution,
        error: error && error.message ? error.message : String(error),
        code: "CODEX_PREFLIGHT_FAILED",
        raw_code: error && error.code ? error.code : null,
        diagnostic: formatCodexSpawnError(error, error && error.codexCommandInfo),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      closeCodexOutputCapture(capture);
      const stdout = fs.existsSync(capture.stdoutPath)
        ? fs.readFileSync(capture.stdoutPath, "utf8")
        : "";
      const stderr = fs.existsSync(capture.stderrPath)
        ? fs.readFileSync(capture.stderrPath, "utf8")
        : "";
      resolve({
        ok: code === 0,
        codexResolution,
        exitCode: code,
        stdout: stdout.trim().slice(0, 500),
        stderr: stderr.trim().slice(0, 1000),
        error: code === 0 ? null : `codex preflight ${mode} exited with ${code}`,
        code: code === 0 ? null : "CODEX_PREFLIGHT_FAILED",
      });
    });
  });
}

async function runCodexStartupPreflight(options = {}) {
  const versionResult = await runCodexPreflight({
    ...options,
    mode: "version",
  });
  const version = String(versionResult.stdout || "").trim().split(/\r?\n/)[0] || "";

  if (!versionResult.ok) {
    const diagnostics = buildCodexDiagnostics(versionResult.codexResolution, {
      version,
      preflightStatus: "failed",
      failureCode:
        versionResult.codexResolution?.reason ||
        versionResult.code ||
        "CODEX_PREFLIGHT_FAILED",
    });
    codexStartupDiagnostics = diagnostics;
    codexResolvedExecutableState = versionResult.codexResolution || null;
    logCodexStartupDiagnostics(diagnostics);
    throw createCodexPreflightFailure(diagnostics, versionResult.error);
  }

  const smokeResult = await runCodexPreflight({
    ...options,
    mode: "smoke",
    codexResolution: versionResult.codexResolution,
  });

  if (!smokeResult.ok) {
    const diagnostics = buildCodexDiagnostics(versionResult.codexResolution, {
      version,
      preflightStatus: "failed",
      failureCode: smokeResult.code || "CODEX_PREFLIGHT_FAILED",
    });
    codexStartupDiagnostics = diagnostics;
    codexResolvedExecutableState = versionResult.codexResolution;
    logCodexStartupDiagnostics(diagnostics);
    throw createCodexPreflightFailure(diagnostics, smokeResult.error);
  }

  const diagnostics = buildCodexDiagnostics(versionResult.codexResolution, {
    version,
    preflightStatus: "passed",
    failureCode: null,
  });
  codexStartupDiagnostics = diagnostics;
  codexResolvedExecutableState = versionResult.codexResolution;
  logCodexStartupDiagnostics(diagnostics);
  return diagnostics;
}

function redactWorkerUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch (_) {
    return String(value || "").replace(/([?&](?:token|authorization|key|secret)=)[^&]+/gi, "$1[redacted]");
  }
}

function classifyWorkerFetchError(error) {
  const cause = error && error.cause ? error.cause : null;
  const code = String(
    (cause && (cause.code || cause.errno)) ||
      (error && (error.code || error.name)) ||
      ""
  );
  const message = String(error && error.message ? error.message : error || "");

  if (/AbortError|timeout|timed out/i.test([code, message].join(" "))) {
    return "timeout";
  }
  if (/ENOTFOUND|EAI_AGAIN|dns/i.test(code) || /getaddrinfo/i.test(message)) {
    return "dns_failure";
  }
  if (/ECONNREFUSED/i.test(code)) {
    return "connection_refused";
  }
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|socket/i.test([code, message].join(" "))) {
    return "tcp_connection_reset";
  }
  if (/CERT|TLS|SSL|certificate/i.test([code, message].join(" "))) {
    return "tls_failure";
  }
  if (/HTTP\s+\d{3}/i.test(message)) {
    return "http_error";
  }
  if (/JSON|Unexpected token|Unexpected end/i.test(message)) {
    return "json_parse_failure";
  }
  if (/fetch failed/i.test(message)) {
    return "network_fetch_failed";
  }
  return "unknown";
}

function formatWorkerFetchError(error) {
  const cause = error && error.cause ? error.cause : null;
  const details = {
    type: classifyWorkerFetchError(error),
    name: error && error.name ? error.name : null,
    message: error && error.message ? error.message : String(error),
    cause_name: cause && cause.name ? cause.name : null,
    cause_code: cause && cause.code ? cause.code : null,
    cause_errno: cause && cause.errno ? cause.errno : null,
    cause_syscall: cause && cause.syscall ? cause.syscall : null,
    cause_address: cause && cause.address ? cause.address : null,
    cause_port: cause && cause.port ? cause.port : null,
    method: error && error.workerRequest ? error.workerRequest.method : null,
    url: error && error.workerRequest ? redactWorkerUrl(error.workerRequest.url) : null,
    timeout_ms: error && error.workerRequest ? error.workerRequest.timeoutMs : null,
  };

  return Object.entries(details)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function getWorkerPollBackoffMs(consecutiveFailures) {
  if (consecutiveFailures <= 0) return POLL_INTERVAL_MS;
  const exponent = Math.min(consecutiveFailures - 1, 5);
  return Math.min(WORKER_POLL_BACKOFF_MAX_MS, POLL_INTERVAL_MS * 2 ** exponent);
}

async function request(path, options = {}) {
  const url = `${WORKER_API_URL}${path}`;
  const method = String(options.method || "GET").toUpperCase();
  const timeoutMs = Number(options.timeoutMs || WORKER_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
      headers: {
        Authorization: `Bearer ${WORKER_AUTH}`,
        "Content-Type": "application/json",
        "X-Worker-Id": WORKER_NAME,
        "X-Worker-Name": WORKER_NAME,
        ...(options.headers || {}),
      },
    });

    return response;
  } catch (error) {
    if (error && typeof error === "object") {
      error.workerRequest = {
        method,
        url,
        timeoutMs,
      };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendHeartbeat(jobId, attemptId = null) {
  if (isTerminalReportLockedForJob(jobId)) {
    return { ok: true, skipped: "terminal_report_locked" };
  }

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
    if (
      recordPostCompletionTransportWarning(
        { status: response.status, text },
        "worker_heartbeat",
        jobId
      )
    ) {
      return { ok: true, warning: "post_completion_transport_warning" };
    }
    throw new Error(
      `心跳上报失败 HTTP ${response.status}: ${text}`
    );
  }

  return { ok: true };
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
      if (recordPostCompletionTransportWarning(error, "worker_heartbeat", jobId)) {
        return;
      }
      console.error(
        `任务 ${jobId} 心跳失败：`,
        error instanceof Error ? error.message : error
      );
    }
  };

  send();

  const timer = setInterval(send, 60 * 1000);

  return registerTerminalTimerStopper("heartbeat", () => {
    stopped = true;
    clearInterval(timer);
  });
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
  assertGitOperationAllowed(args, options);
  return runCommand("git", args, PROJECT_DIR, options);
}

function sanitizeGitErrorMessage(message) {
  return String(message || "")
    .replace(/https:\/\/[^@\s]+@/gi, "https://<redacted>@")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted>")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "<redacted>");
}

function sanitizeCodexFailureDetail(message) {
  const text = sanitizeGitErrorMessage(message)
    .replace(/Authorization\s*:\s*Bearer\s+[^\s,}]+/gi, "Authorization: Bearer [redacted]")
    .replace(/\b(token|secret|key|password)\b\s*[:=]\s*[^\s,}]+/gi, "$1=[redacted]")
    .replace(/\b[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*\b\s*[:=]\s*[^\s,}]+/gi, "[redacted_secret]=[redacted]")
    .replace(/([?&](?:token|key|secret|access_token|api_key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, "[redacted private key]")
    .trim();

  return text.length > 1200 ? text.slice(0, 1200) : text;
}

function isCodexUsageLimitText(value) {
  return CODEX_USAGE_LIMIT_PATTERN.test(String(value || ""));
}

function toCodexUsageLimitError(value) {
  const raw = value instanceof Error ? value.message : String(value || "");
  if (!isCodexUsageLimitText(raw)) return null;

  const detail = sanitizeCodexFailureDetail(raw);
  const error = new Error([CODEX_USAGE_LIMIT, detail].filter(Boolean).join("\n"));
  error.code = CODEX_USAGE_LIMIT;
  error.failureStage = "codex_execution";
  error.failureDetail = detail || CODEX_USAGE_LIMIT;
  return error;
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

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decodeOriginalRequestTextBase64(value) {
  const raw = readString(value);
  if (!raw) return "";

  const compact = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return "";
  }

  try {
    const decoded = Buffer.from(compact, "base64").toString("utf8");
    const encodedAgain = Buffer.from(decoded, "utf8")
      .toString("base64")
      .replace(/=+$/g, "");
    if (encodedAgain !== compact.replace(/=+$/g, "")) {
      return "";
    }
    return decoded.trim();
  } catch (_) {
    return "";
  }
}

const NO_FIX_APPLIED = "NO_FIX_APPLIED";
const READ_ONLY_MODE_VIOLATION = "READ_ONLY_MODE_VIOLATION";
const OUT_OF_SCOPE_BUSINESS_CHANGE = "OUT_OF_SCOPE_BUSINESS_CHANGE";
const OUT_OF_SCOPE_SYSTEM_CHANGE = "OUT_OF_SCOPE_SYSTEM_CHANGE";
const ORIGINAL_BATCH_CONTEXT_MISSING = "ORIGINAL_BATCH_CONTEXT_MISSING";
const TASK_MODE_MISMATCH = "TASK_MODE_MISMATCH";
const EXPLICIT_TASK_MODE_OVERRIDDEN = "EXPLICIT_TASK_MODE_OVERRIDDEN";
const EXPLICIT_PROJECT_DOMAIN_OVERRIDDEN = "EXPLICIT_PROJECT_DOMAIN_OVERRIDDEN";
const MISSING_REQUIRED_DOCS = "MISSING_REQUIRED_DOCS";
const INSUFFICIENT_DOC_OUTPUT = "INSUFFICIENT_DOC_OUTPUT";
const INCOMPLETE_QA_REPORT = "INCOMPLETE_QA_REPORT";
const INCOMPLETE_ARCHITECTURE_REPORT = "INCOMPLETE_ARCHITECTURE_REPORT";
const WORKER_READONLY_CONTEXT_INCOMPLETE = "WORKER_READONLY_CONTEXT_INCOMPLETE";
const CONTEXT_MISSING_WARNING = "CONTEXT_MISSING_WARNING";
const CANONICAL_WORKER_REPORT_SCHEMA_VERSION = 2;
const CODEX_USAGE_LIMIT = "CODEX_USAGE_LIMIT";

const TASK_MODES = {
  READ_ONLY: "read_only",
  MANAGER_READ_ONLY: "manager_read_only",
  WORKER_READ_ONLY: "worker_read_only",
  DOCS_WRITE_ALLOWED: "docs_write_allowed",
  AUTOMATION_SYSTEM_WRITE_ALLOWED: "automation_system_write_allowed",
  PRODUCT_WRITE_ALLOWED: "product_write_allowed",
};
const SYSTEM_REPAIR_BATCH_PREFIX = "BATCH-ARCH-COMPLETE";
const SYSTEM_REPAIR_TASK_TYPE = "system_repair";
const SYSTEM_REPAIR_SCOPE = [
  "src/app/api/feishu/event/route.ts",
  "src/lib/project-director-console.ts",
  "src/lib/worker-jobs.ts",
  "infra/windows-worker/local_worker.js",
  "infra/windows-worker/tests/git-safety.test.js",
  "infra/windows-worker/tests/worker-attempt-lifecycle.test.mjs",
  "infra/windows-worker/tests/worker-diagnostics-contract.test.mjs",
];
const SYSTEM_REPAIR_SCOPE_TEXT = SYSTEM_REPAIR_SCOPE.join(", ");

const PRODUCT_WRITE_ALLOWED_SCOPE_TEXT =
  "src/app/**, docs/NEXT_TASK_CARD.md, docs/projects/city-partner-website.md";

const TASK_MUTATION_PATTERN =
  /修复|新增|更新|补齐|建立|修改|改动|创建|写入|补充|fix|repair|add|create|update|modify|patch|implement/i;
const READ_ONLY_TASK_PATTERN =
  /read[_ -]?only(?:[_ -]?mode)?\s*(?::|=)?\s*(?:true|1|yes|on)?|只读模式|本任务只读|只读执行|只读检查|只读诊断|只读验证|不修改(?:任何)?(?:文件|代码|仓库|项目)?|禁止修改(?:任何)?(?:文件|代码|仓库|项目)?|禁止\s*(?:执行\s*)?(?:git\s+)?(?:add|commit|push)\b/i;
const READ_ONLY_POLICY_IMPLEMENTATION_PATTERN =
  /只读任务锁死|强制\s*read[_ -]?only[_ -]?mode|read[_ -]?only(?:[_ -]?mode)?.*(?:lock|guard)/i;
const QA_BATCH_PATTERN = /\bBATCH-QA(?:-[A-Z0-9]+)*\b/i;
const ARCH_BATCH_PATTERN = /\bBATCH-ARCH(?:-[A-Z0-9]+)*\b/i;
const AUTOMATION_CONTEXT_PATTERN =
  /Worker|Codex|Hermes|飞书|总管|自动化|worker|worker_api|feishu_gateway|route|路由|上报|NO_FIX_APPLIED|READ_ONLY_MODE_VIOLATION|git_commit_sha|attempt_id/i;
const DOCS_WRITE_TASK_PATTERN =
  /\bBATCH-37-(?:DOCS(?:-[A-Z0-9]+)*|FIX)\b|docs_write_allowed/i;
const DOCS_WRITE_TARGET_PATTERN = /\bdocs\//i;
const AUTOMATION_WRITE_TASK_PATTERN =
  /\bBATCH-44\b|\bBATCH-45A\b|automation_system_write_allowed|Worker|Windows Worker|Gateway|worker-api|worker_api|feishu_gateway|project-director|project director|project-director-console|worker-jobs|local_worker|git-safety/i;
const PRODUCT_WRITE_TASK_PATTERN =
  /product_write_allowed|产品开发|业务页面开发|同城搭子.*(?:页面|产品|业务)/i;
const BATCH_FIX_PATTERN = /\bBATCH-FIX(?:-[A-Z0-9]+)*\b/i;
const BATCH_FIX_PRODUCT_SIGNAL_PATTERN =
  /同城搭子网站|partners|\/partners|\/post|login|profile|page\.tsx|src\/app|产品页面|产品修复|QA\s*发现|首页|发布页|搭子浏览|详情页|product\s+repair|product\s+page/i;
const READ_ONLY_BATCH_PATTERN = /\bBATCH-43\b|\bBATCH-GM-SMOKE(?:-\d+)?\b/i;
const FORCED_READ_ONLY_BATCH_PATTERN =
  /\bBATCH-QA(?:-[A-Z0-9]+)*\b|\bBATCH-43\b|\bBATCH-GM-SMOKE(?:-\d+)?\b/i;
const ARCHITECTURE_SMOKE_REPORT_TASK_PATTERN =
  /\bSMOKE\b|ARCH_REPORT_FIELDS|架构烟测|烟测/i;
const FORBIDDEN_SECTION_PATTERN =
  /禁止|不修改|不得|不允许|forbidden(?:[_\s-]*scope)?|do\s+not|don't|must\s+not|not\s+(?:modify|change|read|touch)/i;
const BATCH_RELEVANT_LINE_PATTERN =
  /标题|title|修复目标|目标|批准|approved|approval|执行批次|当前批次/i;
const BATCH_FORBIDDEN_FRAGMENT_PATTERN = /禁止范围|禁止修改|不得|不允许|forbidden|不执行/i;
const BATCH_FORBIDDEN_SECTION_HEADING_PATTERN =
  /^\s*(?:[-*#>\d.、\s]*)?(?:【)?(?:禁止范围|禁止修改|forbidden)(?:】)?\s*[:：]?\s*$/i;
const BATCH_FORBIDDEN_SECTION_EXIT_PATTERN =
  /标题|title|修复目标|(^|\s)目标\s*[:：]|批准|approved|approval|执行批次|当前执行批次/i;
const REQUIRED_FILE_SECTION_PATTERN =
  /输出文件|目标文件|指定文件|修复目标|repair\s+target|必须(?:修改|新增|更新|创建)|要求(?:修改|新增|更新|创建)|需要(?:修改|新增|更新|创建)|请(?:修改|新增|更新|创建)|修复文件|required(?:[_\s-]*(?:changed|change))?[_\s-]*paths?|required files?|output files?|target files?/i;
const ALLOWED_ONLY_SECTION_PATTERN =
  /允许修改|只允许修改|allowed(?:[_\s-]*scope| files?)?|editable files?/i;
const BATCH_CODE_PATTERN = /\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/gi;
const CODEX_USAGE_LIMIT_PATTERN =
  /You've hit your usage limit|usage limit|purchase more credits|try again at/i;
const DOCS_WRITE_ALLOWED_PREFIXES = ["docs/"];
const BATCH_37_REQUIRED_DOCS = [
  "docs/projects/reusable-assets.md",
  "docs/projects/modification-needed.md",
  "docs/projects/team-management.md",
  "docs/projects/qa-handoff-process.md",
  "docs/projects/operations-team-plan.md",
  "docs/projects/agent-expansion-plan.md",
  "docs/NEXT_TASK_CARD.md",
];
const QA_READ_ONLY_ALLOWED_READS = [
  "src/app/page.tsx",
  "src/app/partners/**",
  "src/app/post/**",
  "src/app/login/**",
  "src/app/profile/**",
  "src/lib/db/mock.ts",
  "src/types/db.ts",
  "docs/**",
  "package.json",
  "next.config.*",
  "tsconfig.json",
];
const QA_REPORT_REQUIRED_FIELDS = [
  {
    key: "currently_usable_features",
    label: "当前能直接用的功能",
    pattern: /当前能直接(?:用|使用)的功能|能直接(?:用|使用)的功能|currently usable features/i,
  },
  {
    key: "features_needing_fixes",
    label: "当前需要修的功能",
    pattern: /当前需要(?:修|修复)的功能|需要(?:修|修复)的功能|features needing fixes/i,
  },
  {
    key: "home_page_acceptance",
    label: "首页验收结论",
    pattern: /首页验收结论|首页.*验收|首页\s*[:：]\s*(?:通过|不通过|warning|需修复)|home page acceptance/i,
  },
  {
    key: "partners_page_acceptance",
    label: "搭子浏览页验收结论",
    pattern: /搭子浏览页验收结论|搭子浏览页.*验收|搭子浏览页\s*[:：]\s*(?:通过|不通过|warning|需修复)|partners page acceptance/i,
  },
  {
    key: "post_page_acceptance",
    label: "发布页验收结论",
    pattern: /发布页验收结论|发布页.*验收|发布页\s*[:：]\s*(?:通过|不通过|warning|需修复)|post page acceptance/i,
  },
  {
    key: "draft_review_flow_acceptance",
    label: "本地草稿 / 待审核流程验收结论",
    pattern: /本地草稿\s*\/?\s*待审核流程验收结论|本地草稿\s*\/?\s*待审核流程\s*[:：]|本地草稿.*待审核.*验收|draft.*review.*acceptance/i,
  },
  {
    key: "login_profile_warning",
    label: "登录页和个人中心 warning 说明",
    pattern: /登录页和个人中心\s*warning\s*说明|登录页\s*\/\s*个人中心\s*warning|登录页.*个人中心.*warning|login.*profile.*warning/i,
  },
  {
    key: "dev_team_next_steps",
    label: "开发团队下一步建议",
    pattern: /开发团队下一步建议|开发团队\s*[:：]|下一步建议[\s\S]*开发团队\s*[:：]|dev team next steps/i,
  },
  {
    key: "qa_team_next_steps",
    label: "测试审核团队下一步建议",
    pattern: /测试审核团队下一步建议|测试审核团队\s*[:：]|测试.*审核.*下一步|下一步建议[\s\S]*测试审核团队\s*[:：]|qa team next steps/i,
  },
  {
    key: "operations_team_join",
    label: "运营团队是否可以加入",
    pattern: /运营团队是否可以加入|运营团队\s*[:：]\s*(?:暂不建议加入|可以加入|不建议加入|建议加入)|运营团队.*可以加入|operations team.*join/i,
  },
  {
    key: "next_batch_recommendation",
    label: "下一批建议从哪个 BATCH 开始",
    pattern: /下一批建议从哪个\s*BATCH\s*开始|下一批建议.*BATCH|next batch/i,
  },
];
const QA_REPORT_MACHINE_FIELDS = [
  {
    key: "current_usable_features",
    label: "current_usable_features",
    pattern: /^(yes|no)$/i,
  },
  {
    key: "current_fix_needed",
    label: "current_fix_needed",
    pattern: /^(yes|no)$/i,
  },
  {
    key: "homepage_verdict",
    label: "homepage_verdict",
    pattern: /^(pass|fail|warning)$/i,
  },
  {
    key: "partners_verdict",
    label: "partners_verdict",
    pattern: /^(pass|fail|warning)$/i,
  },
  {
    key: "post_verdict",
    label: "post_verdict",
    pattern: /^(pass|fail|warning)$/i,
  },
  {
    key: "local_draft_review_verdict",
    label: "local_draft_review_verdict",
    pattern: /^(pass|fail|warning)$/i,
  },
  {
    key: "login_profile_warning",
    label: "login_profile_warning",
    pattern: /^(yes|no)$/i,
  },
  {
    key: "dev_team_next_step",
    label: "dev_team_next_step",
    pattern: /^(yes|no)$/i,
  },
  {
    key: "qa_team_next_step",
    label: "qa_team_next_step",
    pattern: /^(yes|no)$/i,
  },
  {
    key: "ops_team_join",
    label: "ops_team_join",
    pattern: /^(yes|no)$/i,
  },
  {
    key: "next_batch",
    label: "next_batch",
    pattern: /^BATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*$/i,
  },
];
const ARCHITECTURE_REPORT_REQUIRED_FIELDS = [
  {
    key: "architecture_inventory_conclusion",
    label: "架构盘点结论",
    pattern: /架构盘点结论|architecture (?:inventory|review|audit) conclusion/i,
  },
  {
    key: "missing_modules",
    label: "缺失模块清单",
    pattern: /缺失模块清单|missing modules?/i,
  },
  {
    key: "knowledge_base_status",
    label: "知识库现状判断",
    pattern: /知识库现状判断|knowledge base (?:status|assessment)/i,
  },
  {
    key: "automation_iteration_status",
    label: "自动迭代能力现状判断",
    pattern: /自动迭代能力现状判断|automation iteration (?:status|capability|assessment)/i,
  },
  {
    key: "batch_arch_plan",
    label: "BATCH-ARCH-02 到 BATCH-ARCH-10 的分批计划",
    pattern:
      /BATCH-ARCH-02[\s\S]*BATCH-ARCH-10|BATCH-ARCH-10[\s\S]*BATCH-ARCH-02|BATCH-ARCH-02[\s\S]*分批计划|分批计划[\s\S]*BATCH-ARCH-02/i,
  },
];
const ARCH_REPORT_MACHINE_FIELDS = [
  {
    key: "final_report_status",
    label: "final_report_status",
    pattern: /^succeeded$/i,
  },
  {
    key: "no_fix_applied",
    label: "no_fix_applied",
    pattern: /^false$/i,
  },
  {
    key: "read_only_violation",
    label: "read_only_violation",
    pattern: /^false$/i,
  },
  {
    key: "task_mode_mismatch",
    label: "task_mode_mismatch",
    pattern: /^false$/i,
  },
  {
    key: "out_of_scope_business_change",
    label: "out_of_scope_business_change",
    pattern: /^false$/i,
  },
];
const AUTOMATION_WRITE_ALLOWED_PATHS = [
  "infra/windows-worker",
  "src/lib/worker-jobs.ts",
  "src/app/api/feishu/event/route.ts",
  "src/lib/project-director-console.ts",
  "docs/projects/feishu-gm-automation.md",
  "docs/projects/team-routing.md",
  "docs/projects/feishu-group-routing.md",
];
const AUTOMATION_ALLOWED_SCOPE_DOC_PREFIXES = [
  "docs/architecture/",
  "docs/projects/",
];
const AUTOMATION_ALLOWED_SCOPE_DOC_FILES = [
  "docs/BATCH_LOG.md",
  "docs/ACCEPTANCE_LOG.md",
  "docs/NEXT_TASK_CARD.md",
];
const AUTOMATION_ALLOWED_SCOPE_WILDCARDS = [
  "infra/windows-worker/**",
  "docs/architecture/**",
];
const PRODUCT_WRITE_ALLOWED_PREFIXES = ["src/app"];
const BATCH_FIX_PRODUCT_ALLOWED_PATHS = [
  "src/app",
  "docs/NEXT_TASK_CARD.md",
  "docs/projects/city-partner-website.md",
];
const SYSTEM_CHANGE_FORBIDDEN_PATHS = [
  "infra/windows-worker",
  "src/lib/worker-jobs.ts",
  "src/app/api/feishu",
  "src/lib/project-director-console.ts",
  "work/tencent-cloud",
];
const BUSINESS_PAGE_PREFIXES = [
  "app",
  "app/page.tsx",
  "app/post",
  "app/partners",
  "src/app/page.tsx",
  "src/app/post",
  "src/app/partners",
  "src/app/login",
  "src/app/profile",
];
const DATABASE_OR_ENV_PREFIXES = [
  ".env",
  "supabase",
  "prisma",
  "docs/setup-supabase.sql",
  "docs/setup-hermes-jobs.sql",
  "docs/setup-hermes-v2-schema.sql",
  "src/lib/db",
  "src/types/db.ts",
];

const FAILURE_FINGERPRINTS = {
  QA_TASK_MODE_MISMATCH:
    "BATCH-QA-* was misclassified as automation_system_write_allowed.",
  DOCS_INSUFFICIENT_OUTPUT:
    "BATCH-37-DOCS-* only changed feishu-gm-automation.md.",
  READ_ONLY_LOCKED_DOCS:
    "docs_write_allowed was locked by read_only_mode=true.",
  PATH_PARSE_FIRST_CHAR_LOSS:
    "git status path lost its first character.",
  FALSE_SUCCEEDED:
    "Task goal was incomplete but reported succeeded.",
  QA_REPORT_FIELD_MATCH_TOO_STRICT:
    "QA report content was present, but field matching was too strict and caused INCOMPLETE_QA_REPORT.",
  QA_REPORT_NATURAL_LANGUAGE_MATCH_UNSTABLE:
    "QA report natural language was complete but unstable to match; prefer QA_REPORT_FIELDS.",
  BATCH_FIX_PRODUCT_MISROUTED_TO_AUTOMATION:
    "BATCH-FIX product repair was misrouted to automation/docs_write_allowed and changed system files instead of product pages.",
  BATCH_FIX_PRODUCT_MISCLASSIFIED_AS_AUTOMATION_SYSTEM:
    "BATCH-FIX product repair was classified as automation_system during the new-demand classification stage.",
  EXPLICIT_TASK_MODE_OVERRIDDEN:
    "Explicit boss task_mode was overwritten by automatic routing or historical job fields.",
  TASK_MODE_EXPLICIT_READ_ONLY_OVERRIDE:
    "Explicit read_only task fields overrode product/background wording and forced read_only mode.",
  ORIGINAL_BATCH_CONTEXT_MISSING:
    "Approved execution referenced a BATCH-FIX batch without carrying the original product repair request.",
};

const TRUE_TASK_FAILURE_CODES = new Set([
  "NO_FIX_APPLIED",
  "READ_ONLY_MODE_VIOLATION",
  "TASK_MODE_MISMATCH",
  "MISSING_REQUIRED_DOCS",
  "INSUFFICIENT_DOC_OUTPUT",
  "INCOMPLETE_QA_REPORT",
  "INCOMPLETE_ARCHITECTURE_REPORT",
  "WORKER_READONLY_CONTEXT_INCOMPLETE",
  "TEST_FAILED",
  "TYPESCRIPT_FAILED",
  "OUT_OF_SCOPE_CHANGE",
  "CONTEXT_RECONSTRUCT_FAILED",
  "GIT_COMMIT_FAILED",
  "GIT_PUSH_FAILED",
  "GIT_SYNC_FAILED",
]);

const NON_TASK_FAILURE_CODES = new Set([
  "FEISHU_RATE_LIMIT",
  "FEISHU_SEND_FAILED",
  "BITABLE_RECORD_MISSING",
  "BITABLE_SYNC_FAILED",
  "DUPLICATE_REPORT",
  "PROGRESS_REPORT_FAILED",
]);

const NON_TASK_FAILURE_PATTERNS = [
  {
    code: "FEISHU_RATE_LIMIT",
    pattern: /(?:feishu|飞书|bitable|多维表).*(?:rate|limit|429|限流)|(?:HTTP\s*)?429|too many requests/i,
  },
  {
    code: "FEISHU_SEND_FAILED",
    pattern: /(?:feishu|飞书).*(?:send|发送).*(?:fail|failed|失败)|飞书发送失败/i,
  },
  {
    code: "BITABLE_RECORD_MISSING",
    pattern: /bitable_record_id.*(?:missing|null|缺失)|(?:missing|缺失).*bitable_record_id|skipped_no_record_id/i,
  },
  {
    code: "BITABLE_SYNC_FAILED",
    pattern: /(?:bitable|多维表).*(?:sync|同步).*(?:fail|failed|失败)|feishu-worker-sync.*failed/i,
  },
  {
    code: "DUPLICATE_REPORT",
    pattern: /duplicate report|terminal_job_report_ignored|idempotent.*report|重复\s*report|重复上报/i,
  },
  {
    code: "PROGRESS_REPORT_FAILED",
    pattern: /progress.*(?:report|上报).*(?:fail|failed|失败)|任务进度上报失败|\/api\/worker\/progress/i,
  },
];

const READ_ONLY_BLOCKED_GIT_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "push",
  "checkout",
  "switch",
  "merge",
  "rebase",
  "reset",
]);

function readTextValue(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map(readTextValue).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    return Object.values(value).map(readTextValue).filter(Boolean).join("\n");
  }
  return String(value);
}

function getJobText(job) {
  const payload = job && typeof job.payload === "object" ? job.payload : null;
  const result = job && typeof job.result === "object" ? job.result : null;

  return [
    job?.request_text,
    job?.requestText,
    job?.demand,
    job?.title,
    job?.name,
    job?.original_request_text,
    job?.originalRequestText,
    decodeOriginalRequestTextBase64(job?.original_request_text_base64),
    decodeOriginalRequestTextBase64(job?.originalRequestTextBase64),
    payload?.request_text,
    payload?.requestText,
    payload?.original_request_text,
    payload?.originalRequestText,
    decodeOriginalRequestTextBase64(payload?.original_request_text_base64),
    decodeOriginalRequestTextBase64(payload?.originalRequestTextBase64),
    payload?.demand,
    payload?.title,
    result?.request_text,
    result?.requestText,
    result?.original_request_text,
    result?.originalRequestText,
    decodeOriginalRequestTextBase64(result?.original_request_text_base64),
    decodeOriginalRequestTextBase64(result?.originalRequestTextBase64),
    ].map(readTextValue).filter(Boolean).join("\n");
}

function getExplicitRequestText(job) {
  const payload = job && typeof job.payload === "object" ? job.payload : null;
  const result = job && typeof job.result === "object" ? job.result : null;

  return [
    job?.request_text,
    job?.requestText,
    job?.demand,
    job?.original_request_text,
    job?.originalRequestText,
    decodeOriginalRequestTextBase64(job?.original_request_text_base64),
    decodeOriginalRequestTextBase64(job?.originalRequestTextBase64),
    payload?.request_text,
    payload?.requestText,
    payload?.original_request_text,
    payload?.originalRequestText,
    decodeOriginalRequestTextBase64(payload?.original_request_text_base64),
    decodeOriginalRequestTextBase64(payload?.originalRequestTextBase64),
    payload?.demand,
    result?.original_request_text,
    result?.originalRequestText,
    decodeOriginalRequestTextBase64(result?.original_request_text_base64),
    decodeOriginalRequestTextBase64(result?.originalRequestTextBase64),
  ].map(readTextValue).filter(Boolean).join("\n");
}

function readExplicitFieldFromText(text, fieldName) {
  const pattern = new RegExp(
    `\\b${fieldName.replace(/_/g, "[_\\\\s-]*")}\\s*[:=]\\s*[\\\`'"“”]?([a-z_]+)[\\\`'"“”]?`,
    "gi"
  );
  const matches = [...String(text || "").matchAll(pattern)];
  const match = matches[matches.length - 1];
  return match ? match[1].toLowerCase() : null;
}

function readExplicitTaskModeFromText(text) {
  const taskMode = readExplicitFieldFromText(extractOriginalTaskBody(text), "task_mode");
  return Object.values(TASK_MODES).includes(taskMode) ? taskMode : null;
}

function readExplicitBooleanFieldFromText(text, fieldName) {
  const pattern = new RegExp(
    `\\b${fieldName.replace(/_/g, "[_\\\\s-]*")}\\s*[:=]\\s*[\\\`'"“”]?(true|false|1|0|yes|no|on|off)[\\\`'"“”]?`,
    "gi"
  );
  const matches = [...String(text || "").matchAll(pattern)];
  const match = matches[matches.length - 1];
  if (!match) {
    return null;
  }

  const value = match[1];
  if (readBooleanFlag(value)) {
    return true;
  }
  if (readBooleanFalseFlag(value)) {
    return false;
  }
  return null;
}

function readExplicitReadOnlyModeFromText(text) {
  return readExplicitBooleanFieldFromText(
    extractOriginalTaskBody(text),
    "read_only_mode"
  );
}

function readProjectDomainFromText(text) {
  return readExplicitFieldFromText(extractOriginalTaskBody(text), "project_domain");
}

function readProjectDomainField(job) {
  const payload = job && typeof job.payload === "object" ? job.payload : null;
  const result = job && typeof job.result === "object" ? job.result : null;
  const candidates = [
    job?.project_domain,
    job?.projectDomain,
    payload?.project_domain,
    payload?.projectDomain,
    result?.project_domain,
    result?.projectDomain,
  ];

  for (const candidate of candidates) {
    const value = readString(candidate);
    if (value) return value.toLowerCase();
  }

  return null;
}

function getExplicitTextCandidates(job) {
  const payload = job && typeof job.payload === "object" ? job.payload : null;
  const result = job && typeof job.result === "object" ? job.result : null;

  return [
    job?.request_text,
    job?.requestText,
    job?.demand,
    job?.original_request_text,
    job?.originalRequestText,
    decodeOriginalRequestTextBase64(job?.original_request_text_base64),
    decodeOriginalRequestTextBase64(job?.originalRequestTextBase64),
    payload?.request_text,
    payload?.requestText,
    payload?.original_request_text,
    payload?.originalRequestText,
    decodeOriginalRequestTextBase64(payload?.original_request_text_base64),
    decodeOriginalRequestTextBase64(payload?.originalRequestTextBase64),
    payload?.demand,
    result?.request_text,
    result?.requestText,
    result?.original_request_text,
    result?.originalRequestText,
    decodeOriginalRequestTextBase64(result?.original_request_text_base64),
    decodeOriginalRequestTextBase64(result?.originalRequestTextBase64),
  ].map(readTextValue).filter(Boolean);
}

function readExplicitTextTaskContext(job) {
  const context = {
    taskMode: null,
    projectDomain: null,
    readOnlyMode: null,
  };

  for (const text of getExplicitTextCandidates(job)) {
    if (!context.taskMode) {
      context.taskMode = readExplicitTaskModeFromText(text);
    }
    if (!context.projectDomain) {
      context.projectDomain = readProjectDomainFromText(text);
    }
    if (context.readOnlyMode === null) {
      context.readOnlyMode = readExplicitReadOnlyModeFromText(text);
    }

    if (
      context.taskMode &&
      context.projectDomain &&
      context.readOnlyMode !== null
    ) {
      break;
    }
  }

  return context;
}

function resolveTaskModeFromExplicitTextContext(context) {
  if (
    context.taskMode &&
    (context.readOnlyMode === true ||
      isReadOnlyTaskMode(context.taskMode))
  ) {
    return isReadOnlyTaskMode(context.taskMode)
      ? context.taskMode
      : TASK_MODES.READ_ONLY;
  }

  return context.taskMode || null;
}

function createExplicitFieldOverrideError(code, message, details = {}) {
  const error = new Error(
    [
      code,
      message,
      details.explicitValue ? `explicit_value: ${details.explicitValue}` : null,
      details.finalValue ? `final_value: ${details.finalValue}` : null,
      details.payloadValue ? `payload_value: ${details.payloadValue}` : null,
    ].filter(Boolean).join("\n")
  );
  error.code = code;
  error.failureStage = "explicit task field override validation";
  return error;
}


function hasOriginalRequestContext(job) {
  const payload = job && typeof job.payload === "object" ? job.payload : null;
  const result = job && typeof job.result === "object" ? job.result : null;
  return Boolean(
    readString(job?.original_request_text) ||
      readString(job?.originalRequestText) ||
      readString(payload?.original_request_text) ||
      readString(payload?.originalRequestText) ||
      readString(result?.original_request_text) ||
      readString(result?.originalRequestText)
  );
}

function isApprovedExecutionShellText(text) {
  const raw = String(text || "");
  return /执行项目总管批准批次\s+BATCH-FIX(?:-[A-Z0-9]+)*|批准执行[:：].*BATCH-FIX(?:-[A-Z0-9]+)*|仅批准\s+BATCH-FIX(?:-[A-Z0-9]+)*/i.test(raw);
}

function createOriginalBatchContextMissingError(job) {
  const batchCode = getJobBatchCode(job) || "BATCH-FIX-*";
  const error = new Error(
    [
      ORIGINAL_BATCH_CONTEXT_MISSING,
      `${batchCode} approval shell is missing original_request_text; refusing to execute or infer automation_system.`,
      "Worker task must carry the original 新需求：BATCH-XXX full text before Codex runs.",
      `approved_batch: ${batchCode}`,
    ].join("\n")
  );
  error.code = ORIGINAL_BATCH_CONTEXT_MISSING;
  error.failureStage = "approved batch context validation";
  return error;
}

function assertOriginalBatchContextAvailable(job) {
  const text = [job?.request_text, job?.prompt, job?.description].filter(Boolean).join("\n");
  const batchCode = getJobBatchCode(job);
  if (
    batchCode &&
    BATCH_FIX_PATTERN.test(batchCode) &&
    isApprovedExecutionShellText(text) &&
    !hasOriginalRequestContext(job) &&
    !isBatchFixProductTaskText(text)
  ) {
    throw createOriginalBatchContextMissingError(job);
  }
}

function taskRequiresFileChanges(requestText) {
  return TASK_MUTATION_PATTERN.test(String(requestText || ""));
}

function readBooleanFlag(value) {
  if (value === true) {
    return true;
  }

  if (typeof value === "string") {
    return /^(true|1|yes|on)$/i.test(value.trim());
  }

  if (typeof value === "number") {
    return value === 1;
  }

  return false;
}

function hasReadOnlyField(job) {
  const payload = job && typeof job.payload === "object" ? job.payload : null;
  const result = job && typeof job.result === "object" ? job.result : null;
  const candidates = [
    job?.read_only_mode,
    job?.readOnlyMode,
    job?.readonly,
    job?.read_only,
    payload?.read_only_mode,
    payload?.readOnlyMode,
    payload?.readonly,
    payload?.read_only,
    result?.read_only_mode,
    result?.readOnlyMode,
  ];

  return candidates.some(readBooleanFlag);
}

function readBooleanFalseFlag(value) {
  if (value === false) {
    return true;
  }

  if (typeof value === "string") {
    return /^(false|0|no|off)$/i.test(value.trim());
  }

  if (typeof value === "number") {
    return value === 0;
  }

  return false;
}

function taskTextDeclaresReadOnlyFalse(text) {
  return readExplicitReadOnlyModeFromText(text) === false;
}

function hasReadOnlyFalseField(job) {
  const payload = job && typeof job.payload === "object" ? job.payload : null;
  const result = job && typeof job.result === "object" ? job.result : null;
  const candidates = [
    job?.read_only_mode,
    job?.readOnlyMode,
    job?.readonly,
    job?.read_only,
    payload?.read_only_mode,
    payload?.readOnlyMode,
    payload?.readonly,
    payload?.read_only,
    result?.read_only_mode,
    result?.readOnlyMode,
  ];

  return candidates.some(readBooleanFalseFlag) || taskTextDeclaresReadOnlyFalse(getJobText(job));
}

function taskTextDeclaresReadOnlyMode(text) {
  return readExplicitTaskModeFromText(text) === TASK_MODES.READ_ONLY;
}

function taskTextDeclaresQaReviewDomain(text) {
  return readProjectDomainFromText(text) === "qa_review";
}

function hasConflictingReadOnlyLock(job, taskMode) {
  if (
    taskMode !== TASK_MODES.DOCS_WRITE_ALLOWED &&
    taskMode !== TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED &&
    taskMode !== TASK_MODES.PRODUCT_WRITE_ALLOWED
  ) {
    return false;
  }

  return hasReadOnlyField(job) && !hasReadOnlyFalseField(job);
}

function extractOriginalTaskBody(text) {
  const raw = String(text || "");
  const marker = "【原始任务内容】";
  const markerIndex = raw.lastIndexOf(marker);

  if (markerIndex < 0) {
    return raw;
  }

  const afterMarker = raw.slice(markerIndex + marker.length);
  const stopMarkers = ["【再次强调】", "【Windows Worker 强制规则】"];
  const stopIndex = stopMarkers
    .map((stopMarker) => afterMarker.indexOf(stopMarker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  return (stopIndex >= 0 ? afterMarker.slice(0, stopIndex) : afterMarker).trim();
}

function isReadOnlyPolicyImplementationTask(text) {
  const raw = String(text || "");
  return (
    READ_ONLY_POLICY_IMPLEMENTATION_PATTERN.test(raw) &&
    TASK_MUTATION_PATTERN.test(raw) &&
    AUTOMATION_CONTEXT_PATTERN.test(raw)
  );
}

function isReadOnlyTaskText(text) {
  const raw = String(text || "");
  const originalTaskBody = extractOriginalTaskBody(raw);

  if (isReadOnlyPolicyImplementationTask(originalTaskBody)) {
    return false;
  }

  return READ_ONLY_TASK_PATTERN.test(originalTaskBody);
}

function isReadOnlyTask(jobOrText) {
  if (typeof jobOrText === "string") {
    return isReadOnlyTaskMode(getTaskModeFromText(jobOrText));
  }

  return isReadOnlyTaskMode(getTaskMode(jobOrText));
}

function pathMatchesPrefix(filePath, prefixes) {
  const normalized = normalizeGitPath(filePath);
  return prefixes.some((prefix) => {
    const normalizedPrefix = normalizeGitPath(prefix).replace(/\/+$/g, "");
    return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
  });
}

function getTaskModeFromText(text) {
  const raw = String(text || "");
  const batchCode = getCurrentBatchCodeFromText(raw);

  const explicitTextMode = readExplicitTaskModeFromText(raw);
  const explicitReadOnlyMode = readExplicitReadOnlyModeFromText(raw);
  if (
    explicitTextMode &&
    (explicitReadOnlyMode === true ||
      isReadOnlyTaskMode(explicitTextMode))
  ) {
    return isReadOnlyTaskMode(explicitTextMode)
      ? explicitTextMode
      : TASK_MODES.READ_ONLY;
  }

  if (explicitTextMode) {
    return explicitTextMode;
  }

  if (
    readProjectDomainFromText(raw) === "automation_system" &&
    /(?:requested_mode|final_mode|执行模式)\s*[:：=]\s*write_allowed\b/i.test(raw)
  ) {
    return TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED;
  }

  if (isBatchFixProductTaskText(raw)) {
    return TASK_MODES.PRODUCT_WRITE_ALLOWED;
  }

  if (batchCode && FORCED_READ_ONLY_BATCH_PATTERN.test(batchCode)) {
    return TASK_MODES.READ_ONLY;
  }

  if (
    DOCS_WRITE_TASK_PATTERN.test(raw) ||
    (DOCS_WRITE_TARGET_PATTERN.test(raw) && TASK_MUTATION_PATTERN.test(raw))
  ) {
    return TASK_MODES.DOCS_WRITE_ALLOWED;
  }

  if (
    /BATCH-44|BATCH-45A|automation_system_write_allowed/i.test(raw) ||
    (AUTOMATION_WRITE_TASK_PATTERN.test(raw) && TASK_MUTATION_PATTERN.test(raw))
  ) {
    return TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED;
  }

  if (isReadOnlyTaskText(raw)) {
    return TASK_MODES.READ_ONLY;
  }

  if (
    PRODUCT_WRITE_TASK_PATTERN.test(raw) ||
    (batchCode && /^BATCH-P\d+$/i.test(batchCode))
  ) {
    return TASK_MODES.PRODUCT_WRITE_ALLOWED;
  }

  return null;
}

function readTaskModeField(job) {
  const payload = job && typeof job.payload === "object" ? job.payload : null;
  const result = job && typeof job.result === "object" ? job.result : null;
  const candidates = [
    job?.task_mode,
    job?.taskMode,
    payload?.task_mode,
    payload?.taskMode,
    result?.task_mode,
    result?.taskMode,
  ];

  for (const candidate of candidates) {
    const value = readString(candidate);
    if (!value) continue;
    const normalized = value.toLowerCase();
    if (Object.values(TASK_MODES).includes(normalized)) {
      return normalized;
    }
  }

  return null;
}


function readBatchCodeField(job) {
  const payload = job && typeof job.payload === "object" ? job.payload : null;
  const result = job && typeof job.result === "object" ? job.result : null;
  const candidates = [
    job?.approved_batch,
    job?.approvedBatch,
    job?.batch_code,
    job?.batchCode,
    payload?.approved_batch,
    payload?.approvedBatch,
    payload?.batch_code,
    payload?.batchCode,
    result?.approved_batch,
    result?.approvedBatch,
    result?.batch_code,
    result?.batchCode,
  ];

  for (const candidate of candidates) {
    const value = readString(candidate);
    if (!value) continue;
    const match = value.match(/\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i);
    if (match) return match[0].toUpperCase();
  }

  return null;
}

function getTaskMode(job) {
  try {
    const normalized = normalizeWorkerContext(job);
    if (normalized.task_mode) {
      return normalized.task_mode;
    }

    const directRequestText = readTextValue([
      job?.request_text,
      job?.requestText,
      job?.payload?.request_text,
      job?.payload?.requestText,
      job?.payload?.original_request_text,
      job?.payload?.originalRequestText,
    ]);
    const text = getJobText(job);
    const explicitTextMode = resolveTaskModeFromExplicitTextContext(
      readExplicitTextTaskContext(job)
    );
    if (explicitTextMode) {
      return explicitTextMode;
    }

    const explicitMode = readTaskModeField(job);

    if (
      explicitMode === TASK_MODES.READ_ONLY ||
      taskTextDeclaresReadOnlyMode(directRequestText) ||
      taskTextDeclaresReadOnlyMode(text)
    ) {
      return TASK_MODES.READ_ONLY;
    }

    if (
      isQaReviewTask(job) ||
      (taskTextDeclaresQaReviewDomain(text) && hasReadOnlyField(job))
    ) {
      return TASK_MODES.READ_ONLY;
    }

    // BATCH-FIX product repair must stay product_write_allowed unless the current task explicitly says read_only.
    // BATCH_FIX_PRODUCT_OUTRANKS_FORBIDDEN_WORDS_BUT_NOT_EXPLICIT_READ_ONLY
    const productModeText = readTextValue([
      job?.request_text,
      job?.requestText,
      job?.demand,
      job?.title,
      job?.name,
      job?.payload?.request_text,
      job?.payload?.requestText,
      job?.payload?.original_request_text,
      job?.payload?.originalRequestText,
      job?.payload?.demand,
      job?.payload?.title,
    ]);

    if (
      /\bBATCH-FIX(?:-[A-Z0-9]+)*\b/i.test(productModeText) &&
      /(同城搭子|city_partner_product|product_write_allowed|产品修复|首批阻断|QA-05|\/partners|\/post|login|profile|src\/app)/i.test(productModeText)
    ) {
      if (hasReadOnlyField(job) && !hasReadOnlyFalseField(job)) {
        return TASK_MODES.READ_ONLY;
      }
      return TASK_MODES.PRODUCT_WRITE_ALLOWED;
    }

    // BATCH-FIX product repair must stay product even when the text mentions system/worker forbidden scopes.
    // BATCH_FIX_PRODUCT_REQUEST_TEXT_OUTRANKS_READ_ONLY_DEFAULT
    if (/\bBATCH-FIX(?:-[A-Z0-9]+)*\b/i.test(directRequestText) && isBatchFixProductTaskText(directRequestText)) {
      if (hasReadOnlyField(job) && !hasReadOnlyFalseField(job)) {
        return TASK_MODES.READ_ONLY;
      }
      return TASK_MODES.PRODUCT_WRITE_ALLOWED;
    }

    const currentBatchCode = getCurrentBatchCode(job);

    // 当前真实批次最高优先级，防止历史 task_mode 污染。
    // CURRENT_BATCH_IDENTITY_OUTRANKS_TASK_MODE
    if (currentBatchCode && FORCED_READ_ONLY_BATCH_PATTERN.test(currentBatchCode)) {
      return TASK_MODES.READ_ONLY;
    }

    if (currentBatchCode && /^BATCH-GM-STABILIZE(?:-|$)/i.test(currentBatchCode)) {
      return TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED;
    }

    if (explicitMode) {
      if (
        explicitMode !== TASK_MODES.READ_ONLY &&
        hasReadOnlyField(job) &&
        !hasReadOnlyFalseField(job)
      ) {
        throw createTaskModeMismatchError(
          "A write-allowed task was locked by read_only_mode=true before it could satisfy its goal.",
          { taskMode: explicitMode }
        );
      }

      return explicitMode;
    }

    const textMode = getTaskModeFromText(text);

    if (
      textMode !== TASK_MODES.PRODUCT_WRITE_ALLOWED &&
      currentBatchCode &&
      FORCED_READ_ONLY_BATCH_PATTERN.test(currentBatchCode)
    ) {
      return TASK_MODES.READ_ONLY;
    }

    if (textMode && textMode !== TASK_MODES.READ_ONLY) {
      return textMode;
    }

    if (hasReadOnlyField(job)) {
      return TASK_MODES.READ_ONLY;
    }

    return textMode || TASK_MODES.READ_ONLY;
  } catch (_) {
    return TASK_MODES.READ_ONLY;
  }
}

function assertExplicitTaskFieldsNotOverridden(job) {
  const explicitTextContext = readExplicitTextTaskContext(job);
  const explicitTaskMode = explicitTextContext.taskMode;
  const explicitProjectDomain = explicitTextContext.projectDomain;
  const payload = job && typeof job.payload === "object" ? job.payload : null;
  const payloadTaskMode = readTaskModeField({
    task_mode: payload?.task_mode || payload?.taskMode,
  });
  const payloadProjectDomain = readProjectDomainField({ payload });
  const finalTaskMode = getTaskMode(job);
  const finalProjectDomain =
    getEffectiveProjectDomain(job) || classifyWorkerTaskDomain(getJobText(job));

  if (
    explicitTaskMode === TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED &&
    finalTaskMode !== TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED
  ) {
    throw createExplicitFieldOverrideError(
      EXPLICIT_TASK_MODE_OVERRIDDEN,
      "request_text explicitly declares task_mode=automation_system_write_allowed, but final Worker task_mode was overwritten.",
      {
        explicitValue: explicitTaskMode,
        finalValue: finalTaskMode,
        payloadValue: payloadTaskMode,
      }
    );
  }

  if (
    explicitProjectDomain === "automation_system" &&
    finalProjectDomain !== "automation_system"
  ) {
    throw createExplicitFieldOverrideError(
      EXPLICIT_PROJECT_DOMAIN_OVERRIDDEN,
      "request_text explicitly declares project_domain=automation_system, but final Worker project_domain was overwritten.",
      {
        explicitValue: explicitProjectDomain,
        finalValue: finalProjectDomain,
        payloadValue: payloadProjectDomain,
      }
    );
  }
}


function createOutOfScopeBusinessChangeError(message, details = {}) {
  const outOfScopePaths = uniqueSortedPaths(details.outOfScopePaths || []);
  const error = new Error(
    [
      OUT_OF_SCOPE_BUSINESS_CHANGE,
      message,
      details.taskMode ? `task_mode: ${details.taskMode}` : null,
      outOfScopePaths.length
        ? `out_of_scope_paths: ${outOfScopePaths.join(", ")}`
        : "out_of_scope_paths: none",
    ]
      .filter(Boolean)
      .join("\n")
  );

  error.code = OUT_OF_SCOPE_BUSINESS_CHANGE;
  error.failureStage = "task_mode scope validation";
  error.outOfScopePaths = outOfScopePaths;
  error.taskMode = details.taskMode || null;
  return error;
}

function createOutOfScopeSystemChangeError(message, details = {}) {
  const outOfScopePaths = uniqueSortedPaths(details.outOfScopePaths || []);
  const error = new Error(
    [
      OUT_OF_SCOPE_SYSTEM_CHANGE,
      message,
      details.taskMode ? `task_mode: ${details.taskMode}` : null,
      outOfScopePaths.length
        ? `out_of_scope_system_paths: ${outOfScopePaths.join(", ")}`
        : "out_of_scope_system_paths: none",
    ]
      .filter(Boolean)
      .join("\n")
  );

  error.code = OUT_OF_SCOPE_SYSTEM_CHANGE;
  error.failureStage = "product task system-scope validation";
  error.outOfScopePaths = outOfScopePaths;
  error.taskMode = details.taskMode || null;
  return error;
}

function createTaskModeMismatchError(message, details = {}) {
  const error = new Error(
    [
      TASK_MODE_MISMATCH,
      message,
      details.taskMode ? `task_mode: ${details.taskMode}` : null,
      "read_only_mode=true conflicts with a write-allowed task mode.",
    ]
      .filter(Boolean)
      .join("\n")
  );

  error.code = TASK_MODE_MISMATCH;
  error.failureStage = "task_mode/read_only_mode consistency validation";
  error.taskMode = details.taskMode || null;
  return error;
}

function isBusinessPagePath(filePath) {
  return pathMatchesPrefix(filePath, BUSINESS_PAGE_PREFIXES);
}

function isDatabaseOrEnvPath(filePath) {
  const normalized = normalizeGitPath(filePath);
  const baseName = normalized.split("/").pop() || normalized;
  return (
    pathMatchesPrefix(normalized, DATABASE_OR_ENV_PREFIXES) ||
    baseName === ".env" ||
    baseName.startsWith(".env.") ||
    baseName.endsWith(".env")
  );
}

function isDocsWriteAllowedPath(filePath) {
  return pathMatchesPrefix(filePath, DOCS_WRITE_ALLOWED_PREFIXES);
}

function isAutomationWriteAllowedPath(filePath) {
  return pathMatchesPrefix(filePath, AUTOMATION_WRITE_ALLOWED_PATHS);
}

function isExplicitAutomationAllowedDocPath(filePath) {
  const normalized = normalizeGitPath(filePath);
  const fileName = normalized.split("/").pop() || "";
  return (
    !normalized.includes("*") &&
    fileName.includes(".") &&
    (AUTOMATION_ALLOWED_SCOPE_DOC_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
      AUTOMATION_ALLOWED_SCOPE_DOC_FILES.includes(normalized))
  );
}

const HERMES_CONTEXT_FIELD_PATTERN =
  /\b(?:context_source|context_reconstruct_failed|project_domain|task_type|requested_mode|final_mode|task_mode|read_only_mode|repair_mode|repair_scope|verification_only|worker_only|allow_no_change_success|execution_intent|execution_policy_conflict|deterministic_git_operation|code_changes_required|codex_required|git_commit_required|git_push_required|approval_required|allowed_scope|exact_allowed_scope|exact_allowed_scope_count|writable_scope|readable_scope|read_only_operations|forbidden_operations|forbidden_scope|route|task_goal|required_output_fields|acceptance_conditions|original_request_text(?:_base64)?|approved_batch|batch_code|attempt_id|worker_stage|workflow_stage|final_report_status|effective_final_status|failure_code|failure_stage|changed_files|committed_files|codex_changed_files|worktree_changed_files|task_changed_files|unexpected_changed_files|git_commit_sha|codex_git_push|worker_git_push|git_push|pushed|pushed_branch|remote_contains_commit|repository_clean_after_push|next_batch|completed_at|deploy_status|execution_policy_source|execution_policy_batch_code|execution_policy_context_id|execution_policy_request_hash|execution_policy_inherited|execution_policy_inheritance_rejected_reason)\s*[:=]/i;

function contextFieldNamePattern(fieldName) {
  return fieldName.replace(/_/g, "[_\\s-]*");
}

function decodeEscapedWorkerContextText(value) {
  return String(value || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

function stripWorkerContextValue(value) {
  let stripped = String(value || "").trim();
  const first = stripped[0];
  const last = stripped[stripped.length - 1];
  if (
    stripped.length >= 2 &&
    ((first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "`" && last === "`") ||
      (first === "“" && last === "”"))
  ) {
    stripped = stripped.slice(1, -1).trim();
  }
  return stripped;
}

function extractWorkerContextFieldValues(text, fieldName) {
  const values = [];
  const pattern = new RegExp(
    `(?:^|[^\\w-])${contextFieldNamePattern(fieldName)}\\s*[:=]\\s*`,
    "i"
  );

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const match = pattern.exec(rawLine);
    if (!match) {
      continue;
    }

    const rawValue = rawLine.slice(match.index + match[0].length);
    const decodedValue = decodeEscapedWorkerContextText(rawValue).split(/\r?\n/)[0] || "";
    const nextField = HERMES_CONTEXT_FIELD_PATTERN.exec(decodedValue);
    values.push(stripWorkerContextValue(nextField ? decodedValue.slice(0, nextField.index) : decodedValue));
  }

  return values.filter(Boolean);
}

function extractOriginalRequestTextsFromContext(text) {
  const nestedTexts = [];

  for (const value of extractWorkerContextFieldValues(
    text,
    "original_request_text_base64"
  )) {
    const base64Token = value.match(/[A-Za-z0-9+/=]+/)?.[0] || "";
    const decoded = decodeOriginalRequestTextBase64(base64Token);
    if (decoded) {
      nestedTexts.push(decoded);
    }
  }

  for (const value of extractWorkerContextFieldValues(text, "original_request_text")) {
    const decoded = decodeEscapedWorkerContextText(value).trim();
    if (decoded) {
      nestedTexts.push(decoded);
    }
  }

  return nestedTexts;
}

function expandWorkerContextTexts(text, seen = new Set(), depth = 0) {
  if (depth > 5) {
    return [];
  }

  const raw = String(text || "");
  if (!raw.trim()) {
    return [];
  }

  const expanded = [];
  const candidates = [raw, decodeEscapedWorkerContextText(raw)];

  for (const candidate of candidates) {
    const normalizedCandidate = candidate.trim();
    if (!normalizedCandidate || seen.has(normalizedCandidate)) {
      continue;
    }

    seen.add(normalizedCandidate);
    expanded.push(normalizedCandidate);

    for (const nestedText of extractOriginalRequestTextsFromContext(normalizedCandidate)) {
      expanded.push(...expandWorkerContextTexts(nestedText, seen, depth + 1));
    }
  }

  return expanded;
}

function extractAllowedScopeValueFromLine(line) {
  const pattern = new RegExp(
    `(?:^|[^\\w-])${contextFieldNamePattern("allowed_scope")}\\s*[:=]\\s*`,
    "i"
  );
  const match = pattern.exec(line);
  if (!match) {
    return null;
  }

  const rawValue = line.slice(match.index + match[0].length);
  const decodedValue = decodeEscapedWorkerContextText(rawValue).split(/\r?\n/)[0] || "";
  const nextField = HERMES_CONTEXT_FIELD_PATTERN.exec(decodedValue);
  const value = nextField ? decodedValue.slice(0, nextField.index) : decodedValue;
  return stripWorkerContextValue(value);
}

function extractAllowedScopePaths(requestText) {
  const paths = [];
  for (const contextText of expandWorkerContextTexts(requestText)) {
    for (const rawLine of contextText.split(/\r?\n/)) {
      const value = extractAllowedScopeValueFromLine(rawLine.trim());
      if (!value) {
        continue;
      }
      paths.push(...extractPathLikeTokens(value));
    }
  }
  return uniqueSortedPaths(paths);
}

function normalizeTaskModeValue(value) {
  const normalized = readString(value)?.toLowerCase();
  return Object.values(TASK_MODES).includes(normalized) ? normalized : null;
}

function extractExactAllowedScopePaths(scopeValue) {
  return uniqueSortedPaths(extractPathLikeTokens(` ${String(scopeValue || "")}`));
}

function exactAllowedScopePathMatches(allowedPath, filePath) {
  const normalizedAllowed = normalizeGitPath(allowedPath);
  const normalizedFile = normalizeGitPath(filePath);
  if (!normalizedAllowed) return false;
  if (normalizedAllowed.endsWith("/**")) {
    const prefix = normalizedAllowed.slice(0, -3);
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }
  return normalizedFile === normalizedAllowed;
}

function fileMatchesExactAllowedScope(filePath, exactAllowedScope) {
  const exactPaths = extractExactAllowedScopePaths(exactAllowedScope);
  if (exactPaths.length === 0) return false;
  return exactPaths.some((allowedPath) => exactAllowedScopePathMatches(allowedPath, filePath));
}

function isReadOnlyTaskMode(taskMode) {
  return (
    taskMode === TASK_MODES.READ_ONLY ||
    taskMode === TASK_MODES.MANAGER_READ_ONLY ||
    taskMode === TASK_MODES.WORKER_READ_ONLY
  );
}

function isSystemRepairMode(input) {
  return (
    input?.projectDomain === "automation_system" &&
    input?.taskType === SYSTEM_REPAIR_TASK_TYPE &&
    typeof input?.batchCode === "string" &&
    input.batchCode.startsWith(SYSTEM_REPAIR_BATCH_PREFIX)
  );
}

function readNullableBooleanFlag(value) {
  if (readBooleanFlag(value)) return true;
  if (readBooleanFalseFlag(value)) return false;
  return null;
}

function readStringList(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function readScopeValue(value) {
  const items = readStringList(value);
  if (items.length > 0) return items.join(", ");
  return readString(value);
}

function readContractTextValue(value) {
  const items = readStringList(value);
  if (items.length > 0) return items.join("\n");
  const text = readTextValue(value).trim();
  return text || null;
}

function firstPresentValue(...values) {
  return values.find(
    (value) =>
      value !== null &&
      value !== undefined &&
      !(typeof value === "string" && value.trim() === "")
  );
}

function stripListMarker(value) {
  return String(value || "")
    .replace(/^\s*(?:[-*]|\d+[.)、])\s*/, "")
    .trim();
}

function lineIsTaskSectionHeading(line) {
  const text = stripListMarker(line).trim();
  if (!text) return false;
  if (/^(?:[A-Za-z_][A-Za-z0-9_\s-]{2,60}|[\u4e00-\u9fffA-Za-z0-9_\s/-]{2,60})\s*[:：]\s*$/.test(text)) {
    return true;
  }
  return /^【[^】]+】$/.test(text);
}

function extractTaskSection(text, headingPatterns, options = {}) {
  const lines = String(text || "").split(/\r?\n/);
  const collected = [];
  let collecting = false;
  const maxLines = options.maxLines || 30;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!collecting) {
      const heading = headingPatterns.find((pattern) => pattern.test(line));
      if (!heading) continue;

      const inlineValue = line.split(/[:：]/).slice(1).join(":").trim();
      if (inlineValue) return stripListMarker(inlineValue);
      collecting = true;
      continue;
    }

    if (!line) {
      if (collected.length > 0) break;
      continue;
    }

    if (lineIsTaskSectionHeading(line) && !/^\s*(?:[-*]|\d+[.)、])\s+/.test(rawLine)) {
      break;
    }

    collected.push(stripListMarker(line));
    if (collected.length >= maxLines) break;
  }

  return collected.filter(Boolean).join("\n").trim() || null;
}

function extractTaskGoalFromText(text) {
  return extractTaskSection(
    text,
    [
      /\btask[_\s-]*goal\b/i,
      /\btask[_\s-]*objective\b/i,
      /本批次唯一目标/,
      /任务目标/,
      /修复目标/,
    ],
    { maxLines: 6 }
  );
}

function extractRequiredOutputFieldsFromText(text) {
  return extractTaskSection(
    text,
    [
      /\brequired[_\s-]*output[_\s-]*fields\b/i,
      /\boutput[_\s-]*fields\b/i,
      /必填输出字段/,
      /^返回\s*[:：]?\s*$/,
      /必须输出/,
    ],
    { maxLines: 30 }
  );
}

function extractAcceptanceConditionsFromText(text) {
  return extractTaskSection(
    text,
    [
      /\bacceptance[_\s-]*(?:conditions|criteria)\b/i,
      /验收条件/,
      /完成条件/,
    ],
    { maxLines: 40 }
  );
}

function parseRequiredOutputFieldList(value) {
  return readStringList(value)
    .flatMap((item) => String(item || "").split(/\r?\n/))
    .map((item) => stripListMarker(item).replace(/^`|`$/g, "").trim())
    .map((item) => item.split(/[:：=]/)[0].trim() || item)
    .filter(Boolean);
}

function requiredOutputFieldMatchesReport(field, reportText) {
  const label = String(field || "").trim();
  if (!label) return true;
  const report = String(reportText || "");
  if (report.includes(label)) return true;

  const normalizedLabel = label
    .replace(/^`|`$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedLabel) return true;

  const pattern = new RegExp(
    escapeRegExp(normalizedLabel).replace(/[_\s-]+/g, "[_\\s-]+"),
    "i"
  );
  return pattern.test(report);
}

function getMissingWorkerReadOnlyRequiredOutputFields(contract, reportText) {
  const requiredFields = parseRequiredOutputFieldList(contract.required_output_fields);
  return requiredFields.filter((field) => !requiredOutputFieldMatchesReport(field, reportText));
}

const WORKER_CONTEXT_FIELD_NAMES = [
  "context_source",
  "context_reconstruct_failed",
  "project_domain",
  "task_type",
  "requested_mode",
  "final_mode",
  "task_mode",
  "read_only_mode",
  "repair_mode",
  "repair_scope",
  "verification_only",
  "worker_only",
  "allow_no_change_success",
  "execution_intent",
  "execution_policy_conflict",
  "deterministic_git_operation",
  "code_changes_required",
  "codex_required",
  "git_commit_required",
  "git_push_required",
  "approval_required",
  "allowed_scope",
  "exact_allowed_scope",
  "exact_allowed_scope_count",
  "writable_scope",
  "readable_scope",
  "read_only_operations",
  "forbidden_operations",
  "forbidden_scope",
  "task_goal",
  "required_output_fields",
  "acceptance_conditions",
  "original_request_text",
  "original_request_text_base64",
  "route",
  "approved_batch",
  "batch_code",
  "attempt_id",
  "worker_stage",
  "workflow_stage",
  "final_report_status",
  "effective_final_status",
  "failure_code",
  "failure_stage",
  "changed_files",
  "committed_files",
  "codex_changed_files",
  "worktree_changed_files",
  "task_changed_files",
  "unexpected_changed_files",
  "git_commit_sha",
  "codex_git_push",
  "worker_git_push",
  "git_push",
  "pushed_branch",
  "remote_contains_commit",
  "repository_clean_after_push",
  "next_batch",
  "completed_at",
  "pushed",
  "deploy_status",
  "execution_policy_source",
  "execution_policy_batch_code",
  "execution_policy_context_id",
  "execution_policy_request_hash",
  "execution_policy_inherited",
  "execution_policy_inheritance_rejected_reason",
];

const WORKER_CONTEXT_CORE_FIELDS = [
  "project_domain",
  "task_type",
  "requested_mode",
  "final_mode",
  "task_mode",
  "read_only_mode",
  "repair_mode",
  "repair_scope",
  "execution_intent",
  "allowed_scope",
  "forbidden_scope",
  "route",
];

function canonicalWorkerContextFieldName(fieldName) {
  if (fieldName === "batch_code") return "approved_batch";
  return fieldName === "workflow_stage" ? "worker_stage" : fieldName;
}

function parseWorkerContextFieldLine(rawLine) {
  for (const fieldName of WORKER_CONTEXT_FIELD_NAMES) {
    const pattern = new RegExp(
      `(?:^|[^\\w-])${contextFieldNamePattern(fieldName)}\\s*[:=]\\s*`,
      "i"
    );
    const match = pattern.exec(rawLine);
    if (!match) {
      continue;
    }

    const rawValue = rawLine.slice(match.index + match[0].length);
    const decodedValue = decodeEscapedWorkerContextText(rawValue).split(/\r?\n/)[0] || "";
    const nextField = HERMES_CONTEXT_FIELD_PATTERN.exec(decodedValue);
    const value = stripWorkerContextValue(
      nextField ? decodedValue.slice(0, nextField.index) : decodedValue
    );
    return {
      fieldName: canonicalWorkerContextFieldName(fieldName),
      value,
    };
  }

  return null;
}

function parseWorkerContextFields(text) {
  const fields = {};
  const explicitFields = new Set();

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const parsed = parseWorkerContextFieldLine(rawLine.trim());
    if (!parsed || !parsed.value) {
      continue;
    }

    explicitFields.add(parsed.fieldName);

    if (parsed.fieldName === "original_request_text_base64") {
      fields.original_request_text_base64 = parsed.value;
      const decoded = decodeOriginalRequestTextBase64(
        parsed.value.match(/[A-Za-z0-9+/=]+/)?.[0] || ""
      );
      if (decoded) {
        fields.original_request_text = decoded;
        explicitFields.add("original_request_text");
      }
      continue;
    }

    fields[parsed.fieldName] = parsed.value;
  }

  return {
    fields,
    explicitFields,
  };
}

function findOriginalDemandAnchor(text) {
  const raw = String(text || "");
  const markers = [
    "【原始任务内容】",
    "新需求",
    "Original task",
    "original_request_text",
  ];
  const indexes = markers
    .map((marker) => raw.indexOf(marker))
    .filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : 0;
}

function extractHermesContextCandidatesFromText(text, options = {}) {
  const raw = String(text || "");
  if (!raw.trim()) {
    return [];
  }

  const depth = options.depth || 0;
  const sourceLabel = options.sourceLabel || "request_text";
  const seen = options.seen || new Set();
  const candidates = [];
  const variants = [raw, decodeEscapedWorkerContextText(raw)];

  for (const variant of variants) {
    const normalizedVariant = variant.trim();
    const seenKey = `${depth}:${sourceLabel}:${normalizedVariant}`;
    if (!normalizedVariant || seen.has(seenKey)) {
      continue;
    }
    seen.add(seenKey);

    const lines = normalizedVariant.split(/\r?\n/);
    const lineStarts = [];
    let cursor = 0;
    for (const line of lines) {
      lineStarts.push(cursor);
      cursor += line.length + 1;
    }

    for (let index = 0; index < lines.length; index += 1) {
      if (!/^\s*HERMES_WORKER_CONTEXT\s*[:：]\s*$/i.test(lines[index])) {
        continue;
      }

      const blockLines = [];
      for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
        if (/^\s*HERMES_WORKER_CONTEXT\s*[:：]\s*$/i.test(lines[blockIndex])) {
          break;
        }
        blockLines.push(lines[blockIndex]);
      }

      const parsed = parseWorkerContextFields(blockLines.join("\n"));
      const fieldCount = Object.keys(parsed.fields).filter((fieldName) =>
        readString(parsed.fields[fieldName])
      ).length;
      if (fieldCount === 0) {
        continue;
      }

      const anchor = findOriginalDemandAnchor(normalizedVariant);
      const startIndex = lineStarts[index] || 0;
      const coreMissing = WORKER_CONTEXT_CORE_FIELDS.filter(
        (fieldName) => !readString(parsed.fields[fieldName])
      ).length;

      candidates.push({
        fields: parsed.fields,
        explicitFields: parsed.explicitFields,
        depth,
        sourceLabel,
        startIndex,
        distance: Math.abs(startIndex - anchor),
        fieldCount,
        coreMissing,
      });
    }

    for (const nestedText of extractOriginalRequestTextsFromContext(normalizedVariant)) {
      candidates.push(
        ...extractHermesContextCandidatesFromText(nestedText, {
          depth: depth + 1,
          sourceLabel: "original_request_text",
          seen,
        })
      );
    }
  }

  return candidates;
}

function selectPreferredHermesContext(text) {
  const candidates = extractHermesContextCandidatesFromText(text);
  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((a, b) => {
    if (a.coreMissing !== b.coreMissing) return a.coreMissing - b.coreMissing;
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.fieldCount !== b.fieldCount) return b.fieldCount - a.fieldCount;
    return a.startIndex - b.startIndex;
  })[0];
}

function readTextContextField(text, fieldName) {
  const values = extractWorkerContextFieldValues(extractOriginalTaskBody(text), fieldName);
  if (fieldName === "original_request_text") {
    const base64Values = extractWorkerContextFieldValues(
      extractOriginalTaskBody(text),
      "original_request_text_base64"
    );
    const decoded = base64Values
      .map((value) => decodeOriginalRequestTextBase64(value.match(/[A-Za-z0-9+/=]+/)?.[0] || ""))
      .filter(Boolean);
    if (decoded.length > 0) {
      return decoded[decoded.length - 1];
    }
  }

  return values.length > 0 ? values[values.length - 1] : null;
}

function readPayloadContextField(payload, fieldName) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const aliases = {
    project_domain: ["project_domain", "projectDomain"],
    task_type: ["task_type", "taskType"],
    requested_mode: ["requested_mode", "requestedMode"],
    final_mode: ["final_mode", "finalMode"],
    task_mode: ["task_mode", "taskMode"],
    read_only_mode: ["read_only_mode", "readOnlyMode", "readonly", "read_only"],
    repair_mode: ["repair_mode", "repairMode"],
    repair_scope: ["repair_scope", "repairScope"],
    verification_only: ["verification_only", "verificationOnly"],
    worker_only: ["worker_only", "workerOnly"],
    allow_no_change_success: ["allow_no_change_success", "allowNoChangeSuccess"],
    execution_intent: ["execution_intent", "executionIntent"],
    code_changes_required: ["code_changes_required", "codeChangesRequired"],
    codex_required: ["codex_required", "codexRequired"],
    git_commit_required: ["git_commit_required", "gitCommitRequired"],
    git_push_required: ["git_push_required", "gitPushRequired"],
    approval_required: ["approval_required", "approvalRequired"],
    allowed_scope: ["allowed_scope", "allowedScope", "allowed_files", "allowedFiles"],
    exact_allowed_scope: ["exact_allowed_scope", "exactAllowedScope", "exact_allowed_paths", "exactAllowedPaths"],
    exact_allowed_scope_count: ["exact_allowed_scope_count", "exactAllowedScopeCount"],
    writable_scope: ["writable_scope", "writableScope", "writable_files", "writableFiles"],
    readable_scope: ["readable_scope", "readableScope", "readable_files", "readableFiles"],
    read_only_operations: ["read_only_operations", "readOnlyOperations", "readonly_operations", "readonlyOperations"],
    forbidden_operations: ["forbidden_operations", "forbiddenOperations"],
    forbidden_scope: ["forbidden_scope", "forbiddenScope", "forbidden_files", "forbiddenFiles"],
    task_goal: ["task_goal", "taskGoal", "goal", "objective", "task_objective", "taskObjective"],
    required_output_fields: ["required_output_fields", "requiredOutputFields", "output_fields", "outputFields"],
    acceptance_conditions: ["acceptance_conditions", "acceptanceConditions", "acceptance_criteria", "acceptanceCriteria"],
    original_request_text: [
      "original_request_text",
      "originalRequestText",
      "original_request_text_base64",
      "originalRequestTextBase64",
    ],
    route: ["route"],
    approved_batch: ["approved_batch", "approvedBatch", "batch_code", "batchCode"],
    attempt_id: ["attempt_id", "attemptId"],
    worker_stage: ["worker_stage", "workerStage", "workflow_stage", "workflowStage"],
    final_report_status: ["final_report_status", "finalReportStatus"],
    effective_final_status: ["effective_final_status", "effectiveFinalStatus"],
    failure_code: ["failure_code", "failureCode", "error_code", "errorCode"],
    failure_stage: ["failure_stage", "failureStage"],
    changed_files: ["changed_files", "changedFiles", "files_changed", "filesChanged"],
    committed_files: ["committed_files", "committedFiles"],
    codex_changed_files: ["codex_changed_files", "codexChangedFiles"],
    worktree_changed_files: ["worktree_changed_files", "worktreeChangedFiles"],
    task_changed_files: ["task_changed_files", "taskChangedFiles"],
    unexpected_changed_files: ["unexpected_changed_files", "unexpectedChangedFiles"],
    git_commit_sha: ["git_commit_sha", "gitCommitSha"],
    codex_git_push: ["codex_git_push", "codexGitPush"],
    worker_git_push: ["worker_git_push", "workerGitPush"],
    git_push: ["git_push", "gitPush"],
    pushed_branch: ["pushed_branch", "pushedBranch"],
    remote_contains_commit: ["remote_contains_commit", "remoteContainsCommit"],
    repository_clean_after_push: ["repository_clean_after_push", "repositoryCleanAfterPush"],
    next_batch: ["next_batch", "nextBatch"],
    completed_at: ["completed_at", "completedAt"],
    pushed: ["pushed"],
    deploy_status: ["deploy_status", "deployStatus"],
    execution_policy_source: ["execution_policy_source", "executionPolicySource"],
    execution_policy_batch_code: ["execution_policy_batch_code", "executionPolicyBatchCode"],
    execution_policy_context_id: ["execution_policy_context_id", "executionPolicyContextId", "context_id", "contextId"],
    execution_policy_request_hash: ["execution_policy_request_hash", "executionPolicyRequestHash"],
    execution_policy_inherited: ["execution_policy_inherited", "executionPolicyInherited"],
    execution_policy_inheritance_rejected_reason: [
      "execution_policy_inheritance_rejected_reason",
      "executionPolicyInheritanceRejectedReason",
    ],
  };

  for (const key of aliases[fieldName] || [fieldName]) {
    const value = payload[key];
    if (
      fieldName === "original_request_text" &&
      (key === "original_request_text_base64" || key === "originalRequestTextBase64")
    ) {
      const decoded = decodeOriginalRequestTextBase64(value);
      if (decoded) return decoded;
      continue;
    }
    if (Array.isArray(value)) {
      const scopeValue = readScopeValue(value);
      if (scopeValue) return scopeValue;
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number") {
      return value;
    }
    const text = readString(value);
    if (text) return text;
  }

  return null;
}

function hasPayloadContext(payload) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      WORKER_CONTEXT_CORE_FIELDS.some((fieldName) =>
        readPayloadContextField(payload, fieldName) !== null
      )
  );
}

function hasStructuredPayloadContext(payload) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      (readPayloadContextField(payload, "route") !== null ||
        readPayloadContextField(payload, "allowed_scope") !== null ||
        readPayloadContextField(payload, "forbidden_scope") !== null ||
        readPayloadContextField(payload, "original_request_text") !== null ||
        readPayloadContextField(payload, "approved_batch") !== null ||
        readPayloadContextField(payload, "worker_stage") !== null ||
        readPayloadContextField(payload, "final_report_status") !== null)
  );
}

function getOriginalRequestTextFallback(job, payload, result, overrides) {
  return (
    readString(overrides.originalRequestText) ||
    readPayloadContextField(payload, "original_request_text") ||
    readPayloadContextField(result, "original_request_text") ||
    readString(job?.original_request_text) ||
    readString(job?.originalRequestText) ||
    decodeOriginalRequestTextBase64(job?.original_request_text_base64) ||
    decodeOriginalRequestTextBase64(job?.originalRequestTextBase64) ||
    null
  );
}

function normalizeWorkerContext(job, overrides = {}) {
  const payload = job && typeof job.payload === "object" ? job.payload : null;
  const result = job && typeof job.result === "object" ? job.result : null;
  const requestText = readTextValue([
    job?.request_text,
    job?.requestText,
    overrides.requestText,
  ]);
  const fallbackOriginalRequest = getOriginalRequestTextFallback(
    job,
    payload,
    result,
    overrides
  );
  const sourceText = readTextValue([
    requestText,
    fallbackOriginalRequest,
    getJobText(job),
  ]);
  const explicitContext = selectPreferredHermesContext(sourceText);
  const explicitFields = explicitContext?.fields || {};
  const explicitOriginalRequestText = readLatestOriginalRequestTextFromContexts(sourceText);
  const originalRequestText =
    readString(explicitFields.original_request_text) ||
    explicitOriginalRequestText ||
    readString(fallbackOriginalRequest) ||
    readTextContextField(requestText, "original_request_text") ||
    readString(requestText) ||
    "";
  const originalRequestTextPreserved = Boolean(
    readString(explicitFields.original_request_text) ||
      explicitOriginalRequestText ||
      readString(fallbackOriginalRequest) ||
      readTextContextField(requestText, "original_request_text")
  );
  const originalRequestTextFields = {
    project_domain: readTextContextField(fallbackOriginalRequest, "project_domain"),
    task_type: readTextContextField(fallbackOriginalRequest, "task_type"),
    requested_mode: readTextContextField(fallbackOriginalRequest, "requested_mode"),
    final_mode: readTextContextField(fallbackOriginalRequest, "final_mode"),
    task_mode: readTextContextField(fallbackOriginalRequest, "task_mode"),
    read_only_mode: readTextContextField(fallbackOriginalRequest, "read_only_mode"),
    repair_mode: readTextContextField(fallbackOriginalRequest, "repair_mode"),
    repair_scope: readTextContextField(fallbackOriginalRequest, "repair_scope"),
    verification_only: readTextContextField(fallbackOriginalRequest, "verification_only"),
    worker_only: readTextContextField(fallbackOriginalRequest, "worker_only"),
    allow_no_change_success: readTextContextField(fallbackOriginalRequest, "allow_no_change_success"),
    execution_intent: readTextContextField(fallbackOriginalRequest, "execution_intent"),
    code_changes_required: readTextContextField(fallbackOriginalRequest, "code_changes_required"),
    codex_required: readTextContextField(fallbackOriginalRequest, "codex_required"),
    git_commit_required: readTextContextField(fallbackOriginalRequest, "git_commit_required"),
    git_push_required: readTextContextField(fallbackOriginalRequest, "git_push_required"),
    approval_required: readTextContextField(fallbackOriginalRequest, "approval_required"),
    allowed_scope: readTextContextField(fallbackOriginalRequest, "allowed_scope"),
    exact_allowed_scope: readTextContextField(fallbackOriginalRequest, "exact_allowed_scope"),
    exact_allowed_scope_count: readTextContextField(fallbackOriginalRequest, "exact_allowed_scope_count"),
    writable_scope: readTextContextField(fallbackOriginalRequest, "writable_scope"),
    readable_scope: readTextContextField(fallbackOriginalRequest, "readable_scope"),
    read_only_operations: readTextContextField(fallbackOriginalRequest, "read_only_operations"),
    forbidden_operations: readTextContextField(fallbackOriginalRequest, "forbidden_operations"),
    forbidden_scope: readTextContextField(fallbackOriginalRequest, "forbidden_scope"),
    task_goal: readTextContextField(fallbackOriginalRequest, "task_goal"),
    required_output_fields: readTextContextField(fallbackOriginalRequest, "required_output_fields"),
    acceptance_conditions: readTextContextField(fallbackOriginalRequest, "acceptance_conditions"),
    route: readTextContextField(fallbackOriginalRequest, "route"),
    approved_batch: readTextContextField(fallbackOriginalRequest, "approved_batch"),
  };
  const requestTextFields = {
    project_domain: readTextContextField(requestText, "project_domain"),
    task_type: readTextContextField(requestText, "task_type"),
    requested_mode: readTextContextField(requestText, "requested_mode"),
    final_mode: readTextContextField(requestText, "final_mode"),
    task_mode: readTextContextField(requestText, "task_mode"),
    read_only_mode: readTextContextField(requestText, "read_only_mode"),
    repair_mode: readTextContextField(requestText, "repair_mode"),
    repair_scope: readTextContextField(requestText, "repair_scope"),
    verification_only: readTextContextField(requestText, "verification_only"),
    worker_only: readTextContextField(requestText, "worker_only"),
    allow_no_change_success: readTextContextField(requestText, "allow_no_change_success"),
    execution_intent: readTextContextField(requestText, "execution_intent"),
    code_changes_required: readTextContextField(requestText, "code_changes_required"),
    codex_required: readTextContextField(requestText, "codex_required"),
    git_commit_required: readTextContextField(requestText, "git_commit_required"),
    git_push_required: readTextContextField(requestText, "git_push_required"),
    approval_required: readTextContextField(requestText, "approval_required"),
    allowed_scope: readTextContextField(requestText, "allowed_scope"),
    exact_allowed_scope: readTextContextField(requestText, "exact_allowed_scope"),
    exact_allowed_scope_count: readTextContextField(requestText, "exact_allowed_scope_count"),
    writable_scope: readTextContextField(requestText, "writable_scope"),
    readable_scope: readTextContextField(requestText, "readable_scope"),
    read_only_operations: readTextContextField(requestText, "read_only_operations"),
    forbidden_operations: readTextContextField(requestText, "forbidden_operations"),
    forbidden_scope: readTextContextField(requestText, "forbidden_scope"),
    task_goal: readTextContextField(requestText, "task_goal"),
    required_output_fields: readTextContextField(requestText, "required_output_fields"),
    acceptance_conditions: readTextContextField(requestText, "acceptance_conditions"),
    route: readTextContextField(requestText, "route"),
    approved_batch: readTextContextField(requestText, "approved_batch"),
  };
  const overrideFields = {
    project_domain: overrides.projectDomain,
    task_type: overrides.taskType,
    requested_mode: overrides.requestedMode,
    final_mode: overrides.finalMode,
    task_mode: overrides.taskMode,
    read_only_mode: overrides.readOnlyMode,
    repair_mode: overrides.repairMode,
    repair_scope: readScopeValue(overrides.repairScope),
    verification_only: overrides.verificationOnly,
    worker_only: overrides.workerOnly,
    allow_no_change_success: overrides.allowNoChangeSuccess,
    execution_intent: overrides.executionIntent,
    code_changes_required: overrides.codeChangesRequired,
    codex_required: overrides.codexRequired,
    git_commit_required: overrides.gitCommitRequired,
    git_push_required: overrides.gitPushRequired,
    approval_required: overrides.approvalRequired,
    allowed_scope: readScopeValue(overrides.allowedScope),
    exact_allowed_scope: readScopeValue(overrides.exactAllowedScope),
    exact_allowed_scope_count: overrides.exactAllowedScopeCount,
    writable_scope: readContractTextValue(overrides.writableScope),
    readable_scope: readContractTextValue(overrides.readableScope),
    read_only_operations: readContractTextValue(overrides.readOnlyOperations),
    forbidden_operations: readContractTextValue(overrides.forbiddenOperations),
    forbidden_scope: readScopeValue(overrides.forbiddenScope),
    task_goal: readContractTextValue(overrides.taskGoal),
    required_output_fields: readContractTextValue(overrides.requiredOutputFields),
    acceptance_conditions: readContractTextValue(overrides.acceptanceConditions),
    route: overrides.route,
    approved_batch: overrides.approvedBatch,
  };
  const structuredPayload = hasStructuredPayloadContext(payload);
  const payloadField = (fieldName) => {
    const payloadValue = readPayloadContextField(payload, fieldName);
    if (payloadValue !== null && payloadValue !== undefined) {
      return payloadValue;
    }
    return readPayloadContextField(result, fieldName);
  };
  const readPriorityField = (fieldName) =>
    firstPresentValue(
      readString(explicitFields[fieldName]),
      structuredPayload ? payloadField(fieldName) : null,
      readString(originalRequestTextFields[fieldName]),
      readString(requestTextFields[fieldName]),
      !structuredPayload ? payloadField(fieldName) : null,
      overrideFields[fieldName]
    );
  const explicitTaskMode = normalizeTaskModeValue(readPriorityField("task_mode"));
  const explicitReadOnlyMode =
    readNullableBooleanFlag(explicitFields.read_only_mode) ??
    (structuredPayload ? readNullableBooleanFlag(payloadField("read_only_mode")) : null) ??
    readNullableBooleanFlag(originalRequestTextFields.read_only_mode) ??
    readNullableBooleanFlag(requestTextFields.read_only_mode) ??
    (typeof overrides.readOnlyMode === "boolean" ? overrides.readOnlyMode : null);
  const approvedBatch =
    readString(explicitFields.approved_batch) ||
    readString(originalRequestTextFields.approved_batch) ||
    readString(requestTextFields.approved_batch) ||
    getJobBatchCode({
      request_text: [originalRequestText, requestText].join("\n"),
    }) ||
    readString(payloadField("approved_batch"));
  const payloadPolicyBatchCode =
    readString(payloadField("approved_batch")) ||
    readString(payloadField("batch_code")) ||
    null;
  const policyPayloadMatchesCurrentBatch =
    !payloadPolicyBatchCode || !approvedBatch || payloadPolicyBatchCode === approvedBatch;
  const policyInheritanceRejectedReason = policyPayloadMatchesCurrentBatch
    ? null
    : "batch_code_mismatch";
  const booleanExecutionPolicyFields = new Set([
    "repair_mode",
    "verification_only",
    "worker_only",
    "allow_no_change_success",
    "code_changes_required",
    "codex_required",
    "git_commit_required",
    "git_push_required",
    "approval_required",
  ]);
  const normalizeExecutionPolicyCandidate = (fieldName, value) => {
    if (!booleanExecutionPolicyFields.has(fieldName)) return readString(value);
    return readNullableBooleanFlag(value);
  };
  const readExecutionPolicyField = (fieldName) =>
    firstPresentValue(
      normalizeExecutionPolicyCandidate(fieldName, explicitFields[fieldName]),
      structuredPayload && policyPayloadMatchesCurrentBatch
        ? normalizeExecutionPolicyCandidate(fieldName, payloadField(fieldName))
        : null,
      normalizeExecutionPolicyCandidate(fieldName, originalRequestTextFields[fieldName]),
      normalizeExecutionPolicyCandidate(fieldName, requestTextFields[fieldName]),
      !structuredPayload && policyPayloadMatchesCurrentBatch
        ? normalizeExecutionPolicyCandidate(fieldName, payloadField(fieldName))
        : null,
      normalizeExecutionPolicyCandidate(fieldName, overrideFields[fieldName])
    );
  const executionPolicySource = explicitContext
    ? "current_approval_context"
    : policyPayloadMatchesCurrentBatch && hasStructuredPayloadContext(payload)
    ? "current_worker_payload"
    : WORKER_CONTEXT_CORE_FIELDS.some((fieldName) => originalRequestTextFields[fieldName])
    ? "current_original_request_text"
    : WORKER_CONTEXT_CORE_FIELDS.some((fieldName) => requestTextFields[fieldName])
    ? "current_request_text"
    : "classification_default";
  const executionPolicyRequestHash = originalRequestText
    ? crypto.createHash("sha256").update(originalRequestText, "utf8").digest("hex")
    : null;
  const classificationText = [originalRequestText, requestText, approvedBatch].filter(Boolean).join("\n");
  const currentBatchIsQa = approvedBatch && QA_BATCH_PATTERN.test(approvedBatch);
  const productRepairRequest =
    !currentBatchIsQa && isBatchFixProductTaskText(classificationText);
  const forceReadOnlyMode =
    explicitReadOnlyMode === true &&
    !(productRepairRequest && !isReadOnlyTaskMode(explicitTaskMode));
  const inferredTaskMode =
    getTaskModeFromText(classificationText) ||
    TASK_MODES.READ_ONLY;
  const taskMode =
    forceReadOnlyMode || isReadOnlyTaskMode(explicitTaskMode)
      ? (isReadOnlyTaskMode(explicitTaskMode) ? explicitTaskMode : TASK_MODES.READ_ONLY)
      : explicitTaskMode || inferredTaskMode;
  const readOnlyMode = productRepairRequest && !isReadOnlyTaskMode(explicitTaskMode)
    ? false
    : explicitReadOnlyMode ?? isReadOnlyTaskMode(taskMode);
  const projectDomain =
    readString(readPriorityField("project_domain")) ||
    classifyWorkerTaskDomain([originalRequestText, requestText].join("\n"));
  const taskType = readString(readPriorityField("task_type")) || null;
  const requestedMode = readString(readExecutionPolicyField("requested_mode")) || null;
  const finalMode = readString(readExecutionPolicyField("final_mode")) || null;
  const executionIntent = readString(readExecutionPolicyField("execution_intent")) || null;
  const explicitRepairMode = readNullableBooleanFlag(readExecutionPolicyField("repair_mode"));
  const systemRepairMode = isSystemRepairMode({
    projectDomain,
    taskType,
    batchCode: approvedBatch,
  });
  const repairMode = systemRepairMode && explicitRepairMode !== false;
  const repairScope = repairMode
    ? readString(readExecutionPolicyField("repair_scope")) || SYSTEM_REPAIR_SCOPE_TEXT
    : readString(readExecutionPolicyField("repair_scope")) || null;
  const explicitVerificationOnly = readNullableBooleanFlag(readExecutionPolicyField("verification_only"));
  const explicitWorkerOnly = readNullableBooleanFlag(readExecutionPolicyField("worker_only"));
  const explicitAllowNoChangeSuccess = readNullableBooleanFlag(
    readExecutionPolicyField("allow_no_change_success")
  );
  const verificationOnly = explicitVerificationOnly === true;
  const workerOnly = explicitWorkerOnly === true;
  const policyDefaults = {
    task_type: taskType,
    requested_mode: requestedMode,
    final_mode: finalMode,
    ["task_" + "mode"]: taskMode,
    execution_intent: executionIntent,
    task_goal: readContractTextValue(readExecutionPolicyField("task_goal")),
    original_request_text: originalRequestText,
  };
  const defaultCodeChangesRequired = defaultCodeChangesRequiredForPolicy(policyDefaults);
  const explicitCodeChangesRequired = readNullableBooleanFlag(
    readExecutionPolicyField("code_changes_required")
  );
  const explicitCodexRequired = readNullableBooleanFlag(readExecutionPolicyField("codex_required"));
  const explicitGitCommitRequired = readNullableBooleanFlag(
    readExecutionPolicyField("git_commit_required")
  );
  const explicitGitPushRequired = readNullableBooleanFlag(
    readExecutionPolicyField("git_push_required")
  );
  const codeChangesRequired =
    verificationOnly || workerOnly
      ? false
      : explicitCodeChangesRequired ?? defaultCodeChangesRequired;
  const codexRequired =
    verificationOnly || workerOnly ? false : explicitCodexRequired ?? codeChangesRequired;
  const gitCommitRequired =
    verificationOnly || workerOnly ? false : explicitGitCommitRequired ?? codeChangesRequired;
  const gitPushRequired = verificationOnly
    ? false
    : explicitGitPushRequired ?? codeChangesRequired;
  const executionPolicyConflict =
    /^(?:code[_ -]?change[_ -]?required|code[_ -]?changes?[_ -]?required)$/i.test(executionIntent || "") &&
    (verificationOnly ||
      workerOnly ||
      explicitCodeChangesRequired === false ||
      explicitCodexRequired === false ||
      explicitGitCommitRequired === false)
      ? "EXPLICIT_FALSE_OVERRIDES_CODE_CHANGE_INTENT"
      : null;
  const deterministicGitOperation = Boolean(
    codeChangesRequired === false &&
      codexRequired === false &&
      gitCommitRequired === false &&
      gitPushRequired === true
  );
  const approvalRequired =
    readNullableBooleanFlag(readExecutionPolicyField("approval_required"));
  const allowNoChangeSuccess =
    explicitAllowNoChangeSuccess === true &&
    verificationOnly &&
    explicitCodeChangesRequired === false &&
    explicitCodexRequired === false &&
    explicitGitCommitRequired === false &&
    explicitGitPushRequired === false;
  const rawAllowedScope = readString(readPriorityField("allowed_scope")) || null;
  const rawExactAllowedScope = readString(readExecutionPolicyField("exact_allowed_scope")) || null;
  const allowedScope = repairMode ? SYSTEM_REPAIR_SCOPE_TEXT : rawAllowedScope;
  const exactAllowedScope = repairMode ? SYSTEM_REPAIR_SCOPE_TEXT : rawExactAllowedScope;
  const exactAllowedScopeCountValue = readPriorityField("exact_allowed_scope_count");
  const exactAllowedScopeCount =
    (exactAllowedScopeCountValue !== null &&
    exactAllowedScopeCountValue !== undefined &&
    String(exactAllowedScopeCountValue).trim() !== ""
      ? String(exactAllowedScopeCountValue).trim()
      : null) ||
    (exactAllowedScope ? String(extractExactAllowedScopePaths(exactAllowedScope).length) : null);
  const forbiddenScope = readString(readExecutionPolicyField("forbidden_scope")) || null;
  const workerReadOnlyMode = taskMode === TASK_MODES.WORKER_READ_ONLY;
  const writableScope = workerReadOnlyMode
    ? "[]"
    : readContractTextValue(readPriorityField("writable_scope")) || allowedScope || null;
  const readableScope =
    readContractTextValue(readPriorityField("readable_scope")) ||
    (workerReadOnlyMode
      ? "code, configuration, logs, and explicitly specified external read-only resources required by the original task"
      : null);
  const readOnlyOperations =
    readContractTextValue(readPriorityField("read_only_operations")) ||
    (workerReadOnlyMode
      ? "non-destructive diagnostics requested by original_request_text"
      : null);
  const forbiddenOperations =
    readContractTextValue(readPriorityField("forbidden_operations")) ||
    (workerReadOnlyMode
      ? "file writes, apply_patch, git add, git commit, git push, checkout, merge, rebase, reset, deployment, database writes"
      : null);
  const taskGoal =
    readContractTextValue(readPriorityField("task_goal")) ||
    extractTaskGoalFromText(originalRequestText) ||
    null;
  const requiredOutputFields =
    readContractTextValue(readPriorityField("required_output_fields")) ||
    extractRequiredOutputFieldsFromText(originalRequestText) ||
    null;
  const acceptanceConditions =
    readContractTextValue(readPriorityField("acceptance_conditions")) ||
    extractAcceptanceConditionsFromText(originalRequestText) ||
    null;
  const route = readString(readPriorityField("route")) || null;
  const contextSource = explicitContext
    ? "explicit_hermes_worker_context"
    : hasStructuredPayloadContext(payload) || hasPayloadContext(payload)
    ? "payload"
    : WORKER_CONTEXT_CORE_FIELDS.some((fieldName) => originalRequestTextFields[fieldName])
    ? "original_request_text"
    : WORKER_CONTEXT_CORE_FIELDS.some((fieldName) => requestTextFields[fieldName])
    ? "request_text"
    : "automatic_classification";
  const contextWarnings =
    contextSource === "explicit_hermes_worker_context"
      ? []
      : [`${CONTEXT_MISSING_WARNING}: explicit HERMES_WORKER_CONTEXT missing; using ${contextSource}`];
  const workerReadOnlyContextIncomplete = Boolean(
    workerReadOnlyMode &&
      (!approvedBatch ||
        !projectDomain ||
        taskMode !== TASK_MODES.WORKER_READ_ONLY ||
        readOnlyMode !== true ||
        !originalRequestTextPreserved ||
        !originalRequestText ||
        !taskGoal ||
        !requiredOutputFields ||
        !acceptanceConditions ||
        !forbiddenScope)
  );
  const contextReconstructFailed = Boolean(
      !projectDomain ||
      !taskMode ||
      readOnlyMode === null ||
      (!isReadOnlyTaskMode(taskMode) && !allowedScope) ||
      workerReadOnlyContextIncomplete
  );
  const changedFiles = uniqueSortedPaths(
    readStringList(
      overrides.changedFiles ??
        readPayloadContextField(payload, "changed_files") ??
        readPayloadContextField(result, "changed_files")
    )
  );
  const pushed =
    typeof overrides.pushed === "boolean"
      ? overrides.pushed
      : readNullableBooleanFlag(readPriorityField("pushed")) ?? false;
  const workerStage =
    readString(overrides.workerStage) ||
    readString(overrides.workflowStage) ||
    readString(readPriorityField("worker_stage"));

  return {
    context_source: contextSource,
    context_reconstruct_failed: contextReconstructFailed,
    context_warnings: contextWarnings,
    project_domain: projectDomain,
    task_type: taskType,
    requested_mode: requestedMode,
    final_mode: finalMode,
    ["task_" + "mode"]: taskMode,
    read_only_mode: readOnlyMode,
    repair_mode: repairMode,
    repair_scope: repairScope,
    verification_only: verificationOnly,
    worker_only: workerOnly,
    allow_no_change_success: allowNoChangeSuccess,
    execution_intent: executionIntent,
    execution_policy_conflict: executionPolicyConflict,
    deterministic_git_operation: deterministicGitOperation,
    code_changes_required: codeChangesRequired,
    codex_required: codexRequired,
    git_commit_required: gitCommitRequired,
    git_push_required: gitPushRequired,
    approval_required: approvalRequired,
    execution_policy_source: executionPolicySource,
    execution_policy_batch_code: approvedBatch || null,
    execution_policy_context_id:
      readString(readExecutionPolicyField("execution_policy_context_id")) ||
      readString(readExecutionPolicyField("context_id")) ||
      null,
    execution_policy_request_hash: executionPolicyRequestHash,
    execution_policy_inherited: false,
    execution_policy_inheritance_rejected_reason: policyInheritanceRejectedReason,
    allowed_scope: allowedScope,
    exact_allowed_scope: exactAllowedScope,
    exact_allowed_scope_count: exactAllowedScopeCount,
    writable_scope: writableScope,
    readable_scope: readableScope,
    read_only_operations: readOnlyOperations,
    forbidden_operations: forbiddenOperations,
    forbidden_scope: forbiddenScope,
    task_goal: taskGoal,
    required_output_fields: requiredOutputFields,
    acceptance_conditions: acceptanceConditions,
    original_request_text: originalRequestText,
    original_request_text_preserved: originalRequestTextPreserved,
    original_request_text_base64: Buffer.from(originalRequestText, "utf8").toString("base64"),
    route,
    payload: payload || null,
    approved_batch: approvedBatch || null,
    attempt_id:
      readString(overrides.attemptId) ||
      readString(readPriorityField("attempt_id")) ||
      readString(job?.attempt_id) ||
      readString(job?.active_attempt_id) ||
      null,
    worker_stage: workerStage,
    workflow_stage: workerStage,
    final_report_status:
      readString(overrides.finalReportStatus) ||
      readString(readPriorityField("final_report_status")) ||
      null,
    effective_final_status:
      readString(overrides.effectiveFinalStatus) ||
      readString(readPriorityField("effective_final_status")) ||
      null,
    failure_code:
      readString(overrides.failureCode) ||
      readString(readPriorityField("failure_code")) ||
      null,
    failure_stage:
      readString(overrides.failureStage) ||
      readString(readPriorityField("failure_stage")) ||
      null,
    changed_files: changedFiles,
    git_commit_sha:
      readString(overrides.gitCommitSha) ||
      readString(readPriorityField("git_commit_sha")) ||
      readString(job?.git_commit_sha) ||
      null,
    next_batch:
      readString(overrides.nextBatch) ||
      readString(readPriorityField("next_batch")) ||
      null,
    completed_at:
      readString(overrides.completedAt) ||
      readString(readPriorityField("completed_at")) ||
      readString(job?.completed_at) ||
      null,
    pushed,
    deploy_status:
      readString(overrides.deployStatus) ||
      readString(readPriorityField("deploy_status")) ||
      null,
  };
}

function readLatestWorkerContextFieldValue(text, fieldName) {
  const values = expandWorkerContextTexts(text).flatMap((contextText) =>
    extractWorkerContextFieldValues(contextText, fieldName)
  );
  return values.length > 0 ? values[values.length - 1] : null;
}

function readMergedWorkerContextFieldValue(text, fieldName) {
  const values = expandWorkerContextTexts(text).flatMap((contextText) =>
    extractWorkerContextFieldValues(contextText, fieldName)
  );
  const uniqueValues = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return uniqueValues.length > 0 ? uniqueValues.join(", ") : null;
}

function readLatestOriginalRequestTextFromContexts(text) {
  const values = expandWorkerContextTexts(text).flatMap(extractOriginalRequestTextsFromContext);
  return values.length > 0 ? values[values.length - 1] : null;
}

function resolveWorkerJobContract(job, overrides = {}) {
  return normalizeWorkerContext(job, overrides);
}

const CODE_CHANGE_REQUIRED_TASK_TYPES = new Set([
  "system_repair",
  "bug_fix",
  "architecture_fix",
  "implementation",
  "feature",
  "migration",
  "refactor",
]);

function textHasWriteChangeIntent(text) {
  return /修复|修改|实现|增加|新增|删除|重构|迁移|fix|repair|modify|implement|add|delete|refactor|migrat/i.test(
    String(text || "")
  );
}

function isWriteExecutionMode(value) {
  return [
    TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED,
    TASK_MODES.PRODUCT_WRITE_ALLOWED,
    TASK_MODES.DOCS_WRITE_ALLOWED,
    "write_allowed",
    "automation_system_write_allowed",
  ].includes(String(value || "").trim());
}

function defaultCodeChangesRequiredForPolicy(contract) {
  const taskType = String(contract?.task_type || "").trim();
  const executionText = [
    contract?.execution_intent,
    contract?.task_goal,
    contract?.original_request_text,
  ]
    .filter(Boolean)
    .join("\n");

  return Boolean(
    CODE_CHANGE_REQUIRED_TASK_TYPES.has(taskType) ||
      isWriteExecutionMode(contract?.task_mode) ||
      isWriteExecutionMode(contract?.final_mode) ||
      (isWriteExecutionMode(contract?.requested_mode) && textHasWriteChangeIntent(executionText))
  );
}

function allowsVerificationOnlyNoChangeSuccess(contract) {
  return Boolean(
    contract?.verification_only === true &&
      contract?.allow_no_change_success === true &&
      contract?.code_changes_required === false &&
      contract?.codex_required === false &&
      contract?.git_commit_required === false &&
      contract?.git_push_required === false
  );
}

function isVerificationOnlyNoopTask(job, contract = resolveWorkerJobContract(job)) {
  return allowsVerificationOnlyNoChangeSuccess(contract);
}

function getMissingWorkerReadOnlyContextFields(contract) {
  if (!contract || contract.task_mode !== TASK_MODES.WORKER_READ_ONLY) {
    return [];
  }

  const missing = [];
  if (!readString(contract.approved_batch)) missing.push("batch_code");
  if (!readString(contract.project_domain)) missing.push("project_domain");
  if (contract.task_mode !== TASK_MODES.WORKER_READ_ONLY) missing.push("task_mode");
  if (contract.read_only_mode !== true) missing.push("read_only_mode");
  if (!contract.original_request_text_preserved || !readString(contract.original_request_text)) {
    missing.push("original_request_text");
  }
  if (!readString(contract.task_goal)) missing.push("task_goal");
  if (!readString(contract.required_output_fields)) missing.push("required_output_fields");
  if (!readString(contract.acceptance_conditions)) missing.push("acceptance_conditions");
  if (!readString(contract.forbidden_scope)) missing.push("forbidden_scope");
  return missing;
}

function createWorkerReadOnlyContextIncompleteError(missingFields, details = {}) {
  const missing = uniqueSortedPaths(missingFields || []);
  const error = new Error(
    [
      WORKER_READONLY_CONTEXT_INCOMPLETE,
      "worker_read_only context is incomplete; refusing to downgrade the task to generic git status/git diff.",
      missing.length
        ? `missing_worker_readonly_context_fields: ${missing.join(", ")}`
        : "missing_worker_readonly_context_fields: none",
      details.missingRequiredOutputFields?.length
        ? `missing_required_output_fields: ${details.missingRequiredOutputFields.join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n")
  );

  error.code = WORKER_READONLY_CONTEXT_INCOMPLETE;
  error.failureStage = details.failureStage || "worker_readonly_context_validation";
  error.missingWorkerReadonlyContextFields = missing;
  error.missingRequiredOutputFields = details.missingRequiredOutputFields || [];
  return error;
}

function assertWorkerReadOnlyContextComplete(contract) {
  const missingFields = getMissingWorkerReadOnlyContextFields(contract);
  if (missingFields.length > 0) {
    throw createWorkerReadOnlyContextIncompleteError(missingFields);
  }
}

function assertWorkerReadOnlyTaskGoalComplete(job, reportText) {
  const contract = resolveWorkerJobContract(job);
  if (contract.task_mode !== TASK_MODES.WORKER_READ_ONLY) {
    return;
  }

  assertWorkerReadOnlyContextComplete(contract);

  const missingRequiredOutputFields = getMissingWorkerReadOnlyRequiredOutputFields(
    contract,
    reportText
  );
  if (missingRequiredOutputFields.length > 0) {
    throw createWorkerReadOnlyContextIncompleteError([], {
      failureStage: "worker_readonly_required_output_validation",
      missingRequiredOutputFields,
    });
  }
}

function formatWorkerJobContractLines(contract, options = {}) {
  const originalRequestValue = options.includeOriginalRequest === false
    ? contract.original_request_text
      ? "[present]"
      : "null"
    : contract.original_request_text || "null";
  return [
    "[Worker job payload contract]",
    `context_source: ${contract.context_source || "null"}`,
    `context_reconstruct_failed: ${contract.context_reconstruct_failed ? "true" : "false"}`,
    `project_domain: ${contract.project_domain || "null"}`,
    `task_type: ${contract.task_type || "null"}`,
    `requested_mode: ${contract.requested_mode || "null"}`,
    `final_mode: ${contract.final_mode || "null"}`,
    `task_mode: ${contract.task_mode || "null"}`,
    `read_only_mode: ${contract.read_only_mode ? "true" : "false"}`,
    `verification_only: ${contract.verification_only ? "true" : "false"}`,
    `worker_only: ${contract.worker_only ? "true" : "false"}`,
    `allow_no_change_success: ${contract.allow_no_change_success ? "true" : "false"}`,
    `execution_intent: ${contract.execution_intent || "null"}`,
    `execution_policy_conflict: ${contract.execution_policy_conflict || "null"}`,
    `deterministic_git_operation: ${contract.deterministic_git_operation ? "true" : "false"}`,
    `code_changes_required: ${contract.code_changes_required ? "true" : "false"}`,
    `codex_required: ${contract.codex_required ? "true" : "false"}`,
    `git_commit_required: ${contract.git_commit_required ? "true" : "false"}`,
    `git_push_required: ${contract.git_push_required ? "true" : "false"}`,
    `approval_required: ${contract.approval_required === null || contract.approval_required === undefined ? "null" : contract.approval_required ? "true" : "false"}`,
    `execution_policy_source: ${contract.execution_policy_source || "null"}`,
    `execution_policy_batch_code: ${contract.execution_policy_batch_code || "null"}`,
    `execution_policy_context_id: ${contract.execution_policy_context_id || "null"}`,
    `execution_policy_request_hash: ${contract.execution_policy_request_hash || "null"}`,
    `execution_policy_inherited: ${contract.execution_policy_inherited ? "true" : "false"}`,
    `execution_policy_inheritance_rejected_reason: ${contract.execution_policy_inheritance_rejected_reason || "null"}`,
    `allowed_scope: ${contract.allowed_scope || "null"}`,
    `exact_allowed_scope: ${contract.exact_allowed_scope || "null"}`,
    `exact_allowed_scope_count: ${contract.exact_allowed_scope_count || "null"}`,
    `writable_scope: ${contract.writable_scope || "null"}`,
    `readable_scope: ${contract.readable_scope || "null"}`,
    `read_only_operations: ${contract.read_only_operations || "null"}`,
    `forbidden_operations: ${contract.forbidden_operations || "null"}`,
    `forbidden_scope: ${contract.forbidden_scope || "null"}`,
    `task_goal: ${contract.task_goal || "null"}`,
    `required_output_fields: ${contract.required_output_fields || "null"}`,
    `acceptance_conditions: ${contract.acceptance_conditions || "null"}`,
    `original_request_text: ${originalRequestValue}`,
    `original_request_text_preserved: ${contract.original_request_text_preserved ? "true" : "false"}`,
    `original_request_text_base64: ${contract.original_request_text_base64 ? "[present]" : "null"}`,
    `route: ${contract.route || "null"}`,
    "payload: hermes_jobs.payload",
    `approved_batch: ${contract.approved_batch || "null"}`,
    `batch_code: ${contract.approved_batch || "null"}`,
    `attempt_id: ${contract.attempt_id || "null"}`,
    `worker_stage: ${contract.worker_stage || "null"}`,
    `workflow_stage: ${contract.workflow_stage || "null"}`,
    `final_report_status: ${contract.final_report_status || "null"}`,
    `effective_final_status: ${contract.effective_final_status || "null"}`,
    `failure_code: ${contract.failure_code || "null"}`,
    `failure_stage: ${contract.failure_stage || "null"}`,
    `changed_files: ${contract.changed_files.length ? contract.changed_files.join(", ") : "[]"}`,
    `git_commit_sha: ${contract.git_commit_sha || "null"}`,
    `next_batch: ${contract.next_batch || "null"}`,
    `completed_at: ${contract.completed_at || "null"}`,
    `pushed: ${contract.pushed ? "true" : "false"}`,
    `deploy_status: ${contract.deploy_status || "null"}`,
    `context_warnings: ${contract.context_warnings?.length ? contract.context_warnings.join("; ") : "[]"}`,
  ];
}

function buildWorkerReportContractExtra(contract) {
  const codexDiagnostics = getCodexReportDiagnostics();
  return {
    report_schema_version: CANONICAL_WORKER_REPORT_SCHEMA_VERSION,
    worker_instance_id: WORKER_NAME,
    batch_code: contract.approved_batch,
    context_source: contract.context_source,
    context_reconstruct_failed: contract.context_reconstruct_failed,
    context_warnings: contract.context_warnings || [],
    project_domain: contract.project_domain,
    task_type: contract.task_type,
    requested_mode: contract.requested_mode,
    final_mode: contract.final_mode,
    task_mode: contract.task_mode,
    read_only_mode: contract.read_only_mode,
    repair_mode: contract.repair_mode,
    repair_scope: contract.repair_scope,
    verification_only: contract.verification_only,
    worker_only: contract.worker_only,
    allow_no_change_success: contract.allow_no_change_success,
    execution_intent: contract.execution_intent,
    execution_policy_conflict: contract.execution_policy_conflict,
    deterministic_git_operation: contract.deterministic_git_operation,
    code_changes_required: contract.code_changes_required,
    codex_required: contract.codex_required,
    git_commit_required: contract.git_commit_required,
    git_push_required: contract.git_push_required,
    approval_required: contract.approval_required,
    execution_policy_source: contract.execution_policy_source,
    execution_policy_batch_code: contract.execution_policy_batch_code,
    execution_policy_context_id: contract.execution_policy_context_id,
    execution_policy_request_hash: contract.execution_policy_request_hash,
    execution_policy_inherited: contract.execution_policy_inherited,
    execution_policy_inheritance_rejected_reason:
      contract.execution_policy_inheritance_rejected_reason,
    allowed_scope: contract.allowed_scope,
    exact_allowed_scope: contract.exact_allowed_scope,
    exact_allowed_scope_count: contract.exact_allowed_scope_count,
    writable_scope: contract.writable_scope,
    readable_scope: contract.readable_scope,
    read_only_operations: contract.read_only_operations,
    forbidden_operations: contract.forbidden_operations,
    forbidden_scope: contract.forbidden_scope,
    task_goal: contract.task_goal,
    required_output_fields: contract.required_output_fields,
    acceptance_conditions: contract.acceptance_conditions,
    original_request_text: contract.original_request_text,
    original_request_text_preserved: contract.original_request_text_preserved,
    original_request_text_base64: contract.original_request_text_base64,
    route: contract.route,
    approved_batch: contract.approved_batch,
    worker_stage: contract.worker_stage,
    workflow_stage: contract.workflow_stage,
    final_report_status: contract.final_report_status,
    effective_final_status: contract.effective_final_status,
    failure_code: contract.failure_code,
    failure_stage: contract.failure_stage,
    changed_files: contract.changed_files,
    committed_files: contract.changed_files,
    unexpected_changed_files: [],
    git_commit_sha: contract.git_commit_sha,
    worker_git_push: contract.pushed,
    git_push: contract.pushed,
    pushed_branch: null,
    remote_contains_commit: false,
    repository_clean_after_push: false,
    terminal_state_persisted: true,
    post_completion_state_applied: true,
    final_report_source: "worker_runtime_report",
    next_batch: contract.next_batch,
    completed_at: contract.completed_at,
    pushed: contract.pushed,
    deploy_status: contract.deploy_status,
    codex_resolution_source: codexDiagnostics.codex_resolution_source,
    codex_requested_path: codexDiagnostics.codex_requested_path,
    codex_executable_resolved: codexDiagnostics.codex_executable_resolved,
    codex_executable_exists: codexDiagnostics.codex_executable_exists,
    codex_executable_file_type: codexDiagnostics.codex_executable_file_type,
    codex_executable_version: codexDiagnostics.codex_executable_version,
    codex_executable_is_app_alias: codexDiagnostics.codex_executable_is_app_alias,
    codex_preflight_status: codexDiagnostics.codex_preflight_status,
  };
}

function isAutomationAllowedByExplicitScope(filePath, requestText) {
  const normalized = normalizeGitPath(filePath);

  return extractAllowedScopePaths(requestText).some(
    (allowedPath) => automationAllowedScopePathMatches(allowedPath, normalized)
  );
}

function automationAllowedScopePathMatches(allowedPath, filePath) {
  const normalizedAllowed = normalizeGitPath(allowedPath);
  const normalizedFile = normalizeGitPath(filePath);

  if (!normalizedAllowed || normalizedAllowed === "docs/**") {
    return false;
  }

  if (normalizedAllowed.endsWith("/**")) {
    if (!AUTOMATION_ALLOWED_SCOPE_WILDCARDS.includes(normalizedAllowed)) {
      return false;
    }

    const prefix = normalizedAllowed.slice(0, -3);
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }

  if (normalizedAllowed.includes("*")) {
    return false;
  }

  if (isAutomationWriteAllowedPath(normalizedAllowed)) {
    return normalizedFile === normalizedAllowed;
  }

  if (isExplicitAutomationAllowedDocPath(normalizedAllowed)) {
    return normalizedFile === normalizedAllowed;
  }

  return false;
}

function buildNormalizedScopeText(contract) {
  return [
    contract?.allowed_scope ? `allowed_scope=${contract.allowed_scope}` : "",
    contract?.forbidden_scope ? `forbidden_scope=${contract.forbidden_scope}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function extractScopeValuePaths(scopeValue) {
  return uniqueSortedPaths(extractPathLikeTokens(` ${String(scopeValue || "")}`));
}

function isProductWriteAllowedPath(filePath) {
  return pathMatchesPrefix(filePath, PRODUCT_WRITE_ALLOWED_PREFIXES);
}

function isBatchFixProductTaskText(text) {
  const raw = String(text || "");
  return BATCH_FIX_PATTERN.test(raw) && BATCH_FIX_PRODUCT_SIGNAL_PATTERN.test(raw);
}

function isBatchFixProductAllowedPath(filePath) {
  return pathMatchesPrefix(filePath, BATCH_FIX_PRODUCT_ALLOWED_PATHS);
}

function isSystemChangeForbiddenPath(filePath) {
  return pathMatchesPrefix(filePath, SYSTEM_CHANGE_FORBIDDEN_PATHS);
}

function normalizeFailureMemory(memory) {
  return memory && typeof memory === "object" && !Array.isArray(memory)
    ? { ...memory }
    : {};
}

function recordFailureMemory(memory, fingerprint, batchCode, now = new Date().toISOString()) {
  const normalizedMemory = normalizeFailureMemory(memory);
  const errorFingerprint = String(fingerprint || "").trim();
  if (!Object.prototype.hasOwnProperty.call(FAILURE_FINGERPRINTS, errorFingerprint)) {
    throw new Error(`Unknown failure fingerprint: ${errorFingerprint || "empty"}`);
  }

  const previous = normalizedMemory[errorFingerprint] || {};
  const count = Number(previous.count || 0) + 1;
  const entry = {
    error_fingerprint: errorFingerprint,
    first_seen_at: previous.first_seen_at || now,
    last_seen_at: now,
    count,
    last_batch: batchCode || previous.last_batch || "unknown",
    suggested_guard: FAILURE_FINGERPRINTS[errorFingerprint],
  };
  const status =
    count >= 3 ? "blocked" : count === 2 ? "repeated_warning" : "warning";

  return {
    memory: {
      ...normalizedMemory,
      [errorFingerprint]: entry,
    },
    entry,
    status,
    blocked: status === "blocked",
  };
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readStructuredResultField(content, fieldName) {
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(fieldName).replace(/_/g, "[_\\s-]*")}\\s*[:=：]\\s*(.*?)\\s*$`,
    "i"
  );

  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const match = rawLine.match(pattern);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }

  return null;
}

function normalizeTerminalStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["success", "succeeded", "completed", "complete"].includes(text)) return "succeeded";
  if (["fail", "failed", "error"].includes(text)) return "failed";
  if (["cancel", "cancelled", "canceled"].includes(text)) return "cancelled";
  if (["queued", "pending"].includes(text)) return "queued";
  if (["running", "in_progress"].includes(text)) return "running";
  return null;
}

function normalizeFailureCodeValue(value) {
  const text = String(value || "").trim();
  if (!text || /^(null|none|n\/a|not[_ -]?provided|undefined)$/i.test(text)) {
    return null;
  }

  const code = text
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  const aliases = {
    TEST_FAILURE: "TEST_FAILED",
    TESTS_FAILED: "TEST_FAILED",
    NODE_TEST_FAILED: "TEST_FAILED",
    TSC_FAILED: "TYPESCRIPT_FAILED",
    TYPESCRIPT_CHECK_FAILED: "TYPESCRIPT_FAILED",
    TYPECHECK_FAILED: "TYPESCRIPT_FAILED",
    OUT_OF_SCOPE_BUSINESS_CHANGE: "OUT_OF_SCOPE_CHANGE",
    OUT_OF_SCOPE_SYSTEM_CHANGE: "OUT_OF_SCOPE_CHANGE",
    BUSINESS_PAGE_BOUNDARY_VIOLATION: "OUT_OF_SCOPE_CHANGE",
    READ_ONLY_VIOLATION: "READ_ONLY_MODE_VIOLATION",
    READONLY_MODE_VIOLATION: "READ_ONLY_MODE_VIOLATION",
    NOOP_RUN: "NO_FIX_APPLIED",
    NO_OP_RUN: "NO_FIX_APPLIED",
    NO_FILE_CHANGE: "NO_FIX_APPLIED",
    NO_FILE_CHANGES: "NO_FIX_APPLIED",
    WORKER_READONLY_CONTEXT_INCOMPLETE: "WORKER_READONLY_CONTEXT_INCOMPLETE",
    WORKER_READ_ONLY_CONTEXT_INCOMPLETE: "WORKER_READONLY_CONTEXT_INCOMPLETE",
    CODEX_QUOTA_EXHAUSTED: "CODEX_USAGE_LIMIT",
    CODEX_CREDITS_EXHAUSTED: "CODEX_USAGE_LIMIT",
    CODEX_USAGE_LIMIT_REACHED: "CODEX_USAGE_LIMIT",
    USAGE_LIMIT: "CODEX_USAGE_LIMIT",
    QUOTA_EXHAUSTED: "CODEX_USAGE_LIMIT",
    CONTEXT_FAILED: "CONTEXT_RECONSTRUCT_FAILED",
    ORIGINAL_BATCH_CONTEXT_MISSING: "CONTEXT_RECONSTRUCT_FAILED",
    COMMIT_FAILED: "GIT_COMMIT_FAILED",
    PUSH_FAILED: "GIT_PUSH_FAILED",
    TLS_HANDSHAKE_FAILED: "GIT_SYNC_FAILED",
    NETWORK_TIMEOUT: "GIT_SYNC_FAILED",
    CONNECTION_RESET: "GIT_SYNC_FAILED",
  };

  return aliases[code] || code;
}

function classifyNonTaskFailureCode(text) {
  const raw = String(text || "");
  for (const item of NON_TASK_FAILURE_PATTERNS) {
    if (item.pattern.test(raw)) {
      return item.code;
    }
  }
  return null;
}

function classifyFailureCodeFromText(text) {
  const raw = String(text || "");
  const nonTaskFailureCode = classifyNonTaskFailureCode(raw);
  if (nonTaskFailureCode) return nonTaskFailureCode;
  if (isCodexUsageLimitText(raw)) {
    return CODEX_USAGE_LIMIT;
  }
  if (
    /git\s+(?:fetch|pull|ls-remote|sync|remote)|schannel|TLS|SSL|CERT|handshake|timed?\s*out|timeout|ECONNRESET|EAI_AGAIN|ENOTFOUND|fetch failed|connection reset/i.test(
      raw
    )
  ) {
    return "GIT_SYNC_FAILED";
  }
  if (/NO_FIX_APPLIED|no_fix_applied\s*[:=]\s*(true|yes)|Task goal status:\s*failed_no_fix_applied/i.test(raw)) {
    return "NO_FIX_APPLIED";
  }
  if (/READ_ONLY_MODE_VIOLATION|read_only_mode_violation\s*[:=]\s*(true|yes)|Read-only violation:\s*yes|Task goal status:\s*failed_read_only_mode_violation/i.test(raw)) {
    return "READ_ONLY_MODE_VIOLATION";
  }
  if (/TASK_MODE_MISMATCH|task_mode_mismatch\s*[:=]\s*(true|yes)|Task goal status:\s*failed_task_mode_mismatch/i.test(raw)) {
    return "TASK_MODE_MISMATCH";
  }
  if (/MISSING_REQUIRED_DOCS|Task goal status:\s*failed_missing_required_docs/i.test(raw)) {
    return "MISSING_REQUIRED_DOCS";
  }
  if (/INSUFFICIENT_DOC_OUTPUT|insufficient_doc_output\s*[:=]\s*(true|yes)|Task goal status:\s*failed_insufficient_doc_output/i.test(raw)) {
    return "INSUFFICIENT_DOC_OUTPUT";
  }
  if (/INCOMPLETE_QA_REPORT|incomplete_qa_report\s*[:=]\s*(true|yes)|Task goal status:\s*failed_incomplete_qa_report/i.test(raw)) {
    return "INCOMPLETE_QA_REPORT";
  }
  if (/INCOMPLETE_ARCHITECTURE_REPORT|incomplete_architecture_report\s*[:=]\s*(true|yes)|Task goal status:\s*failed_incomplete_architecture_report/i.test(raw)) {
    return "INCOMPLETE_ARCHITECTURE_REPORT";
  }
  if (/WORKER_READONLY_CONTEXT_INCOMPLETE|worker_readonly_context_incomplete|missing_worker_readonly_context_fields|Task goal status:\s*failed_worker_readonly_context_incomplete/i.test(raw)) {
    return "WORKER_READONLY_CONTEXT_INCOMPLETE";
  }
  if (/node\s+--test|tests?\s+failed|test\s+failure|测试失败/i.test(raw)) {
    return "TEST_FAILED";
  }
  if (/typescript|tsc|typecheck|TypeScript\s+检查失败/i.test(raw)) {
    return "TYPESCRIPT_FAILED";
  }
  if (
    /OUT_OF_SCOPE|BUSINESS_PAGE_BOUNDARY_VIOLATION|越界修改|范围边界|context_reconstruct_failed\s*[:=：]\s*true/i.test(
      raw
    )
  ) {
    return /context_reconstruct_failed\s*[:=：]\s*true/i.test(raw)
      ? "CONTEXT_RECONSTRUCT_FAILED"
      : "OUT_OF_SCOPE_CHANGE";
  }
  if (/ORIGINAL_BATCH_CONTEXT_MISSING|上下文恢复失败|context.*(?:missing|failed|缺失|失败)/i.test(raw)) {
    return "CONTEXT_RECONSTRUCT_FAILED";
  }
  if (/git\s+commit|commit\s+失败|commit failed/i.test(raw)) {
    return "GIT_COMMIT_FAILED";
  }
  if (/git\s+push|push\s+失败|push failed/i.test(raw)) {
    return "GIT_PUSH_FAILED";
  }
  return null;
}

function isTrueTaskFailureCode(code) {
  return TRUE_TASK_FAILURE_CODES.has(normalizeFailureCodeValue(code));
}

function isNonTaskFailureCode(code) {
  return NON_TASK_FAILURE_CODES.has(normalizeFailureCodeValue(code));
}

function extractNextBatchFromText(text) {
  const explicit = readStructuredResultField(text, "next_batch");
  const match = String(explicit || text || "").match(/\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i);
  return match ? match[0].toUpperCase() : null;
}

function inferNextBatchFromBatchCode(batchCode) {
  const text = String(batchCode || "").trim();
  const match = text.match(/^(BATCH-[A-Z]+-)(\d+)$/i);
  if (!match) return null;
  const nextNumber = String(Number(match[2]) + 1).padStart(match[2].length, "0");
  return `${match[1].toUpperCase()}${nextNumber}`;
}

function buildFailureMemoryStatus(finalResult) {
  const status = normalizeTerminalStatus(finalResult?.effective_final_status);
  const failureCode = normalizeFailureCodeValue(finalResult?.failure_code);
  if (status === "succeeded") return "skipped_success";
  if (status === "cancelled") return "skipped_cancelled";
  if (status !== "failed") return "skipped_non_terminal";
  if (!failureCode || isNonTaskFailureCode(failureCode)) return "skipped_non_task_failure";
  return isTrueTaskFailureCode(failureCode) ? "recordable" : "skipped_non_task_failure";
}

function normalizeWorkerFinalResult(input = {}) {
  const job = input.job || {};
  const error = input.error || null;
  const errorText = error instanceof Error ? error.message : String(error || "");
  const analysis = error ? classifyFailure(error) : null;
  const reportText = [
    input.resultText,
    input.errorText,
    input.payload,
    errorText,
  ]
    .filter(Boolean)
    .join("\n");
  const jobResult = readPlainRecord(job.result);
  const acceptedFinalReportData =
    readAcceptedFinalReportData(
      input.acceptedFinalReportResponse ||
        input.accepted_final_report_response ||
        input.finalReportResponse ||
        input.final_report_response
    ) ||
    readProjectDirectorReportData(jobResult?.project_director_report) ||
    null;
  const terminalSnapshot =
    readPlainRecord(input.terminalStatusSnapshot) ||
    readPlainRecord(input.terminal_status_snapshot) ||
    readPlainRecord(input.effectiveFinalStatusSnapshot) ||
    readPlainRecord(input.effective_final_status_snapshot) ||
    null;
  const readSnapshotRawField = (...keys) => {
    for (const source of [acceptedFinalReportData, terminalSnapshot]) {
      if (!source) continue;
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          const value = source[key];
          if (value !== undefined && value !== null) return value;
        }
      }
    }
    return null;
  };
  const readSnapshotField = (...keys) => {
    for (const source of [acceptedFinalReportData, terminalSnapshot]) {
      if (!source) continue;
      for (const key of keys) {
        const value = source[key];
        if (value !== undefined && value !== null && String(value).trim() !== "") {
          return value;
        }
      }
    }
    return null;
  };
  const requestedStatus =
    readSnapshotField("effective_final_status", "effectiveFinalStatus") ||
    input.effective_final_status ||
    input.effectiveFinalStatus ||
    readStructuredResultField(reportText, "effective_final_status") ||
    input.status ||
    input.final_report_status ||
    input.finalReportStatus;
  const nonTaskFailureCode = classifyNonTaskFailureCode(reportText);
  const effectiveFinalStatus =
    normalizeTerminalStatus(requestedStatus) === "failed" && nonTaskFailureCode
      ? normalizeTerminalStatus(input.previousEffectiveFinalStatus) || "running"
      : normalizeTerminalStatus(requestedStatus) || "running";
  const approvedBatch =
    readNullableReportString(readSnapshotField("approved_batch", "approvedBatch", "batch_code", "batchCode")) ||
    readString(input.approved_batch) ||
    readString(input.approvedBatch) ||
    readStructuredResultField(reportText, "approved_batch") ||
    getJobBatchCode(job) ||
    null;
  const rawFailureCode =
    readSnapshotField("failure_code", "failureCode", "error_code", "errorCode") ||
    input.failure_code ||
    input.failureCode ||
    readStructuredResultField(reportText, "failure_code") ||
    readStructuredResultField(reportText, "error_code") ||
    (effectiveFinalStatus === "failed" ? error?.code : null) ||
    (effectiveFinalStatus === "failed" ? classifyFailureCodeFromText(reportText) : null);
  const failureCode =
    effectiveFinalStatus === "failed"
      ? normalizeFailureCodeValue(rawFailureCode) ||
        normalizeFailureCodeValue(classifyFailureCodeFromText(reportText))
      : null;
  const failureStage =
    effectiveFinalStatus === "failed"
      ? readNullableReportString(readSnapshotField("failure_stage", "failureStage")) ||
        readNullableReportString(input.failure_stage) ||
        readNullableReportString(input.failureStage) ||
        readNullableReportString(readStructuredResultField(reportText, "failure_stage")) ||
        (failureCode === CODEX_USAGE_LIMIT ? "codex_execution" : null) ||
        (failureCode === "GIT_SYNC_FAILED" ? "git_sync_preflight" : null) ||
        readStructuredResultField(reportText, "失败阶段") ||
        error?.failureStage ||
        analysis?.stage ||
        null
      : null;
  const nextBatch =
    readNullableReportString(readSnapshotField("next_batch", "nextBatch")) ||
    readString(input.next_batch) ||
    readString(input.nextBatch) ||
    extractNextBatchFromText(reportText) ||
    (effectiveFinalStatus === "succeeded" ? inferNextBatchFromBatchCode(approvedBatch) : null);
  const committedFilesForFinalResult = uniqueSortedPaths(
    readStringList(
      readSnapshotRawField("committed_files", "committedFiles") ||
        input.committed_files ||
        input.committedFiles
    )
  );
  const changedFilesForFinalResult = committedFilesForFinalResult.length
    ? committedFilesForFinalResult
    : uniqueSortedPaths(
        readStringList(
          readSnapshotRawField("changed_files", "changedFiles", "files_changed", "filesChanged") ||
            input.changed_files ||
            input.files_changed
        )
      );

  const finalResult = {
    job_id:
      readString(input.job_id) ||
      readString(input.jobId) ||
      readString(job.id) ||
      readString(job.job_id) ||
      null,
    approved_batch: approvedBatch,
    worker_execution_status:
      readNullableReportString(readSnapshotField("worker_execution_status", "workerExecutionStatus")) ||
      readString(input.worker_execution_status) ||
      readStructuredResultField(reportText, "worker_execution_status") ||
      null,
    task_goal_status:
      readNullableReportString(readSnapshotField("task_goal_status", "taskGoalStatus")) ||
      readString(input.task_goal_status) ||
      readStructuredResultField(reportText, "task_goal_status") ||
      null,
    final_report_status:
      normalizeTerminalStatus(
        readSnapshotField("final_report_status", "finalReportStatus") ||
          input.final_report_status ||
          input.finalReportStatus ||
          input.status
      ) ||
      null,
    effective_final_status: effectiveFinalStatus,
    failure_code: failureCode,
    failure_stage: failureStage,
    changed_files: changedFilesForFinalResult,
    committed_files: committedFilesForFinalResult.length
      ? committedFilesForFinalResult
      : changedFilesForFinalResult,
    codex_changed_files: uniqueSortedPaths(
      readStringList(
        readSnapshotRawField("codex_changed_files", "codexChangedFiles") ||
          input.codex_changed_files ||
          input.codexChangedFiles
      )
    ),
    worktree_changed_files: uniqueSortedPaths(
      readStringList(
        readSnapshotRawField("worktree_changed_files", "worktreeChangedFiles") ||
          input.worktree_changed_files ||
          input.worktreeChangedFiles
      )
    ),
    task_changed_files: uniqueSortedPaths(
      readStringList(
        readSnapshotRawField("task_changed_files", "taskChangedFiles") ||
          input.task_changed_files ||
          input.taskChangedFiles ||
          input.changed_files ||
          input.files_changed
      )
    ),
    unexpected_changed_files: uniqueSortedPaths(
      readStringList(
        readSnapshotRawField("unexpected_changed_files", "unexpectedChangedFiles") ||
          input.unexpected_changed_files ||
          input.unexpectedChangedFiles
      )
    ),
    git_commit_sha:
      readNullableReportString(readSnapshotField("git_commit_sha", "gitCommitSha")) ||
      readString(input.git_commit_sha) ||
      readString(input.gitCommitSha) ||
      readString(job.git_commit_sha) ||
      null,
    pushed:
      readReportPushFlag(
        readSnapshotField("git_push", "gitPush", "pushed"),
        readSnapshotField("github_push_status", "githubPushStatus"),
        readSnapshotField("deploy_status", "deployStatus"),
        input.git_push,
        input.gitPush,
        input.pushed,
        input.github_push_status,
        input.githubPushStatus,
        input.deploy_status,
        input.deployStatus
      ),
    codex_git_push:
      readNullableReportString(readSnapshotField("codex_git_push", "codexGitPush")) ||
      readString(input.codex_git_push) ||
      readString(input.codexGitPush) ||
      null,
    worker_git_push: readReportPushFlag(
      readSnapshotField("worker_git_push", "workerGitPush"),
      input.worker_git_push,
      input.workerGitPush
    ),
    git_push:
      readReportPushFlag(
        readSnapshotField("git_push", "gitPush", "pushed"),
        readSnapshotField("github_push_status", "githubPushStatus"),
        readSnapshotField("deploy_status", "deployStatus"),
        input.git_push,
        input.gitPush,
        input.pushed,
        input.github_push_status,
        input.githubPushStatus,
        input.deploy_status,
        input.deployStatus
      ),
    pushed_branch:
      readNullableReportString(readSnapshotField("pushed_branch", "pushedBranch")) ||
      readString(input.pushed_branch) ||
      readString(input.pushedBranch) ||
      null,
    remote_contains_commit: readReportPushFlag(
      readSnapshotField("remote_contains_commit", "remoteContainsCommit"),
      input.remote_contains_commit,
      input.remoteContainsCommit
    ),
    repository_clean_after_push:
      readNullableBooleanFlag(readSnapshotField("repository_clean_after_push", "repositoryCleanAfterPush")) ??
      readNullableBooleanFlag(input.repository_clean_after_push) ??
      readNullableBooleanFlag(input.repositoryCleanAfterPush) ??
      false,
    post_completion_transport_warning:
      readBooleanFlag(readSnapshotField("post_completion_transport_warning", "postCompletionTransportWarning")) ||
      readBooleanFlag(input.post_completion_transport_warning) ||
      readBooleanFlag(input.postCompletionTransportWarning),
    post_completion_warning_count:
      Number(readSnapshotField("post_completion_warning_count", "postCompletionWarningCount")) ||
      Number(input.post_completion_warning_count || input.postCompletionWarningCount) ||
      0,
    next_batch: nextBatch,
    next_stage_allowed:
      typeof input.next_stage_allowed === "boolean"
        ? input.next_stage_allowed
        : readNullableBooleanFlag(input.next_stage_allowed) || false,
    reply_error: readString(input.reply_error) || null,
    completed_at:
      readString(input.completed_at) ||
      readString(input.completedAt) ||
      readString(job.completed_at) ||
      null,
  };

  return {
    ...finalResult,
    failure_memory_status: buildFailureMemoryStatus(finalResult),
    terminal_index: buildTerminalJobIndex(finalResult),
    auto_iteration_suggestion: buildAutoIterationSuggestion(finalResult),
  };
}

function buildTerminalJobIndex(finalResult) {
  return {
    job_id: finalResult?.job_id || null,
    approved_batch: finalResult?.approved_batch || null,
    worker_execution_status: finalResult?.worker_execution_status || null,
    task_goal_status: finalResult?.task_goal_status || null,
    effective_final_status: finalResult?.effective_final_status || null,
    failure_code: finalResult?.failure_code || null,
    failure_stage: finalResult?.failure_stage || null,
    changed_files: uniqueSortedPaths(finalResult?.changed_files || []),
    committed_files: uniqueSortedPaths(finalResult?.committed_files || finalResult?.changed_files || []),
    codex_changed_files: uniqueSortedPaths(finalResult?.codex_changed_files || []),
    worktree_changed_files: uniqueSortedPaths(finalResult?.worktree_changed_files || []),
    task_changed_files: uniqueSortedPaths(finalResult?.task_changed_files || finalResult?.changed_files || []),
    unexpected_changed_files: uniqueSortedPaths(finalResult?.unexpected_changed_files || []),
    git_commit_sha: finalResult?.git_commit_sha || null,
    codex_git_push: finalResult?.codex_git_push || null,
    worker_git_push:
      typeof finalResult?.worker_git_push === "boolean"
        ? finalResult.worker_git_push
        : readNullableBooleanFlag(finalResult?.worker_git_push) || false,
    pushed:
      typeof finalResult?.pushed === "boolean"
        ? finalResult.pushed
        : readNullableBooleanFlag(finalResult?.pushed) || false,
    git_push:
      typeof finalResult?.git_push === "boolean"
        ? finalResult.git_push
        : readNullableBooleanFlag(finalResult?.git_push) ||
          readNullableBooleanFlag(finalResult?.pushed) ||
          false,
    pushed_branch: finalResult?.pushed_branch || null,
    remote_contains_commit:
      typeof finalResult?.remote_contains_commit === "boolean"
        ? finalResult.remote_contains_commit
        : readNullableBooleanFlag(finalResult?.remote_contains_commit) || false,
    repository_clean_after_push:
      typeof finalResult?.repository_clean_after_push === "boolean"
        ? finalResult.repository_clean_after_push
        : readNullableBooleanFlag(finalResult?.repository_clean_after_push) || false,
    next_batch: finalResult?.next_batch || null,
    next_stage_allowed:
      typeof finalResult?.next_stage_allowed === "boolean"
        ? finalResult.next_stage_allowed
        : readNullableBooleanFlag(finalResult?.next_stage_allowed) || false,
    reply_error: finalResult?.reply_error || null,
    post_completion_transport_warning: readBooleanFlag(
      finalResult?.post_completion_transport_warning
    ),
    post_completion_warning_count:
      Number(finalResult?.post_completion_warning_count) || 0,
    completed_at: finalResult?.completed_at || null,
  };
}

function buildTerminalIndexKey(finalResult) {
  return [
    finalResult?.job_id || "unknown-job",
    finalResult?.approved_batch || "unknown-batch",
  ].join("::");
}

function isTerminalFinalResult(finalResult) {
  return ["succeeded", "failed", "cancelled"].includes(
    normalizeTerminalStatus(finalResult?.effective_final_status)
  );
}

function recordTerminalJobIndex(index, finalResult) {
  const normalizedIndex = normalizeFailureMemory(index);
  const normalizedFinalResult = normalizeWorkerFinalResult(finalResult);
  if (!isTerminalFinalResult(normalizedFinalResult)) {
    return {
      index: normalizedIndex,
      entry: null,
      status: "skipped_non_terminal",
      idempotent: false,
    };
  }

  const key = buildTerminalIndexKey(normalizedFinalResult);
  const existing = normalizedIndex[key] || null;
  if (existing) {
    return {
      index: normalizedIndex,
      entry: existing,
      status: "duplicate",
      idempotent: true,
    };
  }

  const entry = buildTerminalJobIndex(normalizedFinalResult);
  return {
    index: {
      ...normalizedIndex,
      [key]: entry,
    },
    entry,
    status: "recorded",
    idempotent: false,
  };
}

function recordFailureMemoryForFinalResult(memory, finalResult, now = new Date().toISOString()) {
  const normalizedMemory = normalizeFailureMemory(memory);
  const normalizedFinalResult = normalizeWorkerFinalResult(finalResult);
  const memoryStatus = buildFailureMemoryStatus(normalizedFinalResult);

  if (memoryStatus !== "recordable") {
    return {
      memory: normalizedMemory,
      entry: null,
      status: memoryStatus,
      recorded: false,
      idempotent: false,
    };
  }

  const eventKey = buildTerminalIndexKey(normalizedFinalResult);
  const events = normalizeFailureMemory(normalizedMemory.__task_failure_events);
  const existing = events[eventKey] || null;

  if (existing) {
    return {
      memory: normalizedMemory,
      entry: existing,
      status: "duplicate",
      recorded: false,
      idempotent: true,
    };
  }

  const entry = {
    job_id: normalizedFinalResult.job_id,
    approved_batch: normalizedFinalResult.approved_batch,
    effective_final_status: normalizedFinalResult.effective_final_status,
    failure_code: normalizedFinalResult.failure_code,
    failure_stage: normalizedFinalResult.failure_stage,
    git_commit_sha: normalizedFinalResult.git_commit_sha,
    completed_at: normalizedFinalResult.completed_at,
    recorded_at: now,
  };

  return {
    memory: {
      ...normalizedMemory,
      __task_failure_events: {
        ...events,
        [eventKey]: entry,
      },
    },
    entry,
    status: "recorded",
    recorded: true,
    idempotent: false,
  };
}

function buildAutoIterationSuggestion(finalResult) {
  const normalized = {
    ...finalResult,
    effective_final_status: normalizeTerminalStatus(finalResult?.effective_final_status),
    failure_code: normalizeFailureCodeValue(finalResult?.failure_code),
  };

  if (normalized.effective_final_status === "succeeded") {
    return normalized.next_batch
      ? {
          action: "continue",
          next_batch: normalized.next_batch,
          reason: "succeeded_next_batch",
        }
      : {
          action: "none",
          reason: "succeeded_without_next_batch",
        };
  }

  if (normalized.effective_final_status === "failed") {
    if (!isTrueTaskFailureCode(normalized.failure_code)) {
      return {
        action: "none",
        reason: "non_task_failure",
      };
    }

    return {
      action: "repair",
      suggested_batch: normalized.approved_batch
        ? `${normalized.approved_batch}-FIX`
        : "BATCH-REPAIR",
      failure_code: normalized.failure_code,
      failure_stage: normalized.failure_stage || null,
      reason: "minimal_repair_batch",
    };
  }

  if (normalized.effective_final_status === "cancelled") {
    return {
      action: "none",
      reason: "cancelled",
    };
  }

  return {
    action: "none",
    reason: "non_terminal",
  };
}

function classifyWorkerTaskDomain(requestText) {
  const text = String(requestText || "");
  const declaredProjectDomain = readProjectDomainFromText(text);
  const currentBatchCode = getCurrentBatchCodeFromText(text);

  if (declaredProjectDomain) {
    if (declaredProjectDomain === "qa_review") {
      return "qa_review";
    }
    if (declaredProjectDomain === "automation_system") {
      return "automation_system";
    }
    if (declaredProjectDomain === "automation_architecture") {
      return "automation_architecture";
    }
    if (declaredProjectDomain === "city_partner_product") {
      return "city_partner_product";
    }
  }

  if (currentBatchCode && QA_BATCH_PATTERN.test(currentBatchCode)) {
    return "qa_review";
  }

  if (isBatchFixProductTaskText(text)) {
    return "city_partner_product";
  }

  if (currentBatchCode && ARCH_BATCH_PATTERN.test(currentBatchCode)) {
    return "automation_architecture";
  }

  if (/文档整理|整理文档|归档|governance[_ -]?docs/i.test(text)) {
    return "governance_docs";
  }

  if (AUTOMATION_CONTEXT_PATTERN.test(text) || /系统修复|系统升级|automation[_ -]?system/i.test(text)) {
    return "automation_system";
  }

  if (/测试审核|测试|审核|验收|复测|qa[_ -]?review|QA review|test review/i.test(text)) {
    return "qa_review";
  }

  if (/运营|运维|发布|部署|上线|监控|operations?|ops|release|deploy/i.test(text)) {
    return "operations";
  }

  return "general";
}

function isAutomationSystemTask(requestText) {
  return classifyWorkerTaskDomain(requestText) === "automation_system";
}

function stripTrailingPunctuation(value) {
  return String(value || "").replace(/[。；;，,、)）\]】}>"'`]+$/g, "");
}

function extractPathLikeTokens(line) {
  const tokens = [];
  const pathPattern =
    /(?:^|[\s`"'“”‘’（(：:，,])((?:\.\/)?(?:src|infra|docs|app|pages|lib|components|tests|scripts|public|supabase)\/[A-Za-z0-9._@+\-=()[\]*/?]+(?:\/[A-Za-z0-9._@+\-=()[\]*/?]+)*)/g;
  let match = pathPattern.exec(line);

  while (match) {
    tokens.push(stripTrailingPunctuation(match[1]));
    match = pathPattern.exec(line);
  }

  return uniqueSortedPaths(tokens);
}

function isScopeDeclarationLine(line) {
  return (
    ALLOWED_ONLY_SECTION_PATTERN.test(line) ||
    FORBIDDEN_SECTION_PATTERN.test(line) ||
    /allowed[_\s-]*scope|forbidden[_\s-]*scope|允许(?:修改|范围)|禁止(?:修改|范围)|不得修改|不修改|不要(?:修改|读取|读|碰)|背景(?:说明)?|do\s+not\s+(?:modify|change|touch|read)|must\s+not\s+(?:modify|change|touch|read)/i.test(
      String(line || "")
    )
  );
}

function extractRequiredChangePaths(requestText) {
  const lines = String(requestText || "").split(/\r?\n/);
  const paths = [];
  let inRequiredSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const isPathListItem = /^\s*(?:[-*]|\d+[.)、])\s+/.test(rawLine);

    if (!line) {
      inRequiredSection = false;
      continue;
    }

    if (isScopeDeclarationLine(line)) {
      inRequiredSection = false;
      continue;
    }

    const hasRequiredMarker = REQUIRED_FILE_SECTION_PATTERN.test(line);
    const hasMutationInstruction = TASK_MUTATION_PATTERN.test(line);
    const linePaths = extractPathLikeTokens(line);

    if (hasRequiredMarker) {
      inRequiredSection = true;
    } else if (!isPathListItem) {
      inRequiredSection = false;
    }

    if (linePaths.length > 0 && (inRequiredSection || hasMutationInstruction)) {
      paths.push(...linePaths);
    }
  }

  return uniqueSortedPaths(paths);
}

function extractForbiddenChangePaths(requestText) {
  const paths = [];
  for (const rawLine of String(requestText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!FORBIDDEN_SECTION_PATTERN.test(line) && !/forbidden[_\s-]*scope|禁止|不得|不修改|不要(?:修改|读取|读|碰)|do\s+not|must\s+not/i.test(line)) {
      continue;
    }
    paths.push(...extractPathLikeTokens(line));
  }
  return uniqueSortedPaths(paths);
}

function isProductAppPath(filePath) {
  const normalized = normalizeGitPath(filePath);
  return normalized === "app" ||
    normalized === "src/app" ||
    normalized.startsWith("app/") ||
    normalized.startsWith("src/app/");
}

function pathConflictsWithForbiddenPath(requiredPath, forbiddenPath) {
  return requestedPathMatchesChangedPath(requiredPath, forbiddenPath) ||
    requestedPathMatchesChangedPath(forbiddenPath, requiredPath);
}

function filterRequiredChangePathsForTask(requiredPaths, requestText, taskMode) {
  const forbiddenPaths = extractForbiddenChangePaths(requestText);
  const kept = [];

  for (const requiredPath of uniqueSortedPaths(requiredPaths)) {
    if (taskMode === TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED && isProductAppPath(requiredPath)) {
      console.warn(`required_path_dropped_product_path: ${requiredPath}`);
      continue;
    }

    if (
      forbiddenPaths.some((forbiddenPath) =>
        pathConflictsWithForbiddenPath(requiredPath, forbiddenPath)
      )
    ) {
      console.warn(`required_path_dropped_forbidden: ${requiredPath}`);
      continue;
    }

    kept.push(requiredPath);
  }

  return uniqueSortedPaths(kept);
}

function requestedPathMatchesChangedPath(requestedPath, changedPath) {
  const requested = normalizeGitPath(requestedPath).replace(/\*+$/g, "").replace(/\/+$/g, "");
  const changed = normalizeGitPath(changedPath);

  if (!requested || !changed) {
    return false;
  }

  return changed === requested || changed.startsWith(`${requested}/`);
}

function getMissingRequiredChangePaths(requiredPaths, changedPaths) {
  return uniqueSortedPaths(requiredPaths).filter(
    (requiredPath) =>
      !uniqueSortedPaths(changedPaths).some((changedPath) =>
        requestedPathMatchesChangedPath(requiredPath, changedPath)
      )
  );
}

function taskRequiresCompleteRequiredDocs(requestText) {
  return /必须新增或更新以下全部文件|缺一个就失败|MISSING_REQUIRED_DOCS|required_docs/i.test(
    String(requestText || "")
  );
}

function getRequiredDocsForTask(requestText) {
  const text = String(requestText || "");
  const docs = [];

  if (/\bBATCH-37-DOCS(?:-[A-Z0-9]+)*\b/i.test(text)) {
    docs.push(...BATCH_37_REQUIRED_DOCS);
  }

  if (taskRequiresCompleteRequiredDocs(text)) {
    docs.push(
      ...extractPathLikeTokens(text).filter((filePath) =>
        isDocsWriteAllowedPath(filePath)
      )
    );
  }

  return uniqueSortedPaths(docs);
}

function getPresentRequiredDocs(requiredDocs) {
  return uniqueSortedPaths(requiredDocs).filter((filePath) =>
    fs.existsSync(path.join(PROJECT_DIR, normalizeGitPath(filePath)))
  );
}

function getChangedRequiredDocs(requiredDocs, changedPaths) {
  return uniqueSortedPaths(requiredDocs).filter((requiredDoc) =>
    uniqueSortedPaths(changedPaths || []).some((changedPath) =>
      requestedPathMatchesChangedPath(requiredDoc, changedPath)
    )
  );
}

function createRequiredDocsError(code, message, details = {}) {
  const requiredDocs = uniqueSortedPaths(details.requiredDocs || []);
  const presentDocs = uniqueSortedPaths(details.presentDocs || []);
  const changedDocs = uniqueSortedPaths(details.changedDocs || []);
  const missingDocs = uniqueSortedPaths(details.missingDocs || []);
  const error = new Error(
    [
      code,
      message,
      `required_docs_total: ${requiredDocs.length}`,
      `required_docs_present: ${presentDocs.length}`,
      `required_docs_changed: ${changedDocs.length}`,
      missingDocs.length
        ? `missing_required_docs: ${missingDocs.join(", ")}`
        : "missing_required_docs: none",
      `insufficient_doc_output: ${code === INSUFFICIENT_DOC_OUTPUT ? "yes" : "no"}`,
    ].join("\n")
  );

  error.code = code;
  error.failureStage = "required docs completion validation";
  error.requiredDocs = requiredDocs;
  error.presentDocs = presentDocs;
  error.changedDocs = changedDocs;
  error.missingDocs = missingDocs;
  return error;
}

function createNoFixAppliedError(message, details = {}) {
  const error = new Error(
    [
      NO_FIX_APPLIED,
      message,
      details.requiredPaths?.length
        ? `required_paths: ${uniqueSortedPaths(details.requiredPaths).join(", ")}`
        : null,
      details.changedPaths?.length
        ? `changed_paths: ${uniqueSortedPaths(details.changedPaths).join(", ")}`
        : "changed_paths: none",
      details.taskDomain ? `task_domain: ${details.taskDomain}` : null,
      details.taskMode ? `task_mode: ${details.taskMode}` : null,
    ]
      .filter(Boolean)
      .join("\n")
  );

  error.code = NO_FIX_APPLIED;
  error.failureStage = "任务目标完成验收";
  error.requiredPaths = details.requiredPaths || [];
  error.changedPaths = details.changedPaths || [];
  error.taskDomain = details.taskDomain || null;
  error.taskMode = details.taskMode || null;
  return error;
}

function createReadOnlyModeViolationError(changedPaths) {
  const normalizedChangedPaths = uniqueSortedPaths(changedPaths || []);
  const error = new Error(
    [
      READ_ONLY_MODE_VIOLATION,
      "任务正文要求只读 / 不修改 / 禁止 Git 写入，但 Codex 产生了文件变更；Worker 已停止 git add/commit/push。",
      normalizedChangedPaths.length
        ? `changed_paths: ${normalizedChangedPaths.join(", ")}`
        : "changed_paths: none",
    ].join("\n")
  );

  error.code = READ_ONLY_MODE_VIOLATION;
  error.failureStage = "read_only_mode 验收";
  error.changedPaths = normalizedChangedPaths;
  return error;
}

function getEffectiveProjectDomain(job) {
  const explicitDomain = readExplicitTextTaskContext(job).projectDomain;
  return explicitDomain || readProjectDomainField(job);
}

function isQaReviewTask(job) {
  const domain = getEffectiveProjectDomain(job);
  if (domain) {
    return domain === "qa_review";
  }

  const batchCode = getCurrentBatchCode(job);
  return Boolean(batchCode && QA_BATCH_PATTERN.test(batchCode));
}

function isArchitectureReviewTask(job) {
  const domain = getEffectiveProjectDomain(job);
  if (domain) {
    return domain === "automation_architecture";
  }

  const batchCode = getCurrentBatchCode(job);
  return Boolean(batchCode && ARCH_BATCH_PATTERN.test(batchCode));
}

function isQaReviewTaskText(taskText) {
  const domain = readProjectDomainFromText(taskText);
  if (domain) {
    return domain === "qa_review";
  }

  const batchCode = getCurrentBatchCodeFromText(taskText);
  return Boolean(batchCode && QA_BATCH_PATTERN.test(batchCode));
}

function isArchitectureReviewTaskText(taskText) {
  const domain = readProjectDomainFromText(taskText);
  if (domain) {
    return domain === "automation_architecture";
  }

  const batchCode = getCurrentBatchCodeFromText(taskText);
  return Boolean(batchCode && ARCH_BATCH_PATTERN.test(batchCode));
}

function isArchitectureSmokeReportTaskText(taskText) {
  return ARCHITECTURE_SMOKE_REPORT_TASK_PATTERN.test(String(taskText || ""));
}

function isArchitectureSmokeReportTask(job) {
  if (!isArchitectureReviewTask(job)) {
    return false;
  }

  return isArchitectureSmokeReportTaskText(getExplicitRequestText(job));
}

function parseQaReportFields(reportText) {
  const lines = String(reportText || "").split(/\r?\n/);
  const markerIndex = lines.findIndex((line) =>
    /^\s*QA_REPORT_FIELDS\s*:\s*$/i.test(line)
  );

  if (markerIndex < 0) {
    return null;
  }

  const fields = new Map();
  for (const line of lines.slice(markerIndex + 1)) {
    const match = line.match(/^\s*([a-z_]+)\s*:\s*(\S.*?)\s*$/i);
    if (!match) {
      continue;
    }

    const key = match[1].toLowerCase();
    if (QA_REPORT_MACHINE_FIELDS.some((field) => field.key === key)) {
      fields.set(key, match[2].trim());
    }
  }

  return fields;
}

function parseArchitectureReportFields(reportText) {
  const lines = String(reportText || "").split(/\r?\n/);
  const markerIndex = lines.findIndex((line) =>
    /^\s*ARCH_REPORT_FIELDS\s*:?\s*$/i.test(line)
  );

  if (markerIndex < 0) {
    return null;
  }

  const fields = new Map();
  for (const line of lines.slice(markerIndex + 1)) {
    const match = line.match(/^\s*([a-z_]+)\s*[:=]\s*(\S.*?)\s*$/i);
    if (!match) {
      continue;
    }

    const key = match[1].toLowerCase();
    if (ARCH_REPORT_MACHINE_FIELDS.some((field) => field.key === key)) {
      fields.set(key, match[2].trim());
    }
  }

  return fields;
}

function getMissingMachineQaReportFields(fields) {
  return QA_REPORT_MACHINE_FIELDS.filter((field) => {
    const value = fields?.get(field.key);
    return !value || !field.pattern.test(value);
  });
}

function getMissingMachineArchitectureReportFields(fields) {
  return ARCH_REPORT_MACHINE_FIELDS.filter((field) => {
    const value = fields?.get(field.key);
    return !value || !field.pattern.test(value);
  });
}

function getMissingQaReportFields(reportText) {
  const machineFields = parseQaReportFields(reportText);
  if (machineFields) {
    return getMissingMachineQaReportFields(machineFields);
  }

  const text = String(reportText || "");
  return QA_REPORT_REQUIRED_FIELDS.filter((field) => !field.pattern.test(text));
}

function createIncompleteQaReportError(missingFields) {
  const missing = (missingFields || []).map((field) => field.label);
  const error = new Error(
    [
      INCOMPLETE_QA_REPORT,
      "BATCH-QA read-only task must output a full static QA report, not only git status / git diff.",
      `qa_report_required_total: ${QA_REPORT_REQUIRED_FIELDS.length}`,
      `qa_report_present: ${QA_REPORT_REQUIRED_FIELDS.length - missing.length}`,
      missing.length
        ? `missing_qa_report_fields: ${missing.join(", ")}`
        : "missing_qa_report_fields: none",
      `qa_allowed_static_reads: ${QA_READ_ONLY_ALLOWED_READS.join(", ")}`,
    ].join("\n")
  );

  error.code = INCOMPLETE_QA_REPORT;
  error.failureStage = "QA read-only report completeness validation";
  error.missingQaReportFields = missing;
  return error;
}

function getMissingArchitectureReportFields(reportText) {
  const text = String(reportText || "");
  return ARCHITECTURE_REPORT_REQUIRED_FIELDS.filter((field) => !field.pattern.test(text));
}

function getMissingArchitectureSmokeReportFields(reportText) {
  const machineFields = parseArchitectureReportFields(reportText);
  return getMissingMachineArchitectureReportFields(machineFields);
}

function createIncompleteArchitectureReportError(missingFields) {
  const missing = (missingFields || []).map((field) => field.label);
  const error = new Error(
    [
      INCOMPLETE_ARCHITECTURE_REPORT,
      "BATCH-ARCH read-only task must output an architecture inventory report, not a product QA report.",
      `architecture_report_required_total: ${ARCHITECTURE_REPORT_REQUIRED_FIELDS.length}`,
      `architecture_report_present: ${ARCHITECTURE_REPORT_REQUIRED_FIELDS.length - missing.length}`,
      missing.length
        ? `missing_architecture_report_fields: ${missing.join(", ")}`
        : "missing_architecture_report_fields: none",
    ].join("\n")
  );

  error.code = INCOMPLETE_ARCHITECTURE_REPORT;
  error.failureStage = "architecture read-only report completeness validation";
  error.missingArchitectureReportFields = missing;
  return error;
}

function createIncompleteArchitectureSmokeReportError(missingFields) {
  const missing = (missingFields || []).map((field) => field.label);
  const error = new Error(
    [
      INCOMPLETE_ARCHITECTURE_REPORT,
      "Architecture smoke read-only task must output complete ARCH_REPORT_FIELDS.",
      `architecture_report_required_total: ${ARCH_REPORT_MACHINE_FIELDS.length}`,
      `architecture_report_present: ${ARCH_REPORT_MACHINE_FIELDS.length - missing.length}`,
      missing.length
        ? `missing_architecture_report_fields: ${missing.join(", ")}`
        : "missing_architecture_report_fields: none",
    ].join("\n")
  );

  error.code = INCOMPLETE_ARCHITECTURE_REPORT;
  error.failureStage = "architecture smoke read-only report fields validation";
  error.missingArchitectureReportFields = missing;
  return error;
}

function assertQaReportComplete(job, reportText) {
  if (!isQaReviewTask(job)) {
    return;
  }

  const missingFields = getMissingQaReportFields(reportText);
  if (missingFields.length > 0) {
    throw createIncompleteQaReportError(missingFields);
  }
}

function assertArchitectureReportComplete(job, reportText) {
  if (!isArchitectureReviewTask(job)) {
    return;
  }

  const isSmokeReportTask = isArchitectureSmokeReportTask(job);
  const missingFields = isSmokeReportTask
    ? getMissingArchitectureSmokeReportFields(reportText)
    : getMissingArchitectureReportFields(reportText);
  if (missingFields.length > 0) {
    throw isSmokeReportTask
      ? createIncompleteArchitectureSmokeReportError(missingFields)
      : createIncompleteArchitectureReportError(missingFields);
  }
}

function assertQaTaskOutcome(job, changedPaths, reportText) {
  const shouldValidateQaReport = isQaReviewTask(job);
  const shouldValidateArchitectureReport =
    isReadOnlyTaskMode(getTaskMode(job)) && isArchitectureReviewTask(job);

  if (!shouldValidateQaReport && !shouldValidateArchitectureReport) {
    return;
  }

  const normalizedChangedPaths = uniqueSortedPaths(changedPaths || []);
  if (normalizedChangedPaths.length > 0) {
    throw createReadOnlyModeViolationError(normalizedChangedPaths);
  }

  if (shouldValidateQaReport) {
    assertQaReportComplete(job, reportText);
  }

  if (shouldValidateArchitectureReport) {
    assertArchitectureReportComplete(job, reportText);
  }
}

function createReadOnlyGitCommandError(args, details = {}) {
  const command = ["git", ...(args || [])].join(" ").trim();
  const changedPaths = uniqueSortedPaths(details.changedPaths || []);
  const error = new Error(
    [
      READ_ONLY_MODE_VIOLATION,
      `read_only_mode=true blocks ${command}; Worker refused git write/branch-history commands before any write.`,
      changedPaths.length
        ? `changed_paths: ${changedPaths.join(", ")}`
        : "changed_paths: none",
    ].join("\n")
  );

  error.code = READ_ONLY_MODE_VIOLATION;
  error.failureStage = "read_only_mode git write guard";
  error.blockedGitCommand = command;
  error.changedPaths = changedPaths;
  return error;
}

function getGitSubcommand(args) {
  const first = Array.isArray(args) ? args[0] : null;
  return typeof first === "string" ? first.toLowerCase() : "";
}

function assertGitOperationAllowed(args, options = {}) {
  const readOnlyLocked = currentReadOnlyMode || options.readOnlyMode === true;

  if (!readOnlyLocked) {
    return;
  }

  const subcommand = getGitSubcommand(args);

  if (READ_ONLY_BLOCKED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw createReadOnlyGitCommandError(args, options);
  }
}

function assertTaskGoalApplied(job, changedPaths) {
  const contract = resolveWorkerJobContract(job);
  const requestText = readTextValue([
    contract.original_request_text,
    job?.request_text,
    job?.requestText,
  ]);
  const normalizedScopeText = buildNormalizedScopeText(contract);
  const taskDomain = classifyWorkerTaskDomain(requestText);
  const taskMode = contract.task_mode;
  const exactAllowedScope = contract.exact_allowed_scope;
  const allowNoChangeSuccess = allowsVerificationOnlyNoChangeSuccess(contract);
  const requiredPaths = filterRequiredChangePathsForTask(
    extractRequiredChangePaths(requestText),
    normalizedScopeText || requestText,
    taskMode
  ).filter((requiredPath) =>
    !extractScopeValuePaths(contract.forbidden_scope).some((forbiddenPath) =>
      pathConflictsWithForbiddenPath(requiredPath, forbiddenPath)
    )
  );
  const normalizedChangedPaths = uniqueSortedPaths(changedPaths || []);

  if (exactAllowedScope && normalizedChangedPaths.length > 0) {
    const outOfScopePaths = normalizedChangedPaths.filter(
      (filePath) => !fileMatchesExactAllowedScope(filePath, exactAllowedScope)
    );

    if (outOfScopePaths.length > 0) {
      throw createOutOfScopeBusinessChangeError(
        "exact_allowed_scope is present; changed_files must match the boss-approved exact scope before git add.",
        {
          taskMode,
          outOfScopePaths,
        }
      );
    }
  }

  if (hasConflictingReadOnlyLock(job, taskMode)) {
    throw createTaskModeMismatchError(
      "A write-allowed task was locked by read_only_mode=true before it could satisfy its goal.",
      { taskMode }
    );
  }

  if (isReadOnlyTaskMode(taskMode)) {
    if (normalizedChangedPaths.length > 0) {
      throw createReadOnlyModeViolationError(normalizedChangedPaths);
    }

    return;
  }

  const blockedSafetyPaths =
    taskMode === TASK_MODES.PRODUCT_WRITE_ALLOWED
      ? []
      : normalizedChangedPaths.filter(
          (filePath) => isBusinessPagePath(filePath) || isDatabaseOrEnvPath(filePath)
        );

  if (blockedSafetyPaths.length > 0) {
    throw createOutOfScopeBusinessChangeError(
      "Task mode forbids business page, database, or env changes.",
      {
        taskMode,
        outOfScopePaths: blockedSafetyPaths,
      }
    );
  }

  if (taskMode === TASK_MODES.DOCS_WRITE_ALLOWED) {
    const outOfScopePaths = normalizedChangedPaths.filter(
      (filePath) => !isDocsWriteAllowedPath(filePath)
    );

    if (outOfScopePaths.length > 0) {
      throw createOutOfScopeBusinessChangeError(
        "docs_write_allowed only permits docs/** changes.",
        {
          taskMode,
          outOfScopePaths,
        }
      );
    }

    const docsChangedPaths = normalizedChangedPaths.filter(isDocsWriteAllowedPath);
    const requiredDocs = getRequiredDocsForTask(requestText);
    const presentRequiredDocs = getPresentRequiredDocs(requiredDocs);
    const changedRequiredDocs = getChangedRequiredDocs(requiredDocs, normalizedChangedPaths);
    const missingRequiredDocs = uniqueSortedPaths(requiredDocs).filter(
      (requiredDoc) =>
        !presentRequiredDocs.includes(normalizeGitPath(requiredDoc)) ||
        !changedRequiredDocs.includes(normalizeGitPath(requiredDoc))
    );

    if (
      requiredDocs.length > 0 &&
      normalizedChangedPaths.length === 1 &&
      normalizedChangedPaths[0] === "docs/projects/feishu-gm-automation.md"
    ) {
      throw createRequiredDocsError(
        INSUFFICIENT_DOC_OUTPUT,
        "docs_write_allowed task only changed feishu-gm-automation.md and did not produce the required docs output.",
        {
          requiredDocs,
          presentDocs: presentRequiredDocs,
          changedDocs: changedRequiredDocs,
          missingDocs: missingRequiredDocs,
        }
      );
    }

    if (requiredDocs.length > 0 && missingRequiredDocs.length > 0) {
      throw createRequiredDocsError(
        MISSING_REQUIRED_DOCS,
        "docs_write_allowed task did not create or update every required doc.",
        {
          requiredDocs,
          presentDocs: presentRequiredDocs,
          changedDocs: changedRequiredDocs,
          missingDocs: missingRequiredDocs,
        }
      );
    }

    if (docsChangedPaths.length === 0) {
      throw createNoFixAppliedError(
        "docs_write_allowed task produced no docs/** diff; refusing succeeded.",
        {
          requiredPaths,
          changedPaths: normalizedChangedPaths,
          taskDomain,
          taskMode,
        }
      );
    }
  }

  if (taskMode === TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED) {
    const isAllowedAutomationPath = (filePath) =>
      isAutomationWriteAllowedPath(filePath) ||
      isAutomationAllowedByExplicitScope(filePath, normalizedScopeText || requestText);
    const outOfScopePaths = normalizedChangedPaths.filter(
      (filePath) => !isAllowedAutomationPath(filePath)
    );

    if (outOfScopePaths.length > 0) {
      throw createOutOfScopeBusinessChangeError(
        "automation_system_write_allowed only permits automation-system files.",
        {
          taskMode,
          outOfScopePaths,
        }
      );
    }

    const automationChangedPaths = normalizedChangedPaths.filter(isAllowedAutomationPath);
    if (automationChangedPaths.length === 0) {
      if (allowNoChangeSuccess) {
        return;
      }

      throw createNoFixAppliedError(
        "automation_system_write_allowed task produced no automation-system diff; refusing succeeded.",
        {
          requiredPaths,
          changedPaths: normalizedChangedPaths,
          taskDomain,
          taskMode,
        }
      );
    }

    const missingRequiredPaths = getMissingRequiredChangePaths(
      requiredPaths,
      normalizedChangedPaths
    );

    if (requiredPaths.length > 0 && missingRequiredPaths.length === requiredPaths.length) {
      throw createNoFixAppliedError(
        "任务要求修改指定文件，但 Codex 没有修改任何指定文件；禁止上报 succeeded。",
        {
          requiredPaths,
          changedPaths: normalizedChangedPaths,
          taskDomain,
          taskMode,
        }
      );
    }

    return;
  }

  if (taskMode === TASK_MODES.PRODUCT_WRITE_ALLOWED) {
    if (isBatchFixProductTaskText(requestText)) {
      const systemPaths = normalizedChangedPaths.filter(isSystemChangeForbiddenPath);
      if (systemPaths.length > 0) {
        throw createOutOfScopeSystemChangeError(
          "BATCH-FIX product repair forbids Worker, Gateway, director, Tencent Cloud, or automation-system file changes.",
          {
            taskMode,
            outOfScopePaths: systemPaths,
          }
        );
      }

      const outOfScopeProductPaths = normalizedChangedPaths.filter(
        (filePath) => !isBatchFixProductAllowedPath(filePath)
      );
      if (outOfScopeProductPaths.length > 0) {
        throw createOutOfScopeBusinessChangeError(
          "BATCH-FIX product repair only permits src/app/** and approved product docs.",
          {
            taskMode,
            outOfScopePaths: outOfScopeProductPaths,
          }
        );
      }
    } else {
      const outOfScopePaths = normalizedChangedPaths.filter(
        (filePath) => !isProductWriteAllowedPath(filePath) && !isDocsWriteAllowedPath(filePath)
      );

      if (outOfScopePaths.length > 0) {
        throw createOutOfScopeBusinessChangeError(
          "product_write_allowed only permits product or docs files.",
          {
            taskMode,
            outOfScopePaths,
          }
        );
      }
    }

    if (normalizedChangedPaths.length === 0) {
      throw createNoFixAppliedError(
        "product_write_allowed task produced no product/docs diff; refusing succeeded.",
        {
          requiredPaths,
          changedPaths: normalizedChangedPaths,
          taskDomain,
          taskMode,
        }
      );
    }

    return;
  }

  if (taskRequiresFileChanges(requestText) && normalizedChangedPaths.length === 0) {
    throw createNoFixAppliedError(
      "任务正文要求修复/新增/更新/补齐/建立/修改，但 Codex 没有产生任何文件变更；禁止空跑 succeeded。",
      {
        requiredPaths,
        changedPaths: normalizedChangedPaths,
        taskDomain,
        taskMode,
      }
    );
  }

  const missingRequiredPaths = getMissingRequiredChangePaths(
    requiredPaths,
    normalizedChangedPaths
  );

  if (requiredPaths.length > 0 && missingRequiredPaths.length === requiredPaths.length) {
    throw createNoFixAppliedError(
      "任务要求修改指定文件，但 Codex 没有修改任何指定文件；禁止上报 succeeded。",
      {
        requiredPaths,
        changedPaths: normalizedChangedPaths,
        taskDomain,
        taskMode,
      }
    );
  }
}

function findBatchCodes(text) {
  const matches = String(text || "").match(BATCH_CODE_PATTERN) || [];
  const seen = new Set();
  const codes = [];

  for (const match of matches) {
    const key = String(match).toUpperCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    codes.push(match);
  }

  return codes;
}

function stripForbiddenBatchFragments(line) {
  return String(line || "").split(BATCH_FORBIDDEN_FRAGMENT_PATTERN)[0].trim();
}

function extractRelevantBatchTextFromRequest(requestText) {
  const lines = String(requestText || "").split(/\r?\n/);
  const chunks = [];
  let inForbiddenSection = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line) {
      inForbiddenSection = false;
      continue;
    }

    const isRelevantLine =
      (index === 0 && /^新需求[:：]/.test(line)) ||
      BATCH_RELEVANT_LINE_PATTERN.test(line);

    if (BATCH_FORBIDDEN_SECTION_HEADING_PATTERN.test(line) && !isRelevantLine) {
      inForbiddenSection = true;
      continue;
    }

    if (inForbiddenSection) {
      if (!BATCH_FORBIDDEN_SECTION_EXIT_PATTERN.test(line)) {
        continue;
      }
      inForbiddenSection = false;
    }

    if (isRelevantLine) {
      inForbiddenSection = false;
      const cleanedLine = stripForbiddenBatchFragments(line);
      if (cleanedLine) {
        chunks.push(cleanedLine);
      }
    }
  }

  return chunks.join("\n");
}

function extractCurrentExecutionBatchCode(job) {
  const titleCodes = findBatchCodes(job?.title || "");
  if (titleCodes.length > 0) {
    return titleCodes[0];
  }

  const relevantRequestText = extractRelevantBatchTextFromRequest(
    `${job?.request_text || ""}\n${job?.prompt || ""}`
  );
  const requestCodes = findBatchCodes(relevantRequestText);
  return requestCodes[0] || null;
}

function getCurrentBatchCodeFromText(text) {
  const raw = String(text || "");
  const firstContentLine = raw.split(/\r?\n/).find((line) => line.trim()) || "";
  const firstLineCodes = findBatchCodes(stripForbiddenBatchFragments(firstContentLine));
  const extractedCode = extractCurrentExecutionBatchCode({ request_text: raw });
  return extractedCode || firstLineCodes[0] || null;
}

function getCurrentBatchCode(job) {
  const currentExecutionBatch = extractCurrentExecutionBatchCode(job);
  if (currentExecutionBatch) {
    return currentExecutionBatch.toUpperCase();
  }

  return readBatchCodeField(job) || getCurrentBatchCodeFromText(getJobText(job));
}

function getJobBatchCode(job) {
  return getCurrentBatchCode(job);
}

const CODEX_GIT_OPERATION_GUARD = [
  "【Windows Worker 强制规则】",
  "Codex 只负责修改文件和汇报结果，Git 提交和推送由外层 Worker 自动完成。",
  "只允许修改任务要求的文件。",
  "原始任务正文是唯一执行来源；不得用 docs/NEXT_TASK_CARD.md、docs/PROJECT_INDEX.md 或历史批次文档替换本次任务正文。",
  "如果本次任务是 Worker / Codex / 自动化系统修复，只允许处理任务正文明确批准的批次和自动化系统文件，不得执行产品开发任务。",
  "自动化系统修复任务不得修改 /、/partners、/post 业务页面，也不得修改 src/app/page.tsx、src/app/partners/**、src/app/post/**。",
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

function buildReadOnlyGuard(taskText, options = {}) {
  if (!options.force && !isReadOnlyTaskText(taskText)) {
    return null;
  }

  return [
    "【只读任务锁死】",
    "read_only_mode: true",
    "任务正文出现只读 / 不修改 / 禁止 git add / 禁止 commit / 禁止 push 指令。",
    "Codex 只能读取、分析、静态验证并汇报结果。",
    "Codex 不得修改任何文件，不得调用 apply_patch，不得执行会写入工作区的命令。",
    "Codex 不得执行 git add、git commit、git push、checkout、merge、rebase、reset，不得部署，不得写数据库。",
    "Worker 将跳过 preflight 写入、Git 同步、git add、git commit、git push 和本地预览恢复。",
  ].join("\n");
}

function buildQaReviewGuard(taskText) {
  if (!isQaReviewTaskText(taskText)) {
    return null;
  }

  return [
    "【BATCH-QA 只读验收规则】",
    "project_domain: qa_review",
    "task_mode: read_only",
    "read_only_mode: true",
    `allowed_static_reads: ${QA_READ_ONLY_ALLOWED_READS.join(", ")}`,
    "必须静态读取首页、搭子浏览页、发布页、登录页、个人中心、mock 数据、类型定义和 docs 文档后再输出 QA 报告。",
    "禁止修改任何文件，禁止 apply_patch，禁止 git add/commit/push，禁止 npm run dev / next dev，禁止数据库、环境变量和部署操作。",
    "QA 报告必须包含：当前能直接用的功能、当前需要修的功能、首页验收结论、搭子浏览页验收结论、发布页验收结论、本地草稿 / 待审核流程验收结论、登录页和个人中心 warning 说明、开发团队下一步建议、测试审核团队下一步建议、运营团队是否可以加入、下一批建议从哪个 BATCH 开始。",
    "报告末尾必须输出固定机器字段：",
    "QA_REPORT_FIELDS:",
    "current_usable_features: yes/no",
    "current_fix_needed: yes/no",
    "homepage_verdict: pass/fail/warning",
    "partners_verdict: pass/fail/warning",
    "post_verdict: pass/fail/warning",
    "local_draft_review_verdict: pass/fail/warning",
    "login_profile_warning: yes/no",
    "dev_team_next_step: yes/no",
    "qa_team_next_step: yes/no",
    "ops_team_join: yes/no",
    "next_batch: BATCH-xxx",
    `failure_code_if_incomplete: ${INCOMPLETE_QA_REPORT}`,
  ].join("\n");
}

function buildArchitectureReviewGuard(taskText, taskMode) {
  if (!isReadOnlyTaskMode(taskMode) || !isArchitectureReviewTaskText(taskText)) {
    return null;
  }

  if (isArchitectureSmokeReportTaskText(taskText)) {
    return [
      "【BATCH-ARCH 架构烟测只读验收规则】",
      "project_domain: automation_architecture",
      "task_mode: read_only",
      "read_only_mode: true",
      "禁止修改任何文件，禁止 apply_patch，禁止 git add/commit/push，禁止 npm run dev / next dev，禁止数据库、环境变量和部署操作。",
      "架构烟测报告只校验 ARCH_REPORT_FIELDS，不要求完整架构盘点 5 个中文标题。",
      "报告末尾必须输出固定机器字段：",
      "ARCH_REPORT_FIELDS:",
      "final_report_status: succeeded",
      "no_fix_applied: false",
      "read_only_violation: false",
      "task_mode_mismatch: false",
      "out_of_scope_business_change: false",
      `failure_code_if_incomplete: ${INCOMPLETE_ARCHITECTURE_REPORT}`,
    ].join("\n");
  }

  return [
    "【BATCH-ARCH 只读架构盘点规则】",
    "project_domain: automation_architecture",
    "task_mode: read_only",
    "read_only_mode: true",
    "禁止修改任何文件，禁止 apply_patch，禁止 git add/commit/push，禁止 npm run dev / next dev，禁止数据库、环境变量和部署操作。",
    "架构盘点报告必须包含：架构盘点结论、缺失模块清单、知识库现状判断、自动迭代能力现状判断、BATCH-ARCH-02 到 BATCH-ARCH-10 的分批计划。",
  ].join("\n");
}

function buildProductWriteGuard(taskText, taskMode) {
  if (taskMode !== TASK_MODES.PRODUCT_WRITE_ALLOWED) {
    return null;
  }

  const isBatchFixProduct = isBatchFixProductTaskText(taskText);
  return [
    "【产品修复写入授权】",
    "project_domain: city_partner_product",
    "task_mode: product_write_allowed",
    "read_only_mode: false",
    "can_write_files: true",
    `allowed_scope: ${PRODUCT_WRITE_ALLOWED_SCOPE_TEXT}`,
    isBatchFixProduct
      ? "BATCH-FIX 产品修复批次已清除历史 read_only/QA/docs 残留文本，允许修改 allowed_scope 内产品文件。"
      : "产品修复任务允许在批准范围内修改产品文件。",
    "forbidden_scope: infra/windows-worker/**, src/lib/worker-jobs.ts, src/app/api/feishu/**, src/lib/project-director-console.ts, work/tencent-cloud/**, .env, database, deploy",
    "不得修改 Worker / 腾讯云中转 / 数据库 / env / deploy。",
  ].join("\n");
}

function sanitizeProductTaskTextForPrompt(taskText, taskMode) {
  if (taskMode !== TASK_MODES.PRODUCT_WRITE_ALLOWED) {
    return taskText;
  }

  return String(taskText || "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/只读任务锁死|read_only_mode\s*[:=]\s*true|不得修改任何文件|不修改任何文件|只执行\s*git\s*status|只执行\s*git\s*diff|only\s+git\s+status|only\s+git\s+diff/i.test(
          line
        )
    )
    .join("\n")
    .trim();
}

function buildWorkerReadOnlyContextPrompt(contract) {
  if (!contract || contract.task_mode !== TASK_MODES.WORKER_READ_ONLY) {
    return null;
  }

  return [
    "【worker_read_only 完整上下文契约】",
    `batch_code: ${contract.approved_batch || "null"}`,
    `project_domain: ${contract.project_domain || "null"}`,
    `task_mode: ${contract.task_mode || "null"}`,
    `read_only_mode: ${contract.read_only_mode ? "true" : "false"}`,
    "writable_scope: []",
    `readable_scope: ${contract.readable_scope || "null"}`,
    `read_only_operations: ${contract.read_only_operations || "null"}`,
    `forbidden_operations: ${contract.forbidden_operations || "null"}`,
    `forbidden_scope: ${contract.forbidden_scope || "null"}`,
    `task_goal: ${contract.task_goal || "null"}`,
    `required_output_fields: ${contract.required_output_fields || "null"}`,
    `acceptance_conditions: ${contract.acceptance_conditions || "null"}`,
    `exact_allowed_scope_count: ${contract.exact_allowed_scope_count || "null"}`,
    "exact_allowed_scope_count=0 对 worker_read_only 只能表示没有可写文件，不能解释为只允许 git status 或 git diff。",
    "不得把复杂 worker_read_only 任务统一替换为通用 Git 工作区检查。",
    `如果 original_request_text、任务目标、required_output_fields 或验收条件缺失，必须 fail closed：failure_code=${WORKER_READONLY_CONTEXT_INCOMPLETE}，task_goal_status 不得为 succeeded。`,
    "Codex 输出必须覆盖 required_output_fields 中的每一个字段；缺任何字段都不能把 task_goal_status 标记为 succeeded。",
  ].join("\n");
}

function buildWorkerGuardedPrompt(requestText, options = {}) {
  const taskText = String(requestText || "").trim();
  const taskDomain = classifyWorkerTaskDomain(taskText);
  const taskMode = options.taskMode || getTaskModeFromText(taskText) || TASK_MODES.READ_ONLY;
  const contract = options.contract || resolveWorkerJobContract(
    {
      request_text: taskText,
      payload: options.payload || null,
    },
    {
      taskMode,
      readOnlyMode: options.readOnlyMode,
      requestText: taskText,
    }
  );
  const effectiveTaskMode = contract.task_mode || taskMode;
  const effectiveReadOnlyMode = contract.read_only_mode === true;
  const promptTaskText = sanitizeProductTaskTextForPrompt(taskText, effectiveTaskMode);
  assertWorkerReadOnlyContextComplete(contract);
  const readOnlyGuard =
    isReadOnlyTaskMode(effectiveTaskMode)
      ? buildReadOnlyGuard(taskText, {
          force: effectiveReadOnlyMode || isReadOnlyTaskMode(effectiveTaskMode),
        })
      : null;
  const qaReviewGuard = buildQaReviewGuard(taskText);
  const architectureReviewGuard = buildArchitectureReviewGuard(taskText, effectiveTaskMode);
  const productWriteGuard = buildProductWriteGuard(taskText, effectiveTaskMode);
  const workerReadOnlyContextPrompt = buildWorkerReadOnlyContextPrompt(contract);
  const domainGuard = isAutomationSystemTask(taskText)
    ? [
        "【自动化系统任务边界】",
        "task_domain: automation_system",
        "本任务只验收 Worker / Codex / 飞书总经理 / Hermes / 路由 / 上报链路相关目标。",
        "不得把同城搭子产品页面、首批城市、首批分类、访客浏览、本地草稿、待审核流程当作完成依据。",
        "不得读取 docs/NEXT_TASK_CARD.md、docs/PROJECT_INDEX.md 或产品规划文档来替代本次系统修复目标。",
      ].join("\n")
    : `【任务分类】\ntask_domain: ${taskDomain}`;

  return [
    CODEX_GIT_OPERATION_GUARD,
    "",
    readOnlyGuard,
    readOnlyGuard ? "" : null,
    qaReviewGuard,
    qaReviewGuard ? "" : null,
    architectureReviewGuard,
    architectureReviewGuard ? "" : null,
    productWriteGuard,
    productWriteGuard ? "" : null,
    workerReadOnlyContextPrompt,
    workerReadOnlyContextPrompt ? "" : null,
    domainGuard,
    "",
    "【统一任务模式】",
    `task_mode: ${effectiveTaskMode}`,
    `read_only_mode: ${effectiveReadOnlyMode ? "true" : "false"}`,
    `can_write_files: ${effectiveReadOnlyMode ? "false" : "true"}`,
    "docs_write_allowed: only docs/** may change.",
    "automation_system_write_allowed: only approved automation-system files may change.",
    `product_write_allowed: may change ${PRODUCT_WRITE_ALLOWED_SCOPE_TEXT}.`,
    "Codex may only modify files in allowed_scope and must respect forbidden_scope.",
    "Codex must not run git add, git commit, or git push; the outer Worker owns Git writes.",
    "read_only tasks must not write files.",
    "",
    ...formatWorkerJobContractLines(contract, { includeOriginalRequest: false }),
    "",
    "【原始任务内容】",
    promptTaskText,
    "",
    "【再次强调】",
    CODEX_GIT_OPERATION_GUARD,
  ].join("\n");
}

function buildCodexPrompt(job) {
  assertExplicitTaskFieldsNotOverridden(job);
  const contract = resolveWorkerJobContract(job, {
    taskMode: getTaskMode(job),
    readOnlyMode: isReadOnlyTask(job),
    workerStage: "codex_prompt",
    workflowStage: "codex_prompt",
  });
  const taskText = contract.original_request_text || job?.request_text || "";
  return buildWorkerGuardedPrompt(taskText, {
    readOnlyMode: isReadOnlyTask(job),
    taskMode: getTaskMode(job),
    payload: job?.payload || null,
    contract,
  });
}

function buildCodexExecArgs(_prompt, job) {
  const contract = resolveWorkerJobContract(job, {
    taskMode: getTaskMode(job),
    readOnlyMode: isReadOnlyTask(job),
    workerStage: "codex_spawn",
    workflowStage: "codex_spawn",
  });
  const sandboxMode =
    contract.read_only_mode === true || isReadOnlyTaskMode(contract.task_mode)
      ? "read-only"
      : "workspace-write";

  return [
    "exec",
    "-C",
    PROJECT_DIR,
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-",
  ];
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
    ].join("\n"),
    {
      readOnlyMode: isReadOnlyTask(job),
      taskMode: getTaskMode(job),
      contract: resolveWorkerJobContract(job, {
        taskMode: getTaskMode(job),
        readOnlyMode: isReadOnlyTask(job),
        workerStage: `codex_retry_${attempt}`,
        workflowStage: `codex_retry_${attempt}`,
      }),
    }
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
    reportResult.skipped ? `skipped: ${reportResult.note || "true"}` : "",
    reportResult.reportWriteError ? `warning: 诊断报告写入失败：${reportResult.reportWriteError}` : "",
    reportResult.warning ? `warning: ${reportResult.error || "本地预览诊断失败"}` : "",
  ].join("\n");
}

function classifyFailure(error) {
  const errorText = error instanceof Error ? error.message : String(error);
  const lower = errorText.toLowerCase();

  if (
    error?.code === CODEX_USAGE_LIMIT ||
    isCodexUsageLimitText(errorText)
  ) {
    return {
      stage: "codex_execution",
      keyError: sanitizeCodexFailureDetail(errorText).slice(-1200),
      suggestion:
        "Codex 额度耗尽；等待错误摘要中的恢复时间后重试。verification-only 任务应由 Worker no-op 完成，不应进入 Codex。",
      recommendBossApproval: false,
      retryable: true,
    };
  }

  if (error?.code === NO_FIX_APPLIED || errorText.includes(NO_FIX_APPLIED)) {
    return {
      stage: "任务目标完成验收",
      keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
      suggestion:
        "重新执行对应失败批次的最小修复任务；必须产生任务要求的文件变更，或明确报告阻塞原因，禁止空跑成功。",
      recommendBossApproval: true,
    };
  }

  if (
    error?.code === READ_ONLY_MODE_VIOLATION ||
    errorText.includes(READ_ONLY_MODE_VIOLATION)
  ) {
    return {
      stage: "read_only_mode 验收",
      keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
      suggestion:
        "只读任务不得产生文件变更；保留现场给人工确认，重新执行时必须继续使用 read_only_mode，禁止 git add/commit/push。",
      recommendBossApproval: true,
    };
  }

  if (error?.code === "GIT_ADD_PATH_RESOLUTION" || lower.includes("pathspec")) {
    return {
      stage: "git add 路径解析",
      keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
      suggestion:
        "检查 git status 解析逻辑，使用 git status --porcelain=v1 -z；git add 前校验路径真实存在，保留原始 status 行用于排查。",
      recommendBossApproval: true,
    };
  }

  if (
    error?.code === "GIT_SYNC_FAILED" ||
    /git\s+(?:fetch|pull|ls-remote|sync|remote)|schannel|TLS|SSL|CERT|handshake|timed?\s*out|timeout|ECONNRESET|EAI_AGAIN|ENOTFOUND|fetch failed|connection reset/i.test(
      errorText
    )
  ) {
    return {
      stage: "git_sync_preflight",
      keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
      suggestion:
        "Git 同步预检失败且可重试；先恢复网络/TLS/远端连接后重试，禁止进入 Codex 执行或伪造成功。",
      recommendBossApproval: false,
      retryable: true,
    };
  }

  if (
    error?.code === "BUSINESS_PAGE_BOUNDARY_VIOLATION" ||
    error?.code === OUT_OF_SCOPE_BUSINESS_CHANGE ||
    error?.code === OUT_OF_SCOPE_SYSTEM_CHANGE ||
    error?.code === ORIGINAL_BATCH_CONTEXT_MISSING ||
    error?.code === TASK_MODE_MISMATCH ||
    error?.code === MISSING_REQUIRED_DOCS ||
    error?.code === INSUFFICIENT_DOC_OUTPUT ||
    errorText.includes(OUT_OF_SCOPE_BUSINESS_CHANGE) ||
    errorText.includes(OUT_OF_SCOPE_SYSTEM_CHANGE) ||
    errorText.includes(ORIGINAL_BATCH_CONTEXT_MISSING)
  ) {
    return {
      stage:
        error?.code === ORIGINAL_BATCH_CONTEXT_MISSING
          ? "原始批次上下文缺失"
          : error?.code === OUT_OF_SCOPE_SYSTEM_CHANGE
          ? "产品任务系统文件边界检查"
          : "自动化任务范围边界检查",
      keyError: sanitizeGitErrorMessage(errorText).slice(-1200),
      suggestion:
        error?.code === ORIGINAL_BATCH_CONTEXT_MISSING
          ? "拒绝创建或执行缺少原始需求全文的 BATCH-FIX 任务；必须由总管查询并携带 original_request_text 后重新入队。"
          : error?.code === OUT_OF_SCOPE_SYSTEM_CHANGE
          ? "撤回 Worker / Gateway / 总管 / 腾讯云中转等系统文件改动，只保留 BATCH-FIX 产品修复允许范围内的 src/app/** 和批准产品文档。"
          : "撤回业务页面改动，只保留 Worker / Codex / report / heartbeat 相关允许文件；如确需改业务页面，必须由老板单独批准对应产品开发批次。",
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
  const errorText = error instanceof Error ? error.message : String(error);
  const errorCode =
    normalizeFailureCodeValue(error?.code) ||
    classifyFailureCodeFromText(errorText) ||
    "UNKNOWN_ERROR";
  const failureDetail =
    error?.failureDetail ||
    (errorCode === CODEX_USAGE_LIMIT ? sanitizeCodexFailureDetail(errorText) : null);
  const readOnlyViolation = errorCode === READ_ONLY_MODE_VIOLATION;
  const noFixApplied = errorCode === NO_FIX_APPLIED;
  const outOfScopeBusinessChange =
    errorCode === OUT_OF_SCOPE_BUSINESS_CHANGE ||
    errorCode === "BUSINESS_PAGE_BOUNDARY_VIOLATION";
  const taskModeMismatch = errorCode === TASK_MODE_MISMATCH;
  const missingRequiredDocs = errorCode === MISSING_REQUIRED_DOCS;
  const insufficientDocOutput = errorCode === INSUFFICIENT_DOC_OUTPUT;
  const workerReadOnlyContextIncomplete = errorCode === WORKER_READONLY_CONTEXT_INCOMPLETE;
  const workerExecutionStatus = noFixApplied
    ? "succeeded_until_task_goal_validation"
    : missingRequiredDocs || insufficientDocOutput
    ? "succeeded_until_required_docs_validation"
    : workerReadOnlyContextIncomplete
    ? "succeeded_until_worker_readonly_context_validation"
    : readOnlyViolation
    ? "succeeded_until_read_only_validation"
    : taskModeMismatch
    ? "succeeded_until_task_mode_validation"
    : outOfScopeBusinessChange
    ? "succeeded_until_scope_validation"
    : "failed";
  const taskGoalStatus = readOnlyViolation
    ? "failed_read_only_mode_violation"
    : workerReadOnlyContextIncomplete
    ? "failed_worker_readonly_context_incomplete"
    : noFixApplied
    ? "failed_no_fix_applied"
    : missingRequiredDocs
    ? "failed_missing_required_docs"
    : insufficientDocOutput
    ? "failed_insufficient_doc_output"
    : taskModeMismatch
    ? "failed_task_mode_mismatch"
    : outOfScopeBusinessChange
    ? "failed_out_of_scope_business_change"
    : `failed_${errorCode}`;
  const taskMode = getTaskMode(job);
  const contract = context.contract || resolveWorkerJobContract(job, {
    taskMode,
    workflowStage: "failed",
    finalReportStatus: "failed",
    effectiveFinalStatus: "failed",
    changedFiles: filesChanged,
    gitCommitSha: context.commitSha || null,
    pushed: false,
    deployStatus: null,
  });
  const normalizedFinalResult = normalizeWorkerFinalResult({
    job,
    status: "failed",
    finalReportStatus: "failed",
    effectiveFinalStatus: contract.effective_final_status || "failed",
    failureCode: contract.failure_code,
    failureStage: contract.failure_stage,
    error,
    gitCommitSha: contract.git_commit_sha,
    nextBatch: contract.next_batch,
    completedAt: contract.completed_at,
  });
  const codexDiagnostics = error?.codexDiagnostics || getCodexReportDiagnostics();
  const stdinTransportVerified =
    errorCode === "CODEX_STDIN_TRANSPORT_FAILED"
      ? "false"
      : /^CODEX_/.test(errorCode)
      ? "unknown"
      : "not_applicable";

  return [
    "Codex 任务执行失败",
    `任务编号：${job?.id || "未提供"}`,
    `任务名称：${taskName || "未提供"}`,
    ...formatWorkerJobContractLines(contract, {
      includeOriginalRequest: false,
    }),
    "Worker 执行状态：已完成本地执行链路并进入结果验收",
    `任务目标状态：失败（${errorCode}）`,
    `Worker execution status: ${workerExecutionStatus}`,
    `Task goal status: ${taskGoalStatus}`,
    `task_mode: ${taskMode}`,
    ...formatCodexDiagnosticLines(codexDiagnostics),
    `stdin_transport_verified: ${stdinTransportVerified}`,
    "prompt_in_spawnargs: false",
    `effective_final_status: ${contract.effective_final_status || normalizedFinalResult.effective_final_status}`,
    `failure_memory_status: ${normalizedFinalResult.failure_memory_status}`,
    `failure_code: ${normalizedFinalResult.failure_code || "null"}`,
    `failure_stage: ${normalizedFinalResult.failure_stage || "null"}`,
    `failure_detail: ${failureDetail || "null"}`,
    `next_batch: ${normalizedFinalResult.next_batch || "null"}`,
    `Read-only violation: ${readOnlyViolation ? "yes" : "no"}`,
    `No-op run: ${noFixApplied ? "yes" : "no"}`,
    `Task mode mismatch: ${taskModeMismatch ? "yes" : "no"}`,
    `required_docs_total: ${error?.requiredDocs?.length || 0}`,
    `required_docs_present: ${error?.presentDocs?.length || 0}`,
    `required_docs_changed: ${error?.changedDocs?.length || 0}`,
    `missing_required_docs: ${
      error?.missingDocs?.length ? error.missingDocs.join(", ") : "none"
    }`,
    `insufficient_doc_output: ${insufficientDocOutput ? "yes" : "no"}`,
    `Out-of-scope business change: ${outOfScopeBusinessChange ? "yes" : "no"}`,
    `Committed: ${context.commitSha ? "yes" : "no"}`,
    "Pushed: no",
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

function buildSkippedAutomationPreviewReport() {
  return {
    ok: true,
    skipped: true,
    removedCaches: [],
    routeFiles: [],
    staticChecks: [],
    note:
      "automation_system task: skipped city-partner product route checks; product pages are not completion evidence for system repair tasks.",
  };
}

function buildSkippedReadOnlyPreviewReport() {
  return {
    ok: true,
    skipped: true,
    removedCaches: [],
    routeFiles: [],
    staticChecks: [],
    note:
      "read_only_mode task: skipped local preview recovery and route checks to avoid filesystem writes.",
  };
}

function buildGithubPushStatus(pushResult) {
  if (!pushResult) {
    return "未生成";
  }

  return pushResult.pushed
    ? `已推送：${pushResult.remote}/${pushResult.branch}`
    : pushResult.message || "未推送";
}

function shouldCallCodexForContract(contract = {}) {
  return (
    contract.verification_only !== true &&
    contract.worker_only !== true &&
    contract.code_changes_required === true &&
    contract.codex_required === true
  );
}

function shouldRunDeterministicGitOperation(job, contract = {}) {
  if (contract.deterministic_git_operation !== true) {
    return false;
  }

  return /\b(?:git\s+push|push\s+git|fast[ -]?forward|master-fast-forward)\b/i.test(
    getJobText(job)
  );
}

function createExecutionPolicyError(contract, message) {
  const error = new Error(
    [
      contract?.execution_policy_conflict || "DETERMINISTIC_WORKER_OPERATION_UNAVAILABLE",
      message,
      "codex_called: false",
      "git_mutation_executed: false",
    ].join("\n")
  );
  error.code = contract?.execution_policy_conflict
    ? "EXECUTION_POLICY_CONFLICT"
    : "DETERMINISTIC_WORKER_OPERATION_UNAVAILABLE";
  error.failureStage = "execution_policy";
  return error;
}

async function runCodexWithRetries(job) {
  const prompts = isReadOnlyTask(job)
    ? [() => buildCodexPrompt(job)]
    : [
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

      return await runCodex(prompts[index](failures[failures.length - 1]), job, {
        retryNumber: index + 1,
      });
    } catch (error) {
      const usageLimitError = toCodexUsageLimitError(error);
      if (usageLimitError) {
        throw usageLimitError;
      }
      failures.push(error);
    }
  }

  const summary = failures
    .map((error, index) => {
      const message = error instanceof Error ? error.message : String(error);
      return `第 ${index + 1} 次失败：${classifyLocalError(message)} - ${message.slice(-1200)}`;
    })
    .join("\n\n");

  const usageLimitError = toCodexUsageLimitError(summary);
  if (usageLimitError) {
    throw usageLimitError;
  }

  throw new Error(
    [
      "项目总管连续自动修复失败，已停止继续尝试。",
      "需要老板二选一决策：A. 允许扩大修改范围继续修；B. 保持当前状态，人工指定优先修哪个问题。",
      summary,
    ].join("\n\n")
  );
}

async function commitGitTask(job) {
  const taskMode = getTaskMode(job);
  const readOnlyMode = isReadOnlyTaskMode(taskMode);
  const taskChangedEntries = await getTaskChangedEntries();
  const taskChangedPaths = getStatusPaths(taskChangedEntries);

  if (readOnlyMode) {
    if (taskChangedPaths.length > 0) {
      throw createReadOnlyModeViolationError(taskChangedPaths);
    }

    return {
      committed: false,
      commitSha: null,
      message: "read_only_mode=true，跳过 Git add/commit",
      summary: "read_only_mode=true; no files changed",
      filesChanged: [],
      readOnlyMode: true,
    };
  }

  assertTaskGoalApplied(job, taskChangedPaths);

  if (!GIT_AUTO_COMMIT) {
    return {
      committed: false,
      message: "Git 自动提交已关闭",
      filesChanged: taskChangedPaths,
    };
  }

  if (taskChangedPaths.length === 0) {
    return {
      committed: false,
      message: "Codex 没有产生文件变更",
      filesChanged: [],
    };
  }

  if (taskMode !== TASK_MODES.PRODUCT_WRITE_ALLOWED) {
    validateAutomationTaskBoundaries(taskChangedPaths, {
      requestText: job?.request_text || job?.prompt || "",
    });
  }

  const stagedPaths = await stageTaskPaths(taskChangedPaths, taskChangedEntries);
  assertTaskGoalApplied(job, stagedPaths);

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
  assertGitOperationAllowed(["push", GIT_REMOTE_NAME, GIT_PUSH_BRANCH], {
    commitSha,
  });

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

async function runDeterministicGitOperation(job, contract) {
  if (!shouldRunDeterministicGitOperation(job, contract)) {
    throw createExecutionPolicyError(
      contract,
      "Explicit no-Codex policy has no supported deterministic Git operation."
    );
  }

  await runGit(["rev-parse", "--is-inside-work-tree"]);
  await assertCleanWorktreeBeforeCodex();

  const branchResult = await runGit(["branch", "--show-current"]);
  if (branchResult.stdout !== REQUIRED_GIT_PUSH_BRANCH) {
    throw createExecutionPolicyError(
      contract,
      `Deterministic Git operation requires branch ${REQUIRED_GIT_PUSH_BRANCH}.`
    );
  }

  await runGit(["fetch", REQUIRED_GIT_PUSH_REMOTE, "--prune"]);

  const localBefore = (await runGit(["rev-parse", "HEAD"])).stdout;
  const remoteRef = `${REQUIRED_GIT_PUSH_REMOTE}/${REQUIRED_GIT_PUSH_BRANCH}`;
  const remoteBefore = (await runGit(["rev-parse", remoteRef])).stdout;
  const mergeBase = (await runGit(["merge-base", localBefore, remoteBefore])).stdout;
  let operation = "already_up_to_date";
  let pushResult = {
    pushed: false,
    remote: REQUIRED_GIT_PUSH_REMOTE,
    branch: REQUIRED_GIT_PUSH_BRANCH,
    commitSha: localBefore,
    message: "Remote master already contains local HEAD",
  };

  if (mergeBase === localBefore && localBefore !== remoteBefore) {
    await runGit(["merge", "--ff-only", remoteRef]);
    operation = "fast_forward_local_master";
  } else if (mergeBase === remoteBefore && localBefore !== remoteBefore) {
    pushResult = await pushGitTask(localBefore);
    if (!pushResult.pushed) {
      throw createExecutionPolicyError(
        contract,
        pushResult.message || "Deterministic Git push was not executed."
      );
    }
    operation = "push_local_master";
  } else if (localBefore !== remoteBefore) {
    throw createExecutionPolicyError(
      contract,
      "Local master and origin/master have diverged; fast-forward is not possible."
    );
  }

  await assertCleanWorktreeBeforeCodex();
  await runGit(["fetch", REQUIRED_GIT_PUSH_REMOTE, "--prune"]);
  const localHead = (await runGit(["rev-parse", "HEAD"])).stdout;
  const remoteHead = (await runGit(["rev-parse", remoteRef])).stdout;
  if (localHead !== remoteHead) {
    throw createExecutionPolicyError(
      contract,
      "Deterministic Git operation did not converge local HEAD and origin/master."
    );
  }

  return {
    operation,
    localBefore,
    remoteBefore,
    mergeBase,
    commitSha: localHead,
    remoteContainsCommit: true,
    pushResult: {
      ...pushResult,
      commitSha: localHead,
      remoteContainsCommit: true,
    },
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
    if (isTerminalReportLockedForJob(jobId)) {
      stopped = true;
      clearInterval(timer);
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
      if (recordPostCompletionTransportWarning(error, "worker_progress", jobId)) {
        return;
      }
      console.warn(
        "Codex 执行期间心跳上报异常：",
        error instanceof Error ? error.message : String(error)
      );
    }
  }, CODEX_PROGRESS_HEARTBEAT_INTERVAL_MS);

  return registerTerminalTimerStopper("progress", () => {
    stopped = true;
    clearInterval(timer);
  });
}

function spawnCodexWithStdin(prompt, job, options = {}) {
  return new Promise((resolve, reject) => {
    const promptText = String(prompt || "");
    const promptBytes = Buffer.byteLength(promptText, "utf8");
    const promptSha256 = crypto.createHash("sha256").update(promptText).digest("hex");
    const retryNumber = Number(options.retryNumber || 1);
    const codexArgs = buildCodexExecArgs(null, job);
    const timeoutMs = Number(options.timeoutMs || CODEX_TIMEOUT_MS);
    const idleTimeoutMs = Number(options.idleTimeoutMs || CODEX_IDLE_TIMEOUT_MS);
    let child;

    console.log(`开始执行 Codex，项目目录：${PROJECT_DIR}`);

    try {
      child = spawnCodexProcess(codexArgs, {
        ...options,
        codexResolution: options.codexResolution,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const diagnostic = formatCodexSpawnError(
        error,
        error && error.codexCommandInfo
      );
      const spawnError = createCodexTransportError(
        "CODEX_SPAWN_FAILED",
        `${diagnostic || "CODEX_SPAWN_FAILED"}\n${
          error && error.message ? error.message : String(error)
        }`,
        {
          error_code: error && error.code ? error.code : null,
          errno: error && Object.prototype.hasOwnProperty.call(error, "errno") ? error.errno : null,
          syscall: error && error.syscall ? error.syscall : null,
          prompt_bytes: promptBytes,
          retry_number: retryNumber,
        }
      );
      reject(spawnError);
      return;
    }

    const commandInfo = child.codexCommandInfo || {};
    const resolvedExecutable =
      commandInfo.codexResolution && commandInfo.codexResolution.resolvedPath;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stdinWriteCompleted = false;
    let stdinEndCalled = false;
    let exitSeen = false;
    let closeSeen = false;
    let pendingFailure = null;
    let lastOutputAt = Date.now();
    let stopCodexHeartbeat = () => {};
    let idleTimer;
    let hardTimer;
    let closeTimer;

    const cleanupTimers = () => {
      stopCodexHeartbeat();
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      clearTimeout(closeTimer);
    };

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(error);
    };

    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      resolve(value);
    };

    const buildStdinFailure = (error, message) =>
      createCodexTransportError(
        "CODEX_STDIN_TRANSPORT_FAILED",
        [
          formatCodexStdinDiagnostic({
            failure_code: "CODEX_STDIN_TRANSPORT_FAILED",
            failure_stage: "codex_stdin_transport",
            error_code: error && error.code ? error.code : null,
            errno: error && Object.prototype.hasOwnProperty.call(error, "errno") ? error.errno : null,
            syscall: error && error.syscall ? error.syscall : "stdin.write",
            resolved_executable: resolvedExecutable,
            prompt_bytes: promptBytes,
            retry_number: retryNumber,
          }),
          message || (error && error.message) || String(error || "stdin unavailable"),
        ].join("\n"),
        {
          error_code: error && error.code ? error.code : null,
          errno: error && Object.prototype.hasOwnProperty.call(error, "errno") ? error.errno : null,
          syscall: error && error.syscall ? error.syscall : "stdin.write",
          resolved_executable: resolvedExecutable || null,
          prompt_bytes: promptBytes,
          retry_number: retryNumber,
        }
      );

    const appendOutput = (target, chunk) => {
      const text = chunk.toString();
      lastOutputAt = Date.now();

      if (target === "stdout") {
        stdout += text;
        if (stdout.length > 2 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024);
        if (options.mirrorOutput !== false) process.stdout.write(text);
      } else {
        stderr += text;
        if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
        if (options.mirrorOutput !== false) process.stderr.write(text);
      }

      resetIdleTimer();
    };

    const requestTermination = (code, message) => {
      if (pendingFailure || settled) return;
      pendingFailure = createCodexTransportError(code, message, {
        prompt_bytes: promptBytes,
        retry_number: retryNumber,
        resolved_executable: resolvedExecutable || null,
      });

      try {
        if (child.stdin && !child.stdin.destroyed) {
          stdinEndCalled = true;
          child.stdin.end();
        }
      } catch {}

      killProcessTree(child.pid, message).finally(() => {
        if (closeSeen || settled) return;
        closeTimer = setTimeout(() => {
          rejectOnce(
            createCodexTransportError(
              "CODEX_PROCESS_CLOSE_TIMEOUT",
              "Codex process did not emit close after termination request.",
              {
                prompt_bytes: promptBytes,
                retry_number: retryNumber,
                resolved_executable: resolvedExecutable || null,
              }
            )
          );
        }, Number(options.closeTimeoutMs || 15000));
      });
    };

    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const idleMs = Date.now() - lastOutputAt;
        requestTermination(
          "CODEX_TIMEOUT",
          `Codex 空闲超时：${idleMs}ms 无输出，已强制结束进程树`
        );
      }, idleTimeoutMs);
    };

    child.on("error", (error) => {
      if (pendingFailure) return;
      rejectOnce(
        createCodexTransportError(
          "CODEX_SPAWN_FAILED",
          `${formatCodexSpawnError(error, commandInfo) || "CODEX_SPAWN_FAILED"}\n${
            error && error.message ? error.message : String(error)
          }`,
          {
            error_code: error && error.code ? error.code : null,
            errno: error && Object.prototype.hasOwnProperty.call(error, "errno") ? error.errno : null,
            syscall: error && error.syscall ? error.syscall : null,
            prompt_bytes: promptBytes,
            retry_number: retryNumber,
            resolved_executable: resolvedExecutable || null,
          }
        )
      );
    });

    child.on("exit", () => {
      exitSeen = true;
    });

    child.on("close", (code) => {
      closeSeen = true;
      if (pendingFailure) {
        rejectOnce(pendingFailure);
        return;
      }

      if (!exitSeen && code !== 0) {
        rejectOnce(
          createCodexTransportError(
            "CODEX_PROCESS_EXIT_FAILED",
            `Codex process closed before exit event; close code ${code}.`,
            {
              prompt_bytes: promptBytes,
              retry_number: retryNumber,
              resolved_executable: resolvedExecutable || null,
            }
          )
        );
        return;
      }

      if (code === 0) {
        console.log(
          [
            "codex_stdin_transport_complete=true",
            `fixed_spawnargs=${JSON.stringify(sanitizeSpawnArgs(commandInfo.args || []))}`,
            `prompt_bytes=${promptBytes}`,
            `prompt_sha256=${promptSha256}`,
            `retry_number=${retryNumber}`,
            "stdin_transport=true",
            `stdin_write_completed=${stdinWriteCompleted ? "true" : "false"}`,
            `stdin_end_called=${stdinEndCalled ? "true" : "false"}`,
          ].join(" ")
        );
        resolveOnce(stdout.trim() || "Codex 执行完成");
        return;
      }

      const combinedOutput = `${stderr || ""}\n${stdout || ""}`;
      const usageLimitError = toCodexUsageLimitError(
        `Codex 退出码 ${code}\n${combinedOutput || "没有输出"}`
      );
      if (usageLimitError) {
        rejectOnce(usageLimitError);
        return;
      }

      rejectOnce(
        createCodexTransportError(
          "CODEX_PROCESS_EXIT_FAILED",
          `Codex 退出码 ${code}\n${combinedOutput.trim() || "没有输出"}`,
          {
            prompt_bytes: promptBytes,
            retry_number: retryNumber,
            resolved_executable: resolvedExecutable || null,
          }
        )
      );
    });

    if (child.stdout) child.stdout.on("data", (chunk) => appendOutput("stdout", chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => appendOutput("stderr", chunk));

    if (!child.stdin || child.stdin.destroyed || child.stdin.writable === false) {
      rejectOnce(buildStdinFailure(null, "stdin unavailable or not writable"));
      return;
    }

    stopCodexHeartbeat = options.heartbeat === false ? () => {} : startCodexHeartbeat(job);
    resetIdleTimer();
    hardTimer = setTimeout(() => {
      requestTermination(
        "CODEX_TIMEOUT",
        `Codex 执行总超时：${timeoutMs}ms，已强制结束进程树`
      );
    }, timeoutMs);

    child.stdin.once("error", (error) => {
      if (stdinWriteCompleted || pendingFailure || settled) return;
      requestTermination(
        "CODEX_STDIN_TRANSPORT_FAILED",
        buildStdinFailure(error).message
      );
    });

    try {
      child.stdin.write(promptText, "utf8", (error) => {
        if (error) {
          requestTermination(
            "CODEX_STDIN_TRANSPORT_FAILED",
            buildStdinFailure(error).message
          );
          return;
        }
        stdinWriteCompleted = true;
        if (!stdinEndCalled) {
          stdinEndCalled = true;
          child.stdin.end();
        }
      });
    } catch (error) {
      requestTermination(
        "CODEX_STDIN_TRANSPORT_FAILED",
        buildStdinFailure(error).message
      );
    }
  });
}

function runCodex(prompt, job, options = {}) {
  return spawnCodexWithStdin(prompt, job, options);
}

async function updateProgress(
  jobId,
  progressPercent,
  currentStep,
  statusMessage = "",
  attemptId = null
) {
  if (isTerminalReportLockedForJob(jobId)) {
    return true;
  }

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
      if (
        recordPostCompletionTransportWarning(
          { status: response.status, text },
          "worker_progress",
          jobId
        )
      ) {
        return true;
      }
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
    if (recordPostCompletionTransportWarning(error, "worker_progress", jobId)) {
      return true;
    }
    console.warn(
      "任务进度上报异常：",
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

async function report(jobId, status, payload, extra = {}) {
  const attemptId = extra.attempt_id || currentAttemptId || null;
  const terminalStatus = normalizeTerminalStatus(status);
  if (["succeeded", "failed", "cancelled"].includes(terminalStatus)) {
    stopTerminalReportTimers();
  }
  const normalizedExtra = { ...extra };
  if (normalizedExtra.changed_files === undefined && normalizedExtra.files_changed !== undefined) {
    normalizedExtra.changed_files = normalizedExtra.files_changed;
  }
  if (normalizedExtra.files_changed === undefined && normalizedExtra.changed_files !== undefined) {
    normalizedExtra.files_changed = normalizedExtra.changed_files;
  }
  normalizedExtra.report_schema_version =
    normalizedExtra.report_schema_version || CANONICAL_WORKER_REPORT_SCHEMA_VERSION;
  normalizedExtra.worker_instance_id = normalizedExtra.worker_instance_id || WORKER_NAME;
  normalizedExtra.batch_code =
    normalizedExtra.batch_code ||
    normalizedExtra.approved_batch ||
    extractCurrentExecutionBatchCode(payload) ||
    null;
  normalizedExtra.worker_execution_status =
    normalizedExtra.worker_execution_status ||
    (terminalStatus === "failed" ? "failed" : terminalStatus === "succeeded" ? "succeeded" : status);
  normalizedExtra.task_goal_status =
    normalizedExtra.task_goal_status ||
    (terminalStatus === "failed" ? "failed" : terminalStatus === "succeeded" ? "completed" : status);
  normalizedExtra.effective_final_status =
    normalizedExtra.effective_final_status || terminalStatus || status;
  normalizedExtra.committed_files =
    normalizedExtra.committed_files || normalizedExtra.changed_files || normalizedExtra.files_changed || [];
  normalizedExtra.unexpected_changed_files = normalizedExtra.unexpected_changed_files || [];
  normalizedExtra.terminal_state_persisted =
    normalizedExtra.terminal_state_persisted === undefined ? true : normalizedExtra.terminal_state_persisted;
  normalizedExtra.post_completion_state_applied =
    normalizedExtra.post_completion_state_applied === undefined ? true : normalizedExtra.post_completion_state_applied;
  normalizedExtra.final_report_source =
    normalizedExtra.final_report_source || "worker_runtime_report";
  const body =
    status === "succeeded"
      ? {
          job_id: jobId,
          attempt_id: attemptId,
          worker_id: WORKER_NAME,
          worker_name: WORKER_NAME,
          status,
          result_text: payload,
          ...normalizedExtra,
        }
      : {
          job_id: jobId,
          attempt_id: attemptId,
          worker_id: WORKER_NAME,
          worker_name: WORKER_NAME,
          status,
          error_text: payload,
          ...normalizedExtra,
        };

  const response = await request("/api/worker/report", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`上报失败 HTTP ${response.status}: ${text}`);
  }

  let responseBody = null;
  try {
    responseBody = text ? JSON.parse(text) : null;
  } catch (_) {
    responseBody = null;
  }

  if (["succeeded", "failed", "cancelled"].includes(terminalStatus)) {
    lockAcceptedTerminalReportSnapshot({
      status,
      reportBody: body,
      acceptedFinalReportResponse: responseBody,
    });
  }

  console.log(`任务 ${jobId} 已上报为 ${status}`);
  return {
    ok: true,
    response: responseBody,
    terminal_snapshot: getTerminalReportSnapshot(),
  };
}

async function completeVerificationOnlyNoopJob(job, attemptId, initialContract) {
  const taskModeForReport = initialContract.task_mode;
  const completedAt = new Date().toISOString();
  const approvedBatchForReport = initialContract.approved_batch || getJobBatchCode(job);
  const workerExecutionStatus = "completed";
  const taskGoalStatus = "completed";
  const codexDiagnostics = getCodexReportDiagnostics();
  const noopResultText = [
    "verification-only dispatch no-op completed by Windows Worker.",
    "Codex was not called because verification_only=true and allow_no_change_success=true.",
    "codex_called: false",
    ...formatCodexDiagnosticLines(codexDiagnostics),
    "stdin_transport_verified: skipped_verification_only",
    "prompt_in_spawnargs: false",
    "worker_execution_status: completed",
    "task_goal_status: completed",
    "effective_final_status: succeeded",
    "failure_code: null",
    "failure_stage: null",
    "verification_only: true",
    "allow_no_change_success: true",
    "code_changes_required: false",
    "codex_required: false",
    "git_commit_required: false",
    "git_push_required: false",
    "changed_files: []",
    "git_commit_sha: null",
    "git_push: false",
    "next_stage_allowed: false",
  ].join("\n");
  const normalizedFinalResult = normalizeWorkerFinalResult({
    job,
    status: "succeeded",
    finalReportStatus: "succeeded",
    effectiveFinalStatus: "succeeded",
    worker_execution_status: workerExecutionStatus,
    task_goal_status: taskGoalStatus,
    resultText: noopResultText,
    approvedBatch: approvedBatchForReport,
    changed_files: [],
    gitCommitSha: null,
    pushed: false,
    nextBatch: null,
    next_stage_allowed: false,
    completedAt,
  });
  const successContract = resolveWorkerJobContract(job, {
    attemptId,
    taskMode: taskModeForReport,
    readOnlyMode: false,
      verificationOnly: true,
      allowNoChangeSuccess: true,
      codeChangesRequired: false,
      codexRequired: false,
      gitCommitRequired: false,
      gitPushRequired: false,
    workerStage: "completed",
    workflowStage: "completed",
    finalReportStatus: "succeeded",
    effectiveFinalStatus: normalizedFinalResult.effective_final_status,
    failureCode: null,
    failureStage: null,
    changedFiles: [],
    gitCommitSha: null,
    nextBatch: null,
    completedAt: normalizedFinalResult.completed_at,
    pushed: false,
    deployStatus: null,
  });

  await updateProgress(
    job.id,
    35,
    "verification-only no-op",
    "verification_only=true；跳过 Codex、Git commit 和 Git push"
  );

  const finalResult = [
    noopResultText,
    "",
    ...formatWorkerJobContractLines(successContract, {
      includeOriginalRequest: false,
    }),
    "",
    "Worker / task status:",
    "Worker execution: completed",
    "Worker execution status: completed",
    "Task goal: completed",
    "Task goal status: completed",
    `task_domain: ${classifyWorkerTaskDomain(getJobText(job))}`,
    `task_mode: ${taskModeForReport}`,
    "read_only_mode: false",
    "verification_only: true",
    "allow_no_change_success: true",
    "code_changes_required: false",
    "codex_required: false",
    "git_commit_required: false",
    "git_push_required: false",
    "codex_called: false",
    ...formatCodexDiagnosticLines(codexDiagnostics),
    "stdin_transport_verified: skipped_verification_only",
    "prompt_in_spawnargs: false",
    "original_worker_status: succeeded",
    "effective_final_status: succeeded",
    "failure_code: null",
    "failure_stage: null",
    "read_only_violation: false",
    "no_fix_applied: false",
    "out_of_scope_business_change: false",
    "no_op_run: false",
    "committed: false",
    "pushed: false",
    "git_push: false",
    "git_commit_sha: null",
    "next_stage_allowed: false",
    `failure_memory_status: ${normalizedFinalResult.failure_memory_status}`,
    `completed_at: ${normalizedFinalResult.completed_at || "null"}`,
    "",
    "本地预览诊断：未执行（verification_only no-op）",
    "Git 自动备份：跳过（verification_only=true）",
    "GitHub 自动推送：跳过（verification_only=true）",
  ].join("\n");

  await updateProgress(
    job.id,
    100,
    "verification-only 完成",
    "零文件变更验证任务已完成并准备上报"
  );

  await report(
    job.id,
    "succeeded",
    finalResult,
    {
      attempt_id: attemptId,
      batch_code: successContract.approved_batch || approvedBatchForReport,
      job_created_at: job.created_at || null,
      ...buildWorkerReportContractExtra(successContract),
      project_name: "同城搭子网站",
      project_dir: PROJECT_DIR,
      files_changed: [],
      validation_results: [
        "Worker 领取：通过",
        "attempt_id 创建/绑定：通过",
        "heartbeat 上报：通过",
        "Codex 执行：跳过（verification_only=true）",
        "codex_called: false",
        ...formatCodexDiagnosticLines(codexDiagnostics),
        "stdin_transport_verified: skipped_verification_only",
        "prompt_in_spawnargs: false",
        "Worker execution status: completed",
        "Task goal status: completed",
        "effective_final_status: succeeded",
        "failure_code: null",
        "failure_stage: null",
        "verification_only: true",
        "allow_no_change_success: true",
        "code_changes_required: false",
        "codex_required: false",
        "git_commit_required: false",
        "git_push_required: false",
        "changed_files: []",
        "git_commit_sha: null",
        "git_push: false",
        "next_stage_allowed: false",
      ],
      github_push_status: "verification_only=true，跳过 GitHub 推送",
      read_only_mode: false,
      task_mode: taskModeForReport,
      verification_only: true,
      allow_no_change_success: true,
      code_changes_required: false,
      codex_required: false,
      git_commit_required: false,
      git_push_required: false,
      codex_called: false,
      original_worker_status: "succeeded",
      worker_execution_status: workerExecutionStatus,
      task_goal_status: taskGoalStatus,
      effective_final_status: normalizedFinalResult.effective_final_status,
      failure_memory_status: normalizedFinalResult.failure_memory_status,
      failure_code: null,
      failure_stage: null,
      failure_detail: null,
      terminal_index: normalizedFinalResult.terminal_index,
      auto_iteration_suggestion: normalizedFinalResult.auto_iteration_suggestion,
      next_batch: null,
      next_stage_allowed: false,
      completed_at: normalizedFinalResult.completed_at,
      no_fix_applied: false,
      read_only_mode_violation: false,
      out_of_scope_business_change: false,
      git_commit_sha: null,
      git_push: false,
      pushed: false,
      deploy_status: null,
    }
  );
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
  resetTerminalReportState();

  console.log(`领取任务： ${job.id}`);
  console.log(`执行尝试： ${attemptId || "legacy-no-attempt-id"}`);

  await updateProgress(
    job.id,
    5,
    "已领取任务",
    "任务已被 Worker 领取"
  );
  console.log(`任务内容：${job.request_text}`);

  const initialContract = resolveWorkerJobContract(job, {
    attemptId,
    workerStage: "claimed",
  });
  [
    `received_repair_mode=${initialContract.repair_mode === true ? "true" : "false"}`,
    `received_verification_only=${initialContract.verification_only === true ? "true" : "false"}`,
    `received_allow_no_change_success=${initialContract.allow_no_change_success === true ? "true" : "false"}`,
    `received_code_changes_required=${initialContract.code_changes_required === true ? "true" : "false"}`,
    `received_codex_required=${initialContract.codex_required === true ? "true" : "false"}`,
    `received_git_commit_required=${initialContract.git_commit_required === true ? "true" : "false"}`,
    `received_git_push_required=${initialContract.git_push_required === true ? "true" : "false"}`,
    `received_execution_intent=${initialContract.execution_intent || "null"}`,
    `received_execution_policy_source=${initialContract.execution_policy_source || "null"}`,
    `received_execution_policy_batch_code=${initialContract.execution_policy_batch_code || "null"}`,
  ].forEach((line) => console.log(line));
  const taskModeForReport = initialContract.task_mode;
  const readOnlyMode = initialContract.read_only_mode === true;
  const codexRequired = shouldCallCodexForContract(initialContract);
  const deterministicGitOperation = shouldRunDeterministicGitOperation(
    job,
    initialContract
  );
  currentReadOnlyMode = readOnlyMode;
  const stopHeartbeat = startHeartbeat(job.id, attemptId);
  let gitCheckpoint = null;

  try {
    assertOriginalBatchContextAvailable(job);
    assertWorkerReadOnlyContextComplete(initialContract);

    if (isVerificationOnlyNoopTask(job, initialContract)) {
      await completeVerificationOnlyNoopJob(job, attemptId, initialContract);
      return;
    }

    if (initialContract.execution_policy_conflict) {
      console.warn(
        `execution_policy_conflict=${initialContract.execution_policy_conflict}; explicit false preserved`
      );
    }

    if (!codexRequired && !deterministicGitOperation) {
      throw createExecutionPolicyError(
        initialContract,
        "Codex is explicitly disabled and this task has no supported deterministic Worker operation."
      );
    }

    let deterministicResult = null;

    if (deterministicGitOperation) {
      await updateProgress(
        job.id,
        10,
        "Worker deterministic Git preflight",
        "Explicit no-Codex policy accepted; validating clean master state"
      );

      deterministicResult = await runDeterministicGitOperation(job, initialContract);
      gitCheckpoint = {
        enabled: false,
        baseCommit: deterministicResult.localBefore,
        deterministicGitOperation: true,
      };

      await updateProgress(
        job.id,
        30,
        "Deterministic Git operation complete",
        deterministicResult.operation
      );
    } else if (readOnlyMode) {
      await updateProgress(
        job.id,
        10,
        "Worker 只读自检",
        "read_only_mode=true；只检查 Git 状态，不清理缓存、不还原生成文件"
      );

      await runGit(["rev-parse", "--is-inside-work-tree"]);
      await assertCleanWorktreeBeforeCodex();

      await updateProgress(
        job.id,
        15,
        "只读自检完成",
        "Git 工作区干净；已跳过会写入工作区的 preflight"
      );

      await updateProgress(
        job.id,
        20,
        "跳过 Git 同步",
        "read_only_mode=true；未执行 git fetch/switch/pull"
      );

      gitCheckpoint = {
        enabled: false,
        baseCommit: null,
        readOnlyMode: true,
      };

      await updateProgress(
        job.id,
        30,
        "Git 同步已跳过",
        "read_only_mode=true；Worker 不会修改本地分支"
      );
    } else {
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
    }

    let result;
    if (deterministicResult) {
      await updateProgress(
        job.id,
        35,
        "Skip Codex",
        "codex_required=false; deterministic Worker Git operation used"
      );
      result = [
        "Deterministic Worker Git operation completed.",
        `deterministic_git_operation: ${deterministicResult.operation}`,
        "codex_called: false",
        `execution_policy_conflict: ${initialContract.execution_policy_conflict || "null"}`,
      ].join("\n");
    } else {
      await updateProgress(
        job.id,
        35,
        "执行 Codex",
        "正在启动 Codex"
      );

      result = await runCodexWithRetries(job);

      await updateProgress(
        job.id,
        65,
        "Codex 执行完成",
        "Codex 已完成代码修改"
      );
    }

    let previewReport = null;

    if (deterministicResult) {
      previewReport = buildSkippedAutomationPreviewReport();

      await updateProgress(
        job.id,
        70,
        "Skip preview diagnostics",
        "Deterministic Git operation does not run product preview diagnostics"
      );
    } else if (readOnlyMode) {
      previewReport = buildSkippedReadOnlyPreviewReport();

      await updateProgress(
        job.id,
        70,
        "跳过本地预览诊断",
        "read_only_mode=true；不执行会写入工作区的本地预览恢复"
      );
    } else if (WORKER_PREVIEW_SMOKE && isAutomationSystemTask(getJobText(job))) {
      previewReport = buildSkippedAutomationPreviewReport();

      await updateProgress(
        job.id,
        70,
        "跳过产品页面预览诊断",
        "automation_system 任务不读取同城搭子产品页面作为完成依据"
      );
    } else if (WORKER_PREVIEW_SMOKE) {
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

    let gitResult;
    if (deterministicResult) {
      gitResult = {
        committed: false,
        commitSha: deterministicResult.commitSha,
        message: `No commit created; ${deterministicResult.operation}`,
        summary: "deterministic_git_operation=true; git_commit_required=false",
        filesChanged: [],
      };
    } else if (initialContract.git_commit_required === false) {
      const filesChanged = await getTaskChangedPaths();
      if (filesChanged.length > 0) {
        throw createExecutionPolicyError(
          initialContract,
          "git_commit_required=false but the execution produced worktree changes."
        );
      }
      gitResult = {
        committed: false,
        commitSha: null,
        message: "git_commit_required=false; commit skipped",
        summary: "No worktree changes and no commit created",
        filesChanged: [],
      };
    } else {
      gitResult = await commitGitTask(job);
    }
    assertWorkerReadOnlyTaskGoalComplete(job, result);
    assertQaTaskOutcome(job, gitResult.filesChanged || [], result);

    await updateProgress(
      job.id,
      85,
      "Git 提交完成",
      gitResult.committed
        ? `提交成功：${gitResult.commitSha}`
        : gitResult.message
    );

    let pushResult = deterministicResult
      ? deterministicResult.pushResult
      : readOnlyMode
      ? {
          pushed: false,
          message: "read_only_mode=true，跳过 GitHub 推送",
          readOnlyMode: true,
        }
      : {
          pushed: false,
          message: "没有新提交，无需推送",
        };

    if (
      !deterministicResult &&
      !readOnlyMode &&
      gitResult.committed &&
      initialContract.git_push_required !== false
    ) {
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

    let repositoryCleanAfterPush = readOnlyMode;
    let postPushWorktreeChangedFiles = [];
    if (!readOnlyMode) {
      try {
        postPushWorktreeChangedFiles = await getTaskChangedPaths();
        repositoryCleanAfterPush = postPushWorktreeChangedFiles.length === 0;
      } catch (_) {
        repositoryCleanAfterPush = false;
      }
    }
    const remoteContainsCommit =
      deterministicResult?.remoteContainsCommit === true || pushResult.pushed;

    const completedAt = new Date().toISOString();
    const approvedBatchForReport = initialContract.approved_batch || getJobBatchCode(job);
    const allowNoChangeSuccessForReport = allowsVerificationOnlyNoChangeSuccess(initialContract);
    const successWorkerExecutionStatus = "succeeded";
    const successTaskGoalStatus = readOnlyMode
      ? "completed_read_only_no_file_changes"
      : gitResult.filesChanged?.length
      ? "completed_with_file_changes"
      : allowNoChangeSuccessForReport
      ? "completed_verification_only_no_file_changes"
      : "completed_no_file_change_required";
    const normalizedFinalResult = normalizeWorkerFinalResult({
      job,
      status: "succeeded",
      finalReportStatus: "succeeded",
      effectiveFinalStatus: "succeeded",
      worker_execution_status: successWorkerExecutionStatus,
      task_goal_status: successTaskGoalStatus,
      resultText: result,
      approvedBatch: approvedBatchForReport,
      changed_files: gitResult.filesChanged || [],
      committed_files: gitResult.filesChanged || [],
      codex_changed_files: gitResult.filesChanged || [],
      worktree_changed_files: postPushWorktreeChangedFiles,
      task_changed_files: gitResult.filesChanged || [],
      unexpected_changed_files: [],
      gitCommitSha: gitResult.commitSha || null,
      pushed: pushResult.pushed,
      codex_git_push: "not_run_by_codex",
      worker_git_push: pushResult.pushed,
      git_push: pushResult.pushed,
      pushed_branch: pushResult.branch || null,
      remote_contains_commit: remoteContainsCommit,
      repository_clean_after_push: repositoryCleanAfterPush,
      nextBatch: extractNextBatchFromText(result),
      completedAt,
    });

    const successContract = resolveWorkerJobContract(job, {
      attemptId,
      taskMode: taskModeForReport,
      readOnlyMode,
      verificationOnly: initialContract.verification_only,
      allowNoChangeSuccess: initialContract.allow_no_change_success,
      codeChangesRequired: initialContract.code_changes_required,
      codexRequired: initialContract.codex_required,
      gitCommitRequired: initialContract.git_commit_required,
      gitPushRequired: initialContract.git_push_required,
      workerStage: "completed",
      workflowStage: "completed",
      finalReportStatus: "succeeded",
      effectiveFinalStatus: normalizedFinalResult.effective_final_status,
      failureCode: normalizedFinalResult.failure_code,
      failureStage: normalizedFinalResult.failure_stage,
      changedFiles: gitResult.filesChanged || [],
      committedFiles: gitResult.filesChanged || [],
      gitCommitSha: gitResult.commitSha || null,
      nextBatch: normalizedFinalResult.next_batch,
      completedAt: normalizedFinalResult.completed_at,
      pushed: pushResult.pushed,
      deployStatus: pushResult.pushed ? "pending" : null,
    });
    const codexDiagnostics = getCodexReportDiagnostics();

    const finalResult = [
      result,
      "",
      ...formatWorkerJobContractLines(successContract, {
        includeOriginalRequest: false,
      }),
      "",
      "Worker / task status:",
      "Worker execution: succeeded",
      `Worker execution status: ${successWorkerExecutionStatus}`,
      `Task goal: ${successTaskGoalStatus}`,
      `Task goal status: ${successTaskGoalStatus}`,
      `task_domain: ${classifyWorkerTaskDomain(getJobText(job))}`,
      `task_mode: ${taskModeForReport}`,
      `read_only_mode: ${readOnlyMode ? "true" : "false"}`,
      `verification_only: ${successContract.verification_only ? "true" : "false"}`,
      `allow_no_change_success: ${successContract.allow_no_change_success ? "true" : "false"}`,
      ...formatCodexDiagnosticLines(codexDiagnostics),
      "stdin_transport_verified: true",
      "prompt_in_spawnargs: false",
      "original_worker_status: succeeded",
      "effective_final_status: succeeded",
      "read_only_violation: false",
      "no_fix_applied: false",
      "out_of_scope_business_change: false",
      `no_op_run: ${
        !readOnlyMode &&
        !allowNoChangeSuccessForReport &&
        taskRequiresFileChanges(getJobText(job)) &&
        !gitResult.filesChanged?.length
          ? "true"
          : "false"
      }`,
      `committed: ${gitResult.committed ? "true" : "false"}`,
      `pushed: ${pushResult.pushed ? "true" : "false"}`,
      `failure_memory_status: ${normalizedFinalResult.failure_memory_status}`,
      `failure_code: ${normalizedFinalResult.failure_code || "null"}`,
      `next_batch: ${normalizedFinalResult.next_batch || "null"}`,
      `completed_at: ${normalizedFinalResult.completed_at || "null"}`,
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
      "",
      `codex_changed_files: ${gitResult.filesChanged?.length ? gitResult.filesChanged.join(", ") : "[]"}`,
      `worktree_changed_files: ${postPushWorktreeChangedFiles.length ? postPushWorktreeChangedFiles.join(", ") : "[]"}`,
      `task_changed_files: ${gitResult.filesChanged?.length ? gitResult.filesChanged.join(", ") : "[]"}`,
      `committed_files: ${gitResult.filesChanged?.length ? gitResult.filesChanged.join(", ") : "[]"}`,
      "unexpected_changed_files: []",
      "codex_git_push: not_run_by_codex",
      `worker_git_push: ${pushResult.pushed ? "true" : "false"}`,
      `git_push: ${pushResult.pushed ? "true" : "false"}`,
      `pushed_branch: ${pushResult.branch || "null"}`,
      `remote_contains_commit: ${remoteContainsCommit ? "true" : "false"}`,
      `repository_clean_after_push: ${repositoryCleanAfterPush ? "true" : "false"}`,
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
        batch_code: successContract.approved_batch || approvedBatchForReport,
        job_created_at: job.created_at || null,
        ...buildWorkerReportContractExtra(successContract),
        codex_called: !deterministicResult,
        project_name: "同城搭子网站",
        project_dir: PROJECT_DIR,
        files_changed: gitResult.filesChanged || [],
        changed_files: gitResult.filesChanged || [],
        committed_files: gitResult.filesChanged || [],
        codex_changed_files: gitResult.filesChanged || [],
        worktree_changed_files: postPushWorktreeChangedFiles,
        task_changed_files: gitResult.filesChanged || [],
        unexpected_changed_files: [],
        validation_results: [
          deterministicResult
            ? "Codex 执行：跳过（codex_required=false）"
            : "Codex 执行：通过",
          `codex_called: ${deterministicResult ? "false" : "true"}`,
          `deterministic_git_operation: ${deterministicResult ? "true" : "false"}`,
          `execution_policy_conflict: ${successContract.execution_policy_conflict || "null"}`,
          "Worker 执行：通过",
          "Worker execution status: succeeded",
          readOnlyMode
            ? "任务目标验收：通过（read_only_mode，无文件变更）"
            : allowNoChangeSuccessForReport
            ? "任务目标验收：通过（verification_only，无文件变更）"
            : gitResult.filesChanged?.length
            ? "任务目标验收：通过（已产生文件变更）"
            : "任务目标验收：通过（任务不要求文件变更）",
          readOnlyMode
            ? "Task goal status: completed_read_only_no_file_changes"
            : allowNoChangeSuccessForReport
            ? "Task goal status: completed_verification_only_no_file_changes"
            : gitResult.filesChanged?.length
            ? "Task goal status: completed_with_file_changes"
            : "Task goal status: completed_no_file_change_required",
          `任务分类：${classifyWorkerTaskDomain(getJobText(job))}`,
          `task_mode: ${taskModeForReport}`,
          `read_only_mode：${readOnlyMode ? "true" : "false"}`,
          `verification_only: ${successContract.verification_only ? "true" : "false"}`,
          `allow_no_change_success: ${successContract.allow_no_change_success ? "true" : "false"}`,
          ...formatCodexDiagnosticLines(codexDiagnostics),
          "stdin_transport_verified: true",
          "prompt_in_spawnargs: false",
          "original_worker_status: succeeded",
          "effective_final_status: succeeded",
          `failure_memory_status: ${normalizedFinalResult.failure_memory_status}`,
          `failure_code: ${normalizedFinalResult.failure_code || "null"}`,
          `next_batch: ${normalizedFinalResult.next_batch || "null"}`,
          "Read-only violation: no",
          "NO_FIX_APPLIED: no",
          "OUT_OF_SCOPE_BUSINESS_CHANGE: no",
          `No-op run: ${
            !readOnlyMode &&
            !allowNoChangeSuccessForReport &&
            taskRequiresFileChanges(getJobText(job)) &&
            !gitResult.filesChanged?.length
              ? "yes"
              : "no"
          }`,
          `Committed: ${gitResult.committed ? "yes" : "no"}`,
          `Pushed: ${pushResult.pushed ? "yes" : "no"}`,
          ...getPreviewValidationLines(previewReport),
          gitResult.readOnlyMode
            ? "Git 自动备份：跳过（read_only_mode=true）"
            : gitResult.committed
            ? `Git 自动备份：通过（${gitResult.commitSha}）`
            : `Git 自动备份：warning（${gitResult.message}）`,
          pushResult.readOnlyMode
            ? "GitHub 推送：跳过（read_only_mode=true）"
            : pushResult.pushed
            ? `GitHub 推送：通过（${pushResult.remote}/${pushResult.branch}）`
            : `GitHub 推送：warning（${pushResult.message}）`,
        ],
        github_push_status: buildGithubPushStatus(pushResult),
        read_only_mode: readOnlyMode,
        task_mode: taskModeForReport,
        verification_only: successContract.verification_only,
        allow_no_change_success: successContract.allow_no_change_success,
        original_worker_status: "succeeded",
        worker_execution_status: successWorkerExecutionStatus,
        task_goal_status: successTaskGoalStatus,
        effective_final_status: normalizedFinalResult.effective_final_status,
        failure_memory_status: normalizedFinalResult.failure_memory_status,
        failure_code: normalizedFinalResult.failure_code,
        failure_stage: normalizedFinalResult.failure_stage,
        terminal_index: normalizedFinalResult.terminal_index,
        auto_iteration_suggestion: normalizedFinalResult.auto_iteration_suggestion,
        next_batch: normalizedFinalResult.next_batch,
        completed_at: normalizedFinalResult.completed_at,
        no_fix_applied: false,
        read_only_mode_violation: false,
        out_of_scope_business_change: false,
        git_commit_sha:
          gitResult.commitSha || null,
        git_push: pushResult.pushed,
        pushed: pushResult.pushed,
        codex_git_push: "not_run_by_codex",
        worker_git_push: pushResult.pushed,
        pushed_branch: pushResult.branch || null,
        remote_contains_commit: remoteContainsCommit,
        repository_clean_after_push: repositoryCleanAfterPush,
        deploy_status:
          pushResult.pushed
            ? "pending"
            : null,
      }
    );
  } catch (error) {
    console.error("任务执行失败：", error);

    const errorText = error instanceof Error ? error.message : String(error);
    const errorCode =
      normalizeFailureCodeValue(error && typeof error === "object" && "code" in error ? error.code : null) ||
      classifyFailureCodeFromText(errorText) ||
      null;
    const failureDetail =
      error?.failureDetail ||
      (errorCode === CODEX_USAGE_LIMIT ? sanitizeCodexFailureDetail(errorText) : null);
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

    const completedAt = new Date().toISOString();
    const approvedBatchForReport = initialContract.approved_batch || getJobBatchCode(job);
    const failureWorkerExecutionStatus =
      errorCode === NO_FIX_APPLIED
        ? "succeeded_until_task_goal_validation"
        : errorCode === MISSING_REQUIRED_DOCS ||
          errorCode === INSUFFICIENT_DOC_OUTPUT
        ? "succeeded_until_required_docs_validation"
        : errorCode === WORKER_READONLY_CONTEXT_INCOMPLETE
        ? "succeeded_until_worker_readonly_context_validation"
        : errorCode === READ_ONLY_MODE_VIOLATION
        ? "succeeded_until_read_only_validation"
        : errorCode === INCOMPLETE_QA_REPORT
        ? "succeeded_until_qa_report_validation"
        : errorCode === ORIGINAL_BATCH_CONTEXT_MISSING
        ? "failed_before_codex_original_context_missing"
        : errorCode === TASK_MODE_MISMATCH
        ? "succeeded_until_task_mode_validation"
        : errorCode === OUT_OF_SCOPE_BUSINESS_CHANGE ||
          errorCode === OUT_OF_SCOPE_SYSTEM_CHANGE ||
          errorCode === "BUSINESS_PAGE_BOUNDARY_VIOLATION"
        ? "succeeded_until_scope_validation"
        : "failed";
    const failureTaskGoalStatus =
      errorCode === NO_FIX_APPLIED
        ? "failed_no_fix_applied"
        : errorCode === MISSING_REQUIRED_DOCS
        ? "failed_missing_required_docs"
        : errorCode === INSUFFICIENT_DOC_OUTPUT
        ? "failed_insufficient_doc_output"
        : errorCode === WORKER_READONLY_CONTEXT_INCOMPLETE
        ? "failed_worker_readonly_context_incomplete"
        : errorCode === READ_ONLY_MODE_VIOLATION
        ? "failed_read_only_mode_violation"
        : errorCode === INCOMPLETE_QA_REPORT
        ? "failed_incomplete_qa_report"
        : errorCode === ORIGINAL_BATCH_CONTEXT_MISSING
        ? "failed_original_batch_context_missing"
        : errorCode === TASK_MODE_MISMATCH
        ? "failed_task_mode_mismatch"
        : errorCode === OUT_OF_SCOPE_BUSINESS_CHANGE ||
          errorCode === OUT_OF_SCOPE_SYSTEM_CHANGE ||
          errorCode === "BUSINESS_PAGE_BOUNDARY_VIOLATION"
        ? "failed_out_of_scope_business_change"
        : "failed";
    const normalizedFinalResult = normalizeWorkerFinalResult({
      job,
      status: "failed",
      finalReportStatus: "failed",
      effectiveFinalStatus: "failed",
      worker_execution_status: failureWorkerExecutionStatus,
      task_goal_status: failureTaskGoalStatus,
      error,
      errorText,
      approvedBatch: approvedBatchForReport,
      changed_files: failureChangedPaths,
      gitCommitSha: null,
      pushed: false,
      completedAt,
    });

    const failureContract = resolveWorkerJobContract(job, {
      attemptId,
      taskMode: taskModeForReport,
      readOnlyMode,
      verificationOnly: initialContract.verification_only,
      allowNoChangeSuccess: initialContract.allow_no_change_success,
      codeChangesRequired: initialContract.code_changes_required,
      codexRequired: initialContract.codex_required,
      gitCommitRequired: initialContract.git_commit_required,
      gitPushRequired: initialContract.git_push_required,
      workerStage: "failed",
      workflowStage: "failed",
      finalReportStatus: "failed",
      effectiveFinalStatus: normalizedFinalResult.effective_final_status,
      failureCode: normalizedFinalResult.failure_code,
      failureStage: normalizedFinalResult.failure_stage,
      changedFiles: failureChangedPaths,
      gitCommitSha: null,
      nextBatch: normalizedFinalResult.next_batch,
      completedAt: normalizedFinalResult.completed_at,
      pushed: false,
      deployStatus: null,
    });
    const codexDiagnostics = error?.codexDiagnostics || getCodexReportDiagnostics();
    const stdinTransportVerified =
      errorCode === "CODEX_STDIN_TRANSPORT_FAILED"
        ? "false"
        : /^CODEX_/.test(String(errorCode || ""))
        ? "unknown"
        : "not_applicable";

    const failureReport = buildFailureReport(job, error, {
      filesChanged: failureChangedPaths,
      uncommittedFiles: failureChangedPaths,
      head: currentHead,
      rollbackMessage,
      contract: failureContract,
    });

    await report(
      job.id,
      "failed",
      failureReport,
      {
        attempt_id: attemptId,
        batch_code: failureContract.approved_batch || approvedBatchForReport,
        job_created_at: job.created_at || null,
        ...buildWorkerReportContractExtra(failureContract),
        project_name: "同城搭子网站",
        project_dir: PROJECT_DIR,
        error_code: errorCode,
        files_changed: failureChangedPaths,
        read_only_mode: readOnlyMode,
        task_mode: taskModeForReport,
        original_worker_status: "failed",
        worker_execution_status: failureWorkerExecutionStatus,
        task_goal_status: failureTaskGoalStatus,
        effective_final_status: normalizedFinalResult.effective_final_status,
        failure_detail: failureDetail,
        no_fix_applied: errorCode === NO_FIX_APPLIED,
        read_only_mode_violation: errorCode === READ_ONLY_MODE_VIOLATION,
        task_mode_mismatch: errorCode === TASK_MODE_MISMATCH,
        worker_readonly_context_incomplete: errorCode === WORKER_READONLY_CONTEXT_INCOMPLETE,
        missing_worker_readonly_context_fields:
          error?.missingWorkerReadonlyContextFields || [],
        missing_required_output_fields:
          error?.missingRequiredOutputFields || [],
        missing_required_docs: error?.missingDocs || [],
        incomplete_qa_report: errorCode === INCOMPLETE_QA_REPORT,
        missing_qa_report_fields: error?.missingQaReportFields || [],
        required_docs_total: error?.requiredDocs?.length || 0,
        required_docs_present: error?.presentDocs?.length || 0,
        required_docs_changed: error?.changedDocs?.length || 0,
        insufficient_doc_output: errorCode === INSUFFICIENT_DOC_OUTPUT,
        out_of_scope_business_change:
          errorCode === OUT_OF_SCOPE_BUSINESS_CHANGE ||
          errorCode === OUT_OF_SCOPE_SYSTEM_CHANGE ||
          errorCode === "BUSINESS_PAGE_BOUNDARY_VIOLATION",
        validation_results: [
          "Worker 执行：已进入失败上报链路",
          `Worker execution status: ${
            errorCode === NO_FIX_APPLIED
              ? "succeeded_until_task_goal_validation"
              : errorCode === MISSING_REQUIRED_DOCS ||
                errorCode === INSUFFICIENT_DOC_OUTPUT
              ? "succeeded_until_required_docs_validation"
              : errorCode === WORKER_READONLY_CONTEXT_INCOMPLETE
              ? "succeeded_until_worker_readonly_context_validation"
              : errorCode === READ_ONLY_MODE_VIOLATION
              ? "succeeded_until_read_only_validation"
              : errorCode === INCOMPLETE_QA_REPORT
              ? "succeeded_until_qa_report_validation"
              : errorCode === ORIGINAL_BATCH_CONTEXT_MISSING
              ? "failed_before_codex_original_context_missing"
              : errorCode === TASK_MODE_MISMATCH
              ? "succeeded_until_task_mode_validation"
              : errorCode === OUT_OF_SCOPE_BUSINESS_CHANGE ||
                errorCode === OUT_OF_SCOPE_SYSTEM_CHANGE ||
                errorCode === "BUSINESS_PAGE_BOUNDARY_VIOLATION"
              ? "succeeded_until_scope_validation"
              : "failed"
          }`,
          `Task goal status: ${
            errorCode === NO_FIX_APPLIED
              ? "failed_no_fix_applied"
              : errorCode === MISSING_REQUIRED_DOCS
              ? "failed_missing_required_docs"
              : errorCode === INSUFFICIENT_DOC_OUTPUT
              ? "failed_insufficient_doc_output"
              : errorCode === WORKER_READONLY_CONTEXT_INCOMPLETE
              ? "failed_worker_readonly_context_incomplete"
              : errorCode === READ_ONLY_MODE_VIOLATION
              ? "failed_read_only_mode_violation"
              : errorCode === INCOMPLETE_QA_REPORT
              ? "failed_incomplete_qa_report"
              : errorCode === ORIGINAL_BATCH_CONTEXT_MISSING
              ? "failed_original_batch_context_missing"
              : errorCode === TASK_MODE_MISMATCH
              ? "failed_task_mode_mismatch"
              : errorCode === OUT_OF_SCOPE_BUSINESS_CHANGE ||
                errorCode === OUT_OF_SCOPE_SYSTEM_CHANGE ||
                errorCode === "BUSINESS_PAGE_BOUNDARY_VIOLATION"
              ? "failed_out_of_scope_business_change"
              : "failed"
          }`,
          `失败阶段：${classifyFailure(error).stage}`,
          errorCode ? `错误代码：${errorCode}` : "错误代码：未提供",
          `task_mode: ${taskModeForReport}`,
          `read_only_mode：${readOnlyMode ? "true" : "false"}`,
          ...formatCodexDiagnosticLines(codexDiagnostics),
          `stdin_transport_verified: ${stdinTransportVerified}`,
          "prompt_in_spawnargs: false",
          "original_worker_status: failed",
          `effective_final_status: ${normalizedFinalResult.effective_final_status}`,
          `failure_memory_status: ${normalizedFinalResult.failure_memory_status}`,
          `failure_code: ${normalizedFinalResult.failure_code || "null"}`,
          `failure_stage: ${normalizedFinalResult.failure_stage || "null"}`,
          `failure_detail: ${failureDetail || "null"}`,
          `next_batch: ${normalizedFinalResult.next_batch || "null"}`,
          `Read-only violation: ${errorCode === READ_ONLY_MODE_VIOLATION ? "yes" : "no"}`,
          `No-op run: ${errorCode === NO_FIX_APPLIED ? "yes" : "no"}`,
          `Task mode mismatch: ${errorCode === TASK_MODE_MISMATCH ? "yes" : "no"}`,
          `Incomplete QA report: ${errorCode === INCOMPLETE_QA_REPORT ? "yes" : "no"}`,
          `Worker read-only context incomplete: ${errorCode === WORKER_READONLY_CONTEXT_INCOMPLETE ? "yes" : "no"}`,
          `missing_worker_readonly_context_fields: ${
            error?.missingWorkerReadonlyContextFields?.length
              ? error.missingWorkerReadonlyContextFields.join(", ")
              : "none"
          }`,
          `missing_required_output_fields: ${
            error?.missingRequiredOutputFields?.length
              ? error.missingRequiredOutputFields.join(", ")
              : "none"
          }`,
          `Original batch context missing: ${errorCode === ORIGINAL_BATCH_CONTEXT_MISSING ? "yes" : "no"}`,
          `missing_qa_report_fields: ${
            error?.missingQaReportFields?.length
              ? error.missingQaReportFields.join(", ")
              : "none"
          }`,
          `required_docs_total: ${error?.requiredDocs?.length || 0}`,
          `required_docs_present: ${error?.presentDocs?.length || 0}`,
          `required_docs_changed: ${error?.changedDocs?.length || 0}`,
          `missing_required_docs: ${
            error?.missingDocs?.length ? error.missingDocs.join(", ") : "none"
          }`,
          `insufficient_doc_output: ${errorCode === INSUFFICIENT_DOC_OUTPUT ? "yes" : "no"}`,
          `Out-of-scope business change: ${
            errorCode === OUT_OF_SCOPE_BUSINESS_CHANGE ||
            errorCode === OUT_OF_SCOPE_SYSTEM_CHANGE ||
            errorCode === "BUSINESS_PAGE_BOUNDARY_VIOLATION"
              ? "yes"
              : "no"
          }`,
          "Committed: no",
          "Pushed: no",
          `关键错误：${classifyFailure(error).keyError}`.slice(0, 600),
          `当前 HEAD：${currentHead}`,
          rollbackMessage.trim() || "Git 回滚：未提供",
          "本地预览：未启动 dev server / 浏览器",
        ],
        github_push_status: "失败任务未推送",
        failure_memory_status: normalizedFinalResult.failure_memory_status,
        failure_code: normalizedFinalResult.failure_code,
        failure_stage: normalizedFinalResult.failure_stage,
        terminal_index: normalizedFinalResult.terminal_index,
        auto_iteration_suggestion: normalizedFinalResult.auto_iteration_suggestion,
        next_batch: normalizedFinalResult.next_batch,
        completed_at: normalizedFinalResult.completed_at,
        git_commit_sha: null,
        git_push: false,
        pushed: false,
        deploy_status: null,
      }
    );
  } finally {
    stopHeartbeat();
    currentAttemptId = null;
    currentReadOnlyMode = false;
    working = false;
  }
}

async function main() {
  assertRequiredEnv();

  console.log("本地 Worker 已启动");
  console.log(`Worker 名称：${WORKER_NAME}`);
  console.log(`云端地址：${WORKER_API_URL}`);
  console.log(`项目目录：${PROJECT_DIR}`);

  await runCodexStartupPreflight();

  let consecutivePollFailures = 0;

  while (!stopping) {
    let sleepMs = POLL_INTERVAL_MS;

    try {
      await pollOnce();
      if (consecutivePollFailures > 0) {
        console.log(
          `[${new Date().toISOString()}] Worker 轮询已恢复，连续失败次数已清零`
        );
      }
      consecutivePollFailures = 0;
    } catch (error) {
      consecutivePollFailures += 1;
      sleepMs = getWorkerPollBackoffMs(consecutivePollFailures);
      console.error(
        `[${new Date().toISOString()}] 轮询失败：`,
        formatWorkerFetchError(error)
      );
      console.error(
        `[${new Date().toISOString()}] 下次轮询将在 ${sleepMs}ms 后重试，连续失败次数=${consecutivePollFailures}`
      );
    }

    await sleep(sleepMs);
  }
}

function requestWorkerStop(message) {
  stopping = true;
  if (message) {
    console.log(message);
  }
  void shutdownActiveSshProcesses().catch((error) => {
    console.error(
      "停止活动 SSH 子进程失败：",
      error instanceof Error ? error.message : error
    );
  });
}

process.on("SIGINT", () => {
  requestWorkerStop("正在停止 Worker...");
});

process.on("SIGTERM", () => {
  requestWorkerStop();
});

if (require.main === module) {
  main().catch((error) => {
    console.error("Worker 启动失败：", error);
    process.exit(1);
  });
}

module.exports = {
  NO_FIX_APPLIED,
  READ_ONLY_MODE_VIOLATION,
  OUT_OF_SCOPE_BUSINESS_CHANGE,
  OUT_OF_SCOPE_SYSTEM_CHANGE,
  ORIGINAL_BATCH_CONTEXT_MISSING,
  TASK_MODE_MISMATCH,
  EXPLICIT_TASK_MODE_OVERRIDDEN,
  EXPLICIT_PROJECT_DOMAIN_OVERRIDDEN,
  MISSING_REQUIRED_DOCS,
  INSUFFICIENT_DOC_OUTPUT,
  INCOMPLETE_QA_REPORT,
  INCOMPLETE_ARCHITECTURE_REPORT,
  WORKER_READONLY_CONTEXT_INCOMPLETE,
  CONTEXT_MISSING_WARNING,
  CODEX_USAGE_LIMIT,
  FAILURE_FINGERPRINTS,
  TASK_MODES,
  assertTaskGoalApplied,
  allowsVerificationOnlyNoChangeSuccess,
  assertExplicitTaskFieldsNotOverridden,
  assertOriginalBatchContextAvailable,
  assertQaReportComplete,
  assertWorkerReadOnlyContextComplete,
  assertWorkerReadOnlyTaskGoalComplete,
  assertQaTaskOutcome,
  classifyWorkerFetchError,
  assertGitOperationAllowed,
  assertCleanWorktreeBeforeCodex,
  buildCodexPrompt,
  buildCodexExecArgs,
  buildCodexSpawnCommand,
  buildFailureReport,
  buildWorkerReportContractExtra,
  buildAutoIterationSuggestion,
  buildTerminalJobIndex,
  buildTerminalStatusSnapshot,
  buildWorkerGuardedPrompt,
  classifyWorkerTaskDomain,
  classifyFailure,
  commitGitTask,
  createTerminalReportState,
  extractCurrentExecutionBatchCode,
  extractRequiredChangePaths,
  formatCodexSpawnError,
  formatWorkerFetchError,
  getTerminalReportSnapshot,
  getCodexFileType,
  getWorkerPollBackoffMs,
  getTaskMode,
  isTrueTaskFailureCode,
  isRunningJobNotFoundOrNotOwned,
  isTerminalReportLockedForJob,
  isVerificationOnlyNoopTask,
  shouldCallCodexForContract,
  shouldRunDeterministicGitOperation,
  lockAcceptedTerminalReportSnapshot,
  normalizeWorkerContext,
  normalizeWorkerFinalResult,
  recordFailureMemoryForFinalResult,
  recordFailureMemory,
  recordPostCompletionTransportWarning,
  recordTerminalJobIndex,
  registerTerminalTimerStopper,
  resolveCodexExecutable,
  resolveWorkerJobContract,
  runCodexPreflight,
  runCodexStartupPreflight,
  runDeterministicGitOperation,
  runCanonicalSshCommand,
  shutdownActiveSshProcesses,
  toCodexUsageLimitError,
  spawnCodexWithStdin,
  spawnCodexProcess,
  resetTerminalReportState,
  stopTerminalReportTimers,
  getTaskChangedPaths,
  isReadOnlyTask,
  isReadOnlyTaskText,
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


