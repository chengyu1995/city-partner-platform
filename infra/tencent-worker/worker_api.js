/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars */
const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const { sendFeishuReply } = require("./feishu_reply");
const {
  applyHeartbeat: canonicalApplyHeartbeat,
  applyProgress: canonicalApplyProgress,
  claimJob: canonicalClaimJob,
  cleanupTerminalJob: canonicalCleanupTerminalJob,
  finalizeJob: canonicalFinalizeJob,
  getActiveAttempt: canonicalGetActiveAttempt,
  inspectJobState: canonicalInspectJobState,
  isCanonicalClaimPersisted,
  isJobSelectable: canonicalIsJobSelectable,
  recoverStaleAttempt: canonicalRecoverStaleAttempt,
  rollbackFailedClaim: canonicalRollbackFailedClaim,
  validateJobStateInvariant: canonicalValidateJobStateInvariant,
} = require("./worker_job_state_machine");

if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = class DisabledRealtimeWebSocket {
    constructor() {
      throw new Error("Realtime WebSocket is disabled for this worker-api process.");
    }
  };
}

dotenv.config({
  path: path.join(__dirname, "worker_api.env"),
});

const PORT = Number(process.env.PORT || 3001);
const WORKER_TOKEN = process.env.WORKER_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const missingEnv = [
  ["WORKER_TOKEN", WORKER_TOKEN],
  ["SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_SERVICE_KEY", SUPABASE_SERVICE_KEY],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missingEnv.length > 0) {
  console.error(`缺少环境变量: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);



function sanitizeFeishuLogText(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer ***")
    .replace(/tenant_access_token["']?\s*[:=]\s*["']?[^"',\s]+/gi, "tenant_access_token=***")
    .slice(0, 500);
}

const FEISHU_FIELD_ALIASES = {
  task_status: ["任务状态", "Task Status", "task_status", "Status", "状态"],
  current_stage: ["当前阶段", "Current Stage", "stage", "workflow_stage", "Stage", "阶段"],
  progress_percent: ["进度百分比", "Progress Percent", "Progress %", "progress_percent", "Progress", "进度"],
  current_step: ["当前步骤", "Current Step", "current_step", "步骤"],
  status_message: ["状态消息", "Status Message", "status_message", "消息"],
  git_commit_sha: ["Git Commit", "Git Commit SHA", "git_commit_sha", "commit", "Commit SHA"],
  error_text: ["错误原因", "Error Reason", "Error Text", "error_text", "Error", "失败原因"],
  completed_at: ["完成时间", "Completed At", "completed_at", "Finished At", "finished_at"],
  updated_at: ["更新时间", "Updated At", "updated_at", "Last Updated"],
};

let feishuTenantTokenCache = null;
let feishuTenantTokenExpireAt = 0;
let feishuAppTokenCache = null;
let feishuFieldsCache = null;

function getFeishuSyncConfig() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const tableId =
    process.env.FEISHU_TABLE_ID ||
    process.env.FEISHU_BITABLE_TABLE_ID ||
    process.env.BITABLE_TABLE_ID;

  const explicitAppToken =
    process.env.FEISHU_APP_TOKEN ||
    process.env.FEISHU_BITABLE_APP_TOKEN ||
    process.env.BITABLE_APP_TOKEN;

  const wikiNodeToken = process.env.FEISHU_WIKI_NODE_TOKEN;

  if (!appId || !appSecret || !tableId || (!explicitAppToken && !wikiNodeToken)) {
    return null;
  }

  return {
    appId,
    appSecret,
    tableId,
    explicitAppToken,
    wikiNodeToken,
  };
}

async function getFeishuTenantAccessToken(config) {
  const now = Date.now();
  if (feishuTenantTokenCache && feishuTenantTokenExpireAt > now + 60_000) {
    return feishuTenantTokenCache;
  }

  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret,
    }),
  });

  const data = await response.json();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`tenant token failed: code=${data.code} msg=${sanitizeFeishuLogText(data.msg)}`);
  }

  feishuTenantTokenCache = data.tenant_access_token;
  feishuTenantTokenExpireAt = now + Math.max(60, Number(data.expire || 3600) - 120) * 1000;
  return feishuTenantTokenCache;
}

async function getFeishuBitableAppToken(config, accessToken) {
  if (config.explicitAppToken) {
    return config.explicitAppToken;
  }

  if (feishuAppTokenCache) {
    return feishuAppTokenCache;
  }

  const wikiToken = config.wikiNodeToken;
  const response = await fetch(
    `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(wikiToken)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const data = await response.json();
  const objToken = data && data.data && data.data.node && data.data.node.obj_token;

  if (data.code === 0 && objToken) {
    feishuAppTokenCache = objToken;
    return feishuAppTokenCache;
  }

  feishuAppTokenCache = wikiToken;
  return feishuAppTokenCache;
}

async function getFeishuBitableFields(accessToken, appToken, tableId) {
  if (feishuFieldsCache) {
    return feishuFieldsCache;
  }

  const response = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`list fields failed: code=${data.code} msg=${sanitizeFeishuLogText(data.msg)}`);
  }

  feishuFieldsCache = data.data?.items || data.data?.fields || [];
  return feishuFieldsCache;
}

function findFeishuField(fields, key) {
  const aliases = FEISHU_FIELD_ALIASES[key] || [key];
  return fields.find((field) => {
    const name = field.field_name || field.name;
    return aliases.includes(name);
  });
}

function normalizeFeishuFieldValue(field, key, value) {
  if (value === undefined || value === null) {
    return "";
  }

  const type = Number(field.type);

  if (key === "progress_percent") {
    return Number(value) || 0;
  }

  if (key === "completed_at" || key === "updated_at") {
    const ms = Date.parse(String(value));
    if (type === 5 && Number.isFinite(ms)) {
      return ms;
    }
    return String(value);
  }

  return String(value);
}

function addMappedFeishuField(output, fields, key, value) {
  const field = findFeishuField(fields, key);
  if (!field) {
    console.log(`[feishu-sync] skip missing field: ${key}`);
    return;
  }

  const fieldName = field.field_name || field.name;
  output[fieldName] = normalizeFeishuFieldValue(field, key, value);
}

function isFeishuFinalReportRateLimited(errorMessage) {
  return /\b11232\b|frequency\s*limited|rate\s*limit|too\s*many\s*requests|限频|频率/i.test(String(errorMessage || ""));
}

function sleepFeishuFinalReportRetry(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function readFinalReportString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readFinalReportObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const RUNTIME_DIAGNOSTICS_SCHEMA_VERSION = 1;
const RUNTIME_DIAGNOSTICS_STORAGE_FIELD = "result.diagnostics";
const RUNTIME_DIAGNOSTICS_STORAGE_UNAVAILABLE = "DIAGNOSTICS_STORAGE_UNAVAILABLE";
const RUNTIME_DIAGNOSTICS_FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,64}$/;
const RUNTIME_DIAGNOSTICS_FAILURE_CODES = new Set([
  "DIAGNOSTICS_STORAGE_UNAVAILABLE",
  "NO_FIX_APPLIED", "READ_ONLY_MODE_VIOLATION", "TASK_MODE_MISMATCH", "MISSING_REQUIRED_DOCS",
  "INSUFFICIENT_DOC_OUTPUT", "INCOMPLETE_QA_REPORT", "INCOMPLETE_ARCHITECTURE_REPORT", "TEST_FAILED",
  "TYPESCRIPT_FAILED", "OUT_OF_SCOPE_CHANGE", "CONTEXT_RECONSTRUCT_FAILED", "GIT_COMMIT_FAILED",
  "GIT_PUSH_FAILED", "GIT_SYNC_FAILED", "CODEX_QUOTA_EXHAUSTED", "CODEX_IDLE_TIMEOUT",
  "APPROVAL_CONTEXT_SAVE_FAILED", "AGENT_PAUSED", "EXACT_ALLOWED_SCOPE_MISSING", "TASK_INSERT_FAILED",
  "GIT_SYNC_PREFLIGHT_FAILED", "CHANGED_FILES_PARSE_FAILED", "UTF8_REPLY_CORRUPTED", "DEPLOYMENT_FAILED",
  "TERMINAL_REPORT_DUPLICATE", "WORKER_REPORT_CONTRACT_INCOMPLETE", "UNKNOWN_FAILURE"
]);
const RUNTIME_DIAGNOSTICS_FAILURE_STAGES = new Set([
  "intake", "approval_context", "worker_creation", "worker_claim", "codex_execution", "validation",
  "git", "git_sync_preflight", "push", "report", "notification", "deployment", "task_goal_validation", "unknown"
]);
function sanitizeRuntimeDiagnosticsErrorSummary(value) {
  const text = sanitizeFeishuLogText(String(value || ""))
    .replace(/Authorization\s*:\s*Bearer\s+[^\s,}]+/gi, "Authorization: Bearer [redacted]")
    .replace(/\b(token|secret|key|password)\b\s*[:=]\s*[^\s,}]+/gi, "$1=[redacted]")
    .replace(/\b[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*\b\s*[:=]\s*[^\s,}]+/gi, "[redacted_secret]=[redacted]")
    .replace(/([?&](?:token|key|secret|access_token|api_key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/original_request_text(?:_base64)?\s*[:=].*/gi, "original_request_text=[redacted]")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, "[redacted private key]")
    .replace(/https?:\/\/[^\s]+\.supabase\.co[^\s]*/gi, "[redacted supabase url]")
    .trim();
  if (!text) return null;
  return text.length > 1000 ? text.slice(0, 1000) : text;
}
function normalizeRuntimeDiagnosticsFailureCode(value, effectiveStatus, reportText) {
  const raw = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (raw && RUNTIME_DIAGNOSTICS_FAILURE_CODE_PATTERN.test(raw) && RUNTIME_DIAGNOSTICS_FAILURE_CODES.has(raw)) return raw;
  const classified = gmStabilizeWorkerErrorCode({ error_code: "", error_text: reportText, result_text: reportText });
  if (classified && RUNTIME_DIAGNOSTICS_FAILURE_CODES.has(classified)) return classified;
  return effectiveStatus === "failed" ? "UNKNOWN_FAILURE" : null;
}
function normalizeRuntimeDiagnosticsFailureStage(value, failureCode, effectiveStatus) {
  const stage = String(value || "").trim();
  if (stage && RUNTIME_DIAGNOSTICS_FAILURE_STAGES.has(stage)) return stage;
  if (failureCode === "GIT_SYNC_FAILED") return "git_sync_preflight";
  return effectiveStatus === "failed" ? "unknown" : null;
}
function readRuntimeNonNegativeInteger(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  const text = String(value == null ? "" : value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function buildRuntimeFailureDiagnostics(job, body, fields) {
  const payload = parseWorkerReportObject(job && (job.payload || job.metadata || job.task_payload));
  const result = parseWorkerReportObject(body && body.result);
  const effectiveStatus = normalizeRuntimeTerminalStatus(fields && fields.effective_final_status) || "failed";
  const reportText = [body && body.error_text, body && body.error, body && body.result_text, body && body.output].filter(Boolean).join("\n");
  const failureCode = normalizeRuntimeDiagnosticsFailureCode(fields && fields.failure_code, effectiveStatus, reportText);
  const failureStage = normalizeRuntimeDiagnosticsFailureStage(fields && fields.failure_stage, failureCode, effectiveStatus);
  return {
    diagnostics_schema_version: RUNTIME_DIAGNOSTICS_SCHEMA_VERSION,
    failure_code: effectiveStatus === "failed" ? failureCode : null,
    failure_stage: effectiveStatus === "failed" ? failureStage : null,
    worker_execution_status: fields && fields.worker_execution_status || "unknown",
    task_goal_status: fields && fields.task_goal_status || "unknown",
    effective_final_status: effectiveStatus,
    project_domain: readFinalReportString(payload && payload.project_domain) || readFinalReportString(result && result.project_domain) || "unknown",
    requested_mode: readFinalReportString(payload && payload.requested_mode) || readFinalReportString(result && result.requested_mode) || "unknown",
    task_mode: readFinalReportString(payload && payload.task_mode) || readFinalReportString(result && result.task_mode) || "unknown",
    batch: readFinalReportString(payload && (payload.approved_batch || payload.batch_code)) || readFinalReportString(result && (result.approved_batch || result.batch_code)) || extractFinalReportBatchCode(job) || "unknown",
    attempt_id: readFinalReportString(body && body.attempt_id) || readFinalReportString(job && job.attempt_id) || null,
    retry_count: readRuntimeNonNegativeInteger(job && job.retry_count) || readRuntimeNonNegativeInteger(payload && payload.retry_count),
    completed_at: fields && (fields.finished_at || fields.completed_at) || null,
    diagnostics_source: "worker_api_runtime_report",
    error_summary: sanitizeRuntimeDiagnosticsErrorSummary(reportText),
  };
}
// RUNTIME_CONTRACT_PATCH_WORKER_API_V1
const RUNTIME_CANONICAL_WORKER_REPORT_SCHEMA_VERSION = 2;
const RUNTIME_CANONICAL_WORKER_REPORT_REQUIRED_FIELDS = [
  "job_id",
  "attempt_id",
  "worker_instance_id",
  "batch_code",
  "worker_execution_status",
  "task_goal_status",
  "effective_final_status",
];

function runtimeHasOwnField(object, fieldName) { return Boolean(object && typeof object === "object" && Object.prototype.hasOwnProperty.call(object, fieldName)); }
function normalizeRuntimeTerminalStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (/^(failed|failure|error|failed_[a-z_]+|no_fix_applied|read_only_violation|out_of_scope_change|out_of_scope_business_change|task_mode_mismatch)$/.test(text)) return "failed";
  if (/^(succeeded|success|completed|done)$/.test(text)) return "succeeded";
  if (/^(cancelled|canceled)$/.test(text)) return "cancelled";
  return "";
}
function readRuntimeReportField(body, fieldName) {
  const result = parseWorkerReportObject(body && body.result);
  if (runtimeHasOwnField(body, fieldName)) return body[fieldName];
  if (result && runtimeHasOwnField(result, fieldName)) return result[fieldName];
  return undefined;
}
function getPrioritizedRuntimeFinalStatus(fallbackStatus, body) {
  const effective = normalizeRuntimeTerminalStatus(readRuntimeReportField(body, "effective_final_status") || readRuntimeReportField(body, "effectiveFinalStatus"));
  if (effective) return effective;
  const goal = normalizeRuntimeTerminalStatus(readRuntimeReportField(body, "task_goal_status") || readRuntimeReportField(body, "taskGoalStatus"));
  if (goal) return goal;
  const workerStatus = normalizeRuntimeTerminalStatus(readRuntimeReportField(body, "worker_execution_status") || readRuntimeReportField(body, "workerExecutionStatus"));
  if (workerStatus) return workerStatus;
  return normalizeRuntimeTerminalStatus(fallbackStatus) || String(fallbackStatus || "").trim().toLowerCase();
}
function normalizeRuntimePushed(body) {
  const value = readRuntimeReportField(body, "pushed");
  if (value === true || value === false) return value;
  if (value !== undefined) return readWorkerReportBoolean(value);
  const pushStatus = String((body && (body.github_push_status || body.push_status || body.pushStatus)) || "").trim();
  if (workerReportGithubPushSucceeded(pushStatus) || /origin\/master/i.test(pushStatus)) return true;
  return false;
}
function getRuntimeChangedFilesStrict(body) {
  const result = parseWorkerReportObject(body && body.result);
  if (runtimeHasOwnField(body, "changed_files")) return normalizeWorkerReportFiles(body.changed_files);
  if (runtimeHasOwnField(body, "changedFiles")) return normalizeWorkerReportFiles(body.changedFiles);
  if (result && runtimeHasOwnField(result, "changed_files")) return normalizeWorkerReportFiles(result.changed_files);
  if (result && runtimeHasOwnField(result, "changedFiles")) return normalizeWorkerReportFiles(result.changedFiles);
  return Array.from(new Set([ ...normalizeWorkerReportFiles(body && body.files_changed), ...normalizeWorkerReportFiles(result && result.files_changed) ]));
}
function getRuntimeFailureCode(body, effectiveStatus, fallbackCode) {
  const code = String(readRuntimeReportField(body, "failure_code") || readRuntimeReportField(body, "error_code") || fallbackCode || "").trim().toUpperCase();
  if (code) return code;
  if (effectiveStatus === "failed") return gmStabilizeWorkerErrorCode(body) || "TASK_FAILED";
  return null;
}
function getRuntimeFailureStage(body, failureCode) {
  const stage = String(readRuntimeReportField(body, "failure_stage") || "").trim();
  if (stage) return stage;
  if (failureCode === "NO_FIX_APPLIED") return "task_goal_validation";
  if (failureCode === "FINAL_REPORT_STATE_CONFLICT") return "post_completion_report_validation";
  if (failureCode === "GIT_SYNC_FAILED" || failureCode === "GIT_SYNC_PREFLIGHT_FAILED") return "git_sync_preflight";
  if (/^CODEX_/.test(String(failureCode || ""))) return "codex_execution";
  if (failureCode === "RUNNING_JOB_NOT_FOUND") return "worker_lifecycle";
  if (failureCode === "EXACT_SCOPE_PARSE_FAILED") return "approval_context_validation";
  return null;
}
// RUNTIME_CONTRACT_PATCH_FIX39_FINAL_REPORT_PASSTHROUGH_V1
function getRuntimeCommittedFilesStrict(body) {
  const result = parseWorkerReportObject(body && body.result);
  if (runtimeHasOwnField(body, "committed_files")) return normalizeWorkerReportFiles(body.committed_files);
  if (runtimeHasOwnField(body, "committedFiles")) return normalizeWorkerReportFiles(body.committedFiles);
  if (result && runtimeHasOwnField(result, "committed_files")) return normalizeWorkerReportFiles(result.committed_files);
  if (result && runtimeHasOwnField(result, "committedFiles")) return normalizeWorkerReportFiles(result.committedFiles);
  return [];
}
function getRuntimePolicyBoolean(body, fieldName) {
  const value = readRuntimeReportField(body, fieldName);
  if (value === true || value === false) return value;
  if (value !== undefined && value !== null && String(value).trim() !== "") return readWorkerReportBoolean(value);
  return null;
}
function buildRuntimeFinalReportSourceFields(body) {
  const result = parseWorkerReportObject(body && body.result);
  const source = String(readRuntimeReportField(body, "final_report_source") || readRuntimeReportField(body, "post_completion_source") || (result && (result.final_report_source || result.post_completion_source)) || "worker_runtime_report").trim() || "worker_runtime_report";
  const applied = getRuntimePolicyBoolean(body, "post_completion_state_applied");
  return {
    final_report_source: source,
    post_completion_source: source,
    post_completion_state_applied: applied === null ? true : applied,
  };
}
function runtimeDetectFinalReportStateConflict(body, effectiveFinalStatus, failureCode) {
  const text = [body && body.result_text, body && body.error_text, body && body.output, body && body.error].filter(Boolean).join("\n");
  const noFix = /NO_FIX_APPLIED/i.test(text) || String(failureCode || "").toUpperCase() === "NO_FIX_APPLIED";
  if (effectiveFinalStatus === "succeeded" && noFix) return true;
  return false;
}
function buildRuntimeStructuredTerminalFields(job, body, effectiveFinalStatus, effectiveErrorCode) {
  const changedFiles = getRuntimeChangedFilesStrict(body);
  const committedFiles = getRuntimeCommittedFilesStrict(body);
  let failureCode = getRuntimeFailureCode(body, effectiveFinalStatus, effectiveErrorCode);
  let normalizedFinalStatus = effectiveFinalStatus;
  if (runtimeDetectFinalReportStateConflict(body, normalizedFinalStatus, failureCode)) {
    normalizedFinalStatus = "failed";
    failureCode = "FINAL_REPORT_STATE_CONFLICT";
  } else if (failureCode === "NO_FIX_APPLIED") {
    normalizedFinalStatus = "failed";
  }
  const failureStage = getRuntimeFailureStage(body, failureCode);
  const sourceFields = buildRuntimeFinalReportSourceFields(body);
  return {
    worker_execution_status: String(readRuntimeReportField(body, "worker_execution_status") || readRuntimeReportField(body, "workerExecutionStatus") || body.status || "").trim() || null,
    task_goal_status: String(readRuntimeReportField(body, "task_goal_status") || readRuntimeReportField(body, "taskGoalStatus") || (normalizedFinalStatus === "failed" ? "failed" : normalizedFinalStatus) || "").trim() || null,
    effective_final_status: normalizedFinalStatus,
    failure_code: normalizedFinalStatus === "failed" ? failureCode : null,
    failure_stage: normalizedFinalStatus === "failed" ? failureStage : null,
    changed_files: committedFiles.length > 0 ? committedFiles : changedFiles,
    committed_files: committedFiles,
    git_commit_sha: String((body && (body.git_commit_sha || body.commit_sha || body.gitCommitSha)) || "").trim() || null,
    pushed: normalizeRuntimePushed(body),
    git_push: normalizeRuntimePushed(body),
    deploy_status: String((body && (body.deploy_status || body.deployStatus)) || "").trim() || null,
    verification_only: getRuntimePolicyBoolean(body, "verification_only"),
    allow_no_change_success: getRuntimePolicyBoolean(body, "allow_no_change_success"),
    code_changes_required: getRuntimePolicyBoolean(body, "code_changes_required"),
    codex_required: getRuntimePolicyBoolean(body, "codex_required"),
    git_commit_required: getRuntimePolicyBoolean(body, "git_commit_required"),
    git_push_required: getRuntimePolicyBoolean(body, "git_push_required"),
    final_report_state_conflict: runtimeDetectFinalReportStateConflict(body, normalizedFinalStatus, failureCode),
    final_report_source: sourceFields.final_report_source,
    post_completion_source: sourceFields.post_completion_source,
    post_completion_state_applied: sourceFields.post_completion_state_applied,
    next_stage_allowed: readWorkerReportBoolean(readRuntimeReportField(body, "next_stage_allowed")) || false,
    reply_error: null,
    retryable: failureCode === "GIT_SYNC_FAILED" ? true : undefined,
  };
}
function buildRuntimeCanonicalWorkerReportSchema(job, body, updateData, workerName, attemptId) {
  const source = body && typeof body === "object" ? body : {};
  const result = parseWorkerReportObject(source.result);
  const effectiveStatus = updateData && updateData.effective_final_status ? updateData.effective_final_status : String(source.status || "").trim().toLowerCase();
  const batchCode = String(readRuntimeReportField(source, "batch_code") || readRuntimeReportField(source, "approved_batch") || (job && (job.batch_code || job.approved_batch)) || "").trim();
  return {
    report_schema_version: RUNTIME_CANONICAL_WORKER_REPORT_SCHEMA_VERSION,
    job_id: String(source.job_id || source.id || (job && job.id) || "").trim(),
    attempt_id: String(readRuntimeReportField(source, "attempt_id") || attemptId || "").trim(),
    worker_instance_id: String(readRuntimeReportField(source, "worker_instance_id") || readRuntimeReportField(source, "worker_id") || readRuntimeReportField(source, "worker_name") || workerName || "").trim(),
    batch_code: batchCode,
    worker_execution_status: String(readRuntimeReportField(source, "worker_execution_status") || (updateData && updateData.worker_execution_status) || source.status || "").trim(),
    task_goal_status: String(readRuntimeReportField(source, "task_goal_status") || (updateData && updateData.task_goal_status) || effectiveStatus || "").trim(),
    effective_final_status: effectiveStatus,
    failure_code: updateData && updateData.failure_code ? updateData.failure_code : null,
    failure_stage: updateData && updateData.failure_stage ? updateData.failure_stage : null,
    failure_detail: String(readRuntimeReportField(source, "failure_detail") || readRuntimeReportField(source, "error_text") || source.error_text || "").trim() || null,
    changed_files: normalizeWorkerReportFiles(readRuntimeReportField(source, "changed_files") || (updateData && updateData.changed_files) || []),
    committed_files: normalizeWorkerReportFiles(readRuntimeReportField(source, "committed_files") || (updateData && updateData.committed_files) || []),
    unexpected_changed_files: normalizeWorkerReportFiles(readRuntimeReportField(source, "unexpected_changed_files") || []),
    git_commit_sha: String(readRuntimeReportField(source, "git_commit_sha") || (updateData && updateData.git_commit_sha) || "").trim() || null,
    pushed: updateData && updateData.pushed === true,
    worker_git_push: readRuntimeNullableBoolean(readRuntimeReportField(source, "worker_git_push")) === true,
    git_push: updateData && (updateData.git_push === true || updateData.pushed === true),
    pushed_branch: String(readRuntimeReportField(source, "pushed_branch") || "").trim() || null,
    remote_contains_commit: readRuntimeNullableBoolean(readRuntimeReportField(source, "remote_contains_commit")) === true,
    repository_clean_after_push: readRuntimeNullableBoolean(readRuntimeReportField(source, "repository_clean_after_push")) === true,
    verification_only: updateData ? updateData.verification_only : getRuntimePolicyBoolean(source, "verification_only"),
    allow_no_change_success: updateData ? updateData.allow_no_change_success : getRuntimePolicyBoolean(source, "allow_no_change_success"),
    code_changes_required: updateData ? updateData.code_changes_required : getRuntimePolicyBoolean(source, "code_changes_required"),
    codex_required: updateData ? updateData.codex_required : getRuntimePolicyBoolean(source, "codex_required"),
    git_commit_required: updateData ? updateData.git_commit_required : getRuntimePolicyBoolean(source, "git_commit_required"),
    git_push_required: updateData ? updateData.git_push_required : getRuntimePolicyBoolean(source, "git_push_required"),
    terminal_state_persisted: readRuntimeNullableBoolean(readRuntimeReportField(source, "terminal_state_persisted")) !== false,
    post_completion_state_applied: updateData && updateData.post_completion_state_applied === true,
    final_report_source: updateData && updateData.final_report_source ? updateData.final_report_source : "worker_runtime_report",
    next_stage_allowed: updateData && updateData.next_stage_allowed === true,
    legacy_report_normalized: !(result && Number(result.report_schema_version) === RUNTIME_CANONICAL_WORKER_REPORT_SCHEMA_VERSION),
  };
}
function parseSupabaseMissingColumnName(error) {
  const message = String(error && (error.message || error.details || error.hint) || "");
  const match = message.match(/'([^']+)' column|column ['"]?([A-Za-z0-9_]+)['"]?/i);
  return match && (match[1] || match[2]) || "";
}

function getFinalReportReplyContext(job) {
  const payload = readFinalReportObject(job && (job.payload || job.metadata || job.task_payload));
  const messageId =
    readFinalReportString(job && job.source_message_id) ||
    readFinalReportString(job && job.feishu_message_id) ||
    readFinalReportString(payload.source_message_id) ||
    readFinalReportString(payload.feishu_message_id) ||
    readFinalReportString(payload.message_id);
  const chatId =
    readFinalReportString(job && job.source_chat_id) ||
    readFinalReportString(job && job.feishu_chat_id) ||
    readFinalReportString(payload.source_chat_id) ||
    readFinalReportString(payload.feishu_chat_id) ||
    readFinalReportString(payload.chat_id);
  const receiveId =
    readFinalReportString(job && job.source_receive_id) ||
    readFinalReportString(job && job.receive_id) ||
    readFinalReportString(payload.source_receive_id) ||
    readFinalReportString(payload.receive_id) ||
    chatId;
  return {
    messageId,
    chatId,
    receiveId,
    hasTarget: Boolean(messageId || receiveId || chatId),
  };
}

function isTerminalFinalReportStatus(status) {
  return /^(succeeded|failed|cancelled|completed)$/i.test(String(status || "").trim());
}

function getFeishuFinalReplyConfig() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

function extractFinalReportBatchCode(job) {
  const text = String((job && (job.request_text || job.result_text || job.output || job.error_text)) || "");
  const match = text.match(/\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i);
  return match ? match[0] : "not_provided";
}

function parseFinalReportList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/[\n,]/)
      .map((item) => item.replace(/^[-*]\s*/, "").trim())
      .filter((item) => /^(?:docs|src|infra|app|work)\//.test(item));
  }
  return [];
}

function extractFinalReportChangedFiles(job) {
  const payload = readFinalReportObject(job && (job.payload || job.metadata || job.task_payload));
  if (runtimeHasOwnField(job, "changed_files")) return parseFinalReportList(job.changed_files);
  if (runtimeHasOwnField(payload, "changed_files")) return parseFinalReportList(payload.changed_files);
  if (runtimeHasOwnField(job, "files_changed")) return parseFinalReportList(job.files_changed);
  if (runtimeHasOwnField(payload, "files_changed")) return parseFinalReportList(payload.files_changed);
  return [];
}

function readFinalReportFailureCode(job) {
  const payload = readFinalReportObject(job && (job.payload || job.metadata || job.task_payload));
  return readFinalReportString(job && job.failure_code)
    || readFinalReportString(payload.failure_code)
    || (String(job && job.status || "").toLowerCase() === "succeeded" ? "null" : "not_provided");
}

function buildSourceIndependentFeishuFinalReportText(job) {
  const changedFiles = extractFinalReportChangedFiles(job);
  const committedFiles = parseFinalReportList(job && job.committed_files);
  const pushed = job && typeof job.pushed === "boolean" ? job.pushed : normalizeRuntimePushed(job || {});
  const effectiveStatus = readFinalReportString(job && job.effective_final_status) || String(job && job.status || "unknown");
  const workerStatus = readFinalReportString(job && job.worker_execution_status) || String(job && job.status || "unknown");
  const taskGoalStatus = readFinalReportString(job && job.task_goal_status) || effectiveStatus;
  const failureCode = readFinalReportString(job && job.failure_code) || (effectiveStatus === "failed" ? "UNKNOWN_FAILURE" : "null");
  const failureStage = readFinalReportString(job && job.failure_stage) || getRuntimeFailureStage(job || {}, failureCode) || "null";
  return [
    "Worker final execution report",
    "Batch: " + extractFinalReportBatchCode(job),
    "Worker execution status: " + workerStatus,
    "Task goal status: " + taskGoalStatus,
    "Final status: " + effectiveStatus,
    "Changed files:",
    changedFiles.length > 0 ? changedFiles.map((file) => "- " + file).join("\n") : "- none",
    "Committed files:",
    committedFiles.length > 0 ? committedFiles.map((file) => "- " + file).join("\n") : "- none",
    "Git commit: " + (readFinalReportString(job && job.git_commit_sha) || "null"),
    "Git push: " + (pushed ? "true" : "false"),
    "final_report_source: " + (readFinalReportString(job && job.final_report_source) || readFinalReportString(job && job.post_completion_source) || "worker_runtime_report"),
    "post_completion_state_applied: " + (job && job.post_completion_state_applied === false ? "false" : "true"),
    "failure_code: " + failureCode,
    "failure_stage: " + failureStage,
  ].join("\n");
}

async function sendSourceIndependentFeishuFinalReply(job) {
  const context = getFinalReportReplyContext(job);
  if (!context.hasTarget) {
    return { skipped: true, reason: "skipped_no_target" };
  }

  const config = getFeishuFinalReplyConfig();
  if (!config) {
    return { skipped: true, reason: "webhook_not_configured" };
  }

  const token = await getFeishuTenantAccessToken(config);
  const text = buildSourceIndependentFeishuFinalReportText(job);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    let url;
    let body;
    if (context.messageId) {
      url = "https://open.feishu.cn/open-apis/im/v1/messages/" + encodeURIComponent(context.messageId) + "/reply";
      body = {
        msg_type: "text",
        content: JSON.stringify({ text }),
      };
    } else if (context.receiveId || context.chatId) {
      url = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id";
      body = {
        receive_id: context.receiveId || context.chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      };
    } else {
      return { skipped: true, reason: "skipped_no_target" };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error("Feishu final reply HTTP " + response.status + ": " + sanitizeFeishuLogText(responseText));
    }
    let parsed = null;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      parsed = responseText;
    }
    if (parsed && typeof parsed === "object" && parsed.code !== undefined && parsed.code !== 0) {
      throw new Error("Feishu final reply error: " + sanitizeFeishuLogText(responseText));
    }
    return { skipped: false, response: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function shouldSendFeishuFinalReport(job) {
  const context = getFinalReportReplyContext(job);
  const replySent = Boolean(job && job.reply_sent_at);
  const status = String(job && job.status || "").trim().toLowerCase();
  const notificationStatus = String(job && job.notification_status || "").trim().toLowerCase();
  const hasActiveLease = Boolean(job && job.reply_lease_until && Date.parse(job.reply_lease_until) > Date.now());
  const hasSendingLock = notificationStatus === "sending";
  return {
    ok: isTerminalFinalReportStatus(status) && context.hasTarget && !replySent && !hasActiveLease && !hasSendingLock && notificationStatus !== "sent",
    context,
    reason: !isTerminalFinalReportStatus(status)
      ? "not_terminal"
      : replySent || notificationStatus === "sent"
        ? "already_sent"
        : hasActiveLease || hasSendingLock
          ? "active_reply_lease"
          : !context.hasTarget
            ? "skipped_no_target"
            : "ready",
  };
}

async function updateFinalReportNotificationState(supabase, jobId, fields) {
  const pending = { ...fields, updated_at: new Date().toISOString() };
  const skipped = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { error } = await supabase.from("hermes_jobs").update(pending).eq("id", jobId);
    if (!error) return { ok: true, skipped };
    const message = String(error.message || "");
    const match = message.match(/'([^']+)' column|column ['"]?([A-Za-z0-9_]+)['"]?/i);
    const missing = match && (match[1] || match[2]);
    if (!missing || !(missing in pending)) {
      console.warn("final_report_notification_state_update_failed", {
        job_id: jobId,
        code: error.code || null,
        message: error.message || null,
        skipped,
      });
      return { ok: false, skipped, error };
    }
    skipped.push(missing);
    delete pending[missing];
  }
  return { ok: false, skipped, error: new Error("too_many_notification_state_retries") };
}


async function claimFinalReportNotificationSend(supabase, jobId, currentAttemptCount) {
  const now = new Date().toISOString();
  let pending = {
    notification_status: "sending",
    reply_last_attempt_at: now,
    reply_attempt_count: Number(currentAttemptCount || 0) + 1,
    reply_error: null,
    updated_at: now,
  };
  let useNotificationStatusFilter = true;
  const skipped = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let query = supabase
      .from("hermes_jobs")
      .update(pending)
      .eq("id", jobId)
      .is("reply_sent_at", null);
    if (useNotificationStatusFilter) {
      query = query.or("notification_status.is.null,notification_status.eq.failed,notification_status.eq.skipped");
    }
    const { data, error } = await query.select("id,reply_sent_at").maybeSingle();
    if (!error && data && data.id) return { ok: true, data, skipped };
    if (!error) return { ok: false, reason: "already_sending_or_sent", skipped };

    const message = String(error.message || "");
    const match = message.match(/'([^']+)' column|column ['"]?([A-Za-z0-9_]+)['"]?/i);
    const missing = match && (match[1] || match[2]);
    if (missing === "notification_status" && useNotificationStatusFilter) {
      useNotificationStatusFilter = false;
      if (missing in pending) delete pending[missing];
      skipped.push(missing);
      continue;
    }
    if (missing && missing in pending) {
      delete pending[missing];
      skipped.push(missing);
      continue;
    }
    console.warn("final_report_notification_claim_failed", {
      job_id: jobId,
      code: error.code || null,
      message: error.message || null,
      skipped,
    });
    return { ok: false, reason: "claim_failed", error, skipped };
  }
  return { ok: false, reason: "too_many_claim_schema_retries", skipped };
}

async function sendFeishuFinalReplyWithRetry(job, sendFn = sendSourceIndependentFeishuFinalReply, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 3));
  const retryDelaysMs = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : [1200, 3000];
  let lastErrorMessage = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await sendFn(job);
      if (result && result.skipped) {
        const reason = result.reason || "unknown";
        if (/webhook_not_configured|missing_(?:message_id|chat_id|receive_id|target)|no_(?:message_id|chat_id|receive_id|target)/i.test(reason)) {
          console.warn("final_report_target_missing", {
            job_id: job && job.id || "unknown",
            reason,
          });
        }
        return { ok: true, skipped: true, reason };
      }
      return { ok: true, skipped: false, response: result && result.response };
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
      const rateLimited = isFeishuFinalReportRateLimited(lastErrorMessage);
      if (rateLimited) {
        console.warn("feishu_rate_limited", {
          job_id: job && job.id || "unknown",
          attempt,
          max_attempts: maxAttempts,
          message: sanitizeFeishuLogText(lastErrorMessage),
        });
      }
      if (!rateLimited || attempt >= maxAttempts) {
        console.warn("final_report_delivery_warning", {
          job_id: job && job.id || "unknown",
          attempt,
          max_attempts: maxAttempts,
          rate_limited: rateLimited,
          message: sanitizeFeishuLogText(lastErrorMessage),
        });
        return {
          ok: false,
          skipped: false,
          rate_limited: rateLimited,
          reason: rateLimited ? "feishu_rate_limited" : "send_failed",
          error: lastErrorMessage,
        };
      }
      await sleepFeishuFinalReportRetry(Number(retryDelaysMs[attempt - 1] || 1000));
    }
  }

  return {
    ok: false,
    skipped: false,
    reason: "send_failed",
    error: lastErrorMessage || "unknown",
  };
}

async function deliverFeishuFinalReportIfEligible(job, label = "terminal_report") {
  const jobId = job && job.id;
  const decision = shouldSendFeishuFinalReport(job);
  console.log("final_report_delivery_decision", {
    job_id: jobId || null,
    source: job && job.source || null,
    notification_status: job && job.notification_status || null,
    reason: decision.reason,
    label,
    message_id_present: Boolean(decision.context.messageId),
    chat_id_present: Boolean(decision.context.chatId),
    receive_id_present: Boolean(decision.context.receiveId),
  });
  if (!jobId) return { ok: false, reason: "missing_job_id" };
  if (!decision.ok) {
    if (decision.reason === "skipped_no_target") {
      await updateFinalReportNotificationState(supabase, jobId, {
        notification_status: "skipped_no_target",
        reply_error: "no_reply_target",
      });
      console.warn("final_report_target_missing", { job_id: jobId, source: job && job.source || null });
    }
    return { ok: true, skipped: true, reason: decision.reason };
  }
  const claimResult = await claimFinalReportNotificationSend(supabase, jobId, job.reply_attempt_count);
  if (!claimResult.ok) {
    console.log("final_report_delivery_claim_skipped", { job_id: jobId, reason: claimResult.reason });
    return { ok: true, skipped: true, reason: claimResult.reason };
  }
  const replyResult = await sendFeishuFinalReplyWithRetry(job);
  if (replyResult.ok && !replyResult.skipped) {
    const replyTime = new Date().toISOString();
    const updateResult = await updateFinalReportNotificationState(supabase, jobId, {
      notification_status: "sent",
      reply_sent_at: replyTime,
      reply_error: null,
    });
    if (!updateResult.ok) {
      console.error("记录飞书回复状态失败:", updateResult.error);
      return { ok: false, reason: "state_update_failed" };
    }
    console.log("飞书结果已发送: " + jobId);
    return { ok: true, skipped: false, reason: "sent" };
  }
  if (replyResult.skipped) {
    await updateFinalReportNotificationState(supabase, jobId, {
      notification_status: replyResult.reason === "skipped_no_target" ? "skipped_no_target" : "skipped",
      reply_error: replyResult.reason === "skipped_no_target" ? "no_reply_target" : (replyResult.reason || "final_report_skipped"),
    });
    return { ok: true, skipped: true, reason: replyResult.reason || "final_report_skipped" };
  }
  const errorMessage = replyResult.error || replyResult.reason || "final_report_delivery_failed";
  console.error("飞书结果回复失败:", sanitizeFeishuLogText(errorMessage));
  await updateFinalReportNotificationState(supabase, jobId, {
    notification_status: "failed",
    reply_error: errorMessage,
  });
  return { ok: false, reason: errorMessage };
}

async function syncWorkerJobToFeishu(jobId, input, reason) {
  try {
    const config = getFeishuSyncConfig();
    if (!config) {
      console.log("[feishu-sync] skip: missing Feishu env config");
      return { ok: true, skipped: true, reason: "missing_config" };
    }

    const { data: job, error: jobError } = await supabase
      .from("hermes_jobs")
      .select("id,bitable_record_id")
      .eq("id", jobId)
      .maybeSingle();

    if (jobError) {
      console.log("[feishu-sync] skip: read job failed", sanitizeFeishuLogText(jobError.message));
      return { ok: false, skipped: true, reason: "read_job_failed" };
    }

    const recordId = job && job.bitable_record_id;
    if (!recordId) {
      console.warn("[feishu-sync] missing_bitable_record_id_bitable_sync_skipped", {
        job_id: jobId,
        reason,
      });
      return { ok: true, skipped: true, reason: "missing_bitable_record_id_bitable_sync_skipped" };
    }

    const accessToken = await getFeishuTenantAccessToken(config);
    const appToken = await getFeishuBitableAppToken(config, accessToken);
    const fieldsMeta = await getFeishuBitableFields(accessToken, appToken, config.tableId);

    const fields = {};
    addMappedFeishuField(fields, fieldsMeta, "task_status", input.status);
    addMappedFeishuField(fields, fieldsMeta, "current_stage", input.workflow_stage);
    addMappedFeishuField(fields, fieldsMeta, "progress_percent", input.progress_percent);
    addMappedFeishuField(fields, fieldsMeta, "current_step", input.current_step);
    addMappedFeishuField(fields, fieldsMeta, "status_message", input.status_message);
    addMappedFeishuField(fields, fieldsMeta, "git_commit_sha", input.git_commit_sha);
    addMappedFeishuField(fields, fieldsMeta, "error_text", input.error_text);
    addMappedFeishuField(fields, fieldsMeta, "completed_at", input.finished_at);
    addMappedFeishuField(fields, fieldsMeta, "updated_at", input.updated_at);

    if (Object.keys(fields).length === 0) {
      console.log("[feishu-sync] skip: no matching bitable fields");
      return { ok: true, skipped: true, reason: "missing_fields" };
    }

    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${config.tableId}/records/${recordId}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ fields }),
    });

    const result = await response.json();
    if (result.code !== 0) {
      console.log(`[feishu-sync] failed: reason=${reason} code=${result.code} msg=${sanitizeFeishuLogText(result.msg)}`);
      return { ok: false, reason: "api_failed" };
    }

    console.log(`[feishu-sync] updated: job=${jobId} reason=${reason}`);
    return { ok: true };
  } catch (error) {
    console.log("[feishu-sync] best-effort failed:", sanitizeFeishuLogText(error && error.message ? error.message : error));
    return { ok: false, reason: "sync_failed" };
  }
}

// PROJECT_DIRECTOR_FINAL_FEISHU_NOTIFY
const projectDirectorFinalNotifySent = globalThis.__projectDirectorFinalNotifySent || new Set();
globalThis.__projectDirectorFinalNotifySent = projectDirectorFinalNotifySent;

function getProjectDirectorNotifyWebhook() {
  return (
    process.env.FEISHU_NOTIFY_WEBHOOK ||
    process.env.FEISHU_REPORT_WEBHOOK ||
    process.env.FEISHU_WEBHOOK_URL ||
    process.env.FEISHU_BOT_WEBHOOK ||
    process.env.FEISHU_CUSTOM_BOT_WEBHOOK ||
    process.env.LARK_NOTIFY_WEBHOOK ||
    process.env.LARK_WEBHOOK_URL ||
    ""
  );
}

function truncateProjectDirectorNotifyText(value, maxLength = 2600) {
  const text = String(value || "");
  return text.length > maxLength ? text.slice(0, maxLength) + "\n...已截断" : text;
}

function pickProjectDirectorFinalStatus(reqBody, payload) {
  return (
    reqBody && (reqBody.status || reqBody.final_status || reqBody.result_status) ||
    payload && (payload.status || payload.final_status || payload.job_status) ||
    ""
  );
}

function pickProjectDirectorJobId(reqBody, payload) {
  return (
    reqBody && (reqBody.job_id || reqBody.id || reqBody.jobId) ||
    payload && (payload.job_id || payload.id || payload.jobId) ||
    "unknown"
  );
}

function buildProjectDirectorFinalNotifyText(reqBody, payload) {
  const status = pickProjectDirectorFinalStatus(reqBody, payload);
  const jobId = pickProjectDirectorJobId(reqBody, payload);
  const gitSha =
    (reqBody && (reqBody.git_commit_sha || reqBody.commit_sha || reqBody.gitCommitSha)) ||
    (payload && (payload.git_commit_sha || payload.commit_sha || payload.gitCommitSha)) ||
    "";

  const requestText =
    (reqBody && (reqBody.request_text || reqBody.request || reqBody.task || reqBody.prompt)) ||
    (payload && (payload.request_text || payload.request || payload.task || payload.prompt)) ||
    "";

  const reportText =
    (reqBody && (reqBody.report || reqBody.result || reqBody.output || reqBody.summary || reqBody.error_text || reqBody.error)) ||
    (payload && (payload.report || payload.result || payload.output || payload.summary || payload.error_text || payload.error)) ||
    "";

  const ok = status === "succeeded" || status === "success" || status === "completed";

  return truncateProjectDirectorNotifyText([
    ok ? "✅ Codex 任务执行成功" : "❌ Codex 任务执行失败",
    `任务编号：${jobId}`,
    requestText ? `需求：${truncateProjectDirectorNotifyText(requestText, 700)}` : "",
    "",
    reportText ? `执行结果：\n${truncateProjectDirectorNotifyText(reportText, 1400)}` : "",
    gitSha ? `\nGit commit SHA：${gitSha}` : ""
  ].filter(Boolean).join("\n"));
}

async function sendProjectDirectorFinalFeishuNotify(reqBody, payload) {
  try {
    const status = pickProjectDirectorFinalStatus(reqBody, payload);
    if (!["succeeded", "success", "completed", "failed", "error"].includes(status)) {
      return;
    }

    const jobId = pickProjectDirectorJobId(reqBody, payload);
    const key = `${jobId}:${status}`;

    if (projectDirectorFinalNotifySent.has(key)) {
      return;
    }

    const webhook = getProjectDirectorNotifyWebhook();
    if (!webhook) {
      console.warn("[worker-api] final feishu notify skipped: webhook env missing");
      return;
    }

    projectDirectorFinalNotifySent.add(key);

    const text = buildProjectDirectorFinalNotifyText(reqBody, payload);

    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msg_type: "text",
        content: { text }
      })
    });

    if (!resp.ok) {
      console.warn("[worker-api] final feishu notify failed", resp.status);
      projectDirectorFinalNotifySent.delete(key);
    } else {
      console.log("[worker-api] final feishu notify sent", jobId, status);
    }
  } catch (err) {
    console.warn("[worker-api] final feishu notify error", err && (err.stack || err.message || err));
  }
}

function installProjectDirectorFinalNotifyMiddleware(app) {
  app.use((req, res, next) => {
    const path = req.path || req.url || "";
    const isReportRequest =
      req.method === "POST" &&
      (path.includes("/worker/report") || path.includes("/api/worker/report"));

    if (!isReportRequest) {
      return next();
    }

    const originalJson = res.json.bind(res);
    res.json = function patchedProjectDirectorReportJson(payload) {
      setImmediate(() => {
        sendProjectDirectorFinalFeishuNotify(req.body || {}, payload || {});
      });
      return originalJson(payload);
    };

    return next();
  });
}



const app = express();

// === FEISHU INTAKE V8 ABSOLUTE PREFLIGHT ===
// This route must stay immediately after `const app = express();`.
// It runs before all old /feishu/event handlers.
// Website/product requests must never enter hermes_jobs queued.

function feishuV8TextFromAny(value, depth = 0) {
  if (value == null || depth > 12) return "";

  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return "";

    try {
      const parsed = JSON.parse(raw);
      const nested = feishuV8TextFromAny(parsed, depth + 1);
      if (nested) return nested;
    } catch (_) {}

    return raw;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = feishuV8TextFromAny(item, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (typeof value === "object") {
    for (const key of ["text", "content", "message", "event", "body", "data"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = feishuV8TextFromAny(value[key], depth + 1);
        if (found) return found;
      }
    }

    for (const key of Object.keys(value)) {
      const found = feishuV8TextFromAny(value[key], depth + 1);
      if (found) return found;
    }
  }

  return "";
}

function feishuV8MessageIdFromAny(value, depth = 0) {
  if (value == null || depth > 12) return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = feishuV8MessageIdFromAny(item, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (typeof value === "object") {
    if (typeof value.message_id === "string" && value.message_id.trim()) {
      return value.message_id.trim();
    }

    for (const key of Object.keys(value)) {
      const found = feishuV8MessageIdFromAny(value[key], depth + 1);
      if (found) return found;
    }
  }

  return "";
}

function feishuV8IsWebsiteProductRequest(text) {
  const raw = String(text || "").trim();

  if (!/^新需求[:：]/.test(raw)) return false;
  if (raw.includes("执行系统升级阶段")) return false;

  const body = raw.replace(/^新需求[:：]\s*/, "").trim();

  return /(网站|首页|页面|功能|产品|搭子|平台|开发|设计|上线|建立|创建|做|改版|小程序|APP|app|前端|后端|登录|注册|支付|会员|地图|搜索|筛选)/i.test(body);
}

function feishuV8DirectorReply(text) {
  const body = String(text || "").replace(/^新需求[:：]\s*/, "").trim() || "网站需求";

  return [
    "【项目总管确认】",
    "",
    "我理解你的需求：" + body,
    "",
    "我的建议：先不要直接进入代码执行，先确认首页目标、首屏结构、核心入口和 MVP 范围。",
    "",
    "我建议先这样做：",
    "A. 先做首页 MVP：定位口号、分类入口、同城筛选、发布搭子按钮、热门搭子推荐。",
    "B. 先做完整产品规划：页面结构、用户流程、任务树、分批开发计划。",
    "",
    "关键问题：你想先做一个能看的首页，还是先做完整平台规划？",
    "",
    "请回复：批准建议 / 选 A / 选 B / 补充要求"
  ].join("\n");
}

let feishuV8TenantToken = null;
let feishuV8TenantTokenExpireAt = 0;

async function feishuV8GetTenantToken() {
  const now = Date.now();

  if (feishuV8TenantToken && feishuV8TenantTokenExpireAt > now + 60000) {
    return feishuV8TenantToken;
  }

  const appId = process.env.FEISHU_APP_ID || process.env.APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || process.env.APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error("missing_feishu_app_id_or_secret");
  }

  const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error("tenant_token_failed");
  }

  feishuV8TenantToken = data.tenant_access_token;
  feishuV8TenantTokenExpireAt = now + Math.max(60, Number(data.expire || 3600) - 120) * 1000;

  return feishuV8TenantToken;
}

async function feishuV8Reply(messageId, text) {
  if (!messageId) {
    console.log("[feishu-intake-v8] no message_id, skip reply");
    return;
  }

  const token = await feishuV8GetTenantToken();

  const resp = await fetch("https://open.feishu.cn/open-apis/im/v1/messages/" + encodeURIComponent(messageId) + "/reply", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      msg_type: "text",
      content: JSON.stringify({ text })
    })
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok || data.code !== 0) {
    throw new Error("reply_failed");
  }

  console.log("[feishu-intake-v8] project director reply sent");
}

app.post("/feishu/event", express.json({ type: "*/*", limit: "2mb" }), async (req, res, next) => {
  try {
    const body = req.body || {};

    if (body.type === "url_verification" && body.challenge) {
      console.log("[feishu-intake-v8] url_verification handled");
      return res.status(200).json({ challenge: body.challenge });
    }

    const text = feishuV8TextFromAny(body);

    if (feishuV8IsWebsiteProductRequest(text)) {
      const messageId = feishuV8MessageIdFromAny(body);
      const replyText = feishuV8DirectorReply(text);

      setImmediate(() => {
        feishuV8Reply(messageId, replyText).catch((error) => {
          console.error("[feishu-intake-v8] reply failed:", error && error.message ? error.message : String(error));
        });
      });

      console.log("[feishu-intake-v8] ABSOLUTE HARD RETURN website/product request before hermes_jobs queued. queued=false");

      return res.status(200).json({
        ok: true,
        routed: "project_director_v8",
        queued: false
      });
    }

    return next();
  } catch (error) {
    console.error("[feishu-intake-v8] middleware error:", error && error.message ? error.message : String(error));
    return next();
  }
});



// FEISHU_URL_VERIFICATION_FAST_PATH
// 飞书开放平台保存回调地址时，会在 3 秒内 POST url_verification。
// 这里必须快速返回 challenge，不能进入 Supabase / hermes_jobs / 消息处理逻辑。


// === PROJECT_DIRECTOR_INTAKE_GUARD_V5 START ===
// Strong Feishu payload guard.
// This guard searches the whole Feishu event payload, because real message.receive_v1
// content may be nested or JSON-encoded differently from simple curl test payloads.
function collectFeishuStringsV5(value, out = [], depth = 0) {
  if (depth > 8 || value == null) return out;

  if (typeof value === "string") {
    out.push(value);

    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        collectFeishuStringsV5(JSON.parse(trimmed), out, depth + 1);
      } catch (_) {}
    }

    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectFeishuStringsV5(item, out, depth + 1);
    return out;
  }

  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      collectFeishuStringsV5(item, out, depth + 1);
    }
  }

  return out;
}

function findFeishuMessageIdV5(value, depth = 0) {
  if (depth > 8 || value == null) return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFeishuMessageIdV5(item, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (typeof value === "object") {
    if (typeof value.message_id === "string" && value.message_id) {
      return value.message_id;
    }

    for (const item of Object.values(value)) {
      const found = findFeishuMessageIdV5(item, depth + 1);
      if (found) return found;
    }
  }

  return "";
}

function normalizeFeishuTextV5(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/\u00a0/g, "")
    .trim();
}

function extractFeishuDemandTextV5(payload) {
  const strings = collectFeishuStringsV5(payload);

  const direct = strings.find((x) => String(x).includes("新需求"));
  if (direct) return String(direct).trim();

  return strings.join(" ").trim();
}

function isSystemUpgradeRequestV5(text) {
  const t = normalizeFeishuTextV5(text);
  return t.includes("执行系统升级阶段") || t.includes("系统升级阶段");
}

function isWebsiteProductRequestV5(text, payload) {
  const raw = normalizeFeishuTextV5(JSON.stringify(payload || {}));
  const t = normalizeFeishuTextV5(text) + raw;

  if (!t.includes("新需求")) return false;
  if (isSystemUpgradeRequestV5(t)) return false;

  return [
    "网站",
    "首页",
    "页面",
    "功能",
    "产品",
    "搭子",
    "平台",
    "开发",
    "设计",
    "上线",
    "做",
    "搭建",
    "建立",
    "创建",
    "同城"
  ].some((keyword) => t.includes(keyword));
}

function buildProjectDirectorConfirmTextV5(text) {
  const cleanText = String(text || "")
    .replace(/^新需求[:：]\s*/, "")
    .replace(/[{}"]/g, "")
    .trim();

  return [
    "【项目总管确认】",
    "",
    `我理解你的需求：${cleanText || "你想启动一个网站 / 产品类需求。"}`,
    "",
    "我的建议：先不要直接让 Codex 开工，应该先由项目总管确认目标、范围和第一批任务，避免做偏。",
    "",
    "我建议先这样做：",
    "1. 先确认首页目标用户和核心转化路径。",
    "2. 再生成首页结构、文案、视觉方向和首批开发任务。",
    "3. 你批准后，再进入任务树和分批执行。",
    "",
    "关键问题：",
    "A. 先做 MVP 首页，快速上线验证。",
    "B. 先做完整产品规划，再开始开发。",
    "",
    "请回复：批准建议 / 选 A / 选 B / 补充要求"
  ].join("\n");
}

async function sendProjectDirectorConfirmToFeishuV5(payload, text) {
  try {
    const messageId = findFeishuMessageIdV5(payload);

    if (!messageId) {
      console.log("[feishu-intake-v5] missing message_id, cannot direct reply");
      return false;
    }

    if (typeof getFeishuTenantToken !== "function") {
      console.log("[feishu-intake-v5] getFeishuTenantToken not available");
      return false;
    }

    const token = await getFeishuTenantToken();

    const response = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          msg_type: "text",
          content: JSON.stringify({
            text: buildProjectDirectorConfirmTextV5(text)
          })
        })
      }
    );

    if (!response.ok) {
      console.error("[feishu-intake-v5] project director reply failed:", response.status);
      return false;
    }

    console.log("[feishu-intake-v5] project director confirm sent");
    return true;
  } catch (error) {
    console.error("[feishu-intake-v5] project director reply error:", error && error.message ? error.message : String(error));
    return false;
  }
}

// V5 must be before all existing /feishu/event handlers.

// === FEISHU WEBSITE INTAKE V6 HARD STOP ===
// Purpose:
// 1. url_verification must return immediately.
// 2. Website/product requests must NOT enter hermes_jobs queued/execution.
// 3. Website/product requests must reply with project director confirmation.
// 4. System upgrade requests continue to the old queue logic.

let feishuV6TenantTokenCache = null;
let feishuV6TenantTokenExpireAt = 0;

function feishuV6NormalizeText(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return "";

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.text === "string") return parsed.text.trim();
        if (typeof parsed.content === "string") return parsed.content.trim();
      }
    } catch (_) {}

    return raw;
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (typeof value.content === "string") return feishuV6NormalizeText(value.content);
  }

  return "";
}

function feishuV6FindText(value, depth = 0) {
  if (!value || depth > 8) return "";

  const direct = feishuV6NormalizeText(value);
  if (direct.includes("新需求")) return direct;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = feishuV6FindText(item, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (typeof value === "object") {
    const preferredKeys = ["content", "text", "message", "event", "body"];
    for (const key of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = feishuV6FindText(value[key], depth + 1);
        if (found) return found;
      }
    }

    for (const key of Object.keys(value)) {
      const found = feishuV6FindText(value[key], depth + 1);
      if (found) return found;
    }
  }

  return "";
}

function feishuV6FindMessageId(value, depth = 0) {
  if (!value || depth > 8) return "";

  if (typeof value === "object") {
    if (typeof value.message_id === "string" && value.message_id.trim()) {
      return value.message_id.trim();
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = feishuV6FindMessageId(item, depth + 1);
        if (found) return found;
      }
      return "";
    }

    for (const key of Object.keys(value)) {
      const found = feishuV6FindMessageId(value[key], depth + 1);
      if (found) return found;
    }
  }

  return "";
}

function feishuV6IsSystemUpgradeRequest(text) {
  return String(text || "").includes("执行系统升级阶段");
}

function feishuV6IsWebsiteProductRequest(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (!/^新需求[:：]/.test(raw)) return false;
  if (feishuV6IsSystemUpgradeRequest(raw)) return false;

  const body = raw.replace(/^新需求[:：]\s*/, "").trim();

  return /(网站|首页|页面|功能|产品|搭子|平台|开发|设计|上线|建立|创建|做|改版|小程序|APP|app|前端|后端|登录|注册|支付|会员|地图|搜索|筛选)/i.test(body);
}

function feishuV6BuildProjectDirectorReply(text) {
  const body = String(text || "").replace(/^新需求[:：]\s*/, "").trim() || "网站/产品需求";

  return [
    "【项目总管确认】",
    "",
    `我理解你的需求：${body}`,
    "",
    "我的建议：不要直接让 Worker 开始写代码，先确认首页目标、核心模块和首屏内容，避免做偏。",
    "",
    "我建议先这样做：",
    "A. 先做首页 MVP：定位口号、分类入口、同城筛选、发布搭子按钮、热门搭子推荐。",
    "B. 先做完整产品方案：用户流程、页面结构、任务树、分批开发计划。",
    "",
    "关键问题：你想先做一个能看的首页，还是先做完整平台规划？",
    "",
    "请回复：批准建议 / 选 A / 选 B / 补充要求"
  ].join("\n");
}

async function feishuV6GetTenantAccessToken() {
  const now = Date.now();

  if (feishuV6TenantTokenCache && feishuV6TenantTokenExpireAt > now + 60_000) {
    return feishuV6TenantTokenCache;
  }

  const appId = process.env.FEISHU_APP_ID || process.env.APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || process.env.APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error("missing_feishu_app_id_or_secret");
  }

  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`tenant_token_failed:${data.code || response.status}:${data.msg || "unknown"}`);
  }

  feishuV6TenantTokenCache = data.tenant_access_token;
  feishuV6TenantTokenExpireAt = now + Math.max(60, Number(data.expire || 3600) - 120) * 1000;

  return feishuV6TenantTokenCache;
}

async function feishuV6ReplyText(messageId, text) {
  if (!messageId) {
    console.log("[feishu-intake-v6] skip reply: missing message_id");
    return;
  }

  const token = await feishuV6GetTenantAccessToken();

  const response = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        msg_type: "text",
        content: JSON.stringify({ text })
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.code !== 0) {
    throw new Error(`reply_failed:${data.code || response.status}:${data.msg || "unknown"}`);
  }

  console.log("[feishu-intake-v6] project director reply sent");
}


// === FEISHU INTAKE V7 FORCE RETURN ===
// Must be before old /feishu/event route.
// Website/product requests must return here and must not enter hermes_jobs queued.

function feishuV7TextFromAny(value, depth = 0) {
  if (value == null || depth > 12) return "";

  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return "";

    try {
      const parsed = JSON.parse(raw);
      const nested = feishuV7TextFromAny(parsed, depth + 1);
      if (nested) return nested;
    } catch (_) {}

    return raw;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = feishuV7TextFromAny(item, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (typeof value === "object") {
    for (const key of ["text", "content", "message", "event", "body", "data"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = feishuV7TextFromAny(value[key], depth + 1);
        if (found) return found;
      }
    }

    for (const key of Object.keys(value)) {
      const found = feishuV7TextFromAny(value[key], depth + 1);
      if (found) return found;
    }
  }

  return "";
}

function feishuV7MessageIdFromAny(value, depth = 0) {
  if (value == null || depth > 12) return "";

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = feishuV7MessageIdFromAny(item, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (typeof value === "object") {
    if (typeof value.message_id === "string" && value.message_id.trim()) {
      return value.message_id.trim();
    }

    for (const key of Object.keys(value)) {
      const found = feishuV7MessageIdFromAny(value[key], depth + 1);
      if (found) return found;
    }
  }

  return "";
}

function feishuV7IsWebsiteRequest(text) {
  const raw = String(text || "").trim();

  if (!/^新需求[:：]/.test(raw)) return false;
  if (raw.includes("执行系统升级阶段")) return false;

  const body = raw.replace(/^新需求[:：]\s*/, "").trim();

  return /(网站|首页|页面|功能|产品|搭子|平台|开发|设计|上线|建立|创建|做|改版|小程序|APP|app|前端|后端|登录|注册|支付|会员|地图|搜索|筛选)/i.test(body);
}

function feishuV7DirectorReply(text) {
  const body = String(text || "").replace(/^新需求[:：]\s*/, "").trim() || "网站需求";

  return [
    "【项目总管确认】",
    "",
    "我理解你的需求：" + body,
    "",
    "我的建议：先不要直接进入代码执行，先确认首页目标、首屏结构、核心入口和 MVP 范围。",
    "",
    "我建议先这样做：",
    "A. 先做首页 MVP：定位口号、分类入口、同城筛选、发布搭子按钮、热门搭子推荐。",
    "B. 先做完整产品规划：页面结构、用户流程、任务树、分批开发计划。",
    "",
    "关键问题：你想先做一个能看的首页，还是先做完整平台规划？",
    "",
    "请回复：批准建议 / 选 A / 选 B / 补充要求"
  ].join("\n");
}

let feishuV7TenantToken = null;
let feishuV7TenantTokenExpireAt = 0;

async function feishuV7GetTenantToken() {
  const now = Date.now();

  if (feishuV7TenantToken && feishuV7TenantTokenExpireAt > now + 60000) {
    return feishuV7TenantToken;
  }

  const appId = process.env.FEISHU_APP_ID || process.env.APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || process.env.APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error("missing_feishu_app_id_or_secret");
  }

  const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error("tenant_token_failed");
  }

  feishuV7TenantToken = data.tenant_access_token;
  feishuV7TenantTokenExpireAt = now + Math.max(60, Number(data.expire || 3600) - 120) * 1000;

  return feishuV7TenantToken;
}

async function feishuV7Reply(messageId, text) {
  if (!messageId) {
    console.log("[feishu-intake-v7] no message_id, skip reply");
    return;
  }

  const token = await feishuV7GetTenantToken();

  const resp = await fetch("https://open.feishu.cn/open-apis/im/v1/messages/" + encodeURIComponent(messageId) + "/reply", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      msg_type: "text",
      content: JSON.stringify({ text })
    })
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok || data.code !== 0) {
    throw new Error("reply_failed");
  }

  console.log("[feishu-intake-v7] project director reply sent");
}

app.post("/feishu/event", async (req, res, next) => {
  try {
    const body = req.body || {};

    if (body.type === "url_verification" && body.challenge) {
      console.log("[feishu-intake-v7] url_verification handled");
      return res.status(200).json({ challenge: body.challenge });
    }

    const text = feishuV7TextFromAny(body);

    if (feishuV7IsWebsiteRequest(text)) {
      const messageId = feishuV7MessageIdFromAny(body);
      const replyText = feishuV7DirectorReply(text);

      setImmediate(() => {
        feishuV7Reply(messageId, replyText).catch((error) => {
          console.error("[feishu-intake-v7] reply failed:", error && error.message ? error.message : String(error));
        });
      });

      console.log("[feishu-intake-v7] HARD RETURN website/product request before hermes_jobs queued. queued=false");

      return res.status(200).json({
        ok: true,
        routed: "project_director_v7",
        queued: false
      });
    }

    return next();
  } catch (error) {
    console.error("[feishu-intake-v7] middleware error:", error && error.message ? error.message : String(error));
    return next();
  }
});


app.post("/feishu/event", async (req, res, next) => {
  try {
    const body = req.body || {};

    if (body.type === "url_verification" && body.challenge) {
      return res.status(200).json({ challenge: body.challenge });
    }

    const text = feishuV6FindText(body);

    if (feishuV6IsWebsiteProductRequest(text)) {
      const messageId = feishuV6FindMessageId(body);
      const replyText = feishuV6BuildProjectDirectorReply(text);

      setImmediate(() => {
        feishuV6ReplyText(messageId, replyText).catch((error) => {
          console.error("[feishu-intake-v6] project director reply failed:", error && error.message ? error.message : String(error));
        });
      });

      console.log("[feishu-intake-v6] website/product request HARD STOP before hermes_jobs queue. queued=false");

      return res.status(200).json({
        ok: true,
        routed: "project_director",
        queued: false
      });
    }

    return next();
  } catch (error) {
    console.error("[feishu-intake-v6] middleware error:", error && error.message ? error.message : String(error));
    return next();
  }
});


app.post("/feishu/event", express.json({ type: "*/*", limit: "2mb" }), async (req, res, next) => {
  try {
    if (req.body && req.body.type === "url_verification") {
      return res.json({
        challenge: req.body.challenge
      });
    }

    const text = extractFeishuDemandTextV5(req.body);

    if (isWebsiteProductRequestV5(text, req.body)) {
      console.log("[feishu-intake-v5] website/product request intercepted. queued=false");

      sendProjectDirectorConfirmToFeishuV5(req.body, text).catch((error) => {
        console.error("[feishu-intake-v5] async reply failed:", error && error.message ? error.message : String(error));
      });

      return res.json({
        ok: true,
        routed: "project_director",
        queued: false
      });
    }

    return next();
  } catch (error) {
    console.error("[feishu-intake-v5] guard failed, continue old route:", error && error.message ? error.message : String(error));
    return next();
  }
});
// === PROJECT_DIRECTOR_INTAKE_GUARD_V5 END ===


// === PROJECT_DIRECTOR_INTAKE_GUARD_V4 START ===
// Purpose:
// 1. Keep Feishu url_verification fast.
// 2. Stop website/product requests from entering hermes_jobs queued.
// 3. Let system-upgrade requests continue to the old queue flow.
function extractFeishuIntakeText(payload) {
  try {
    const event = payload && payload.event ? payload.event : {};
    const message = event.message || {};
    const raw = message.content || payload.content || "";

    if (!raw) return "";

    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        return String(parsed.text || parsed.title || parsed.content || raw || "").trim();
      } catch (_) {
        return String(raw || "").trim();
      }
    }

    if (typeof raw === "object") {
      return String(raw.text || raw.title || raw.content || "").trim();
    }

    return String(raw || "").trim();
  } catch (_) {
    return "";
  }
}

function isFeishuSystemUpgradeRequestText(text) {
  const t = String(text || "").replace(/\s+/g, "");
  return t.includes("执行系统升级阶段") || t.includes("系统升级阶段");
}

function isFeishuWebsiteProductRequestText(text) {
  const t = String(text || "").replace(/\s+/g, "");

  if (!t.startsWith("新需求：") && !t.startsWith("新需求:")) {
    return false;
  }

  if (isFeishuSystemUpgradeRequestText(t)) {
    return false;
  }

  return [
    "网站",
    "首页",
    "页面",
    "功能",
    "产品",
    "搭子",
    "平台",
    "开发",
    "设计",
    "上线",
    "做",
    "搭建",
    "建立",
    "创建",
    "同城"
  ].some((keyword) => t.includes(keyword));
}

function buildProjectDirectorConfirmText(text) {
  const cleanText = String(text || "").replace(/^新需求[:：]\s*/, "").trim();

  return [
    "【项目总管确认】",
    "",
    `我理解你的需求：${cleanText || "你想启动一个网站 / 产品类需求。"}`,
    "",
    "我的建议：先不要直接让 Codex 开工，应该先由项目总管确认目标、范围和第一批任务，避免做偏。",
    "",
    "我建议先这样做：",
    "1. 先确认首页目标用户和核心转化路径。",
    "2. 再生成首页结构、文案、视觉方向和首批开发任务。",
    "3. 你批准后，再进入任务树和分批执行。",
    "",
    "关键问题：",
    "A. 先做 MVP 首页，快速上线验证。",
    "B. 先做完整产品规划，再开始开发。",
    "",
    "请回复：批准建议 / 选 A / 选 B / 补充要求"
  ].join("\n");
}

async function sendProjectDirectorConfirmToFeishu(payload, text) {
  try {
    const messageId =
      payload &&
      payload.event &&
      payload.event.message &&
      payload.event.message.message_id;

    if (!messageId) {
      console.log("[feishu-intake] missing message_id, skip direct reply");
      return false;
    }

    if (typeof getFeishuTenantToken !== "function") {
      console.log("[feishu-intake] getFeishuTenantToken not available, skip direct reply");
      return false;
    }

    const token = await getFeishuTenantToken();

    const response = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          msg_type: "text",
          content: JSON.stringify({
            text: buildProjectDirectorConfirmText(text)
          })
        })
      }
    );

    if (!response.ok) {
      console.error("[feishu-intake] project director reply failed:", response.status);
      return false;
    }

    console.log("[feishu-intake] project director confirm sent");
    return true;
  } catch (error) {
    console.error("[feishu-intake] project director reply error:", error && error.message ? error.message : String(error));
    return false;
  }
}

// This route is intentionally inserted before the existing /feishu/event route.
// If it does not handle the request, it calls next() and lets the old logic continue.
app.post("/feishu/event", express.json({ type: "*/*" }), async (req, res, next) => {
  try {
    if (req.body && req.body.type === "url_verification") {
      return res.json({
        challenge: req.body.challenge
      });
    }

    const text = extractFeishuIntakeText(req.body);

    if (isFeishuWebsiteProductRequestText(text)) {
      console.log("[feishu-intake] website/product request intercepted before hermes_jobs queue");

      sendProjectDirectorConfirmToFeishu(req.body, text).catch((error) => {
        console.error("[feishu-intake] async reply failed:", error && error.message ? error.message : String(error));
      });

      return res.json({
        ok: true,
        routed: "project_director",
        queued: false
      });
    }

    return next();
  } catch (error) {
    console.error("[feishu-intake] guard failed, continue old route:", error && error.message ? error.message : String(error));
    return next();
  }
});
// === PROJECT_DIRECTOR_INTAKE_GUARD_V4 END ===


app.post("/feishu/event", express.json({ type: "*/*" }), (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.type === "url_verification" && body.challenge) {
      return res.status(200).json({ challenge: String(body.challenge) });
    }
    return next();
  } catch (error) {
    return res.status(200).json({
      challenge: req.body && req.body.challenge ? String(req.body.challenge) : "",
    });
  }
});



app.use(express.json({
  limit: "1mb",
}));

function authenticateWorker(req, res, next) {
  const authorization = req.get("authorization") || "";
  const bearerToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  const headerToken = req.get("x-worker-token") || "";
  const suppliedToken = bearerToken || headerToken;

  if (!suppliedToken || suppliedToken !== WORKER_TOKEN) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }

  next();
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "worker-api",
    version: "2.0.0",
  });
});


app.post("/api/deploy/status", async (req, res) => {
  const suppliedSecret = String(
    req.headers["x-deploy-secret"] || ""
  );

  const expectedSecret = String(
    process.env.DEPLOY_CALLBACK_SECRET || ""
  );

  if (
    !expectedSecret ||
    suppliedSecret !== expectedSecret
  ) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }

  const commitSha = String(
    req.body?.commit_sha || ""
  ).trim();

  const rawStatus = String(
    req.body?.status || ""
  ).trim().toLowerCase();

  const deployUrl = String(
    req.body?.deploy_url || ""
  ).trim();

  const environment = String(
    req.body?.environment || ""
  ).trim();

  const description = String(
    req.body?.description || ""
  ).trim();

  if (!commitSha || !rawStatus) {
    return res.status(400).json({
      ok: false,
      error: "commit_sha_and_status_required",
    });
  }

  const statusMap = {
    queued: "pending",
    pending: "pending",
    in_progress: "building",
    success: "ready",
    failure: "failed",
    error: "failed",
    inactive: "canceled",
  };

  const deployStatus =
    statusMap[rawStatus] || rawStatus;

  const allowed = new Set([
    "pending",
    "building",
    "ready",
    "failed",
    "canceled",
  ]);

  if (!allowed.has(deployStatus)) {
    return res.status(400).json({
      ok: false,
      error: "invalid_deploy_status",
      received: rawStatus,
    });
  }

  const now = new Date().toISOString();
  const updateData = {
    deploy_status: deployStatus,
    deploy_url: deployUrl || null,
    deploy_environment: environment || null,
    deploy_description: description || null,
    updated_at: now,
  };

  if (
    deployStatus === "ready" ||
    deployStatus === "failed" ||
    deployStatus === "canceled"
  ) {
    updateData.deployed_at = now;
  }

  const shortSha = commitSha.slice(0, 12);

  const { data, error } = await supabase
    .from("hermes_jobs")
    .update(updateData)
    .or(
      `git_commit_sha.eq.${commitSha},git_commit_sha.like.${shortSha}%`
    )
    .select("id,git_commit_sha,deploy_status,deploy_url");

  if (error) {
    console.error(
      "部署状态回写失败：",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "database_update_failed",
      message: error.message,
    });
  }

  console.log(
    `部署状态回写：${shortSha} -> ${deployStatus}，更新 ${data?.length || 0} 条`
  );

  return res.json({
    ok: true,
    updated: data?.length || 0,
    jobs: data || [],
  });
});


function decodeHermesEscapedValue(value) {
  return String(value == null ? "" : value).replace(/\\n/g, "\n");
}

function parseHermesWorkerContextFromRequestText(requestText) {
  const text = String(requestText || "");
  const fields = {};
  for (const field of ["project_domain", "task_mode", "read_only_mode", "allowed_scope", "forbidden_scope", "original_request_text", "original_request_text_base64", "approved_batch", "route"]) {
    const pattern = new RegExp("^" + field + "\\s*[=:]\\s*([^\\r\\n]*)", "im");
    const match = text.match(pattern);
    if (match) fields[field] = decodeHermesEscapedValue(match[1].trim());
  }
  if (fields.original_request_text_base64) {
    try {
      fields.original_request_text = Buffer.from(fields.original_request_text_base64, "base64").toString("utf8");
    } catch (_) {}
    delete fields.original_request_text_base64;
  }
  if (Object.prototype.hasOwnProperty.call(fields, "read_only_mode")) {
    fields.read_only_mode = /^(true|1|yes|on|是)$/i.test(String(fields.read_only_mode).trim());
  }
  return fields;
}

function gmStabilizeObjectContextFields(value) {
  const parsed = parseWorkerReportObject(value) || (value && typeof value === "object" && !Array.isArray(value) ? value : null);
  if (!parsed) return {};
  const fields = {};
  for (const field of ["project_domain", "task_mode", "read_only_mode", "allowed_scope", "forbidden_scope", "original_request_text", "original_request_text_base64", "approved_batch", "route"]) {
    if (Object.prototype.hasOwnProperty.call(parsed, field)) fields[field] = parsed[field];
  }
  if (fields.original_request_text_base64 && !fields.original_request_text) {
    try {
      fields.original_request_text = Buffer.from(String(fields.original_request_text_base64), "base64").toString("utf8");
    } catch (_) {}
  }
  if (Object.prototype.hasOwnProperty.call(fields, "read_only_mode")) {
    fields.read_only_mode = gmStabilizeReadContextBoolean(fields.read_only_mode);
  }
  return fields;
}

function gmStabilizeFirstContextValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

const RUNTIME_EXECUTION_POLICY_BOOLEAN_FIELDS = [
  "verification_only",
  "worker_only",
  "allow_no_change_success",
  "code_changes_required",
  "codex_required",
  "git_commit_required",
  "git_push_required",
];

function runtimeReadLastContextField(requestText, fieldName) {
  const pattern = new RegExp("^" + fieldName + "\\s*[=:]\\s*([^\\r\\n]*)", "gim");
  let value;
  for (const match of String(requestText || "").matchAll(pattern)) value = match[1].trim();
  return value;
}

function runtimeApplyExplicitExecutionPolicy(payload, requestText) {
  const policy = { ...(payload || {}) };
  for (const fieldName of RUNTIME_EXECUTION_POLICY_BOOLEAN_FIELDS) {
    const explicitValue = runtimeReadLastContextField(requestText, fieldName);
    if (explicitValue !== undefined) {
      const parsed = readRuntimeNullableBoolean(explicitValue);
      if (parsed !== null) policy[fieldName] = parsed;
    }
  }
  const explicitIntent = runtimeReadLastContextField(requestText, "execution_intent");
  if (explicitIntent !== undefined) policy.execution_intent = explicitIntent;

  const verificationOnly = readRuntimeNullableBoolean(policy.verification_only) === true;
  const workerOnly = readRuntimeNullableBoolean(policy.worker_only) === true;
  const explicitCodeChangesRequired = readRuntimeNullableBoolean(policy.code_changes_required);
  const explicitCodexRequired = readRuntimeNullableBoolean(policy.codex_required);
  const explicitGitCommitRequired = readRuntimeNullableBoolean(policy.git_commit_required);
  const explicitGitPushRequired = readRuntimeNullableBoolean(policy.git_push_required);

  if (verificationOnly || workerOnly) {
    policy.code_changes_required = false;
    policy.codex_required = false;
    policy.git_commit_required = false;
  }
  if (verificationOnly) policy.git_push_required = false;

  const codeChangesRequired = readRuntimeNullableBoolean(policy.code_changes_required);
  const codexRequired = readRuntimeNullableBoolean(policy.codex_required);
  const gitCommitRequired = readRuntimeNullableBoolean(policy.git_commit_required);
  const gitPushRequired = readRuntimeNullableBoolean(policy.git_push_required);
  const conflictsWithCodeIntent =
    /^(?:code[_ -]?change[_ -]?required|code[_ -]?changes?[_ -]?required)$/i.test(
      String(policy.execution_intent || "").trim()
    ) &&
    (verificationOnly ||
      workerOnly ||
      explicitCodeChangesRequired === false ||
      explicitCodexRequired === false ||
      explicitGitCommitRequired === false);

  policy.execution_policy_conflict = conflictsWithCodeIntent
    ? "EXPLICIT_FALSE_OVERRIDES_CODE_CHANGE_INTENT"
    : null;
  policy.deterministic_git_operation = Boolean(
    codeChangesRequired === false &&
      codexRequired === false &&
      gitCommitRequired === false &&
      gitPushRequired === true
  );
  return policy;
}

function reconstructWorkerPayloadFromRequestText(job) {
  const existingPayload = job && job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
    ? job.payload
    : {};
  const parsedPayload = parseHermesWorkerContextFromRequestText(job && job.request_text);
  const reconstructed = Object.keys(parsedPayload).length > 0 && Object.keys(existingPayload).length === 0;
  if (Object.keys(parsedPayload).length > 0) {
    job.payload = { ...parsedPayload, ...existingPayload };
  }
  job.payload = runtimeApplyExplicitExecutionPolicy(
    job.payload || existingPayload,
    job && job.request_text
  );
  console.log("payload_reconstructed_from_request_text=" + (reconstructed ? "true" : "false"));
  return job;
}

app.get("/healthz", async (req, res) => {
  const { error } = await supabase
    .from("hermes_jobs")
    .select("id")
    .limit(1);

  if (error) {
    console.error("Supabase health check failed:", error);
    return res.status(503).json({
      ok: false,
      service: "worker-api",
      database: false,
      error: error.message,
    });
  }

  return res.json({
    ok: true,
    service: "worker-api",
    database: true,
  });
});


async function countHermesJobsForDispatch(label, buildQuery) {
  try {
    const query = buildQuery(
      supabase
        .from("hermes_jobs")
        .select("id", { count: "exact", head: true })
    );
    const { count, error } = await query;
    if (error) {
      return { label, count: null, error: error.message };
    }
    return { label, count: Number(count || 0), error: null };
  } catch (error) {
    return { label, count: null, error: error && error.message ? error.message : String(error) };
  }
}

async function logWorkerNextNoJobDiagnostics(workerName) {
  const [eligible, excludedClaimed, running, activeTotal] = await Promise.all([
    countHermesJobsForDispatch("eligible_count", (query) =>
      query.in("status", ["pending", "queued"]).is("claimed_by", null)
    ),
    countHermesJobsForDispatch("excluded_claimed_count", (query) =>
      query.in("status", ["pending", "queued"]).not("claimed_by", "is", null)
    ),
    countHermesJobsForDispatch("running_count", (query) =>
      query.eq("status", "running")
    ),
    countHermesJobsForDispatch("active_status_count", (query) =>
      query.in("status", ["pending", "queued", "running"])
    ),
  ]);

  const diagnostics = {
    worker_name: workerName,
    eligible_count: eligible.count,
    excluded_status_count: running.count,
    excluded_claimed_count: excludedClaimed.count,
    excluded_executor_count: 0,
    active_status_count: activeTotal.count,
  };

  const errors = [eligible, excludedClaimed, running, activeTotal]
    .filter((entry) => entry.error)
    .map((entry) => entry.label + ": " + entry.error);

  if (errors.length > 0) {
    diagnostics.diagnostic_errors = errors;
  }

  console.log("[worker-api] next returned 204", diagnostics);
}

// RUNTIME_CONTRACT_PATCH_WORKER_ATTEMPT_LIFECYCLE_V1
function runtimeCreateWorkerAttemptId(jobId, workerName) {
  return [
    "attempt",
    String(workerName || "worker").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40),
    String(jobId || "job").slice(0, 8),
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 8),
  ].join("-");
}

function runtimeBuildAttemptPayloadForJob(job, attempt) {
  const payload = parseWorkerReportObject(job && job.payload) || {};
  return {
    ...payload,
    attempt_id: attempt.attempt_id,
    active_attempt: {
      ...(parseWorkerReportObject(payload.active_attempt) || {}),
      ...attempt,
    },
  };
}

function runtimeReadAttemptContextFromRequestText(job) {
  const text = String(job && job.request_text || "");
  const marker = text.lastIndexOf("HERMES_WORKER_ATTEMPT_CONTEXT:");
  if (marker < 0) return null;
  const contextText = text.slice(marker);
  const result = {};
  for (const match of contextText.matchAll(/`([^=`\r\n]+)=([^`\r\n]*)`/g)) {
    result[match[1]] = match[2];
  }
  return Object.keys(result).length > 0 ? result : null;
}

async function runtimeUpdateHermesJobWithSchemaFallback(jobId, updateData, buildQuery) {
  let pending = { ...updateData };
  const skipped = [];
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let query = supabase.from("hermes_jobs").update(pending).eq("id", jobId);
    query = buildQuery ? buildQuery(query) : query;
    const { data, error } = await query.select("*").maybeSingle();
    if (!error) return { data, error: null, skipped };
    const missing = parseSupabaseMissingColumnName(error);
    if (!missing || !Object.prototype.hasOwnProperty.call(pending, missing)) return { data: null, error, skipped };
    skipped.push(missing);
    delete pending[missing];
    console.warn("worker_lifecycle_schema_field_skipped", { job_id: jobId, field: missing });
  }
  return { data: null, error: new Error("worker_lifecycle_schema_fallback_exhausted"), skipped };
}

async function runtimePersistCanonicalTransition(job, patch) {
  let query = supabase.from("hermes_jobs").update(patch).eq("id", job.id);
  if (job.updated_at) query = query.eq("updated_at", job.updated_at);
  return query.select("*").maybeSingle();
}

async function runtimeRollbackFailedClaim(jobId, workerName, attemptId) {
  const currentRead = await runtimeFindHermesJob(jobId);
  if (currentRead.error || !currentRead.data) {
    return { ok: false, rollback_applied: false, failure_code: "ROLLBACK_STATE_READ_FAILED" };
  }
  const currentJob = currentRead.data;
  const expectedUpdatedAt = readFinalReportString(currentJob.updated_at);
  const transition = canonicalRollbackFailedClaim(currentJob, {
    job_id: jobId,
    worker_id: workerName,
    attempt_id: attemptId,
    expected_updated_at: expectedUpdatedAt,
    now: new Date().toISOString(),
  });
  if (transition.terminal_report_won || transition.rollback_skipped_reason === "JOB_ALREADY_TERMINAL") {
    return {
      ok: true,
      rollback_applied: false,
      rollback_skipped_reason: "JOB_ALREADY_TERMINAL",
      terminal_report_won: true,
      job: currentJob,
    };
  }
  if (!transition.ok || !transition.patch || !transition.compare_and_set) {
    return {
      ok: false,
      rollback_applied: false,
      failure_code: transition.failure_code || "ROLLBACK_TRANSITION_REJECTED",
      job: currentJob,
    };
  }
  const expected = transition.compare_and_set;
  let query = supabase
    .from("hermes_jobs")
    .update(transition.patch)
    .eq("id", jobId)
    .eq("status", expected.status)
    .eq("claimed_by", workerName)
    .eq("attempt_id", attemptId)
    .eq("active_attempt_id", attemptId);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const rollbackWrite = await query.select("*").maybeSingle();
  if (rollbackWrite.error) {
    return { ok: false, rollback_applied: false, failure_code: "ROLLBACK_COMPARE_AND_SET_FAILED" };
  }
  if (rollbackWrite.data) {
    return {
      ok: true,
      rollback_applied: true,
      rollback_skipped_reason: null,
      terminal_report_won: false,
      job: rollbackWrite.data,
    };
  }

  const raceRead = await runtimeFindHermesJob(jobId);
  if (raceRead.error || !raceRead.data) {
    return { ok: false, rollback_applied: false, failure_code: "ROLLBACK_RACE_READ_FAILED" };
  }
  const racedJob = raceRead.data;
  const racedInspection = canonicalInspectJobState(racedJob);
  if (racedInspection.terminal) {
    return {
      ok: true,
      rollback_applied: false,
      rollback_skipped_reason: "JOB_ALREADY_TERMINAL",
      terminal_report_won: true,
      job: racedJob,
    };
  }
  const racedInvariant = canonicalValidateJobStateInvariant(racedJob);
  if (!racedInvariant.ok) {
    return {
      ok: false,
      rollback_applied: false,
      failure_code: racedInvariant.failure_code || "JOB_STATE_INVARIANT_VIOLATION",
      job: racedJob,
    };
  }
  const racedAttempt = canonicalGetActiveAttempt(racedJob);
  const racedLease = racedInspection.active_lease;
  if (
    racedInspection.claimed_by !== workerName ||
    !racedAttempt || racedAttempt.id !== attemptId ||
    !racedLease || racedLease.attempt_id !== attemptId || racedLease.worker_id !== workerName
  ) {
    return { ok: false, rollback_applied: false, failure_code: "ROLLBACK_OWNERSHIP_CHANGED", job: racedJob };
  }
  if (expectedUpdatedAt && racedJob.updated_at !== expectedUpdatedAt) {
    return { ok: false, rollback_applied: false, failure_code: "ROLLBACK_VERSION_CHANGED", job: racedJob };
  }
  return { ok: false, rollback_applied: false, failure_code: "ROLLBACK_COMPARE_AND_SET_FAILED", job: racedJob };
}

async function runtimeClaimHermesJob(job, workerName) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const attemptId = runtimeCreateWorkerAttemptId(job.id, workerName);
  const canonicalClaim = canonicalClaimJob(job, {
    worker_id: workerName,
    attempt_id: attemptId,
    lease_id: "lease:" + attemptId,
    now,
    expires_at: expiresAt,
  });
  if (!canonicalClaim.ok || !canonicalClaim.patch) {
    const error = new Error("canonical job state rejected claim");
    error.failure_code = canonicalClaim.failure_code || "JOB_NOT_SELECTABLE";
    error.violations = canonicalClaim.violations || [];
    return {
      data: null,
      error,
      attempt_id: attemptId,
      failure_code: error.failure_code,
      violations: error.violations,
    };
  }
  const attempt = {
    ...canonicalClaim.attempt,
    attempt_id: attemptId,
    status: canonicalClaim.attempt.state,
    started_at: canonicalClaim.attempt.started_at || now,
  };
  const updateData = {
    ...canonicalClaim.patch,
    status: "running",
    claimed_by: workerName,
    claimed_at: now,
    attempt_id: attemptId,
    active_attempt_id: attemptId,
    expires_at: expiresAt,
    progress_percent: 0,
    current_step: "waiting_worker_claim",
    status_message: "Worker claimed job",
    payload: runtimeBuildAttemptPayloadForJob(job, attempt),
    updated_at: now,
  };
  const result = await runtimeUpdateHermesJobWithSchemaFallback(job.id, updateData, (query) => {
    let guarded = query.in("status", ["pending", "queued"]);
    if (job.updated_at) guarded = guarded.eq("updated_at", job.updated_at);
    return guarded.or("claimed_by.is.null,claimed_by.eq." + workerName);
  });
  if (!result.data) return { ...result, attempt_id: attemptId };
  const claimedAttemptId = getRuntimeActiveAttemptId(result.data);
  if (claimedAttemptId !== attemptId || !isCanonicalClaimPersisted(result.data, attemptId)) {
    const rollback = await runtimeRollbackFailedClaim(job.id, workerName, attemptId);
    return {
      data: null,
      error: new Error("claim attempt contract was not persisted"),
      skipped: result.skipped,
      attempt_id: attemptId,
      failure_code: "WORKER_ATTEMPT_PERSISTENCE_FAILED",
      rollback,
    };
  }
  return { ...result, attempt_id: attemptId };
}

function runtimeWorkerNameFromRequest(req, body) {
  return String(body && (body.worker_id || body.worker_name) || req.get("x-worker-name") || "local-worker").trim().slice(0, 100);
}

function runtimeAttemptIdFromBody(body) {
  return readFinalReportString(body && (body.attempt_id || body.attemptId));
}

function runtimeBuildAttemptMismatchResponse(job, incomingAttemptId) {
  return {
    ok: false,
    error: "worker_attempt_mismatch",
    failure_code: "WORKER_ATTEMPT_MISMATCH",
    failure_stage: "worker_attempt_validation",
    stale_attempt: true,
    status_unchanged: true,
    diagnostics_persisted: false,
    active_attempt_id: getRuntimeActiveAttemptId(job),
    attempt_id: incomingAttemptId || null,
  };
}

function runtimeOwnsAndMatchesAttempt(job, workerName, attemptId) {
  const claimedBy = readFinalReportString(job && job.claimed_by);
  if (claimedBy && claimedBy !== workerName) {
    return {
      ok: false,
      status: 409,
      body: {
        ok: false,
        error: "running_job_not_found_or_not_owned",
        failure_code: "WORKER_JOB_NOT_OWNED",
        failure_stage: "worker_ownership_validation",
        status_unchanged: true,
        claimed_by: claimedBy,
        worker_id: workerName,
      },
    };
  }
  const activeAttemptId = getRuntimeActiveAttemptId(job);
  if (activeAttemptId && attemptId !== activeAttemptId) {
    return { ok: false, status: 409, body: runtimeBuildAttemptMismatchResponse(job, attemptId) };
  }
  return { ok: true };
}

async function runtimeFindHermesJob(jobId) {
  return supabase.from("hermes_jobs").select("*").eq("id", jobId).maybeSingle();
}

function runtimeGetTerminalJobDescriptor(job) {
  const inspection = canonicalInspectJobState(job);
  if (!inspection.terminal) return null;
  const terminalState = inspection.state;
  return {
    terminalState,
    storageStatus:
      terminalState === "terminal_success"
        ? "succeeded"
        : terminalState === "terminal_cancelled"
          ? "cancelled"
          : "failed",
    status:
      terminalState === "terminal_success"
        ? "succeeded"
        : terminalState === "terminal_cancelled"
          ? "cancelled"
          : "failed",
    closureCode: null,
    source: "canonical_job_state_machine",
  };
}

function runtimeBuildTerminalCleanupFields(job, descriptor, now = new Date().toISOString()) {
  const cleanup = canonicalCleanupTerminalJob({ ...job, status: descriptor.status }, now);
  const fields = cleanup && cleanup.patch ? cleanup.patch : { status: descriptor.status };
  if (descriptor.closureCode) fields.error_text = descriptor.closureCode;
  return Object.fromEntries(
    Object.entries(fields).filter(([field]) => field === "status" || field === "result" || field in job)
  );
}

function runtimeTerminalJobHasRuntimeState(job) {
  const snapshot = canonicalInspectJobState(job);
  const payload = parseWorkerReportObject(job && job.payload) || {};
  return Boolean(
    snapshot.claimed_by || snapshot.active_attempt || snapshot.active_lease ||
      payload.running_job_id ||
      payload.retry_requested === true ||
      payload.retry_pending === true ||
      payload.should_retry === true
  );
}

async function runtimePersistTerminalCleanup(job, descriptor) {
  return runtimeUpdateHermesJobWithSchemaFallback(
    job.id,
    runtimeBuildTerminalCleanupFields(job, descriptor)
  );
}

// RUNTIME_CONTRACT_PATCH_WORKER_STATS_OBSERVABILITY_V1
const RUNTIME_PATCH_WORKER_STATS_PENDING_STATUSES = ["pending", "queued"];
function runtimePatchIsLoopbackWorkerStatsRequest(req) {
  const ip = String((req && (req.ip || req.connection && req.connection.remoteAddress || req.socket && req.socket.remoteAddress)) || "").toLowerCase();
  const host = String(req && typeof req.get === "function" ? req.get("host") || "" : "").toLowerCase().split(":")[0];
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || host === "127.0.0.1" || host === "localhost";
}
function runtimePatchNullWorkerStatsPayload(code) {
  return { ok: false, task_table: "hermes_jobs", worker_status_source: "worker_api", worker_status_healthy: false, worker_status_failure_code: code || "WORKER_STATS_QUERY_FAILED", queued_worker_jobs: null, claimed_worker_jobs: null, running_worker_jobs: null, active_worker_jobs: null, failed_worker_jobs: null, stale_worker_jobs: null, stale_status_healthy: false, stale_status_failure_code: "STALE_RULE_UNAVAILABLE" };
}
function runtimePatchWorkerStatsError(code) { return runtimePatchNullWorkerStatsPayload(code); }
async function runtimePatchCountHermesJobs(label, applyFilters) {
  let query = supabase.from("hermes_jobs").select("id", { count: "exact", head: true });
  query = applyFilters(query);
  const { count, error } = await query;
  if (error) { const message = error && error.message ? String(error.message) : "unknown"; throw new Error("worker_stats_query_failed:" + label + ":" + message); }
  return Number(count || 0);
}
async function runtimePatchBuildWorkerStatsSnapshot() {
  const [queued, claimed, running, active, failed] = await Promise.all([
    runtimePatchCountHermesJobs("queued", (query) => query.in("status", RUNTIME_PATCH_WORKER_STATS_PENDING_STATUSES).is("claimed_by", null)),
    runtimePatchCountHermesJobs("claimed", (query) => query.in("status", RUNTIME_PATCH_WORKER_STATS_PENDING_STATUSES).not("claimed_by", "is", null)),
    runtimePatchCountHermesJobs("running", (query) => query.eq("status", "running")),
    runtimePatchCountHermesJobs("active", (query) => query.in("status", ["pending", "queued", "running"])),
    runtimePatchCountHermesJobs("failed", (query) => query.eq("status", "failed")),
  ]);
  if (active !== queued + claimed + running) throw new Error("worker_stats_active_count_mismatch");
  return { ok: true, task_table: "hermes_jobs", worker_status_source: "worker_api", worker_status_healthy: true, worker_status_failure_code: null, queued_worker_jobs: queued, claimed_worker_jobs: claimed, running_worker_jobs: running, active_worker_jobs: active, failed_worker_jobs: failed, stale_worker_jobs: null, stale_status_healthy: false, stale_status_failure_code: "STALE_RULE_UNAVAILABLE" };
}
app.get("/api/worker/stats", async (req, res) => {
  if (!runtimePatchIsLoopbackWorkerStatsRequest(req)) return res.status(403).json({ ok: false, error: "worker_stats_forbidden", worker_status_healthy: false, worker_status_failure_code: "WORKER_STATS_FORBIDDEN" });
  try { const payload = await runtimePatchBuildWorkerStatsSnapshot(); return res.json(payload); } catch (error) { console.warn("[worker-api] worker stats unavailable", error && error.message ? error.message : error); return res.status(503).json(runtimePatchNullWorkerStatsPayload("WORKER_STATS_QUERY_FAILED")); }
});
app.get("/api/worker/next", authenticateWorker, async (req, res) => {
  const workerName =
    String(req.query.worker_name || req.get("x-worker-name") || "local-worker")
      .trim()
      .slice(0, 100);

  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("*")
    .in("status", ["pending", "queued"])
    .is("claimed_by", null)
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    console.error("Claim job failed:", error);
    return res.status(500).json({
      ok: false,
      error: "claim_failed",
      message: error.message,
    });
  }

  let job = null;
  for (const queuedJob of Array.isArray(data) ? data : []) {
    const terminalDescriptor = runtimeGetTerminalJobDescriptor(queuedJob);
    const invariant = canonicalValidateJobStateInvariant(queuedJob);
    if (!invariant.ok) {
      console.warn("[worker-api] canonical job invariant violation", {
        job_id: queuedJob.id,
        failure_code: invariant.failure_code,
        violated_invariants: invariant.violations.map((item) => item.code),
      });
      continue;
    }
    if (!terminalDescriptor && canonicalIsJobSelectable(queuedJob)) {
      job = queuedJob;
      break;
    }
    if (!terminalDescriptor) continue;
    const cleanup = await runtimePersistTerminalCleanup(queuedJob, terminalDescriptor);
    if (cleanup.error) {
      return res.status(500).json({
        ok: false,
        error: "terminal_job_cleanup_failed",
        failure_code: "TERMINAL_JOB_CLEANUP_FAILED",
        failure_stage: "eligibility_terminal_cleanup",
        worker_next_returned: false,
      });
    }
  }

  if (!job) {
    await logWorkerNextNoJobDiagnostics(workerName);
    return res.status(204).send();
  }

  const { data: persistedJob, error: preClaimError } = await runtimeFindHermesJob(job.id);
  if (preClaimError) {
    return res.status(500).json({ ok: false, error: "pre_claim_terminal_check_failed" });
  }
  const preClaimTerminal = runtimeGetTerminalJobDescriptor(persistedJob || job);
  if (preClaimTerminal) {
    const cleanup = await runtimePersistTerminalCleanup(persistedJob || job, preClaimTerminal);
    if (cleanup.error) {
      return res.status(500).json({
        ok: false,
        error: "terminal_job_cleanup_failed",
        failure_code: "TERMINAL_JOB_CLEANUP_FAILED",
        failure_stage: "pre_claim_terminal_cleanup",
        worker_next_returned: false,
      });
    }
    console.warn("[worker-api] claimed terminal job suppressed", {
      job_id: job.id,
      status: preClaimTerminal.status,
      finished_at: job.finished_at || job.completed_at || job.reported_at || null,
    });
    return res.status(204).send();
  }

  const preClaimInvariant = canonicalValidateJobStateInvariant(persistedJob || job);
  if (!preClaimInvariant.ok || !canonicalIsJobSelectable(persistedJob || job)) {
    return res.status(409).json({
      ok: false,
      error: "job_state_invariant_violation",
      failure_code: preClaimInvariant.failure_code || "JOB_NOT_SELECTABLE",
      failure_stage: "worker_claim",
      violated_invariants: preClaimInvariant.violations.map((item) => item.code),
      worker_next_returned: false,
    });
  }

  const claimResult = await runtimeClaimHermesJob(persistedJob || job, workerName);
  if (claimResult.error) {
    console.error("Claim job failed:", claimResult.error);
    return res.status(500).json({
      ok: false,
      error: "claim_failed",
      failure_code: claimResult.failure_code || "WORKER_CLAIM_FAILED",
      failure_stage: "worker_claim",
      message: claimResult.error.message,
      violated_invariants: claimResult.violations || [],
    });
  }
  if (!claimResult.data) {
    await logWorkerNextNoJobDiagnostics(workerName);
    return res.status(204).send();
  }

  const { data: persistedClaim, error: postClaimError } = await runtimeFindHermesJob(job.id);
  if (postClaimError) {
    return res.status(500).json({ ok: false, error: "post_claim_terminal_check_failed" });
  }
  const postClaimTerminal = runtimeGetTerminalJobDescriptor(persistedClaim || claimResult.data);
  if (postClaimTerminal) {
    const cleanup = await runtimePersistTerminalCleanup(
      persistedClaim || claimResult.data,
      postClaimTerminal
    );
    if (cleanup.error) {
      return res.status(500).json({
        ok: false,
        error: "terminal_job_cleanup_failed",
        failure_code: "TERMINAL_JOB_CLEANUP_FAILED",
        failure_stage: "post_claim_terminal_cleanup",
        worker_next_returned: false,
        execution_aborted: true,
        codex_called: false,
        git_mutation_executed: false,
      });
    }
    return res.status(204).send();
  }

  console.log(`任务已领取: ${(persistedClaim || claimResult.data).id} by ${workerName}`);
  const workerJob = reconstructWorkerPayloadFromRequestText(persistedClaim || claimResult.data);

  return res.json({
    ok: true,
    job: workerJob,
    attempt_id: claimResult.attempt_id,
    project_director: {
      attempt_id: claimResult.attempt_id,
      attempt_contract: "echo this attempt_id in heartbeat, progress, and report; mismatches are rejected",
    },
  });
});


app.post("/api/worker/heartbeat", authenticateWorker, async (req, res) => {
  const jobId = String(req.body?.job_id || req.body?.id || "").trim();
  const workerName = runtimeWorkerNameFromRequest(req, req.body || {});
  const attemptId = runtimeAttemptIdFromBody(req.body || {});

  if (!jobId) {
    return res.status(400).json({
      ok: false,
      error: "job_id_required",
    });
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { data: existingJob, error: findError } = await runtimeFindHermesJob(jobId);
  if (findError) {
    console.error("Heartbeat lookup failed:", findError);
    return res.status(500).json({ ok: false, error: "heartbeat_lookup_failed", message: findError.message });
  }
  if (!existingJob) {
    return res.status(404).json({
      ok: false,
      error: "running_job_not_found",
      failure_code: "RUNNING_JOB_NOT_FOUND",
      failure_stage: "worker_heartbeat",
      attempt_id: attemptId,
    });
  }
  const transition = canonicalApplyHeartbeat(existingJob, {
    worker_id: workerName,
    attempt_id: attemptId,
    now,
    expires_at: expiresAt,
    status_message: req.body?.status_message,
  });
  if (transition.terminal) {
    return res.json({
      ok: true,
      job: existingJob,
      attempt_id: attemptId,
      idempotent: true,
      terminal_heartbeat_is_noop: true,
    });
  }
  if (!transition.ok || !transition.patch) {
    return res.status(409).json({
      ok: false,
      error: "canonical_heartbeat_rejected",
      failure_code: transition.failure_code,
      failure_stage: transition.failure_stage,
      violated_invariants: transition.violations || [],
    });
  }
  const { data, error } = await runtimePersistCanonicalTransition(existingJob, transition.patch);

  if (error) {
    console.error("Heartbeat failed:", error);

    return res.status(500).json({
      ok: false,
      error: "heartbeat_failed",
      message: error.message,
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      error: "running_job_not_found",
      failure_code: "CANONICAL_HEARTBEAT_RACE_LOST",
      failure_stage: "worker_heartbeat",
    });
  }

  return res.json({
    ok: true,
    job: data,
    attempt_id: attemptId,
  });
});


app.post("/api/worker/progress", authenticateWorker, async (req, res) => {
  const {
    id,
    job_id,
    progress_percent,
    current_step,
    status_message,
  } = req.body || {};

  const jobId = String(id || job_id || "").trim();
  const progressPercent = Number(progress_percent);
  const currentStep = String(current_step || "").trim();
  const statusMessage = String(status_message || "").trim();

  const workerName =
    runtimeWorkerNameFromRequest(req, req.body || {});
  const attemptId = runtimeAttemptIdFromBody(req.body || {});

  if (!jobId) {
    return res.status(400).json({
      ok: false,
      error: "job_id_required",
    });
  }

  if (
    !Number.isInteger(progressPercent) ||
    progressPercent < 0 ||
    progressPercent > 100
  ) {
    return res.status(400).json({
      ok: false,
      error: "invalid_progress_percent",
      allowed: "integer from 0 to 100",
    });
  }

  if (!currentStep) {
    return res.status(400).json({
      ok: false,
      error: "current_step_required",
    });
  }

  const now = new Date().toISOString();
  const { data: existingJob, error: findError } = await runtimeFindHermesJob(jobId);
  if (findError) {
    console.error("Progress lookup failed:", findError);
    return res.status(500).json({ ok: false, error: "progress_lookup_failed", message: findError.message });
  }
  if (!existingJob) {
    return res.status(404).json({
      ok: false,
      error: "running_job_not_found_or_not_owned",
      failure_code: "RUNNING_JOB_NOT_FOUND",
      failure_stage: "worker_progress",
      attempt_id: attemptId,
    });
  }
  const transition = canonicalApplyProgress(existingJob, {
    worker_id: workerName,
    attempt_id: attemptId,
    now,
    progress_percent: progressPercent,
    current_step: currentStep.slice(0, 500),
    status_message: statusMessage
      ? statusMessage.slice(0, 2000)
      : null,
  });
  if (transition.terminal) {
    return res.json({
      ok: true,
      job: existingJob,
      attempt_id: attemptId,
      idempotent: true,
      terminal_progress_is_noop: true,
    });
  }
  if (!transition.ok || !transition.patch) {
    return res.status(409).json({
      ok: false,
      error: "canonical_progress_rejected",
      failure_code: transition.failure_code,
      failure_stage: transition.failure_stage,
      violated_invariants: transition.violations || [],
    });
  }
  const { data, error } = await runtimePersistCanonicalTransition(existingJob, transition.patch);

  if (error) {
    console.error("Progress update failed:", error);

    return res.status(500).json({
      ok: false,
      error: "progress_update_failed",
      message: error.message,
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      error: "running_job_not_found_or_not_owned",
    });
  }

  if (progressPercent >= 100 || /完成|失败|final|report/i.test(currentStep)) {
    await syncWorkerJobToFeishu(jobId, {
      status: "running",
      workflow_stage: "execution",
      progress_percent: progressPercent,
      current_step: currentStep,
      status_message: statusMessage,
      updated_at: now,
    }, "reason=progress");
  }

  console.log("任务进度更新", {
    job_id: jobId,
    worker_name: workerName,
    progress_percent: progressPercent,
    current_step: currentStep,
  });

  return res.json({
    ok: true,
    job: data,
    attempt_id: attemptId,
  });
});

const NO_FIX_APPLIED = "NO_FIX_APPLIED";
const READ_ONLY_MODE_VIOLATION = "READ_ONLY_MODE_VIOLATION";
const OUT_OF_SCOPE_BUSINESS_CHANGE = "OUT_OF_SCOPE_BUSINESS_CHANGE";
const TASK_MODE_MISMATCH = "TASK_MODE_MISMATCH";
const MISSING_REQUIRED_DOCS = "MISSING_REQUIRED_DOCS";
const INSUFFICIENT_DOC_OUTPUT = "INSUFFICIENT_DOC_OUTPUT";

function normalizeWorkerReportFiles(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim().replace(/\\/g, "/"))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/[\r\n,]+/g)
      .map((item) => item.trim().replace(/\\/g, "/"))
      .filter(Boolean);
  }

  return [];
}

function workerTaskRequiresFileChange(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  if (/只读|不得修改|禁止修改任何文件|不修改任何文件|read[- ]?only|no file changes/i.test(value)) {
    return false;
  }

  return /修复|新增|更新|补齐|建立|修改|改动|实现|fix|add|update|modify|change|create|implement/i.test(value);
}

function extractWorkerRequiredChangePaths(text) {
  const value = String(text || "");
  const matches = value.match(
    /\b(?:src|infra|docs|app|lib|types|public|scripts|tests?|\.github|prisma|supabase)\/[A-Za-z0-9._/@+\-]+/g
  );

  return Array.from(new Set(
    (matches || [])
      .map((item) => item.replace(/\\/g, "/").replace(/^\/+/, ""))
      .filter((item) => item.includes("."))
  ));
}

function changedFilesIncludeRequiredPath(changedFiles, requiredPaths) {
  if (requiredPaths.length === 0) return true;
  const changed = changedFiles.map((item) => item.toLowerCase());

  return requiredPaths.some((requiredPath) => {
    const required = requiredPath.toLowerCase();
    return changed.some((file) => file === required || file.endsWith(`/${required}`));
  });
}

function readWorkerReportBoolean(value) {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return /^(true|1|yes|on)$/i.test(value.trim());
  return false;
}

function readRuntimeNullableBoolean(value) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (/^(true|1|yes|on)$/.test(text)) return true;
  if (/^(false|0|no|off)$/.test(text)) return false;
  return null;
}

function hasRuntimeReportValue(body, fieldName) {
  const value = readRuntimeReportField(body, fieldName);
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

function validateRuntimeCanonicalWorkerReportSchema(body) {
  const report = parseWorkerReportObject(body && body.result);
  const receivedVersion = readRuntimeReportField(body || {}, "report_schema_version");
  const versionText = String(receivedVersion || "").trim();
  if (!versionText) return { ok: true, canonical_schema_present: false };
  const missing = [];
  const invalid = [];
  if (Number(versionText) !== RUNTIME_CANONICAL_WORKER_REPORT_SCHEMA_VERSION) {
    invalid.push("report_schema_version");
  }
  for (const field of RUNTIME_CANONICAL_WORKER_REPORT_REQUIRED_FIELDS) {
    let present = hasRuntimeReportValue(body || {}, field);
    if (field === "job_id") present = present || hasRuntimeReportValue(body || {}, "id");
    if (field === "worker_instance_id") {
      present = present || hasRuntimeReportValue(body || {}, "worker_id") || hasRuntimeReportValue(body || {}, "worker_name");
    }
    if (field === "batch_code") present = present || hasRuntimeReportValue(body || {}, "approved_batch");
    if (!present) missing.push(field);
  }
  for (const field of ["verification_only", "allow_no_change_success", "code_changes_required", "codex_required", "git_commit_required", "git_push_required", "worker_git_push", "git_push", "remote_contains_commit", "repository_clean_after_push", "terminal_state_persisted", "post_completion_state_applied", "next_stage_allowed"]) {
    const value = readRuntimeReportField(body || {}, field);
    if (value !== undefined && value !== null && String(value).trim() !== "" && readRuntimeNullableBoolean(value) === null) {
      invalid.push(field);
    }
  }
  if (missing.length > 0 || invalid.length > 0) {
    return {
      ok: false,
      failure_code: "WORKER_REPORT_SCHEMA_INVALID",
      failure_stage: "worker_report_validation",
      missing_fields: missing,
      invalid_fields: invalid,
      received_schema_version: versionText || null,
      supported_schema_versions: [RUNTIME_CANONICAL_WORKER_REPORT_SCHEMA_VERSION],
      worker_report_schema_fallback_exhausted: false,
      result_keys: report && typeof report === "object" ? Object.keys(report).sort() : [],
    };
  }
  return {
    ok: true,
    canonical_schema_present: true,
    received_schema_version: Number(versionText),
  };
}

function parseWorkerReportObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

function workerReportDeclaresReadOnly(text) {
  return /read[_ -]?only(?:[_ -]?mode)?\s*(?::|=)?\s*(?:true|1|yes|on)?|只读模式|本任务只读|只读执行|只读检查|只读诊断|只读验证|不修改(?:任何)?(?:文件|代码|仓库|项目)?|禁止修改(?:任何)?(?:文件|代码|仓库|项目)?|禁止\s*(?:执行\s*)?(?:git\s+)?(?:add|commit|push)\b/i.test(String(text || ""));
}

function workerReportGithubPushSucceeded(value) {
  const text = String(value || "").trim();
  return /^(success|succeeded|pushed)$/i.test(text) || /已推送|推送成功|push success/i.test(text);
}

function getWorkerReportCommitSha(body) {
  return String(body && (body.git_commit_sha || body.commit_sha || body.gitCommitSha) || "").trim();
}

function workerReportDeclaresCommitted(value) {
  return readWorkerReportBoolean(value) || /^(committed|commit|yes|true|1|是)$/i.test(String(value || "").trim());
}

function workerReportHasSuccessfulWrite(body) {
  const commitSha = getWorkerReportCommitSha(body);
  const changedFiles = getWorkerReportChangedFiles(body);
  const pushStatus = String(body && (body.github_push_status || body.push_status || body.pushStatus || body.pushed) || "").trim();
  const deployStatus = String(body && (body.deploy_status || body.deployStatus) || "").trim();
  const committed = workerReportDeclaresCommitted(body && (body.committed || body.git_committed || body.gitCommitted)) || Boolean(commitSha);
  const pushed = readWorkerReportBoolean(body && body.pushed)
    || workerReportGithubPushSucceeded(pushStatus)
    || /origin\/master|push(?:ed)?\s*[:=]\s*(?:true|yes|success|succeeded)|pushed/i.test(pushStatus)
    || /^(pending|success|succeeded)$/i.test(deployStatus);

  return changedFiles.length > 0 && committed && pushed;
}

function getWorkerReportChangedFiles(body) {
  return getRuntimeChangedFilesStrict(body);
}

function getWorkerReportUncommittedFiles(body) {
  const result = parseWorkerReportObject(body && body.result);
  return Array.from(new Set([
    ...normalizeWorkerReportFiles(body && body.uncommitted_files),
    ...normalizeWorkerReportFiles(body && body.uncommittedFiles),
    ...normalizeWorkerReportFiles(body && body.modified_files),
    ...normalizeWorkerReportFiles(body && body.modifiedFiles),
    ...normalizeWorkerReportFiles(result && result.uncommitted_files),
    ...normalizeWorkerReportFiles(result && result.uncommittedFiles),
    ...normalizeWorkerReportFiles(result && result.modified_files),
    ...normalizeWorkerReportFiles(result && result.modifiedFiles),
  ]));
}

function getWorkerReportWriteSideEffectFiles(body) {
  return Array.from(new Set([
    ...getWorkerReportChangedFiles(body),
    ...getWorkerReportUncommittedFiles(body),
  ]));
}

function workerReportIsReadOnly(job, body) {
  const result = parseWorkerReportObject(body && body.result);
  const flags = [
    body && body.read_only_mode,
    body && body.readOnlyMode,
    body && body.read_only,
    result && result.read_only_mode,
    result && result.readOnlyMode,
  ];

  if (flags.some(readWorkerReportBoolean)) return true;

  return workerReportDeclaresReadOnly([
    job && job.request_text,
    body && body.request_text,
    body && body.title,
    body && body.result_text,
    body && body.output,
  ].filter(Boolean).join("\n"));
}

function buildReadOnlyModeDecision(finalStatus, job, body) {
  if (finalStatus !== "succeeded") {
    return { status: finalStatus, errorText: null, code: null };
  }

  if (!workerReportIsReadOnly(job, body)) {
    return { status: finalStatus, errorText: null, code: null };
  }

  const commitSha = getWorkerReportCommitSha(body);
  const changedFiles = getWorkerReportChangedFiles(body);
  const githubPushStatus = String(body && body.github_push_status || "").trim();
  const pushed = workerReportGithubPushSucceeded(githubPushStatus);

  if (!commitSha && changedFiles.length === 0 && !pushed) {
    return { status: finalStatus, errorText: null, code: null };
  }

  return {
    status: "failed",
    code: READ_ONLY_MODE_VIOLATION,
    errorText: [
      READ_ONLY_MODE_VIOLATION + ": read_only_mode=true report claimed succeeded but contained git side effects",
      "Worker execution: succeeded",
      "Worker execution status: succeeded_until_read_only_validation",
      "Task goal: failed_read_only_mode_violation",
      "Task goal status: failed_read_only_mode_violation",
      "Read-only violation: yes",
      "No-op run: no",
      "Committed: " + (commitSha ? "yes" : "no"),
      "Pushed: " + (pushed ? "yes" : "no"),
      "git_commit_sha: " + (commitSha || "none"),
      "github_push_status: " + (githubPushStatus || "none"),
      "changed_files:",
      ...(changedFiles.length ? changedFiles.map((file) => "- " + file) : ["- none"]),
    ].join("\n"),
  };
}
// 修复目标4-7：BATCH 任务识别与分类
const BATCH_CODE_PATTERN = /BATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*/g;
const FORBIDDEN_BATCH_PREFIX = /禁止\s*BATCH-/i;

function extractBatchNo(text) {
  if (!text) return null;
  // 修复目标7：禁止从"禁止 BATCH-P3 / BATCH-P4"提取当前批次
  // 先移除所有"禁止 BATCH-xxx"片段，再从剩余文本中提取
  const cleaned = text.replace(/禁止\s*BATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*/gi, "");
  const matches = cleaned.match(BATCH_CODE_PATTERN);
  return matches ? matches[0] : null;
}

function classifyBatchTask(batchNo, requestText) {
  if (!batchNo) return null;

  const upperBatch = batchNo.toUpperCase();

  // 修复目标6：BATCH-43 只读验证任务 → read_only_mode=true
  if (upperBatch === "BATCH-43") {
    return {
      domain: "read_only_verification",
      readOnlyMode: true,
      allowWrite: false,
      description: "BATCH-43: 只读验证任务",
    };
  }

  // 修复目标4：BATCH-44 系统修复任务 → automation_system_write_allowed
  if (upperBatch === "BATCH-44") {
    return {
      domain: "automation_system_write_allowed",
      readOnlyMode: false,
      allowWrite: true,
      description: "BATCH-44: 系统修复任务（允许写入）",
    };
  }

  // 修复目标5：BATCH-37-FIX 文档整理任务 → docs_write_allowed
  if (upperBatch === "BATCH-37-FIX" || upperBatch.startsWith("BATCH-37-FIX")) {
    return {
      domain: "docs_write_allowed",
      readOnlyMode: false,
      allowWrite: true,
      description: "BATCH-37-FIX: 文档整理任务（允许写入）",
    };
  }

  // 其他 BATCH 任务默认行为
  return {
    domain: "generic_batch",
    readOnlyMode: false,
    allowWrite: true,
    description: `${batchNo}: 通用批次任务`,
  };
}

function buildNoFixAppliedDecision(finalStatus, job, body) {
  if (finalStatus !== "succeeded") {
    return { status: finalStatus, errorText: null };
  }

  const requestText = [
    job && job.request_text,
    body && body.request_text,
    body && body.title,
  ].filter(Boolean).join("\n");

  if (workerReportHasSuccessfulWrite(body)) {
    return { status: finalStatus, errorText: null, code: null };
  }

  // 修复目标2：检测 result_text 中的 NO_FIX_APPLIED 标记
  const resultText = String(body && body.result_text || "");
  const noFixAppliedInResult = /NO_FIX_APPLIED\s*是否触发[：:]\s*是/i.test(resultText);

  if (noFixAppliedInResult && !workerReportHasSuccessfulWrite(body)) {
    return {
      status: "failed",
      code: NO_FIX_APPLIED,
      errorText: [
        `${NO_FIX_APPLIED}: result_text indicates no fix was applied`,
        "Worker execution: succeeded",
        "Worker execution status: succeeded_until_task_goal_validation",
        "Task goal: failed_no_fix_applied",
        "Task goal status: failed_no_fix_applied",
        "Read-only violation: no",
        "No-op run: yes",
        "Committed: no",
        "Pushed: no",
      ].join("\n"),
    };
  }

  if (!workerTaskRequiresFileChange(requestText)) {
    return { status: finalStatus, errorText: null };
  }

  const commitSha = String(body && body.git_commit_sha || "").trim();
  const changedFiles = normalizeWorkerReportFiles(body && body.files_changed);
  const requiredPaths = extractWorkerRequiredChangePaths(requestText);
  const touchedRequiredPath = changedFilesIncludeRequiredPath(changedFiles, requiredPaths);
  const noReportedFix = !commitSha && changedFiles.length === 0;
  const missedSpecifiedPath = requiredPaths.length > 0 && changedFiles.length > 0 && !touchedRequiredPath;

  if (!noReportedFix && !missedSpecifiedPath) {
    return { status: finalStatus, errorText: null };
  }

  const detail = missedSpecifiedPath
    ? `specified file not changed; required=${requiredPaths.join(", ")}; changed=${changedFiles.join(", ") || "none"}`
    : "mutation task reported succeeded without git_commit_sha or changed files";

  return {
    status: "failed",
    code: NO_FIX_APPLIED,
    errorText: [
      `${NO_FIX_APPLIED}: ${detail}`,
      "Worker execution: succeeded",
      "Worker execution status: succeeded_until_task_goal_validation",
      "Task goal: failed_no_fix_applied",
      "Task goal status: failed_no_fix_applied",
      "Read-only violation: no",
      "No-op run: yes",
      "Committed: no",
      "Pushed: no",
    ].join("\n"),
  };
}



function gmStabilizeReadBoolean(value) {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return /^(true|1|yes|on|是)$/i.test(value.trim());
  return false;
}

function gmStabilizeReportText(job, body) {
  const result = parseWorkerReportObject(body && body.result);
  return [
    job && job.request_text,
    body && body.request_text,
    body && body.title,
    body && body.result_text,
    body && body.output,
    body && body.error_text,
    body && body.task_goal_status,
    body && body.validation_results,
    result && result.result_text,
    result && result.output,
    result && result.error_text,
    result && result.task_goal_status,
  ].map((item) => Array.isArray(item) ? item.join("\n") : String(item || "")).join("\n");
}

function gmStabilizeTaskRequiresChange(text) {
  return /修复|新增|更新|补齐|建立|修改|改动|创建|写入|补充|fix|repair|add|create|update|modify|patch|implement/i.test(String(text || ""));
}

function gmStabilizeFullBodyText(job, body) {
  let bodyText = "";
  try {
    bodyText = JSON.stringify(body || {});
  } catch (_) {
    bodyText = String(body || "");
  }
  return [job && job.request_text, gmStabilizeReportText(job, body), bodyText].map((item) => String(item || "")).join("\n");
}

function gmStabilizeTextDeclaresReadOnlyFalse(text) {
  return /read[_ -]?only[_ -]?mode\s*[:=]\s*(false|0|no|off)\b|read_only_mode=false/i.test(String(text || ""));
}

function gmStabilizeArchReportTexts(body) {
  const result = parseWorkerReportObject(body && body.result);
  return [
    body && body.result_text,
    body && body.output,
    result && result.result_text,
    result && result.output,
  ].map((item) => Array.isArray(item) ? item.join("\n") : String(item || "")).filter(Boolean);
}

function gmStabilizeParseArchReportFields(body) {
  const fields = {};
  for (const text of gmStabilizeArchReportTexts(body)) {
    const markerIndex = text.indexOf("ARCH_REPORT_FIELDS:");
    if (markerIndex < 0) continue;
    const section = text.slice(markerIndex + "ARCH_REPORT_FIELDS:".length);
    for (const line of section.split(/\r?\n/g)) {
      const match = line.match(/^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*(.*?)\s*$/);
      if (!match) continue;
      fields[match[1].toLowerCase()] = match[2].trim().toLowerCase();
    }
  }
  return fields;
}

function gmStabilizeArchFieldIsFalse(fields, key) {
  return /^(false|no|0|否)$/.test(String(fields && fields[key] || "").trim().toLowerCase());
}

function gmStabilizeArchReportSucceeded(fields) {
  if (!fields || Object.keys(fields).length === 0) return false;
  const finalStatus = String(fields.final_report_status || "").trim().toLowerCase();
  const failureCode = String(fields.failure_code_if_incomplete || "none").trim().toLowerCase();
  return finalStatus === "succeeded"
    && gmStabilizeArchFieldIsFalse(fields, "no_fix_applied")
    && gmStabilizeArchFieldIsFalse(fields, "read_only_violation")
    && gmStabilizeArchFieldIsFalse(fields, "task_mode_mismatch")
    && gmStabilizeArchFieldIsFalse(fields, "out_of_scope_business_change")
    && gmStabilizeArchFieldIsFalse(fields, "context_missing_warning")
    && (failureCode === "none" || failureCode === "" || finalStatus === "succeeded");
}

function gmStabilizeStructuredReportFields(body) {
  return {
    ...gmStabilizeParseArchReportFields(body),
    ...parseWorkerReportObject(body && body.result) || {},
  };
}

function gmStabilizeStructuredFalse(fields, key) {
  return /^(false|no|0|否)$/.test(String((fields && fields[key]) ?? "").trim().toLowerCase());
}

function gmStabilizeStructuredSucceeded(body) {
  const fields = gmStabilizeStructuredReportFields(body);
  if (!fields || Object.keys(fields).length === 0) return false;
  const finalReportStatus = String(fields.final_report_status || fields.task_goal_status || "").trim().toLowerCase();
  const contextFailed = String(fields.context_reconstruct_failed || "").trim().toLowerCase();
  return finalReportStatus === "succeeded"
    && gmStabilizeStructuredFalse(fields, "no_fix_applied")
    && gmStabilizeStructuredFalse(fields, "read_only_violation")
    && gmStabilizeStructuredFalse(fields, "task_mode_mismatch")
    && gmStabilizeStructuredFalse(fields, "out_of_scope_business_change")
    && (contextFailed === "" || gmStabilizeStructuredFalse(fields, "context_reconstruct_failed"));
}

function gmStabilizeWorkerErrorCode(body) {
  const result = parseWorkerReportObject(body && body.result);
  return String(
    body && (body.error_code || body.errorCode || body.failure_code) ||
    result && (result.error_code || result.errorCode || result.failure_code) ||
    ""
  ).trim().toUpperCase();
}

function gmStabilizeShouldTrustArchReadOnlyReport(finalReportContext, body, taskMode, changedFiles) {
  const fields = gmStabilizeParseArchReportFields(body);
  const projectDomain = String(
    finalReportContext && finalReportContext.projectDomain ||
    body && (body.project_domain || body.projectDomain) ||
    ""
  ).trim().toLowerCase();
  const reportedTaskMode = String(body && (body.task_mode || body.taskMode) || "").trim().toLowerCase();
  const readOnlyMode = taskMode === "read_only"
    || reportedTaskMode === "read_only"
    || gmStabilizeReadBoolean(body && (body.read_only_mode || body.readOnlyMode));

  return projectDomain === "automation_architecture"
    && readOnlyMode
    && Array.isArray(changedFiles)
    && changedFiles.length === 0
    && gmStabilizeArchReportSucceeded(fields);
}

function gmStabilizeHasTaskModeMismatch(job, body, taskMode) {
  if (gmStabilizeStructuredSucceeded(body)) return false;
  const errorCode = gmStabilizeWorkerErrorCode(body);
  if (errorCode === TASK_MODE_MISMATCH) return true;
  if (taskMode !== "docs_write_allowed") return false;
  const bodyReadOnly = gmStabilizeReadBoolean(body && (body.read_only_mode || body.readOnlyMode));
  return bodyReadOnly && !gmStabilizeTextDeclaresReadOnlyFalse(gmStabilizeFullBodyText(job, body));
}

function gmStabilizeHasRequiredDocsFailure(job, body) {
  const text = gmStabilizeFullBodyText(job, body);
  if (/MISSING_REQUIRED_DOCS|missing_required_docs\s*[:=]\s*(?!none\b)[^\n\r,}]+/i.test(text)) return MISSING_REQUIRED_DOCS;
  if (/INSUFFICIENT_DOC_OUTPUT|insufficient_doc_output\s*[:=]\s*(yes|true)/i.test(text)) return INSUFFICIENT_DOC_OUTPUT;
  return null;
}

function gmStabilizeScopeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[\r\n,]+/g).map((item) => item.trim()).filter(Boolean);
  return [];
}

function gmStabilizeWriteModeDowngradeFailure(finalReportContext, taskMode, body) {
  const requestedMode = String(finalReportContext && finalReportContext.requestedMode || "").toLowerCase();
  const finalMode = String(finalReportContext && finalReportContext.finalMode || "").toLowerCase();
  const route = String(finalReportContext && finalReportContext.route || "").toLowerCase();
  const text = gmStabilizeFullBodyText(null, body);
  const expectedWrite = requestedMode === "write_allowed"
    || finalMode === "write_allowed"
    || taskMode === "automation_system_write_allowed";
  if (!expectedWrite) return null;
  const exactScope = gmStabilizeScopeList(finalReportContext && finalReportContext.exactAllowedScope);
  const readOnlyExecution = taskMode === "read_only"
    || finalMode === "read_only"
    || route === "approval_only"
    || /read_only_mode\s*[:=]\s*true|allowed_scope\s*[:=]\s*git status\s*\/\s*git diff only|只读任务锁死|只执行\s*git\s*status|只执行\s*git\s*diff/i.test(text);
  if (readOnlyExecution || exactScope.length === 0) {
    return {
      code: TASK_MODE_MISMATCH,
      failureCode: "APPROVAL_CONTEXT_MODE_MISMATCH",
      errorText: "APPROVAL_CONTEXT_MODE_MISMATCH: write_allowed approval was rehydrated as read_only/approval_only or lost exact_allowed_scope.",
    };
  }
  return null;
}

function gmStabilizeLifecycleFailure(body) {
  const text = gmStabilizeFullBodyText(null, body);
  if (/running_job_not_found_or_not_owned|running_job_not_found|WORKER_ATTEMPT_MISMATCH|worker_attempt_mismatch/i.test(text)) {
    return {
      code: "WORKER_ATTEMPT_LIFECYCLE_FAILED",
      errorText: "WORKER_ATTEMPT_LIFECYCLE_FAILED: heartbeat/progress ownership failed before terminal report; terminal success is not trusted.",
    };
  }
  return null;
}

const GM_FAILURE_MEMORY_FILE = "/home/ubuntu/city-partner-agent/runtime_failure_memory.json";
const GM_FAILURE_GUARDS = {
  QA_TASK_MODE_MISMATCH: "BATCH-QA-* must remain qa_review/read_only, not automation_system_write_allowed.",
  DOCS_INSUFFICIENT_OUTPUT: "BATCH-37-DOCS-* must produce all required docs, not only feishu-gm-automation.md.",
  READ_ONLY_LOCKED_DOCS: "docs_write_allowed must not be locked by read_only_mode=true.",
  PATH_PARSE_FIRST_CHAR_LOSS: "Preserve full git status paths without dropping the first character.",
  FALSE_SUCCEEDED: "Do not accept succeeded when task_goal_status is incomplete or failed.",
  BATCH_FIX_PRODUCT_MISROUTED_TO_AUTOMATION: "BATCH-FIX product repair must stay city_partner_product/product_write_allowed.",
  BATCH_FIX_PRODUCT_MISCLASSIFIED_AS_AUTOMATION_SYSTEM: "BATCH-FIX product repair was classified as automation_system during the new-demand classification stage.",
  EXPLICIT_TASK_MODE_OVERRIDDEN: "Explicit boss task_mode/project_domain/read_only_mode fields must not be overwritten by routing inference or historical job fields.",
  PRODUCT_WRITE_PROMPT_POLLUTED_BY_READ_ONLY_LOCK: "product_write_allowed must clear read_only lock residue before prompting Codex.",
  ORIGINAL_BATCH_CONTEXT_MISSING: "Approved BATCH-FIX execution must carry original_request_text.",
};

function gmStabilizeReadFailureMemory() {
  try {
    if (!fs.existsSync(GM_FAILURE_MEMORY_FILE)) return {};
    return JSON.parse(fs.readFileSync(GM_FAILURE_MEMORY_FILE, "utf8"));
  } catch (error) {
    console.warn("[worker-api] failed to read failure memory", error && error.message ? error.message : String(error));
    return {};
  }
}

function gmStabilizeRecordFailureMemory(fingerprint, batchCode) {
  if (!fingerprint || !GM_FAILURE_GUARDS[fingerprint]) return null;
  const now = new Date().toISOString();
  const memory = gmStabilizeReadFailureMemory();
  const previous = memory[fingerprint] || {};
  const count = Number(previous.count || 0) + 1;
  const entry = {
    error_fingerprint: fingerprint,
    first_seen_at: previous.first_seen_at || now,
    last_seen_at: now,
    count,
    last_batch: batchCode || previous.last_batch || "unknown",
    suggested_guard: GM_FAILURE_GUARDS[fingerprint],
  };
  memory[fingerprint] = entry;
  try {
    fs.writeFileSync(GM_FAILURE_MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (error) {
    console.warn("[worker-api] failed to write failure memory", error && error.message ? error.message : String(error));
  }
  return { entry, status: count >= 3 ? "blocked" : count === 2 ? "repeated_warning" : "warning", blocked: count >= 3 };
}


function gmStabilizeExtractContextField(text, fieldName) {
  const pattern = new RegExp("^" + fieldName.replace(/_/g, "[_\\s-]*") + "\\s*[=:]\\s*([^\\r\\n]*)", "im");
  const match = String(text || "").match(pattern);
  return match ? String(match[1] || "").trim().replace(/\\n/g, "\n") : "";
}

function gmStabilizeExtractCurrentBatchCodeFromText(text) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/).slice(0, 16);
  for (const line of lines) {
    const match = String(line || "").match(/\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i);
    if (match) return match[0].toUpperCase();
  }
  const fallback = raw.match(/\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i);
  return fallback ? fallback[0].toUpperCase() : "";
}

function gmStabilizeReadContextBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return /^(true|1|yes|on|是)$/i.test(value.trim());
  return false;
}

function gmStabilizeBuildFinalReportContext(job, body) {
  const requestText = String(job && job.request_text || body && body.request_text || "");
  const bodyText = gmStabilizeFullBodyText(job, body);
  const jobPayload = gmStabilizeObjectContextFields(job && (job.payload || job.metadata || job.task_payload));
  const bodyPayload = gmStabilizeObjectContextFields(body && (body.payload || body.metadata || body.task_payload));
  const requestParsed = parseHermesWorkerContextFromRequestText(requestText);
  const jobOriginalParsed = parseHermesWorkerContextFromRequestText(job && job.original_request_text);
  const bodyParsed = parseHermesWorkerContextFromRequestText(bodyText);
  const parsed = {
    ...bodyParsed,
    ...jobOriginalParsed,
    ...requestParsed,
    ...jobPayload,
    ...bodyPayload,
  };
  const originalRequestText = gmStabilizeFirstContextValue(
    parsed.original_request_text,
    job && job.original_request_text,
    gmStabilizeExtractContextField(bodyText, "original_request_text")
  );
  const batchCode = String(
    body && (body.approved_batch || body.approvedBatch || body.batch_code || body.batchCode) ||
    parsed.approved_batch ||
    gmStabilizeExtractCurrentBatchCodeFromText(originalRequestText) ||
    gmStabilizeExtractCurrentBatchCodeFromText(requestText) ||
    gmStabilizeExtractCurrentBatchCodeFromText(bodyText) ||
    ""
  ).toUpperCase();
  let projectDomain = String(gmStabilizeFirstContextValue(
    body && (body.project_domain || body.projectDomain),
    parsed.project_domain,
    gmStabilizeExtractContextField(bodyText, "project_domain")
  )).trim().toLowerCase();
  let taskMode = String(gmStabilizeFirstContextValue(
    body && (body.task_mode || body.taskMode),
    parsed.task_mode,
    gmStabilizeExtractContextField(bodyText, "task_mode")
  )).trim().toLowerCase();
  let readOnlyMode = gmStabilizeReadContextBoolean(
    (body && (body.read_only_mode ?? body.readOnlyMode ?? body.read_only ?? body.readOnly)) ?? parsed.read_only_mode
  );
  if (/^BATCH-QA(?:-|$)/i.test(batchCode)) {
    projectDomain = "qa_review";
    taskMode = "read_only";
    readOnlyMode = true;
  }
  if (taskMode === "read_only") readOnlyMode = true;
  if (!taskMode && readOnlyMode) taskMode = "read_only";
  if (!projectDomain && /project[_ -]?domain\s*[:=]\s*qa_review/i.test(bodyText)) projectDomain = "qa_review";
  if (!taskMode && /task[_ -]?mode\s*[:=]\s*read_only/i.test(bodyText)) taskMode = "read_only";
  const source = Object.keys(bodyParsed || {}).length > 0
    ? "hermes_worker_context"
    : Object.keys(jobPayload || {}).length > 0
      ? "job_payload"
      : Object.keys(requestParsed || {}).length > 0
        ? "job_request_text"
        : Object.keys(jobOriginalParsed || {}).length > 0
          ? "job_original_request_text"
          : requestText ? "job_request_text" : "worker_report";
  return {
    source,
    batchCode,
    projectDomain,
    taskMode,
    readOnlyMode,
    allowedScope: gmStabilizeFirstContextValue(parsed.allowed_scope, body && (body.allowed_scope || body.allowedScope)),
    exactAllowedScope: gmStabilizeFirstContextValue(parsed.exact_allowed_scope, body && (body.exact_allowed_scope || body.exactAllowedScope)),
    forbiddenScope: gmStabilizeFirstContextValue(parsed.forbidden_scope, body && (body.forbidden_scope || body.forbiddenScope)),
    originalRequestText,
    originalRequestTextPresent: Boolean(originalRequestText),
    approvedBatch: parsed.approved_batch || batchCode,
    requestedMode: parsed.requested_mode || "",
    finalMode: parsed.final_mode || "",
    route: parsed.route || "",
  };
}

function gmStabilizeLogFinalReportContext(context) {
  console.log("final_report_context_source=" + (context.source || "unknown"));
  console.log("final_report_batch_code=" + (context.batchCode || "not_provided"));
  console.log("final_report_project_domain=" + (context.projectDomain || "not_provided"));
  console.log("final_report_task_mode=" + (context.taskMode || "not_provided"));
  console.log("final_report_read_only_mode=" + (context.readOnlyMode ? "true" : "false"));
  console.log("final_report_allowed_scope=" + (context.allowedScope || "not_provided"));
  console.log("final_report_forbidden_scope=" + (context.forbiddenScope || "not_provided"));
  console.log("final_report_original_request_text_present=" + (context.originalRequestTextPresent ? "true" : "false"));
}

function gmStabilizeIsQaBatch(job, body) {
  const context = gmStabilizeBuildFinalReportContext(job, body);
  return /^BATCH-QA(?:-|$)/i.test(context.batchCode) || context.projectDomain === "qa_review" || context.taskMode === "read_only" && /\bBATCH-QA(?:-[A-Z0-9]+)*\b/i.test(gmStabilizeFullBodyText(job, body));
}

function gmStabilizeIsBatchFixProduct(job, body) {
  const context = gmStabilizeBuildFinalReportContext(job, body);
  if (/^BATCH-QA(?:-|$)/i.test(context.batchCode) || context.projectDomain === "qa_review" || context.taskMode === "read_only") return false;
  const text = gmStabilizeFullBodyText(job, body);
  return /^BATCH-FIX(?:-|$)/i.test(context.batchCode) || (/\bBATCH-FIX(?:-[A-Z0-9]+)*\b/i.test(text) && /同城搭子网站|partners|\/partners|\/post|login|profile|page\.tsx|src\/app|产品页面|产品修复|QA\s*发现|首页|发布页|搭子浏览|详情页|product\s+repair|product\s+page/i.test(text));
}

function gmStabilizeOriginalContextMissing(job, body) {
  const text = gmStabilizeFullBodyText(job, body);
  const hasBatchFix = /\bBATCH-FIX(?:-[A-Z0-9]+)*\b/i.test(text);
  const shellOnly = /执行项目总管批准批次\s+BATCH-FIX(?:-[A-Z0-9]+)*|批准执行[:：].*BATCH-FIX(?:-[A-Z0-9]+)*|仅批准\s+BATCH-FIX(?:-[A-Z0-9]+)*/i.test(text);
  const hasOriginal = /original_request_text\s*[:=]\s*[\s\S]*新需求\s*[:：]\s*BATCH-FIX/i.test(text) || /新需求\s*[:：]\s*BATCH-FIX[\s\S]*(同城搭子网站|partners|login|profile|page\.tsx|产品页面|首页|发布页|搭子浏览|详情页)/i.test(text);
  return hasBatchFix && shellOnly && !hasOriginal;
}

function gmStabilizeQaModeMismatch(job, body, taskMode) {
  const context = gmStabilizeBuildFinalReportContext(job, body);
  if (/^BATCH-QA(?:-|$)/i.test(context.batchCode) || context.projectDomain === "qa_review") {
    return taskMode !== "read_only";
  }
  const text = gmStabilizeFullBodyText(job, body);
  return gmStabilizeIsQaBatch(job, body) && (taskMode !== "read_only" || /automation_system_write_allowed|automation_system|system_repair/i.test(text));
}

function gmStabilizeReadExplicitField(text, fieldName) {
  const pattern = new RegExp("\\b" + fieldName.replace(/_/g, "[_\\\\s-]*") + "\\s*[:=]\\s*[\\\"'“”]?([a-z_]+)[\\\"'“”]?", "i");
  const match = String(text || "").match(pattern);
  return match ? match[1].toLowerCase() : null;
}

function gmStabilizeInferTaskMode(job, body) {
  const context = gmStabilizeBuildFinalReportContext(job, body);
  if (context.taskMode === "read_only" || /^BATCH-QA(?:-|$)/i.test(context.batchCode) || context.projectDomain === "qa_review") return "read_only";
  if (context.taskMode === "product_write_allowed" && /^BATCH-FIX(?:-|$)/i.test(context.batchCode)) return "product_write_allowed";
  const text = gmStabilizeFullBodyText(job, body);
  const explicitTextTaskMode = gmStabilizeReadExplicitField(text, "task_mode");
  if (explicitTextTaskMode === "automation_system_write_allowed") return explicitTextTaskMode;
  const explicit = String(body && (body.task_mode || body.taskMode) || "").trim().toLowerCase();
  const allowedModes = ["read_only", "docs_write_allowed", "automation_system_write_allowed", "product_write_allowed"];
  const hasExplicitMode = allowedModes.includes(explicit);

  if (gmStabilizeIsBatchFixProduct(job, body)) return "product_write_allowed";
  if (/\bBATCH-QA(?:-[A-Z0-9]+)*\b|\bBATCH-GM-SMOKE(?:-\d+)?\b|\bBATCH-43\b/i.test(text)) return "read_only";
  if (/\bBATCH-37-(?:DOCS(?:-[A-Z0-9]+)*|FIX)\b|docs_write_allowed/i.test(text) || (/\bdocs\//i.test(text) && gmStabilizeTaskRequiresChange(text))) return "docs_write_allowed";
  if (/\bBATCH-GM-(?!SMOKE)|BATCH-44|BATCH-45A|automation_system_write_allowed/i.test(text) || (/Worker|Windows Worker|Gateway|worker-api|worker_api|feishu_gateway|project-director|project director|project-director-console|worker-jobs|local_worker|git-safety/i.test(text) && gmStabilizeTaskRequiresChange(text))) return "automation_system_write_allowed";
  if (/read[_ -]?only|只读验证|只读检查|不修改任何文件|禁止修改任何文件|只允许\s*git\s*(?:status|diff)/i.test(text)) return "read_only";
  if (/\bBATCH-P\d+\b|product_write_allowed/i.test(text)) return "product_write_allowed";
  if (hasExplicitMode) return explicit;
  if (workerReportIsReadOnly(job, body)) return "read_only";
  return "read_only";
}

function gmStabilizeHasNoFixApplied(job, body) {
  if (workerReportHasSuccessfulWrite(body) || gmStabilizeStructuredSucceeded(body)) return false;
  const errorCode = gmStabilizeWorkerErrorCode(body);
  if (errorCode === NO_FIX_APPLIED) return true;
  const result = parseWorkerReportObject(body && body.result);
  return gmStabilizeReadBoolean(body && body.no_fix_applied) || gmStabilizeReadBoolean(result && result.no_fix_applied);
}

function gmStabilizeHasReadOnlyViolation(job, body, sideEffectFiles = null) {
  const writeFiles = Array.isArray(sideEffectFiles) ? sideEffectFiles : getWorkerReportWriteSideEffectFiles(body);
  const commitSha = getWorkerReportCommitSha(body);
  const pushStatus = String(body && body.github_push_status || "").trim();
  const pushed = workerReportGithubPushSucceeded(pushStatus) || /origin\/master/i.test(pushStatus);
  if (writeFiles.length === 0 && !commitSha && !pushed) return false;
  const text = gmStabilizeFullBodyText(job, body);
  return gmStabilizeReadBoolean(body && body.read_only_mode_violation) || /READ_ONLY_MODE_VIOLATION|Read-only violation:\s*yes|read_only_mode_violation\s*[:=]\s*(?:true|yes|是)/i.test(text);
}

function gmStabilizeIsAutomationAllowedChangedFile(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.startsWith("infra/windows-worker/") ||
    normalized === "src/lib/worker-jobs.ts" ||
    normalized.startsWith("src/app/api/feishu/") ||
    normalized === "src/lib/project-director-console.ts" ||
    normalized === "docs/projects/feishu-gm-automation.md" ||
    normalized === "docs/projects/team-routing.md" ||
    normalized === "docs/projects/feishu-group-routing.md";
}

function gmStabilizeNormalizeScopePath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

function gmStabilizeSplitScope(scope) {
  return String(scope || "")
    .split(/[\r\n,;]+/g)
    .map(gmStabilizeNormalizeScopePath)
    .filter(Boolean);
}

function gmStabilizeScopePatternMatches(filePath, pattern) {
  const file = gmStabilizeNormalizeScopePath(filePath);
  const scope = gmStabilizeNormalizeScopePath(pattern);
  if (!file || !scope) return false;
  if (scope.endsWith("/**")) return file === scope.slice(0, -3) || file.startsWith(scope.slice(0, -2));
  if (scope.endsWith("/*")) {
    const prefix = scope.slice(0, -1);
    return file.startsWith(prefix) && !file.slice(prefix.length).includes("/");
  }
  if (scope.includes("*")) {
    const escaped = scope.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
    return new RegExp("^" + escaped + "$").test(file);
  }
  return file === scope || file.startsWith(scope.replace(/\/$/, "") + "/");
}

function gmStabilizeFileMatchesScope(filePath, scope) {
  const patterns = gmStabilizeSplitScope(scope);
  return patterns.length > 0 && patterns.some((pattern) => gmStabilizeScopePatternMatches(filePath, pattern));
}

function gmStabilizeIsSensitiveChangedFile(filePath) {
  const file = gmStabilizeNormalizeScopePath(filePath).toLowerCase();
  return file === ".env" ||
    file.startsWith(".env.") ||
    file.includes("/.env") ||
    /(^|\/)(?:id_rsa|id_ed25519|.*\.pem|.*\.key|.*secret.*|.*token.*)$/i.test(file) ||
    /(^|\/)(?:database|db|supabase|prisma)\/(?:.*\.sqlite|.*\.db|.*\.sql|migrations?\/.*)$/i.test(file);
}

function gmStabilizeIsProductBusinessPath(filePath) {
  const file = gmStabilizeNormalizeScopePath(filePath);
  return (file === "src/app/page.tsx" ||
    file.startsWith("src/app/partners/") ||
    file.startsWith("src/app/post/") ||
    file.startsWith("app/") ||
    file.startsWith("src/app/login/") ||
    file.startsWith("src/app/profile/")) &&
    !file.startsWith("src/app/api/feishu/");
}

function gmStabilizeHasOutOfScope(job, body, sideEffectFiles = null, taskMode = "", finalReportContext = null) {
  const writeFiles = Array.isArray(sideEffectFiles) ? sideEffectFiles : getWorkerReportWriteSideEffectFiles(body);
  if (writeFiles.length === 0) return false;
  const context = finalReportContext || gmStabilizeBuildFinalReportContext(job, body);
  const allowedScope = context && context.allowedScope || "";
  if (writeFiles.some(gmStabilizeIsSensitiveChangedFile)) return true;
  if (allowedScope) {
    return writeFiles.some((filePath) => !gmStabilizeFileMatchesScope(filePath, allowedScope));
  }
  if (taskMode === "automation_system_write_allowed") {
    if (workerReportHasSuccessfulWrite(body)) {
      return writeFiles.some(gmStabilizeIsProductBusinessPath);
    }
    return writeFiles.some((filePath) => !gmStabilizeIsAutomationAllowedChangedFile(filePath));
  }
  const text = gmStabilizeFullBodyText(job, body);
  return gmStabilizeReadBoolean(body && body.out_of_scope_business_change) || /OUT_OF_SCOPE_BUSINESS_CHANGE|Out-of-scope business change:\s*yes|out_of_scope_business_change\s*[:=]\s*(?:true|yes|是)/i.test(text);
}

function gmStabilizeHasFailedTaskGoal(job, body) {
  if (gmStabilizeStructuredSucceeded(body)) return false;
  const direct = String(body && (body.task_goal_status || body.taskGoalStatus) || "").trim().toLowerCase();
  if (/^(failed|failed_[a-z_]+|no_fix_applied|read_only_violation|out_of_scope_business_change|task_mode_mismatch|failed_no_fix_applied|failed_read_only_mode_violation)$/.test(direct)) return true;
  const result = parseWorkerReportObject(body && body.result);
  const nested = String(result && (result.task_goal_status || result.taskGoalStatus) || "").trim().toLowerCase();
  if (/^(failed|failed_[a-z_]+|no_fix_applied|read_only_violation|out_of_scope_business_change|task_mode_mismatch|failed_no_fix_applied|failed_read_only_mode_violation)$/.test(nested)) return true;
  return Boolean(gmStabilizeWorkerErrorCode(body));
}

function buildGmStabilizeTerminalDecision(finalStatus, job, body) {
  if (finalStatus !== "succeeded") return { status: finalStatus, errorText: null, code: null };
  const finalReportContext = gmStabilizeBuildFinalReportContext(job, body);
  gmStabilizeLogFinalReportContext(finalReportContext);
  const contextMissing = !finalReportContext.taskMode && !finalReportContext.batchCode && !finalReportContext.originalRequestTextPresent;
  if (contextMissing) {
    return {
      status: "failed",
      code: "CONTEXT_RECONSTRUCT_FAILED",
      errorText: [
        "CONTEXT_RECONSTRUCT_FAILED: final report layer could not reconstruct current job context",
        "original_worker_status: " + finalStatus,
        "effective_final_status: failed",
      ].join("\n"),
    };
  }
  const originalContextMissing = gmStabilizeOriginalContextMissing(job, body);
  const taskMode = originalContextMissing ? "read_only" : gmStabilizeInferTaskMode(job, body);
  const qaBatch = gmStabilizeIsQaBatch(job, body);
  const batchFixProduct = gmStabilizeIsBatchFixProduct(job, body);
  const qaModeMismatch = gmStabilizeQaModeMismatch(job, body, taskMode);
  const reportedTaskMode = String(body && (body.task_mode || body.taskMode) || "").trim().toLowerCase();
  const batchFixReadOnlyPollution = batchFixProduct && (/read_only_mode\s*[:=]\s*true|只读任务锁死|不修改任何文件|只执行\s*git\s*status|只执行\s*git\s*diff/i.test(gmStabilizeFullBodyText(job, body)) || body.read_only_mode === true || body.readOnlyMode === true);
  const batchFixMisclassifiedAsAutomation = batchFixProduct && /project_domain\s*[:=]\s*automation_system|Task domain:\s*automation_system|system_repair/i.test(gmStabilizeFullBodyText(job, body));
  const batchFixModeMismatch = batchFixProduct && (taskMode !== "product_write_allowed" || (reportedTaskMode && reportedTaskMode !== "product_write_allowed") || batchFixReadOnlyPollution || batchFixMisclassifiedAsAutomation);
  const explicitTextTaskMode = gmStabilizeReadExplicitField(gmStabilizeFullBodyText(job, body), "task_mode");
  const explicitTextProjectDomain = gmStabilizeReadExplicitField(gmStabilizeFullBodyText(job, body), "project_domain");
  const reportedProjectDomain = String(body && (body.project_domain || body.projectDomain) || "").trim().toLowerCase();
  const explicitTaskModeOverridden = explicitTextTaskMode === "automation_system_write_allowed" && taskMode !== "automation_system_write_allowed";
  const explicitProjectDomainOverridden = explicitTextProjectDomain === "automation_system" && reportedProjectDomain && reportedProjectDomain !== "automation_system";
  const successfulAutomationSystemWrite = taskMode === "automation_system_write_allowed"
    && !gmStabilizeReadBoolean(body && (body.read_only_mode || body.readOnlyMode))
    && workerReportHasSuccessfulWrite(body);
  const taskModeMismatch = successfulAutomationSystemWrite
    ? false
    : explicitTaskModeOverridden || explicitProjectDomainOverridden || qaModeMismatch || batchFixModeMismatch || gmStabilizeHasTaskModeMismatch(job, body, taskMode);
  const requiredDocsFailure = gmStabilizeHasRequiredDocsFailure(job, body);
  const readOnlyMode = taskMode === "read_only";
  const commitSha = getWorkerReportCommitSha(body);
  const changedFiles = getWorkerReportChangedFiles(body);
  const uncommittedFiles = getWorkerReportUncommittedFiles(body);
  const sideEffectFiles = Array.from(new Set([...changedFiles, ...uncommittedFiles]));
  const pushStatus = String(body && body.github_push_status || "").trim();
  const pushed = workerReportGithubPushSucceeded(pushStatus) || /origin\/master/i.test(pushStatus);
  const readOnlySideEffect = readOnlyMode && (sideEffectFiles.length > 0 || Boolean(commitSha) || pushed);
  console.log("readonly_final_guard_changed_files_count=" + changedFiles.length);
  console.log("readonly_final_guard_has_uncommitted_files=" + (uncommittedFiles.length > 0 ? "true" : "false"));
  console.log("readonly_final_guard_violation_reason=" + (readOnlySideEffect ? (sideEffectFiles.length > 0 ? "files_changed" : commitSha ? "commit_sha" : "push") : "none"));
  const readOnlyViolation = readOnlyMode ? readOnlySideEffect : false;
  const outOfScope = readOnlyMode && sideEffectFiles.length === 0 ? false : gmStabilizeHasOutOfScope(job, body, sideEffectFiles, taskMode, finalReportContext);
  const contextMissingWarning = !finalReportContext.allowedScope || !finalReportContext.forbiddenScope || !finalReportContext.originalRequestTextPresent;
  if (contextMissingWarning) {
    console.warn("CONTEXT_MISSING_WARNING", {
      job_id: body && (body.job_id || body.id) || job && job.id || "unknown",
      task_mode: taskMode,
      read_only_mode: readOnlyMode,
      allowed_scope_present: Boolean(finalReportContext.allowedScope),
      forbidden_scope_present: Boolean(finalReportContext.forbiddenScope),
      original_request_text_present: Boolean(finalReportContext.originalRequestTextPresent),
      successful_automation_system_write: successfulAutomationSystemWrite,
    });
  }
  const lifecycleFailure = gmStabilizeLifecycleFailure(body);
  if (lifecycleFailure) {
    return {
      status: "failed",
      code: lifecycleFailure.code,
      errorText: [
        lifecycleFailure.errorText,
        "original_worker_status: " + finalStatus,
        "effective_final_status: failed",
        "failure_stage: worker_lifecycle",
      ].join("\n"),
    };
  }
  const writeModeDowngradeFailure = gmStabilizeWriteModeDowngradeFailure(finalReportContext, taskMode, body);
  if (writeModeDowngradeFailure) {
    return {
      status: "failed",
      code: writeModeDowngradeFailure.failureCode,
      errorText: [
        writeModeDowngradeFailure.errorText,
        "original_worker_status: " + finalStatus,
        "effective_final_status: failed",
        "failure_stage: approval_context_rehydration",
      ].join("\n"),
    };
  }
  if (gmStabilizeShouldTrustArchReadOnlyReport(finalReportContext, body, taskMode, changedFiles) || gmStabilizeStructuredSucceeded(body)) {
    console.log("structured_final_report_trusted=true");
    return { status: finalStatus, errorText: null, code: null };
  }
  const failedTaskGoal = gmStabilizeHasFailedTaskGoal(job, body);
  const noFixDecision = (qaBatch || taskModeMismatch || requiredDocsFailure) ? { status: finalStatus, errorText: null, code: null } : buildNoFixAppliedDecision(finalStatus, job, body);
  if (noFixDecision.status !== finalStatus) return noFixDecision;
  const noFix = qaBatch ? false : gmStabilizeHasNoFixApplied(job, body);
  const failed = originalContextMissing || noFix || readOnlyViolation || outOfScope || (!qaBatch && failedTaskGoal) || taskModeMismatch || requiredDocsFailure;
  if (!failed) return { status: finalStatus, errorText: null, code: null };
  const code = explicitTaskModeOverridden
    ? "EXPLICIT_TASK_MODE_OVERRIDDEN"
    : explicitProjectDomainOverridden
    ? "EXPLICIT_PROJECT_DOMAIN_OVERRIDDEN"
    : originalContextMissing ? "ORIGINAL_BATCH_CONTEXT_MISSING" : requiredDocsFailure || (taskModeMismatch ? TASK_MODE_MISMATCH : readOnlyViolation ? READ_ONLY_MODE_VIOLATION : outOfScope ? OUT_OF_SCOPE_BUSINESS_CHANGE : NO_FIX_APPLIED);
  const memoryResult = code === "EXPLICIT_TASK_MODE_OVERRIDDEN"
    ? gmStabilizeRecordFailureMemory("EXPLICIT_TASK_MODE_OVERRIDDEN", "explicit-task-mode")
    : code === "ORIGINAL_BATCH_CONTEXT_MISSING"
    ? gmStabilizeRecordFailureMemory("ORIGINAL_BATCH_CONTEXT_MISSING", "BATCH-FIX")
    : code === TASK_MODE_MISMATCH && qaBatch
    ? gmStabilizeRecordFailureMemory("QA_TASK_MODE_MISMATCH", "BATCH-QA")
    : code === TASK_MODE_MISMATCH && batchFixProduct && batchFixReadOnlyPollution
      ? gmStabilizeRecordFailureMemory("PRODUCT_WRITE_PROMPT_POLLUTED_BY_READ_ONLY_LOCK", "BATCH-FIX")
      : code === TASK_MODE_MISMATCH && batchFixProduct && batchFixMisclassifiedAsAutomation
        ? gmStabilizeRecordFailureMemory("BATCH_FIX_PRODUCT_MISCLASSIFIED_AS_AUTOMATION_SYSTEM", "BATCH-FIX")
      : code === TASK_MODE_MISMATCH && batchFixProduct
        ? gmStabilizeRecordFailureMemory("BATCH_FIX_PRODUCT_MISROUTED_TO_AUTOMATION", "BATCH-FIX")
      : null;
  return {
    status: "failed",
    code,
    errorText: [
      code + ": effective_final_status coerced to failed by gm-stabilize terminal guard",
      code === "ORIGINAL_BATCH_CONTEXT_MISSING" ? "Approved BATCH-FIX execution is missing original_request_text; refusing shell-only task." : null,
      qaBatch && code === TASK_MODE_MISMATCH ? "QA task was misclassified as automation_system_write_allowed." : null,
      batchFixProduct && code === TASK_MODE_MISMATCH && batchFixReadOnlyPollution ? "BATCH-FIX product_write_allowed report was polluted by a read_only lock." : null,
      batchFixProduct && code === TASK_MODE_MISMATCH && !batchFixReadOnlyPollution ? "BATCH-FIX product task was misclassified away from product_write_allowed." : null,
      memoryResult ? "failure_memory_status: " + memoryResult.status : null,
      memoryResult && memoryResult.blocked ? "blocked: repeated failure count reached 3; run system-fix batch first" : null,
      "original_worker_status: " + finalStatus,
      "effective_final_status: failed",
      "final_report_context_source: " + (finalReportContext.source || "unknown"),
      "final_report_context_missing: " + ((!finalReportContext.allowedScope || !finalReportContext.forbiddenScope || !finalReportContext.originalRequestTextPresent) ? "yes" : "no"),
      "git_commit_sha: " + (commitSha || "none"),
      "pushed/deploy_status: " + (pushed ? "pushed" : (body.deploy_status || body.deployStatus || "none")),
      "task_mode: " + taskMode,
      "project_domain: " + (finalReportContext.projectDomain || (batchFixProduct ? "city_partner_product" : qaBatch ? "qa_review" : (body.project_domain || body.projectDomain || "not_provided"))),
      "approved_batch: " + (finalReportContext.batchCode || body.approved_batch || body.approvedBatch || body.batch_code || "not_provided"),
      "read_only_mode: " + (readOnlyMode ? "true" : "false"),
      "allowed_scope: " + (body.allowed_scope || body.allowedScope || "not_provided"),
      "forbidden_scope: " + (body.forbidden_scope || body.forbiddenScope || "not_provided"),
      "original_request_text: " + String(body.original_request_text || body.originalRequestText || "").slice(0, 500),
      "task_goal_status: " + (requiredDocsFailure === MISSING_REQUIRED_DOCS ? "missing_required_docs" : requiredDocsFailure === INSUFFICIENT_DOC_OUTPUT ? "insufficient_doc_output" : taskModeMismatch ? "task_mode_mismatch" : readOnlyViolation ? "read_only_violation" : outOfScope ? "out_of_scope_business_change" : noFix ? "no_fix_applied" : failedTaskGoal ? "failed" : "completed"),
      "NO_FIX_APPLIED: " + (noFix ? "yes" : "no"),
      "MISSING_REQUIRED_DOCS: " + (requiredDocsFailure === MISSING_REQUIRED_DOCS ? "yes" : "no"),
      "INSUFFICIENT_DOC_OUTPUT: " + (requiredDocsFailure === INSUFFICIENT_DOC_OUTPUT ? "yes" : "no"),
      "READ_ONLY_MODE_VIOLATION: " + (readOnlyViolation ? "yes" : "no"),
      "TASK_MODE_MISMATCH: " + (taskModeMismatch ? "yes" : "no"),
      "OUT_OF_SCOPE_BUSINESS_CHANGE: " + (outOfScope ? "yes" : "no"),
      "Committed: " + (commitSha ? "yes" : "no"),
      "Pushed: " + (pushed ? "yes" : "no"),
      "changed_files:",
      ...(changedFiles.length ? changedFiles.map((changedFile) => "- " + changedFile) : ["- none"]),
    ].filter(Boolean).join("\n"),
  };
}

async function updateHermesJobReportWithSchemaFallback(supabaseClient, jobId, updateData) {
  let pending = { ...updateData };
  const skipped = [];
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const { data, error } = await supabaseClient.from("hermes_jobs").update(pending).eq("id", jobId).in("status", ["pending", "queued", "running"]).select("*").maybeSingle();
    if (!error) return { data, error: null, skipped };
    const missing = parseSupabaseMissingColumnName(error);
    if (!missing || !Object.prototype.hasOwnProperty.call(pending, missing)) return { data: null, error, skipped };
    skipped.push(missing);
    delete pending[missing];
    console.warn("worker_report_schema_field_skipped", { job_id: jobId, field: missing });
  }
  return { data: null, error: new Error("worker_report_schema_fallback_exhausted"), skipped };
}

async function updateHermesJobDiagnosticsEnrichmentWithSchemaFallback(supabaseClient, jobId, updateData) {
  let pending = { ...updateData };
  const skipped = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error } = await supabaseClient.from("hermes_jobs").update(pending).eq("id", jobId).select("*").maybeSingle();
    if (!error) return { data, error: null, skipped };
    const missing = parseSupabaseMissingColumnName(error);
    if (!missing || !Object.prototype.hasOwnProperty.call(pending, missing)) return { data: null, error, skipped };
    skipped.push(missing);
    delete pending[missing];
    console.warn("worker_report_diagnostics_enrichment_schema_field_skipped", { job_id: jobId, field: missing });
  }
  return { data: null, error: new Error("worker_report_diagnostics_enrichment_schema_fallback_exhausted"), skipped };
}

function buildDiagnosticsStorageUnavailableResponse(jobId, finalStatus, skipped, data) {
  return {
    ok: false,
    error: "diagnostics_storage_unavailable",
    failure_code: RUNTIME_DIAGNOSTICS_STORAGE_UNAVAILABLE,
    failure_stage: "report",
    job_id: jobId,
    status: finalStatus,
    diagnostics_storage_field: RUNTIME_DIAGNOSTICS_STORAGE_FIELD,
    terminal_status_persisted: Boolean(data),
    diagnostics_persisted: false,
    terminal_report_idempotent: false,
  };
}

function getStoredRuntimeDiagnostics(job) {
  const result = parseWorkerReportObject(job && job.result);
  return parseWorkerReportObject(result && result.diagnostics);
}

function getRuntimeActiveAttemptId(job) {
  const attempt = canonicalGetActiveAttempt(job);
  return readFinalReportString(attempt && (attempt.id || attempt.attempt_id)) || null;
}

function getRuntimeStoredTerminalAttemptId(job) {
  const result = parseWorkerReportObject(job && job.result);
  return getRuntimeActiveAttemptId(job) || readFinalReportString(result && result.attempt_id) || null;
}

function runtimeTerminalAttemptMatches(job, incomingAttemptId) {
  const storedAttemptId = getRuntimeStoredTerminalAttemptId(job);
  if (!storedAttemptId) return !incomingAttemptId;
  return incomingAttemptId === storedAttemptId;
}

function runtimeBuildStaleAttemptResponse(job, incomingAttemptId, terminal) {
  return {
    ok: false,
    error: terminal ? "stale_attempt_terminal_report" : "stale_attempt_report",
    stale_attempt: true,
    duplicate_report_detected: false,
    status_unchanged: true,
    diagnostics_persisted: false,
    existing_status: job && job.status || null,
    active_attempt_id: getRuntimeActiveAttemptId(job),
    stored_terminal_attempt_id: getRuntimeStoredTerminalAttemptId(job),
    attempt_id: incomingAttemptId || null,
  };
}

function buildRuntimeDiagnosticsEnrichment(existingJob, body, finalStatus) {
  if (!runtimeHasOwnField(existingJob, "result")) return null;
  if (getStoredRuntimeDiagnostics(existingJob)) return null;
  const result = parseWorkerReportObject(existingJob && existingJob.result);
  const incomingFields = buildRuntimeStructuredTerminalFields(existingJob, body || {}, finalStatus, body && body.failure_code);
  return {
    ...result,
    diagnostics: buildRuntimeFailureDiagnostics(existingJob, body || {}, {
      ...incomingFields,
      effective_final_status: incomingFields.effective_final_status || finalStatus,
    }),
  };
}

async function enrichTerminalDiagnosticsIfMissing(supabaseClient, existingJob, body, finalStatus) {
  const enrichment = buildRuntimeDiagnosticsEnrichment(existingJob, body, finalStatus);
  if (!enrichment) {
    return {
      enriched: false,
      reason: runtimeHasOwnField(existingJob, "result") ? "diagnostics_present_or_unavailable" : "result_column_not_loaded",
      retry_count_unchanged: true,
      status_unchanged: true,
      completed_at_not_regressed: true,
    };
  }
  const { data, error, skipped } = await updateHermesJobDiagnosticsEnrichmentWithSchemaFallback(supabaseClient, existingJob.id, {
    result: enrichment,
    updated_at: existingJob.updated_at || new Date().toISOString(),
  });
  if (error || (Array.isArray(skipped) && skipped.includes("result"))) {
    return {
      enriched: false,
      reason: "diagnostics_storage_unavailable",
      retry_count_unchanged: true,
      status_unchanged: true,
      completed_at_not_regressed: true,
    };
  }
  return {
    enriched: Boolean(data),
    reason: data ? "diagnostics_enriched" : "diagnostics_enrichment_not_applied",
    retry_count_unchanged: true,
    status_unchanged: true,
    completed_at_not_regressed: true,
  };
}

app.post("/api/worker/report", authenticateWorker, async (req, res) => {
  console.log("Worker report payload", {
    job_id: req.body?.job_id || null,
    status: req.body?.status || null,
    git_commit_sha: req.body?.git_commit_sha || null,
    deploy_status: req.body?.deploy_status || null,
    has_result_text: Boolean(req.body?.result_text),
    has_error_text: Boolean(req.body?.error_text),
  });

  console.log("收到 Worker 上报", {
    job_id: req.body?.job_id || null,
    status: req.body?.status || null,
    git_commit_sha: req.body?.git_commit_sha || null,
    deploy_status: req.body?.deploy_status || null,
    has_result_text: Boolean(req.body?.result_text),
    has_error_text: Boolean(req.body?.error_text),
  });

  const {
    id,
    job_id,
    status,
    result,
    result_text,
    error,
    error_text,
    git_commit_sha,
    deploy_status,
  } = req.body || {};

  const jobId = String(id || job_id || "").trim();
  const finalStatus = String(status || "").trim().toLowerCase();
  const incomingAttemptId = readFinalReportString(req.body && (req.body.attempt_id || req.body.attemptId));
  const reportWorkerName = runtimeWorkerNameFromRequest(req, req.body || {});

  if (!jobId) {
    return res.status(400).json({
      ok: false,
      error: "job_id_required",
    });
  }

  if (!["succeeded", "failed"].includes(finalStatus)) {
    return res.status(400).json({
      ok: false,
      error: "invalid_status",
      allowed: ["succeeded", "failed"],
    });
  }

  const canonicalReportValidation = validateRuntimeCanonicalWorkerReportSchema(req.body || {});
  if (!canonicalReportValidation.ok) {
    return res.status(400).json({
      ok: false,
      error: "worker_report_schema_invalid",
      ...canonicalReportValidation,
    });
  }

  const { data: existingJob, error: findError } = await supabase
    .from("hermes_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();

  if (findError) {
    console.error("Report job lookup failed:", findError);
    return res.status(500).json({
      ok: false,
      error: "report_lookup_failed",
      message: findError.message,
    });
  }

  if (!existingJob) {
    return res.status(404).json({
      ok: false,
      error: "job_not_found",
    });
  }

  const prioritizedFinalStatus = getPrioritizedRuntimeFinalStatus(finalStatus, req.body || {});
  const terminalDecision = buildGmStabilizeTerminalDecision(prioritizedFinalStatus, existingJob, req.body || {});
  const canonicalFinalization = canonicalFinalizeJob(existingJob, {
    attempt_id: incomingAttemptId,
    worker_execution_status: readRuntimeReportField(req.body || {}, "worker_execution_status") || finalStatus,
    task_goal_status: readRuntimeReportField(req.body || {}, "task_goal_status") || terminalDecision.status,
    effective_final_status: terminalDecision.status,
    now: new Date().toISOString(),
  });

  const terminalDescriptor = runtimeGetTerminalJobDescriptor(existingJob);
  const existingStatusIsTerminal = Boolean(terminalDescriptor);
  const terminalAttemptMatches = runtimeTerminalAttemptMatches(existingJob, incomingAttemptId);
  let terminalJob = existingJob;
  let terminalRuntimeCleanupApplied = false;
  if (existingStatusIsTerminal && runtimeTerminalJobHasRuntimeState(existingJob)) {
    const cleanup = await runtimePersistTerminalCleanup(existingJob, terminalDescriptor);
    if (cleanup.error) {
      return res.status(500).json({
        ok: false,
        error: "terminal_job_cleanup_failed",
        failure_code: "TERMINAL_JOB_CLEANUP_FAILED",
        failure_stage: "duplicate_terminal_report_cleanup",
        status_unchanged: true,
      });
    }
    terminalJob = cleanup.data || existingJob;
    terminalRuntimeCleanupApplied = Boolean(cleanup.data);
  }
  if (existingStatusIsTerminal && !terminalAttemptMatches) {
    console.warn("[worker-api] stale terminal attempt rejected", {
      job_id: jobId,
      existing_status: existingJob.status,
      has_incoming_attempt: Boolean(incomingAttemptId),
      has_stored_attempt: Boolean(getRuntimeStoredTerminalAttemptId(existingJob)),
    });
    return res.status(409).json(runtimeBuildStaleAttemptResponse(terminalJob, incomingAttemptId, true));
  }

  if (existingStatusIsTerminal && !canonicalFinalization.ok) {
    return res.status(409).json({
      ok: false,
      error: "terminal_report_conflict",
      failure_code: canonicalFinalization.failure_code,
      failure_stage: "job_state_machine",
      terminal_immutable: true,
      status_unchanged: true,
      duplicate_report_detected: true,
      existing_state: canonicalFinalization.existing_state || null,
      incoming_state: canonicalFinalization.incoming_state || null,
    });
  }

  if (existingStatusIsTerminal) {
    console.warn("[worker-api] duplicate terminal report ignored", {
      job_id: jobId,
      existing_status: existingJob.status,
      reported_status: finalStatus,
      attempt_id: incomingAttemptId || null,
    });
    const diagnosticsEnrichment = await enrichTerminalDiagnosticsIfMissing(supabase, terminalJob, req.body || {}, finalStatus);
    return res.json({
      ok: true,
      acknowledged: true,
      canonical_report_schema_version: RUNTIME_CANONICAL_WORKER_REPORT_SCHEMA_VERSION,
      already_terminal: true,
      duplicate_report_detected: true,
      duplicate_report_idempotent: true,
      second_side_effect_triggered: false,
      diagnostics_enrichment_only: diagnosticsEnrichment.enriched === true,
      non_diagnostic_side_effects: 0,
      terminal_runtime_cleanup_applied: terminalRuntimeCleanupApplied,
      retry_count_unchanged: diagnosticsEnrichment.retry_count_unchanged === true,
      status_unchanged: diagnosticsEnrichment.status_unchanged === true,
      completed_at_not_regressed: diagnosticsEnrichment.completed_at_not_regressed === true,
      final_report_delivery: "skipped_duplicate_terminal",
      diagnostics_enrichment_reason: diagnosticsEnrichment.reason || null,
      job: terminalJob,
    });
  }

  const reportOwnership = runtimeOwnsAndMatchesAttempt(existingJob, reportWorkerName, incomingAttemptId);
  if (!reportOwnership.ok) return res.status(reportOwnership.status).json(reportOwnership.body);

  const activeAttemptId = getRuntimeActiveAttemptId(existingJob);
  if (activeAttemptId && incomingAttemptId !== activeAttemptId) {
    console.warn("[worker-api] stale active attempt rejected", {
      job_id: jobId,
      existing_status: existingJob.status,
      has_incoming_attempt: Boolean(incomingAttemptId),
      has_active_attempt: true,
    });
    return res.status(409).json(runtimeBuildStaleAttemptResponse(existingJob, incomingAttemptId, false));
  }

  if (!["pending", "queued", "running"].includes(String(existingJob.status || "").toLowerCase())) {
    return res.status(409).json({
      ok: false,
      error: "job_not_active",
      status: existingJob.status,
    });
  }

  const effectiveFinalStatus = terminalDecision.status;
  const effectiveErrorText = terminalDecision.errorText;
  const effectiveErrorCode = terminalDecision.code || null;

  if (effectiveFinalStatus !== finalStatus) {
    console.warn("[worker-api] coerced terminal report", {
      job_id: jobId,
      reported_status: finalStatus,
      effective_status: effectiveFinalStatus,
      code: effectiveErrorCode,
    });
  }

  const structuredTerminalFields = buildRuntimeStructuredTerminalFields(existingJob, req.body || {}, effectiveFinalStatus, effectiveErrorCode);
  const terminalNow = new Date().toISOString();
  if (!canonicalFinalization.ok || !canonicalFinalization.patch) {
    return res.status(409).json({
      ok: false,
      error: "job_finalization_rejected",
      failure_code: canonicalFinalization.failure_code || "JOB_STATE_INVARIANT_VIOLATION",
      failure_stage: "job_state_machine",
      violated_invariants: canonicalFinalization.violations || [],
    });
  }
  const lifecycleResult = parseWorkerReportObject(canonicalFinalization.patch.result);
  const updateData = {
    ...canonicalFinalization.patch,
    status: canonicalFinalization.patch.status || effectiveFinalStatus,
    finished_at: terminalNow,
    completed_at: terminalNow,
    updated_at: terminalNow,
    ...structuredTerminalFields,
    claimed_by: null,
    claimed_at: null,
    attempt_id: null,
    active_attempt_id: null,
    expires_at: null,
    heartbeat_at: null,
    retry_requested: false,
    retry_pending: false,
    should_retry: false,
    retryable: false,
  };

  const runtimeDiagnostics = buildRuntimeFailureDiagnostics(existingJob, req.body || {}, updateData);
  const canonicalWorkerReport = buildRuntimeCanonicalWorkerReportSchema(existingJob, req.body || {}, updateData, reportWorkerName, incomingAttemptId);
  updateData.result = {
    ...(lifecycleResult || {}),
    ...(parseWorkerReportObject(result) || {}),
    attempt_id: incomingAttemptId || getRuntimeActiveAttemptId(existingJob) || null,
    diagnostics: runtimeDiagnostics,
    report_schema_version: RUNTIME_CANONICAL_WORKER_REPORT_SCHEMA_VERSION,
    canonical_worker_report: canonicalWorkerReport,
    worker_report_schema_fallback_exhausted: false,
    worker_execution_status: updateData.worker_execution_status || null,
    task_goal_status: updateData.task_goal_status || null,
    effective_final_status: updateData.effective_final_status || effectiveFinalStatus,
    failure_code: updateData.failure_code || null,
    failure_stage: updateData.failure_stage || null,
    changed_files: Array.isArray(updateData.changed_files) ? updateData.changed_files : [],
    committed_files: Array.isArray(updateData.committed_files) ? updateData.committed_files : [],
    pushed: updateData.pushed === true,
    git_push: updateData.git_push === true || updateData.pushed === true,
    verification_only: updateData.verification_only,
    allow_no_change_success: updateData.allow_no_change_success,
    code_changes_required: updateData.code_changes_required,
    codex_required: updateData.codex_required,
    git_commit_required: updateData.git_commit_required,
    git_push_required: updateData.git_push_required,
    final_report_state_conflict: updateData.final_report_state_conflict === true,
    final_report_source: updateData.final_report_source || null,
    post_completion_source: updateData.post_completion_source || null,
    post_completion_state_applied: updateData.post_completion_state_applied === true,
    ...(lifecycleResult && lifecycleResult.job_state_machine
      ? { job_state_machine: lifecycleResult.job_state_machine }
      : {}),
    next_stage_allowed: updateData.next_stage_allowed === true,
  };
  if (effectiveFinalStatus === "succeeded") {
    updateData.result_text =
      typeof result_text === "string"
        ? result_text
        : typeof result === "string"
          ? result
          : JSON.stringify(result ?? "");

    updateData.error_text = null;
    updateData.workflow_stage = "completed";

    const commitSha = String(git_commit_sha || "").trim();
    const reportedDeployStatus = String(deploy_status || "").trim();

    if (commitSha) {
      updateData.git_commit_sha = commitSha;
    }

    if (reportedDeployStatus) {
      updateData.deploy_status = reportedDeployStatus;
    } else if (commitSha) {
      updateData.deploy_status = "pending";
    }
  }

  if (effectiveFinalStatus === "failed") {
    updateData.error_text =
      effectiveErrorText ||
      (typeof error_text === "string"
          ? error_text
          : typeof error === "string"
            ? error
            : JSON.stringify(error ?? "Worker execution failed"));
  }

  const { data, error: updateError, skipped } = await updateHermesJobReportWithSchemaFallback(supabase, jobId, updateData);

  if (updateError) {
    console.error("Report job failed:", updateError);
    return res.status(500).json({
      ok: false,
      error: "report_failed",
      message: updateError.message,
    });
  }

  if (!data) {
    return res.status(404).json({
      ok: false,
      error: "running_job_not_found",
    });
  }

  if (Array.isArray(skipped) && skipped.includes("result")) {
    console.error("diagnostics_storage_unavailable", {
      job_id: jobId,
      storage_field: RUNTIME_DIAGNOSTICS_STORAGE_FIELD,
      skipped_columns: skipped,
    });
    return res.status(500).json(buildDiagnosticsStorageUnavailableResponse(jobId, effectiveFinalStatus, skipped, data));
  }


  await syncWorkerJobToFeishu(jobId, {
    status: effectiveFinalStatus,
    workflow_stage: "completed",
    progress_percent: 100,
    current_step: effectiveFinalStatus === "succeeded" ? "任务完成" : "任务失败",
    status_message: effectiveFinalStatus === "succeeded" ? "任务执行完成" : "任务执行失败",
    git_commit_sha: updateData.git_commit_sha || null,
    worker_execution_status: updateData.worker_execution_status || null,
    task_goal_status: updateData.task_goal_status || null,
    effective_final_status: updateData.effective_final_status || effectiveFinalStatus,
    failure_code: updateData.failure_code || null,
    failure_stage: updateData.failure_stage || null,
    changed_files: Array.isArray(updateData.changed_files) ? updateData.changed_files : [],
    committed_files: Array.isArray(updateData.committed_files) ? updateData.committed_files : [],
    pushed: updateData.pushed === true,
    git_push: updateData.git_push === true || updateData.pushed === true,
    verification_only: updateData.verification_only,
    allow_no_change_success: updateData.allow_no_change_success,
    code_changes_required: updateData.code_changes_required,
    codex_required: updateData.codex_required,
    git_commit_required: updateData.git_commit_required,
    git_push_required: updateData.git_push_required,
    final_report_state_conflict: updateData.final_report_state_conflict === true,
    final_report_source: updateData.final_report_source || null,
    post_completion_source: updateData.post_completion_source || null,
    post_completion_state_applied: updateData.post_completion_state_applied === true,
    next_stage_allowed: updateData.next_stage_allowed === true,
    reply_error: updateData.reply_error || null,
    error_text: updateData.error_text || null,
    finished_at: updateData.finished_at,
    updated_at: updateData.updated_at,
  }, "reason=report");

  console.log(`任务已完成: ${jobId} -> ${effectiveFinalStatus}`);

  const finalReplyDecision = shouldSendFeishuFinalReport(data);
  console.log("final_report_delivery_decision", {
    job_id: jobId,
    source: data.source || null,
    notification_status: data.notification_status || null,
    reason: finalReplyDecision.reason,
    message_id_present: Boolean(finalReplyDecision.context.messageId),
    chat_id_present: Boolean(finalReplyDecision.context.chatId),
    receive_id_present: Boolean(finalReplyDecision.context.receiveId),
  });

  if (finalReplyDecision.ok) {
    const claimResult = await claimFinalReportNotificationSend(supabase, jobId, data.reply_attempt_count);
    if (!claimResult.ok) {
      console.log("final_report_delivery_claim_skipped", { job_id: jobId, reason: claimResult.reason });
      return res.json({
        ok: true,
        job_id: jobId,
        status: effectiveFinalStatus,
        final_report_delivery: claimResult.reason,
        canonical_report_schema_version: RUNTIME_CANONICAL_WORKER_REPORT_SCHEMA_VERSION,
        canonical_report_submit_verified: true,
        worker_report_schema_fallback_exhausted: false,
      });
    }
    const replyResult = await sendFeishuFinalReplyWithRetry(data);

    if (replyResult.ok && !replyResult.skipped) {
      const replyTime = new Date().toISOString();
      const replyUpdateResult = await updateFinalReportNotificationState(supabase, jobId, {
        notification_status: "sent",
        reply_sent_at: replyTime,
        reply_error: null,
      });

      if (!replyUpdateResult.ok) {
        console.error("记录飞书回复状态失败:", replyUpdateResult.error);
      } else {
        console.log(`飞书结果已发送: ${jobId}`);
      }
    } else if (replyResult.skipped) {
      console.log(`跳过飞书结果回复: ${jobId}, ${replyResult.reason}`);
      await updateFinalReportNotificationState(supabase, jobId, {
        notification_status: replyResult.reason === "skipped_no_target" ? "skipped_no_target" : "skipped",
        reply_error: replyResult.reason || "final_report_skipped",
      });
    } else {
      const errorMessage = replyResult.error || replyResult.reason || "final_report_delivery_failed";
      console.error("飞书结果回复失败:", sanitizeFeishuLogText(errorMessage));
      await updateFinalReportNotificationState(supabase, jobId, {
        notification_status: "failed",
        reply_error: errorMessage,
      });
    }
  } else if (finalReplyDecision.reason === "skipped_no_target") {
    await updateFinalReportNotificationState(supabase, jobId, {
      notification_status: "skipped_no_target",
      reply_error: "skipped_no_target",
    });
    console.warn("final_report_target_missing", { job_id: jobId, source: data.source || null });
  }

  return res.json({
    ok: true,
    canonical_report_schema_version: RUNTIME_CANONICAL_WORKER_REPORT_SCHEMA_VERSION,
    canonical_report_submit_verified: true,
    worker_report_schema_fallback_exhausted: false,
    job: data,
  });
});




// Feishu event callback: must answer url_verification within 3 seconds.
// IMPORTANT: challenge handling must stay before any Supabase/Feishu API work.
app.post("/feishu/event", async (req, res) => {
  try {
    const body = req.body || {};

    const challenge =
      body.challenge ||
      (body.event && body.event.challenge) ||
      "";

    if (challenge) {
      return res.status(200).json({ challenge });
    }

    // Temporary safe behavior:
    // Accept non-verification Feishu events without creating executable hermes_jobs here.
    // Website/product routing should be handled by the project-director flow before any queued job insert.
    return res.status(200).json({
      ok: true,
      route: "/feishu/event",
      received: true
    });
  } catch (error) {
    console.error("[feishu/event] callback failed:", error && error.message ? error.message : error);
    return res.status(200).json({
      ok: false,
      route: "/feishu/event",
      error: "callback_failed"
    });
  }
});


app.get("/health", async (req, res) => {
  const startedAt = process.uptime();

  try {
    const { error } = await supabase
      .from("hermes_jobs")
      .select("id")
      .limit(1);

    if (error) {
      return res.status(503).json({
        ok: false,
        service: "worker-api",
        database: "unavailable",
        error: error.message,
        uptime_seconds: Math.floor(startedAt),
        timestamp: new Date().toISOString(),
      });
    }

    return res.json({
      ok: true,
      service: "worker-api",
      database: "connected",
      uptime_seconds: Math.floor(startedAt),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      service: "worker-api",
      database: "error",
      error: error instanceof Error ? error.message : String(error),
      uptime_seconds: Math.floor(startedAt),
      timestamp: new Date().toISOString(),
    });
  }
});

require("./feishu_routes")(app, supabase);

app.use((err, req, res, next) => {
  console.error("Unhandled request error:", err);

  res.status(500).json({
    ok: false,
    error: "internal_server_error",
  });
});


async function recoverStaleJobs() {
  try {
    await runtimeExcludeTerminalJobsFromActiveQueue("before_stale_recovery");
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("hermes_jobs")
      .select("*")
      .eq("status", "running")
      .lt("updated_at", staleBefore)
      .limit(100);
    if (error) throw error;
    let requeuedCount = 0;
    let failedCount = 0;
    for (const job of data || []) {
      const inspection = canonicalInspectJobState(job, { now });
      if (inspection.terminal || !inspection.active_attempt || inspection.active_lease) continue;
      const recovery = canonicalRecoverStaleAttempt(job, {
        now,
        worker_available: false,
        expected_attempt_id: inspection.active_attempt.id,
        expected_worker_id: inspection.claimed_by,
        retry_allowed: inspection.retry_allowed,
        reason: "worker_lease_expired",
      });
      if (!recovery.ok || !recovery.patch) {
        console.warn("canonical stale recovery rejected", {
          job_id: job.id,
          failure_code: recovery.failure_code || "STALE_RECOVERY_REJECTED",
        });
        continue;
      }
      const recovered = await runtimeUpdateHermesJobWithSchemaFallback(
        job.id,
        recovery.patch,
        (query) => query.eq("status", job.status).eq("updated_at", job.updated_at)
      );
      if (recovered.error || !recovered.data) continue;
      if (recovered.data.status === "queued") requeuedCount += 1;
      else if (recovered.data.status === "failed") failedCount += 1;
    }
    await runtimeExcludeTerminalJobsFromActiveQueue("after_stale_recovery");
    if (requeuedCount > 0 || failedCount > 0) {
      console.log(`canonical stale recovery: requeued=${requeuedCount}, failed=${failedCount}`);
    }
  } catch (error) {
    console.error("canonical stale recovery failed", error);
  }
}

async function runtimeExcludeTerminalJobsFromActiveQueue(reason) {
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("*")
    .in("status", ["pending", "queued", "running"]);
  if (error) throw error;
  let excluded = 0;
  for (const job of data || []) {
    const descriptor = runtimeGetTerminalJobDescriptor(job);
    if (!descriptor) continue;
    const cleanup = await runtimePersistTerminalCleanup(job, descriptor);
    if (cleanup.error) throw cleanup.error;
    excluded += 1;
  }
  if (excluded > 0) console.log("terminal_jobs_excluded_from_active_queue", { reason, excluded });
  return excluded;
}

const recoveryTimer = setInterval(
  recoverStaleJobs,
  5 * 60 * 1000
);

recoveryTimer.unref();
recoverStaleJobs().catch((error) => {
  console.error("known_terminal_job_startup_cleanup_failed", error && error.message ? error.message : error);
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`worker-api v2 listening on 0.0.0.0:${PORT}`);
  console.log(`Supabase URL: ${SUPABASE_URL}`);
  console.log("Worker authentication enabled: true");
});

server.on("error", (error) => {
  console.error("HTTP server failed:", error);
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
