import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseService } from "@/lib/env";
import { createHash } from "node:crypto";
import {
  applyHeartbeat as buildCanonicalHeartbeat,
  applyProgress as buildCanonicalProgress,
  claimJob as buildCanonicalClaim,
  cleanupTerminalJob as buildCanonicalTerminalCleanup,
  finalizeJob as buildCanonicalFinalization,
  getActiveAttempt as getCanonicalActiveAttempt,
  inspectJobState as inspectCanonicalJobState,
  initializeQueuedJob as initializeCanonicalQueuedJob,
  isCanonicalClaimPersisted as canonicalClaimIsPersisted,
  isJobSelectable as isCanonicalJobSelectable,
  normalizeJobState as normalizeCanonicalJobState,
  recoverStaleAttempt as buildCanonicalStaleRecovery,
  rollbackFailedClaim as canonicalRollbackFailedClaim,
  validateJobStateInvariant as validateCanonicalJobStateInvariant,
} from "../../infra/tencent-worker/worker_job_state_machine";
import {
  finalizeCanonicalJobReportSafely as finalizeSharedCanonicalJobReportSafely,
} from "../../infra/tencent-worker/worker_terminal_finalizer";
import {
  canonicalAcquireAttemptLease,
  canonicalFinalizeTerminal,
  canonicalPersistRuntimeSignal,
  canonicalRecoverStaleAttempt as persistCanonicalStaleAttempt,
  canonicalTerminalSemanticsMatch,
  isCanonicalDatabasePersistenceEnabled,
  type CanonicalTerminalSemanticIdentity,
  type CanonicalPersistenceRpcClient,
} from "./worker-job-persistence-contract";
import {
  aggregatePlanResults,
  type CanonicalSubtaskResult,
} from "./hermes/result-aggregator";
import {
  normalizeExecutionPlan,
  type HermesExecutionPlan,
  type HermesExecutionSubtask,
  type HermesRequestedMode,
} from "./hermes/execution-plan";
import {
  attachHermesShadowToFinalReport,
  buildProjectDirectorFinalReport,
} from "./project-director-final-report";
import { getCompletedHermesShadowObservation } from "./hermes/shadow-runtime";
import {
  buildCanonicalCanaryPersistenceAuditRecord,
  evaluateCanonicalCanaryAdmission,
  type CanonicalCanaryAdmissionEvidence,
} from "./hermes/canonical-canary-scope";
import { buildCanonicalJobInsertContract } from "./hermes/canonical-job-insert-contract";

type JobRecord = Record<string, unknown>;

interface SupabaseWriteError {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
}

interface DuplicateFeishuJob {
  id: string;
  job_id?: string | null;
  request_text?: string | null;
  created_at?: string | null;
}

export interface DuplicateFeishuJobCheckResult {
  duplicate: DuplicateFeishuJob | null;
  normalizedText: string;
  error: SupabaseWriteError | null;
}

export interface HermesJobInsertResult {
  insertedCount: number;
  skippedColumns: string[];
  adjustedFields: string[];
  jobIds: string[];
}

const RECORD_ID_KEYS = [
  "bitable_record_id",
  "feishu_record_id",
  "record_id",
  "bitableRecordId",
  "feishuRecordId",
  "recordId",
];

const TASK_MUTATION_PATTERN =
  /修复|新增|更新|补齐|建立|修改|改动|创建|写入|补充|fix|repair|add|create|update|modify|patch|implement/i;
const READ_ONLY_TASK_PATTERN =
  /read[_ -]?only(?:[_ -]?mode)?\s*(?::|=)?\s*(?:true|1|yes|on)?|只读模式|本任务只读|只读执行|只读检查|只读诊断|只读验证|不修改(?:任何)?(?:文件|代码|仓库|项目)?|禁止修改(?:任何)?(?:文件|代码|仓库|项目)?|禁止\s*(?:执行\s*)?(?:git\s+)?(?:add|commit|push)\b/i;
const QA_BATCH_PATTERN = /\bBATCH-QA(?:-[A-Z0-9]+)*\b/i;
const BATCH_FIX_PATTERN = /\bBATCH-FIX(?:-[A-Z0-9]+)*\b/i;
const BATCH_FIX_PRODUCT_SIGNAL_PATTERN =
  /同城搭子网站|partners|\/partners|\/post|login|profile|page\.tsx|src\/app|产品页面|产品修复|QA\s*发现|首页|发布页|搭子浏览|详情页|product\s+repair|product\s+page/i;
const TASK_MODES = {
  READ_ONLY: "read_only",
  MANAGER_READ_ONLY: "manager_read_only",
  WORKER_READ_ONLY: "worker_read_only",
  DOCS_WRITE_ALLOWED: "docs_write_allowed",
  AUTOMATION_SYSTEM_WRITE_ALLOWED: "automation_system_write_allowed",
  PRODUCT_WRITE_ALLOWED: "product_write_allowed",
} as const;
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
const WORKER_READONLY_CONTEXT_INCOMPLETE = "WORKER_READONLY_CONTEXT_INCOMPLETE";
export const CANONICAL_WORKER_REPORT_SCHEMA_VERSION = 2;
export const WORKER_JOB_CONTRACT_FIELDS = [
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
  "original_request_text_preserved",
  "original_request_text_base64",
  "route",
  "payload",
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
  "unexpected_changed_files",
  "git_commit_sha",
  "worker_git_push",
  "git_push",
  "pushed_branch",
  "remote_contains_commit",
  "repository_clean_after_push",
  "terminal_report_acknowledged",
  "terminal_state_persisted",
  "duplicate_terminal_report_idempotent",
  "post_completion_state_applied",
  "final_report_source",
  "next_batch",
  "completed_at",
  "pushed",
  "deploy_status",
] as const;
const CONTEXT_MISSING_WARNING = "CONTEXT_MISSING_WARNING";
const DOCS_WRITE_TASK_PATTERN =
  /\bBATCH-37-(?:DOCS(?:-[A-Z0-9]+)*|FIX)\b|docs_write_allowed/i;
const DOCS_WRITE_TARGET_PATTERN = /\bdocs\//i;
const AUTOMATION_WRITE_TASK_PATTERN =
  /\bBATCH-44\b|\bBATCH-45A\b|automation_system_write_allowed|Worker|Windows Worker|Gateway|worker-api|worker_api|feishu_gateway|project-director|project director|project-director-console|worker-jobs|local_worker|git-safety/i;
const READ_ONLY_BATCH_PATTERN =
  /\bBATCH-QA(?:-[A-Z0-9]+)*\b|\bBATCH-43\b|\bBATCH-GM-SMOKE(?:-\d+)?\b/i;
const WORKER_BATCH_CODE_PATTERN = /\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/gi;
export const DIAGNOSTICS_SCHEMA_VERSION = 1;
export const DIAGNOSTICS_STORAGE_FIELD = "result.diagnostics";
export const DIAGNOSTICS_STORAGE_UNAVAILABLE = "DIAGNOSTICS_STORAGE_UNAVAILABLE";
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,64}$/;
const IMPLEMENTED_DIAGNOSTICS_FAILURE_CODES = [
  "DIAGNOSTICS_STORAGE_UNAVAILABLE",
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
  "CODEX_EXE_NOT_FOUND",
  "CODEX_EXE_APP_ALIAS_OR_SHIM",
  "CODEX_EXE_UNSUPPORTED_FILE_TYPE",
  "CODEX_PREFLIGHT_FAILED",
  "CODEX_USAGE_LIMIT",
  "CODEX_QUOTA_EXHAUSTED",
  "CODEX_IDLE_TIMEOUT",
  "APPROVAL_CONTEXT_SAVE_FAILED",
  "APPROVAL_CONTEXT_BATCH_MISMATCH",
  "APPROVAL_CONTEXT_POLICY_MISMATCH",
  "AGENT_PAUSED",
  "EXACT_ALLOWED_SCOPE_MISSING",
  "TASK_INSERT_FAILED",
  "GIT_SYNC_PREFLIGHT_FAILED",
  "CHANGED_FILES_PARSE_FAILED",
  "UTF8_REPLY_CORRUPTED",
  "DEPLOYMENT_FAILED",
  "TERMINAL_REPORT_DUPLICATE",
  "WORKER_REPORT_CONTRACT_INCOMPLETE",
  "EXECUTION_POLICY_MISMATCH",
  "EXECUTION_POLICY_PAYLOAD_MISMATCH",
  "FINAL_REPORT_STATE_CONFLICT",
  "WORKER_REPORT_SCHEMA_INVALID",
  "UNKNOWN_FAILURE",
] as const;
const IMPLEMENTED_DIAGNOSTICS_FAILURE_STAGES = [
  "intake",
  "approval_context",
  "worker_creation",
  "worker_claim",
  "codex_preflight",
  "codex_execution",
  "validation",
  "git",
  "git_sync_preflight",
  "push",
  "report",
  "worker_payload_creation",
  "worker_execution_policy_validation",
  "worker_report_validation",
  "post_completion_report_validation",
  "notification",
  "deployment",
  "task_goal_validation",
  "unknown",
] as const;
const IMPLEMENTED_DIAGNOSTICS_FAILURE_CODE_SET = new Set<string>(IMPLEMENTED_DIAGNOSTICS_FAILURE_CODES);
const IMPLEMENTED_DIAGNOSTICS_FAILURE_STAGE_SET = new Set<string>(IMPLEMENTED_DIAGNOSTICS_FAILURE_STAGES);
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
const WORKER_BATCH_RELEVANT_LINE_PATTERN =
  /标题|title|修复目标|目标|批准|approved|approval|执行批次|当前批次/i;
const WORKER_BATCH_FORBIDDEN_FRAGMENT_PATTERN = /禁止范围|禁止修改|不得|不允许|forbidden|不执行/i;
const WORKER_BATCH_FORBIDDEN_SECTION_HEADING_PATTERN =
  /^\s*(?:[-*#>\d.、\s]*)?(?:【)?(?:禁止范围|禁止修改|forbidden)(?:】)?\s*[:：]?\s*$/i;
const WORKER_BATCH_FORBIDDEN_SECTION_EXIT_PATTERN =
  /标题|title|修复目标|(^|\s)目标\s*[:：]|批准|approved|approval|执行批次|当前执行批次/i;
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBooleanFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return /^(true|1|yes|on)$/i.test(value.trim());
  return false;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readBooleanFalseFlag(value: unknown): boolean {
  if (value === false) return true;
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") return /^(false|0|no|off)$/i.test(value.trim());
  return false;
}

function readNullableBooleanFlag(value: unknown): boolean | null {
  if (readBooleanFlag(value)) return true;
  if (readBooleanFalseFlag(value)) return false;
  return null;
}

function normalizeTaskMode(value: unknown): string | null {
  const text = readString(value)?.toLowerCase();
  if (!text) return null;
  return Object.values(TASK_MODES).includes(text as typeof TASK_MODES[keyof typeof TASK_MODES])
    ? text
    : null;
}

function isReadOnlyTaskMode(taskMode: unknown): boolean {
  return (
    taskMode === TASK_MODES.READ_ONLY ||
    taskMode === TASK_MODES.MANAGER_READ_ONLY ||
    taskMode === TASK_MODES.WORKER_READ_ONLY
  );
}

function isSystemRepairMode(input: {
  projectDomain: unknown;
  taskType: unknown;
  batchCode: unknown;
}): boolean {
  return (
    input.projectDomain === "automation_system" &&
    input.taskType === SYSTEM_REPAIR_TASK_TYPE &&
    typeof input.batchCode === "string" &&
    input.batchCode.startsWith(SYSTEM_REPAIR_BATCH_PREFIX)
  );
}

function decodeOriginalRequestTextBase64(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;

  const compact = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;

  try {
    const decoded = Buffer.from(compact, "base64").toString("utf8");
    const encodedAgain = Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/g, "");
    return encodedAgain === compact.replace(/=+$/g, "") ? decoded.trim() || null : null;
  } catch {
    return null;
  }
}

const WORKER_CONTEXT_FIELD_PATTERN =
  /\b(?:context_source|context_reconstruct_failed|project_domain|task_type|requested_mode|final_mode|task_mode|read_only_mode|repair_mode|repair_scope|verification_only|worker_only|allow_no_change_success|execution_intent|execution_policy_conflict|deterministic_git_operation|code_changes_required|codex_required|git_commit_required|git_push_required|approval_required|allowed_scope|exact_allowed_scope|exact_allowed_scope_count|writable_scope|readable_scope|read_only_operations|forbidden_operations|forbidden_scope|task_goal|required_output_fields|acceptance_conditions|original_request_text(?:_base64)?|route|approved_batch|batch_code|attempt_id|worker_stage|workflow_stage|final_report_status|effective_final_status|failure_code|failure_stage|changed_files|committed_files|codex_changed_files|worktree_changed_files|task_changed_files|unexpected_changed_files|git_commit_sha|codex_git_push|worker_git_push|git_push|pushed|pushed_branch|remote_contains_commit|repository_clean_after_push|terminal_report_acknowledged|terminal_state_persisted|duplicate_terminal_report_idempotent|post_completion_state_applied|final_report_source|next_batch|completed_at|deploy_status|execution_policy_source|execution_policy_batch_code|execution_policy_context_id|execution_policy_request_hash|execution_policy_inherited|execution_policy_inheritance_rejected_reason)\s*[:=]/i;

function contextFieldNamePattern(fieldName: string): string {
  return fieldName.replace(/_/g, "[_\\s-]*");
}

function decodeEscapedWorkerContextText(value: unknown): string {
  return String(value ?? "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

function stripWorkerContextValue(value: unknown): string {
  let stripped = String(value ?? "").trim();
  const first = stripped[0];
  const last = stripped[stripped.length - 1];
  if (
    stripped.length >= 2 &&
    ((first === "\"" && last === "\"") ||
      (first === "'" && last === "'") ||
      (first === "`" && last === "`") ||
      (first === "“" && last === "”"))
  ) {
    stripped = stripped.slice(1, -1).trim();
  }
  return stripped;
}

function extractWorkerContextFieldValues(text: unknown, fieldName: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(
    `(?:^|[^\\w-])${contextFieldNamePattern(fieldName)}\\s*[:=]\\s*`,
    "i"
  );

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const match = pattern.exec(rawLine);
    if (!match) continue;

    const rawValue = rawLine.slice(match.index + match[0].length);
    const decodedValue = decodeEscapedWorkerContextText(rawValue).split(/\r?\n/)[0] ?? "";
    const nextField = WORKER_CONTEXT_FIELD_PATTERN.exec(decodedValue);
    values.push(stripWorkerContextValue(nextField ? decodedValue.slice(0, nextField.index) : decodedValue));
  }

  return values.filter(Boolean);
}

function extractOriginalRequestTextsFromContext(text: unknown): string[] {
  const nestedTexts: string[] = [];

  for (const value of extractWorkerContextFieldValues(text, "original_request_text_base64")) {
    const base64Token = value.match(/[A-Za-z0-9+/=]+/)?.[0] ?? "";
    const decoded = decodeOriginalRequestTextBase64(base64Token);
    if (decoded) nestedTexts.push(decoded);
  }

  for (const value of extractWorkerContextFieldValues(text, "original_request_text")) {
    const decoded = decodeEscapedWorkerContextText(value).trim();
    if (decoded) nestedTexts.push(decoded);
  }

  return nestedTexts;
}

function expandWorkerContextTexts(text: unknown, seen = new Set<string>(), depth = 0): string[] {
  if (depth > 5) return [];

  const raw = String(text ?? "");
  if (!raw.trim()) return [];

  const expanded: string[] = [];
  const candidates = [raw, decodeEscapedWorkerContextText(raw)];

  for (const candidate of candidates) {
    const normalizedCandidate = candidate.trim();
    if (!normalizedCandidate || seen.has(normalizedCandidate)) continue;

    seen.add(normalizedCandidate);
    expanded.push(normalizedCandidate);

    for (const nestedText of extractOriginalRequestTextsFromContext(normalizedCandidate)) {
      expanded.push(...expandWorkerContextTexts(nestedText, seen, depth + 1));
    }
  }

  return expanded;
}

function readLatestWorkerContextField(text: unknown, fieldName: string): string | null {
  const values = expandWorkerContextTexts(text).flatMap((contextText) =>
    extractWorkerContextFieldValues(contextText, fieldName)
  );
  return values.length > 0 ? values[values.length - 1] : null;
}

function readMergedWorkerContextField(text: unknown, fieldName: string): string | null {
  const values = expandWorkerContextTexts(text).flatMap((contextText) =>
    extractWorkerContextFieldValues(contextText, fieldName)
  );
  const uniqueValues = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  return uniqueValues.length > 0 ? uniqueValues.join(", ") : null;
}

function readScopeText(value: unknown): string | null {
  if (Array.isArray(value)) {
    const items = value.map((item) => readString(item)).filter(Boolean);
    return items.length > 0 ? items.join(", ") : null;
  }
  return readString(value);
}

function readContractText(value: unknown): string | null {
  const items = readStringArray(value);
  if (items.length > 0) return items.join("\n");
  const text = readTextValue(value).trim();
  return text || null;
}

function firstPresentValue(...values: unknown[]): unknown {
  return values.find(
    (value) =>
      value !== null &&
      value !== undefined &&
      !(typeof value === "string" && value.trim() === "")
  );
}

function readTextValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(readTextValue).filter(Boolean).join("\n");
  if (typeof value === "object") return Object.values(value).map(readTextValue).filter(Boolean).join("\n");
  return String(value);
}

function escapeRegExp(value: unknown): string {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripListMarker(value: unknown): string {
  return String(value ?? "")
    .replace(/^\s*(?:[-*]|\d+[.)、])\s*/, "")
    .trim();
}

function lineIsTaskSectionHeading(line: string): boolean {
  const text = stripListMarker(line);
  if (!text) return false;
  if (/^(?:[A-Za-z_][A-Za-z0-9_\s-]{2,60}|[\u4e00-\u9fffA-Za-z0-9_\s/-]{2,60})\s*[:：]\s*$/.test(text)) return true;
  return /^【[^】]+】$/.test(text);
}

function extractTaskSection(
  text: unknown,
  headingPatterns: RegExp[],
  options: { maxLines?: number } = {}
): string | null {
  const lines = String(text ?? "").split(/\r?\n/);
  const collected: string[] = [];
  let collecting = false;
  const maxLines = options.maxLines ?? 30;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!collecting) {
      const matched = headingPatterns.some((pattern) => pattern.test(line));
      if (!matched) continue;

      const inlineValue = line.split(/[:：]/).slice(1).join(":").trim();
      if (inlineValue) return stripListMarker(inlineValue);
      collecting = true;
      continue;
    }

    if (!line) {
      if (collected.length > 0) break;
      continue;
    }

    if (lineIsTaskSectionHeading(line) && !/^\s*(?:[-*]|\d+[.)、])\s+/.test(rawLine)) break;

    collected.push(stripListMarker(line));
    if (collected.length >= maxLines) break;
  }

  const section = collected.filter(Boolean).join("\n").trim();
  return section || null;
}

function extractTaskGoalFromText(text: unknown): string | null {
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

function extractRequiredOutputFieldsFromText(text: unknown): string | null {
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

function extractAcceptanceConditionsFromText(text: unknown): string | null {
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

function parseRequiredOutputFieldList(value: unknown): string[] {
  return readStringArray(value)
    .flatMap((item) => String(item ?? "").split(/\r?\n/))
    .map((item) => stripListMarker(item).replace(/^`|`$/g, "").trim())
    .map((item) => item.split(/[:：=]/)[0].trim() || item)
    .filter(Boolean);
}

function requiredOutputFieldMatchesReport(field: string, reportText: unknown): boolean {
  const label = String(field ?? "").trim();
  if (!label) return true;
  const report = String(reportText ?? "");
  if (report.includes(label)) return true;

  const normalizedLabel = label.replace(/^`|`$/g, "").replace(/\s+/g, " ").trim();
  if (!normalizedLabel) return true;

  const pattern = new RegExp(
    escapeRegExp(normalizedLabel).replace(/[_\s-]+/g, "[_\\s-]+"),
    "i"
  );
  return pattern.test(report);
}

function getMissingWorkerReadOnlyRequiredOutputFields(
  contract: Record<string, unknown>,
  reportText: unknown
): string[] {
  return parseRequiredOutputFieldList(contract.required_output_fields)
    .filter((field) => !requiredOutputFieldMatchesReport(field, reportText));
}

function readWorkerJobContextText(
  job: JobRecord | null,
  payload: Record<string, unknown> | null,
  result: Record<string, unknown> | null
): string {
  return [
    job?.request_text,
    job?.requestText,
    job?.prompt,
    job?.description,
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
  ]
    .map(readTextValue)
    .filter(Boolean)
    .join("\n");
}

function readLatestOriginalRequestText(text: unknown): string | null {
  const expandedTexts = expandWorkerContextTexts(text);
  const explicitTexts = expandedTexts.flatMap(extractOriginalRequestTextsFromContext);
  if (explicitTexts.length > 0) return explicitTexts[explicitTexts.length - 1];
  return null;
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
  "terminal_report_acknowledged",
  "terminal_state_persisted",
  "duplicate_terminal_report_idempotent",
  "post_completion_state_applied",
  "final_report_source",
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
  "verification_only",
  "allow_no_change_success",
  "execution_intent",
  "allowed_scope",
  "forbidden_scope",
  "route",
];

interface WorkerContextCandidate {
  fields: Record<string, string>;
  depth: number;
  sourceLabel: string;
  startIndex: number;
  distance: number;
  fieldCount: number;
  coreMissing: number;
}

function canonicalWorkerContextFieldName(fieldName: string): string {
  if (fieldName === "batch_code") return "approved_batch";
  return fieldName === "workflow_stage" ? "worker_stage" : fieldName;
}

function extractOriginalTaskBody(text: unknown): string {
  const raw = String(text ?? "");
  const marker = "【原始任务内容】";
  const markerIndex = raw.lastIndexOf(marker);
  if (markerIndex < 0) return raw;

  const afterMarker = raw.slice(markerIndex + marker.length);
  const stopMarkers = ["【再次强调】", "【Windows Worker 强制规则】"];
  const stopIndex = stopMarkers
    .map((stopMarker) => afterMarker.indexOf(stopMarker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return (stopIndex >= 0 ? afterMarker.slice(0, stopIndex) : afterMarker).trim();
}

function parseWorkerContextFieldLine(rawLine: string): { fieldName: string; value: string } | null {
  for (const fieldName of WORKER_CONTEXT_FIELD_NAMES) {
    const pattern = new RegExp(
      `(?:^|[^\\w-])${contextFieldNamePattern(fieldName)}\\s*[:=]\\s*`,
      "i"
    );
    const match = pattern.exec(rawLine);
    if (!match) continue;

    const rawValue = rawLine.slice(match.index + match[0].length);
    const decodedValue = decodeEscapedWorkerContextText(rawValue).split(/\r?\n/)[0] ?? "";
    const nextField = WORKER_CONTEXT_FIELD_PATTERN.exec(decodedValue);
    const value = stripWorkerContextValue(nextField ? decodedValue.slice(0, nextField.index) : decodedValue);
    return { fieldName: canonicalWorkerContextFieldName(fieldName), value };
  }
  return null;
}

function parseWorkerContextFields(text: unknown): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const parsed = parseWorkerContextFieldLine(rawLine.trim());
    if (!parsed?.value) continue;

    if (parsed.fieldName === "original_request_text_base64") {
      fields.original_request_text_base64 = parsed.value;
      const decoded = decodeOriginalRequestTextBase64(parsed.value.match(/[A-Za-z0-9+/=]+/)?.[0] ?? "");
      if (decoded) fields.original_request_text = decoded;
      continue;
    }

    fields[parsed.fieldName] = parsed.value;
  }

  return fields;
}

function findOriginalDemandAnchor(text: unknown): number {
  const raw = String(text ?? "");
  const indexes = ["【原始任务内容】", "新需求", "Original task", "original_request_text"]
    .map((marker) => raw.indexOf(marker))
    .filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : 0;
}

function extractHermesContextCandidatesFromText(
  text: unknown,
  options: { depth?: number; sourceLabel?: string; seen?: Set<string> } = {}
): WorkerContextCandidate[] {
  const raw = String(text ?? "");
  if (!raw.trim()) return [];

  const depth = options.depth ?? 0;
  const sourceLabel = options.sourceLabel ?? "request_text";
  const seen = options.seen ?? new Set<string>();
  const candidates: WorkerContextCandidate[] = [];

  for (const variant of [raw, decodeEscapedWorkerContextText(raw)]) {
    const normalizedVariant = variant.trim();
    const seenKey = `${depth}:${sourceLabel}:${normalizedVariant}`;
    if (!normalizedVariant || seen.has(seenKey)) continue;
    seen.add(seenKey);

    const lines = normalizedVariant.split(/\r?\n/);
    const lineStarts: number[] = [];
    let cursor = 0;
    for (const line of lines) {
      lineStarts.push(cursor);
      cursor += line.length + 1;
    }

    for (let index = 0; index < lines.length; index += 1) {
      if (!/^\s*HERMES_WORKER_CONTEXT\s*[:：]\s*$/i.test(lines[index])) continue;

      const blockLines: string[] = [];
      for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
        if (/^\s*HERMES_WORKER_CONTEXT\s*[:：]\s*$/i.test(lines[blockIndex])) break;
        blockLines.push(lines[blockIndex]);
      }

      const fields = parseWorkerContextFields(blockLines.join("\n"));
      const fieldCount = Object.values(fields).filter((value) => readString(value)).length;
      if (fieldCount === 0) continue;

      const startIndex = lineStarts[index] ?? 0;
      const anchor = findOriginalDemandAnchor(normalizedVariant);
      const coreMissing = WORKER_CONTEXT_CORE_FIELDS.filter((fieldName) => !readString(fields[fieldName])).length;
      candidates.push({
        fields,
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

function selectPreferredHermesContext(text: unknown): WorkerContextCandidate | null {
  const candidates = extractHermesContextCandidatesFromText(text);
  if (candidates.length === 0) return null;

  return candidates.sort((a, b) => {
    if (a.coreMissing !== b.coreMissing) return a.coreMissing - b.coreMissing;
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.fieldCount !== b.fieldCount) return b.fieldCount - a.fieldCount;
    return a.startIndex - b.startIndex;
  })[0];
}

function readTextContextField(text: unknown, fieldName: string): string | null {
  const taskBody = extractOriginalTaskBody(text);
  if (fieldName === "original_request_text") {
    const base64Values = extractWorkerContextFieldValues(taskBody, "original_request_text_base64");
    const decoded = base64Values
      .map((value) => decodeOriginalRequestTextBase64(value.match(/[A-Za-z0-9+/=]+/)?.[0] ?? ""))
      .filter(Boolean);
    if (decoded.length > 0) return decoded[decoded.length - 1] ?? null;
  }

  const values = extractWorkerContextFieldValues(taskBody, fieldName);
  return values.length > 0 ? values[values.length - 1] ?? null : null;
}

function readPayloadContextField(
  payload: Record<string, unknown> | null | undefined,
  fieldName: string
): unknown {
  if (!payload || typeof payload !== "object") return null;

  const aliases: Record<string, string[]> = {
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
    terminal_report_acknowledged: ["terminal_report_acknowledged", "terminalReportAcknowledged"],
    terminal_state_persisted: ["terminal_state_persisted", "terminalStatePersisted"],
    duplicate_terminal_report_idempotent: [
      "duplicate_terminal_report_idempotent",
      "duplicateTerminalReportIdempotent",
    ],
    post_completion_state_applied: ["post_completion_state_applied", "postCompletionStateApplied"],
    final_report_source: ["final_report_source", "finalReportSource", "post_completion_source", "postCompletionSource"],
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

  for (const key of aliases[fieldName] ?? [fieldName]) {
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
      const scopeValue = readScopeText(value);
      if (scopeValue) return scopeValue;
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number") return value;
    const textValue = readString(value);
    if (textValue) return textValue;
  }

  return null;
}

function hasStructuredPayloadContext(payload: Record<string, unknown> | null): boolean {
  return Boolean(
    payload &&
      (readPayloadContextField(payload, "route") !== null ||
        readPayloadContextField(payload, "allowed_scope") !== null ||
        readPayloadContextField(payload, "forbidden_scope") !== null ||
        readPayloadContextField(payload, "original_request_text") !== null ||
        readPayloadContextField(payload, "approved_batch") !== null ||
        readPayloadContextField(payload, "worker_stage") !== null ||
        readPayloadContextField(payload, "final_report_status") !== null)
  );
}

function hasPayloadContext(payload: Record<string, unknown> | null): boolean {
  return Boolean(
    payload &&
      WORKER_CONTEXT_CORE_FIELDS.some((fieldName) => readPayloadContextField(payload, fieldName) !== null)
  );
}

function findBatchCodes(text: unknown): string[] {
  const matches = String(text ?? "").match(WORKER_BATCH_CODE_PATTERN) ?? [];
  const seen = new Set<string>();
  const codes: string[] = [];

  for (const match of matches) {
    const key = match.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    codes.push(match);
  }

  return codes;
}

function stripForbiddenBatchFragments(line: string): string {
  return line.split(WORKER_BATCH_FORBIDDEN_FRAGMENT_PATTERN)[0].trim();
}

function extractRelevantBatchTextFromRequest(text: unknown): string {
  const lines = String(text ?? "").split(/\r?\n/);
  const chunks: string[] = [];
  let inForbiddenSection = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line) {
      inForbiddenSection = false;
      continue;
    }

    const isRelevantLine =
      (index === 0 && /^新需求[:：]/.test(line)) ||
      WORKER_BATCH_RELEVANT_LINE_PATTERN.test(line);

    if (WORKER_BATCH_FORBIDDEN_SECTION_HEADING_PATTERN.test(line) && !isRelevantLine) {
      inForbiddenSection = true;
      continue;
    }

    if (inForbiddenSection) {
      if (!WORKER_BATCH_FORBIDDEN_SECTION_EXIT_PATTERN.test(line)) {
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

export function extractCurrentExecutionBatchCode(
  job: JobRecord | null | undefined
): string | null {
  const titleCodes = findBatchCodes(job?.title);
  if (titleCodes.length > 0) return titleCodes[0];

  const requestText = [
    readString(job?.request_text),
    readString(job?.prompt),
    readString(job?.description),
  ]
    .filter(Boolean)
    .join("\n");
  const requestCodes = findBatchCodes(extractRelevantBatchTextFromRequest(requestText));
  return requestCodes[0] ?? null;
}

function classifyWorkerTaskDomain(text: unknown): string {
  const value = String(text ?? "");
  if (/\bproject[_\s-]*domain\s*[:=]\s*automation_system\b/i.test(value)) return "automation_system";
  if (isBatchFixProductTaskText(value)) return "city_partner_product";
  if (QA_BATCH_PATTERN.test(value)) return "qa_review";

  if (/文档整理|整理文档|归档|governance[_ -]?docs/i.test(value)) return "governance_docs";
  if (/Worker|Codex|Hermes|飞书|项目总管|总管|自动化|路由|上报|NO_FIX_APPLIED|git_commit_sha|attempt_id|automation[_ -]?system/i.test(value)) {
    return "automation_system";
  }
  if (/测试审核|测试|审核|验收|复测|qa[_ -]?review|QA review|test review/i.test(value)) return "qa_review";
  if (/运营|运维|发布|部署|上线|监控|operations?|ops|release|deploy/i.test(value)) return "operations";

  return "general";
}

function isBatchFixProductTaskText(text: unknown): boolean {
  const value = String(text ?? "");
  return BATCH_FIX_PATTERN.test(value) && BATCH_FIX_PRODUCT_SIGNAL_PATTERN.test(value);
}

function isSafePostgrestFilterValue(value: string): boolean {
  return /^[A-Za-z0-9._:@-]+$/.test(value);
}

export function getWorkerIdFromRequest(req: NextRequest): string {
  return (
    readString(req.headers.get("x-worker-id")) ??
    readString(req.headers.get("x-worker-name")) ??
    readString(req.nextUrl.searchParams.get("worker_id")) ??
    readString(req.nextUrl.searchParams.get("worker_name")) ??
    "unknown-worker"
  );
}

export function getWorkerIdFromBody(body: {
  worker_id?: unknown;
  worker_name?: unknown;
  workerId?: unknown;
  workerName?: unknown;
}): string {
  return (
    readString(body.worker_id) ??
    readString(body.worker_name) ??
    readString(body.workerId) ??
    readString(body.workerName) ??
    "unknown-worker"
  );
}

export function getAttemptIdFromBody(body: {
  attempt_id?: unknown;
  attemptId?: unknown;
}): string | null {
  return readString(body.attempt_id) ?? readString(body.attemptId);
}

export function getBatchCodeFromBody(body: {
  batch_code?: unknown;
  batchCode?: unknown;
  dispatch_batch?: unknown;
  task_code?: unknown;
}): string | null {
  return (
    readString(body.batch_code) ??
    readString(body.batchCode) ??
    readString(body.dispatch_batch) ??
    readString(body.task_code)
  );
}

export function getCreatedAtFromBody(body: {
  created_at?: unknown;
  createdAt?: unknown;
  job_created_at?: unknown;
  jobCreatedAt?: unknown;
}): string | null {
  return (
    readString(body.job_created_at) ??
    readString(body.jobCreatedAt) ??
    readString(body.created_at) ??
    readString(body.createdAt)
  );
}

export function buildRunningJobNotFoundPayload(input: {
  jobId: string;
  attemptId: string | null;
  batchCode?: string | null;
  createdAt?: string | null;
  workerId?: string | null;
  endpoint: string;
}): Record<string, unknown> {
  return {
    ok: false,
    error: "running_job_not_found",
    endpoint: input.endpoint,
    job_id: input.jobId,
    batch_code: input.batchCode ?? "not_provided",
    attempt_id: input.attemptId ?? "not_provided",
    created_at: input.createdAt ?? "not_provided",
    worker_id: input.workerId ?? "not_provided",
    message:
      "Worker reported a job id that does not exist in hermes_jobs. Check stale Worker state, duplicate attempts, and whether the final report used the claimed job id.",
  };
}

export function createWorkerAttemptId(jobId: string, workerId: string, now = Date.now()): string {
  const safeJob = jobId.replace(/[^A-Za-z0-9._:-]/g, "_");
  const safeWorker = workerId.replace(/[^A-Za-z0-9._:-]/g, "_");
  return `${safeJob}:${safeWorker}:${now.toString(36)}`;
}

export function getClaimedBy(job: JobRecord | null | undefined): string | null {
  if (!job) return null;
  return readString(job.claimed_by);
}

export function getActiveAttemptId(job: JobRecord | null | undefined): string | null {
  const attempt = getCanonicalActiveAttempt(job);
  return readString(attempt?.id ?? attempt?.attempt_id);
}

export function getStoredTerminalAttemptId(job: JobRecord | null | undefined): string | null {
  if (!job) return null;
  const result = readRecord(job.result);
  return getActiveAttemptId(job) ?? readString(result?.attempt_id);
}

function stripAttemptContextFromRequestText(value: unknown): string {
  return String(value ?? "")
    .replace(/\n*HERMES_WORKER_ATTEMPT_CONTEXT:\n(?:`[^`\r\n]+=[^`\r\n]*`\n?)+/g, "")
    .trim();
}

export function buildAttemptRequestText(job: JobRecord | null | undefined, attempt: Record<string, unknown>): string {
  const original = stripAttemptContextFromRequestText(job?.request_text);
  const attemptId = readString(attempt.attempt_id) ?? "";
  const workerId = readString(attempt.worker_id) ?? "";
  const claimedAt = readString(attempt.started_at) ?? readString(attempt.claimed_at) ?? "";
  const context = [
    "HERMES_WORKER_ATTEMPT_CONTEXT:",
    `\`attempt_id=${attemptId}\``,
    `\`active_attempt_id=${attemptId}\``,
    `\`worker_id=${workerId}\``,
    `\`claimed_at=${claimedAt}\``,
  ].join("\n");
  return [original, context].filter(Boolean).join("\n\n").trim();
}

export function readAttemptContextFromRequestText(value: unknown): Record<string, string> | null {
  const text = String(value ?? "");
  const marker = text.lastIndexOf("HERMES_WORKER_ATTEMPT_CONTEXT:");
  if (marker < 0) return null;
  const contextText = text.slice(marker);
  const result: Record<string, string> = {};
  for (const match of contextText.matchAll(/`([^=`\r\n]+)=([^`\r\n]*)`/g)) {
    result[match[1]] = match[2];
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function terminalAttemptMatches(job: JobRecord | null | undefined, attemptId: string | null): boolean {
  const storedAttemptId = getStoredTerminalAttemptId(job);
  if (!storedAttemptId) return !attemptId;
  return attemptId === storedAttemptId;
}

function readLineValue(content: string, key: string): string | null {
  const line = content.split(/\r?\n/).find((item) => item.startsWith(`${key}: `));
  return line ? line.slice(key.length + 2).trim() || null : null;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function placeholder(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : "未提供";
}

function sanitizeReportText(value: unknown): string {
  return String(value ?? "")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[redacted]")
    .replace(/\b(sb_secret|service_role|app_secret|tenant_access_token|access_token|refresh_token|api_key|password)\b\s*[:=]\s*['"]?[^'"\s,}]+/gi, "$1=[redacted]")
    .replace(/\b(WORKER_TOKEN|WORKER_API_TOKEN|HERMES_WORKER_TOKEN|FEISHU_APP_SECRET|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_JWT_SECRET)\b\s*[:=]\s*['"]?[^'"\s,}]+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 40)}\n...[已截断，保留关键字段]`;
}

function sanitizeDiagnosticsErrorSummary(value: unknown): string | null {
  const text = sanitizeReportText(value)
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

function normalizeDiagnosticsFailureCode(value: unknown, effectiveFinalStatus: unknown, reportText?: unknown): string | null {
  const normalized = normalizeFailureCodeValue(value);
  if (normalized && FAILURE_CODE_PATTERN.test(normalized) && IMPLEMENTED_DIAGNOSTICS_FAILURE_CODE_SET.has(normalized)) {
    return normalized;
  }
  const classified = classifyFailureCodeFromText(reportText);
  if (classified && FAILURE_CODE_PATTERN.test(classified) && IMPLEMENTED_DIAGNOSTICS_FAILURE_CODE_SET.has(classified)) {
    return classified;
  }
  return normalizeTerminalStatus(effectiveFinalStatus) === "failed" ? "UNKNOWN_FAILURE" : null;
}

function normalizeDiagnosticsFailureStage(value: unknown, failureCode: unknown, effectiveFinalStatus: unknown): string | null {
  const stage = readString(value);
  if (stage && IMPLEMENTED_DIAGNOSTICS_FAILURE_STAGE_SET.has(stage)) return stage;
  if (normalizeFailureCodeValue(failureCode) === "CODEX_USAGE_LIMIT") return "codex_execution";
  if (normalizeFailureCodeValue(failureCode) === "GIT_SYNC_FAILED") return "git_sync_preflight";
  if (normalizeTerminalStatus(effectiveFinalStatus) === "failed") return "unknown";
  return null;
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  const text = readString(value);
  if (!text || !/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function buildWorkerFailureDiagnostics(input: {
  job: JobRecord | null;
  contract: Record<string, unknown>;
  normalizedFinalResult: Record<string, unknown>;
  workerExecutionStatus: string;
  taskGoalStatus: string;
  effectiveFinalStatus: string;
  failureCode: string | null;
  failureStage: string | null;
  batchCode: string | null;
  attemptId: string | null;
  completedAt: string | null;
  errorText: string | null;
  summary: string;
}): Record<string, unknown> {
  const jobPayload = readRecord(input.job?.payload);
  const jobResult = readRecord(input.job?.result);
  const effectiveStatus = normalizeTerminalStatus(input.effectiveFinalStatus) ?? "failed";
  const reportText = [input.errorText, input.summary].filter(Boolean).join("\n");
  const failureCode = normalizeDiagnosticsFailureCode(input.failureCode, effectiveStatus, reportText);
  const failureStage = normalizeDiagnosticsFailureStage(input.failureStage, failureCode, effectiveStatus);
  const codexExecutableExists = readNullableBooleanFlag(
    readDiagnosticLine(reportText, "codex_executable_exists")
  );
  const codexExecutableIsAppAlias = readNullableBooleanFlag(
    readDiagnosticLine(reportText, "codex_executable_is_app_alias")
  );
  return {
    diagnostics_schema_version: DIAGNOSTICS_SCHEMA_VERSION,
    failure_code: effectiveStatus === "failed" ? failureCode : null,
    failure_stage: effectiveStatus === "failed" ? failureStage : null,
    worker_execution_status: input.workerExecutionStatus || "unknown",
    task_goal_status: input.taskGoalStatus || "unknown",
    effective_final_status: effectiveStatus,
    project_domain: readString(input.contract.project_domain) ?? readString(jobPayload?.project_domain) ?? readString(jobResult?.project_domain) ?? "unknown",
    requested_mode: readString(input.contract.requested_mode) ?? readString(jobPayload?.requested_mode) ?? readString(jobResult?.requested_mode) ?? "unknown",
    task_mode: readString(input.contract.task_mode) ?? readString(jobPayload?.task_mode) ?? readString(jobResult?.task_mode) ?? "unknown",
    batch: readString(input.contract.approved_batch) ?? input.batchCode ?? readString(jobPayload?.approved_batch) ?? readString(jobResult?.batch_code) ?? "unknown",
    attempt_id: input.attemptId ?? readString(input.normalizedFinalResult.attempt_id) ?? readString(input.job?.attempt_id),
    retry_count: readNonNegativeInteger(input.job?.retry_count) ?? readNonNegativeInteger(jobPayload?.retry_count) ?? readNonNegativeInteger(jobResult?.retry_count),
    completed_at: input.completedAt,
    diagnostics_source: "worker_report_api",
    codex_resolution_source: readDiagnosticLine(reportText, "codex_resolution_source"),
    codex_requested_path: readDiagnosticLine(reportText, "codex_requested_path"),
    codex_executable_resolved: readDiagnosticLine(reportText, "codex_executable_resolved"),
    codex_executable_exists: codexExecutableExists,
    codex_executable_file_type: readDiagnosticLine(reportText, "codex_executable_file_type"),
    codex_executable_version: readDiagnosticLine(reportText, "codex_executable_version"),
    codex_executable_is_app_alias: codexExecutableIsAppAlias,
    codex_preflight_status: readDiagnosticLine(reportText, "codex_preflight_status"),
    stdin_transport_verified: readDiagnosticLine(reportText, "stdin_transport_verified"),
    prompt_in_spawnargs: readDiagnosticLine(reportText, "prompt_in_spawnargs"),
    error_summary: sanitizeDiagnosticsErrorSummary(reportText),
  };
}
function readDiagnosticLine(content: string, label: string): string | null {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, "[_\\s-]*");
  const pattern = new RegExp(`^\\s*${escapedLabel}\\s*[:=：]\\s*(.*?)\\s*$`, "i");
  const line = content.split(/\r?\n/).find((item) => pattern.test(item.trim()));

  if (!line) return null;
  const match = line.match(pattern);
  return match?.[1]?.trim() || null;
}

function normalizeTerminalStatus(value: unknown): "queued" | "running" | "succeeded" | "failed" | "cancelled" | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (["success", "succeeded", "completed", "complete"].includes(text)) return "succeeded";
  if (["fail", "failed", "error"].includes(text)) return "failed";
  if (["cancel", "cancelled", "canceled"].includes(text)) return "cancelled";
  if (["queued", "pending"].includes(text)) return "queued";
  if (["running", "in_progress"].includes(text)) return "running";
  return null;
}

function normalizeFailureCodeValue(value: unknown): string | null {
  const text = readString(value);
  if (!text || /^(null|none|n\/a|not[_ -]?provided|undefined)$/i.test(text)) return null;
  const code = text
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  const aliases: Record<string, string> = {
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
  return aliases[code] ?? code;
}

function classifyNonTaskFailureCode(text: unknown): string | null {
  const raw = String(text ?? "");
  for (const item of NON_TASK_FAILURE_PATTERNS) {
    if (item.pattern.test(raw)) return item.code;
  }
  return null;
}

function classifyFailureCodeFromText(text: unknown): string | null {
  const raw = String(text ?? "");
  const nonTaskFailureCode = classifyNonTaskFailureCode(raw);
  if (nonTaskFailureCode) return nonTaskFailureCode;
  if (/You've hit your usage limit|usage limit|purchase more credits|try again at/i.test(raw)) return "CODEX_USAGE_LIMIT";
  if (
    /git\s+(?:fetch|pull|ls-remote|sync|remote)|schannel|TLS|SSL|CERT|handshake|timed?\s*out|timeout|ECONNRESET|EAI_AGAIN|ENOTFOUND|fetch failed|connection reset/i.test(
      raw
    )
  ) {
    return "GIT_SYNC_FAILED";
  }
  if (/NO_FIX_APPLIED|no_fix_applied\s*[:=]\s*(true|yes)|Task goal status:\s*failed_no_fix_applied/i.test(raw)) return "NO_FIX_APPLIED";
  if (/READ_ONLY_MODE_VIOLATION|read_only_mode_violation\s*[:=]\s*(true|yes)|Read-only violation:\s*yes|Task goal status:\s*failed_read_only_mode_violation/i.test(raw)) return "READ_ONLY_MODE_VIOLATION";
  if (/TASK_MODE_MISMATCH|task_mode_mismatch\s*[:=]\s*(true|yes)|Task goal status:\s*failed_task_mode_mismatch/i.test(raw)) return "TASK_MODE_MISMATCH";
  if (/MISSING_REQUIRED_DOCS|Task goal status:\s*failed_missing_required_docs/i.test(raw)) return "MISSING_REQUIRED_DOCS";
  if (/INSUFFICIENT_DOC_OUTPUT|insufficient_doc_output\s*[:=]\s*(true|yes)|Task goal status:\s*failed_insufficient_doc_output/i.test(raw)) return "INSUFFICIENT_DOC_OUTPUT";
  if (/INCOMPLETE_QA_REPORT|incomplete_qa_report\s*[:=]\s*(true|yes)|Task goal status:\s*failed_incomplete_qa_report/i.test(raw)) return "INCOMPLETE_QA_REPORT";
  if (/INCOMPLETE_ARCHITECTURE_REPORT|incomplete_architecture_report\s*[:=]\s*(true|yes)|Task goal status:\s*failed_incomplete_architecture_report/i.test(raw)) return "INCOMPLETE_ARCHITECTURE_REPORT";
  if (/WORKER_READONLY_CONTEXT_INCOMPLETE|worker_readonly_context_incomplete|missing_worker_readonly_context_fields|Task goal status:\s*failed_worker_readonly_context_incomplete/i.test(raw)) return "WORKER_READONLY_CONTEXT_INCOMPLETE";
  if (/node\s+--test|tests?\s+failed|test\s+failure|测试失败/i.test(raw)) return "TEST_FAILED";
  if (/typescript|tsc|typecheck|TypeScript\s+检查失败/i.test(raw)) return "TYPESCRIPT_FAILED";
  if (/context_reconstruct_failed\s*[:=：]\s*true|ORIGINAL_BATCH_CONTEXT_MISSING|上下文恢复失败|context.*(?:missing|failed|缺失|失败)/i.test(raw)) {
    return "CONTEXT_RECONSTRUCT_FAILED";
  }
  if (/OUT_OF_SCOPE|BUSINESS_PAGE_BOUNDARY_VIOLATION|越界修改|范围边界/i.test(raw)) return "OUT_OF_SCOPE_CHANGE";
  if (/git\s+commit|commit\s+失败|commit failed/i.test(raw)) return "GIT_COMMIT_FAILED";
  if (/git\s+push|push\s+失败|push failed/i.test(raw)) return "GIT_PUSH_FAILED";
  return null;
}

export function isTrueTaskFailureCode(code: unknown): boolean {
  const normalized = normalizeFailureCodeValue(code);
  return Boolean(normalized && TRUE_TASK_FAILURE_CODES.has(normalized));
}

function isNonTaskFailureCode(code: unknown): boolean {
  const normalized = normalizeFailureCodeValue(code);
  return Boolean(normalized && NON_TASK_FAILURE_CODES.has(normalized));
}

function extractNextBatchFromText(text: unknown): string | null {
  const explicit = readDiagnosticLine(String(text ?? ""), "next_batch");
  const match = String(explicit ?? text ?? "").match(/\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i);
  return match ? match[0].toUpperCase() : null;
}

function inferNextBatchFromBatchCode(batchCode: string | null): string | null {
  const match = String(batchCode ?? "").trim().match(/^(BATCH-[A-Z]+-)(\d+)$/i);
  if (!match) return null;
  return `${match[1].toUpperCase()}${String(Number(match[2]) + 1).padStart(match[2].length, "0")}`;
}

export function buildTerminalJobIndex(finalResult: Record<string, unknown>): Record<string, unknown> {
  return {
    job_id: readString(finalResult.job_id),
    approved_batch: readString(finalResult.approved_batch),
    worker_execution_status: readString(finalResult.worker_execution_status),
    task_goal_status: readString(finalResult.task_goal_status),
    effective_final_status: readString(finalResult.effective_final_status),
    failure_code: readString(finalResult.failure_code),
    failure_stage: readString(finalResult.failure_stage),
    changed_files: readStringArray(finalResult.changed_files),
    committed_files: readStringArray(finalResult.committed_files ?? finalResult.changed_files),
    codex_changed_files: readStringArray(finalResult.codex_changed_files),
    worktree_changed_files: readStringArray(finalResult.worktree_changed_files),
    task_changed_files: readStringArray(finalResult.task_changed_files ?? finalResult.changed_files),
    unexpected_changed_files: readStringArray(finalResult.unexpected_changed_files),
    git_commit_sha: readString(finalResult.git_commit_sha),
    codex_git_push: readString(finalResult.codex_git_push),
    worker_git_push:
      typeof finalResult.worker_git_push === "boolean"
        ? finalResult.worker_git_push
        : readNullableBooleanFlag(finalResult.worker_git_push) ?? false,
    pushed:
      typeof finalResult.pushed === "boolean"
        ? finalResult.pushed
        : readNullableBooleanFlag(finalResult.pushed) ?? false,
    git_push:
      typeof finalResult.git_push === "boolean"
        ? finalResult.git_push
        : readNullableBooleanFlag(finalResult.git_push) ??
          readNullableBooleanFlag(finalResult.pushed) ??
          false,
    pushed_branch: readString(finalResult.pushed_branch),
    remote_contains_commit:
      typeof finalResult.remote_contains_commit === "boolean"
        ? finalResult.remote_contains_commit
        : readNullableBooleanFlag(finalResult.remote_contains_commit) ?? false,
    repository_clean_after_push:
      typeof finalResult.repository_clean_after_push === "boolean"
        ? finalResult.repository_clean_after_push
        : readNullableBooleanFlag(finalResult.repository_clean_after_push) ?? false,
    next_batch: readString(finalResult.next_batch),
    next_stage_allowed:
      typeof finalResult.next_stage_allowed === "boolean"
        ? finalResult.next_stage_allowed
        : readNullableBooleanFlag(finalResult.next_stage_allowed) ?? false,
    reply_error: readString(finalResult.reply_error),
    post_completion_transport_warning: readBooleanFlag(finalResult.post_completion_transport_warning),
    post_completion_warning_count: Number(finalResult.post_completion_warning_count) || 0,
    completed_at: readString(finalResult.completed_at),
  };
}

function buildFailureMemoryStatus(finalResult: Record<string, unknown>): string {
  const status = normalizeTerminalStatus(finalResult.effective_final_status);
  const failureCode = normalizeFailureCodeValue(finalResult.failure_code);
  if (status === "succeeded") return "skipped_success";
  if (status === "cancelled") return "skipped_cancelled";
  if (status !== "failed") return "skipped_non_terminal";
  if (!failureCode || isNonTaskFailureCode(failureCode)) return "skipped_non_task_failure";
  return isTrueTaskFailureCode(failureCode) ? "recordable" : "skipped_non_task_failure";
}

export function buildAutoIterationSuggestion(finalResult: Record<string, unknown>): Record<string, unknown> {
  const status = normalizeTerminalStatus(finalResult.effective_final_status);
  const failureCode = normalizeFailureCodeValue(finalResult.failure_code);
  if (status === "succeeded") {
    const nextBatch = readString(finalResult.next_batch);
    return nextBatch
      ? { action: "continue", next_batch: nextBatch, reason: "succeeded_next_batch" }
      : { action: "none", reason: "succeeded_without_next_batch" };
  }
  if (status === "failed") {
    if (!isTrueTaskFailureCode(failureCode)) {
      return { action: "none", reason: "non_task_failure" };
    }
    const approvedBatch = readString(finalResult.approved_batch);
    return {
      action: "repair",
      suggested_batch: approvedBatch ? `${approvedBatch}-FIX` : "BATCH-REPAIR",
      failure_code: failureCode,
      failure_stage: readString(finalResult.failure_stage),
      reason: "minimal_repair_batch",
    };
  }
  if (status === "cancelled") return { action: "none", reason: "cancelled" };
  return { action: "none", reason: "non_terminal" };
}

function readNullableReportString(value: unknown): string | null {
  const text = readString(value);
  return text && !/^(null|none|n\/a|not[_ -]?provided|undefined)$/i.test(text)
    ? text
    : null;
}

function readProjectDirectorReportData(value: unknown): Record<string, unknown> | null {
  const record = readRecord(value);
  if (!record) return null;
  return readRecord(record.data) ?? record;
}

function readAcceptedFinalReportData(
  input: Record<string, unknown>,
  jobResult: Record<string, unknown> | null
): Record<string, unknown> | null {
  const response = readRecord(
    input.accepted_final_report_response ??
      input.acceptedFinalReportResponse ??
      input.final_report_response ??
      input.finalReportResponse
  );

  return (
    readProjectDirectorReportData(response?.project_director_report) ??
    readProjectDirectorReportData(readRecord(readRecord(response?.job)?.result)?.project_director_report) ??
    readProjectDirectorReportData(jobResult?.project_director_report)
  );
}

function readTerminalStatusSnapshot(input: Record<string, unknown>): Record<string, unknown> | null {
  return readRecord(
    input.terminal_status_snapshot ??
      input.terminalStatusSnapshot ??
      input.effective_final_status_snapshot ??
      input.effectiveFinalStatusSnapshot ??
      input.terminal_snapshot ??
      input.terminalSnapshot
  );
}

function readPriorityReportField(
  sources: Array<Record<string, unknown> | null>,
  ...keys: string[]
): unknown {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const value = source[key];
        if (value !== undefined && value !== null && String(value).trim() !== "") return value;
      }
    }
  }
  return null;
}

function readPriorityReportRawField(
  sources: Array<Record<string, unknown> | null>,
  ...keys: string[]
): unknown {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const value = source[key];
        if (value !== undefined && value !== null) return value;
      }
    }
  }
  return null;
}

function readReportPushFlag(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    const booleanValue = readNullableBooleanFlag(value);
    if (booleanValue !== null) return booleanValue;
    const text = readString(value);
    if (/^(success|succeeded|pushed|pending|true|yes)$/i.test(String(text ?? "").trim())) {
      return true;
    }
  }
  return false;
}

const CANONICAL_WORKER_REPORT_REQUIRED_FIELDS = [
  "job_id",
  "attempt_id",
  "worker_instance_id",
  "batch_code",
  "worker_execution_status",
  "task_goal_status",
  "effective_final_status",
] as const;

export function validateCanonicalWorkerReportSchema(
  body: Record<string, unknown>
): {
  ok: boolean;
  failure_code?: "WORKER_REPORT_SCHEMA_INVALID";
  failure_stage?: "worker_report_validation";
  missing_fields: string[];
  invalid_fields: string[];
  received_schema_version: unknown;
  supported_schema_versions: number[];
} {
  const received = body.report_schema_version ?? body.reportSchemaVersion;
  const missingFields = CANONICAL_WORKER_REPORT_REQUIRED_FIELDS.filter((field) => {
    const value =
      field === "worker_instance_id"
        ? body.worker_instance_id ?? body.worker_id ?? body.worker_name
        : body[field];
    return value === null || value === undefined || String(value).trim() === "";
  });
  const invalidFields: string[] = [];
  const schemaNumber = Number(received);
  if (!Number.isInteger(schemaNumber) || schemaNumber !== CANONICAL_WORKER_REPORT_SCHEMA_VERSION) {
    invalidFields.push("report_schema_version");
  }
  for (const field of [
    "verification_only",
    "allow_no_change_success",
    "code_changes_required",
    "codex_required",
    "git_commit_required",
    "git_push_required",
    "git_push",
    "worker_git_push",
    "remote_contains_commit",
    "repository_clean_after_push",
    "terminal_report_acknowledged",
    "terminal_state_persisted",
    "duplicate_terminal_report_idempotent",
    "post_completion_state_applied",
    "next_stage_allowed",
  ]) {
    const value = body[field];
    if (value !== undefined && value !== null && readNullableBooleanFlag(value) === null) {
      invalidFields.push(field);
    }
  }
  const ok = missingFields.length === 0 && invalidFields.length === 0;
  return {
    ok,
    ...(ok
      ? {}
      : {
          failure_code: "WORKER_REPORT_SCHEMA_INVALID" as const,
          failure_stage: "worker_report_validation" as const,
        }),
    missing_fields: missingFields,
    invalid_fields: invalidFields,
    received_schema_version: received ?? null,
    supported_schema_versions: [CANONICAL_WORKER_REPORT_SCHEMA_VERSION],
  };
}

export function buildCanonicalWorkerReportSchema(input: {
  job?: JobRecord | null;
  body?: Record<string, unknown> | null;
  contract?: Record<string, unknown> | null;
  finalResult?: Record<string, unknown> | null;
  workerId?: string | null;
  attemptId?: string | null;
}): Record<string, unknown> {
  const body = input.body ?? {};
  const contract = input.contract ?? buildWorkerJobPayloadContract({ job: input.job ?? null });
  const finalResult = input.finalResult ?? normalizeWorkerFinalResult({ job: input.job ?? null, ...body });
  const batchCode =
    readString(finalResult.approved_batch) ??
    readString(body.batch_code) ??
    readString(contract.approved_batch) ??
    getJobBatchCode(input.job);
  const workerId =
    readString(input.workerId) ??
    readString(body.worker_instance_id) ??
    readString(body.worker_id) ??
    readString(body.worker_name);
  return {
    report_schema_version: CANONICAL_WORKER_REPORT_SCHEMA_VERSION,
    job_id: readString(body.job_id) ?? readString(body.id) ?? readString(input.job?.id),
    attempt_id: readString(input.attemptId) ?? readString(body.attempt_id) ?? readString(contract.attempt_id),
    worker_instance_id: workerId,
    batch_code: batchCode,
    worker_execution_status: readString(finalResult.worker_execution_status),
    task_goal_status: readString(finalResult.task_goal_status),
    effective_final_status: readString(finalResult.effective_final_status),
    failure_code: readString(finalResult.failure_code),
    failure_stage: readString(finalResult.failure_stage),
    failure_detail:
      readString(body.failure_detail) ??
      readString(finalResult.failure_detail) ??
      readString(body.error_detail),
    repair_mode: contract.repair_mode === true,
    verification_only: contract.verification_only === true,
    worker_only: contract.worker_only === true,
    allow_no_change_success: contract.allow_no_change_success === true,
    execution_policy_conflict: readString(contract.execution_policy_conflict),
    deterministic_git_operation: contract.deterministic_git_operation === true,
    codex_called: readNullableBooleanFlag(body.codex_called),
    code_changes_required: contract.code_changes_required === true,
    codex_required: contract.codex_required === true,
    git_commit_required: contract.git_commit_required === true,
    git_push_required: contract.git_push_required === true,
    changed_files: readStringArray(finalResult.changed_files),
    committed_files: readStringArray(finalResult.committed_files),
    unexpected_changed_files: readStringArray(finalResult.unexpected_changed_files),
    git_commit_sha: readString(finalResult.git_commit_sha),
    codex_git_push: readString(finalResult.codex_git_push),
    worker_git_push: readReportPushFlag(finalResult.worker_git_push),
    git_push: readReportPushFlag(finalResult.git_push, finalResult.pushed),
    pushed_branch: readString(finalResult.pushed_branch),
    remote_contains_commit: readReportPushFlag(finalResult.remote_contains_commit),
    repository_clean_after_push: readBooleanFlag(finalResult.repository_clean_after_push),
    terminal_report_acknowledged:
      readNullableBooleanFlag(body.terminal_report_acknowledged) ??
      readNullableBooleanFlag(finalResult.terminal_report_acknowledged) ??
      true,
    terminal_state_persisted:
      readNullableBooleanFlag(body.terminal_state_persisted) ??
      readNullableBooleanFlag(finalResult.terminal_state_persisted) ??
      true,
    duplicate_terminal_report_idempotent:
      readNullableBooleanFlag(body.duplicate_terminal_report_idempotent) ??
      readNullableBooleanFlag(finalResult.duplicate_terminal_report_idempotent) ??
      false,
    post_completion_state_applied:
      readNullableBooleanFlag(body.post_completion_state_applied) ??
      readNullableBooleanFlag(finalResult.post_completion_state_applied) ??
      true,
    final_report_source:
      readString(body.final_report_source) ??
      readString(finalResult.final_report_source) ??
      readString(body.post_completion_source) ??
      "worker_runtime_report",
    completed_at: readString(finalResult.completed_at),
    next_stage_allowed: readNullableBooleanFlag(finalResult.next_stage_allowed) ?? false,
  };
}

export function normalizeWorkerFinalResult(input: Record<string, unknown> & {
  job?: JobRecord | null;
  job_id?: string | null;
  approved_batch?: string | null;
  status?: string | null;
  finalReportStatus?: string | null;
  final_report_status?: string | null;
  effectiveFinalStatus?: string | null;
  effective_final_status?: string | null;
  previousEffectiveFinalStatus?: string | null;
  resultText?: string | null;
  errorText?: string | null;
  failureCode?: string | null;
  failure_code?: string | null;
  failureStage?: string | null;
  failure_stage?: string | null;
  gitCommitSha?: string | null;
  git_commit_sha?: string | null;
  gitPush?: boolean | string | null;
  git_push?: boolean | string | null;
  githubPushStatus?: string | null;
  github_push_status?: string | null;
  deployStatus?: string | null;
  deploy_status?: string | null;
  nextBatch?: string | null;
  next_batch?: string | null;
  completedAt?: string | null;
  completed_at?: string | null;
  approvedBatch?: string | null;
  terminalStatusSnapshot?: Record<string, unknown> | null;
  terminal_status_snapshot?: Record<string, unknown> | null;
  terminalSnapshot?: Record<string, unknown> | null;
  terminal_snapshot?: Record<string, unknown> | null;
  acceptedFinalReportResponse?: Record<string, unknown> | null;
  accepted_final_report_response?: Record<string, unknown> | null;
  finalReportResponse?: Record<string, unknown> | null;
  final_report_response?: Record<string, unknown> | null;
  postCompletionTransportWarning?: boolean | string | null;
  post_completion_transport_warning?: boolean | string | null;
  postCompletionWarningCount?: number | string | null;
  post_completion_warning_count?: number | string | null;
}): Record<string, unknown> {
  const job = input.job ?? null;
  const jobResult = readRecord(job?.result);
  const projectDirectorReport = readRecord(jobResult?.project_director_report);
  const acceptedFinalReportData = readAcceptedFinalReportData(input, jobResult);
  const terminalSnapshot = readTerminalStatusSnapshot(input);
  const terminalSources = [acceptedFinalReportData, terminalSnapshot];
  const reportText = [input.resultText, input.errorText].filter(Boolean).join("\n");
  const requestedStatus =
    readPriorityReportField(terminalSources, "effective_final_status", "effectiveFinalStatus") ??
    input.effectiveFinalStatus ??
    input.effective_final_status ??
    readString(projectDirectorReport?.effective_final_status) ??
    readDiagnosticLine(reportText, "effective_final_status") ??
    input.status ??
    input.final_report_status ??
    input.finalReportStatus;
  const nonTaskFailureCode = classifyNonTaskFailureCode(reportText);
  const effectiveFinalStatus =
    normalizeTerminalStatus(requestedStatus) === "failed" && nonTaskFailureCode
      ? normalizeTerminalStatus(input.previousEffectiveFinalStatus) ?? "running"
      : normalizeTerminalStatus(requestedStatus) ?? "running";
  const approvedBatch =
    readNullableReportString(
      readPriorityReportField(terminalSources, "approved_batch", "approvedBatch", "batch_code", "batchCode")
    ) ??
    readString(input.approvedBatch) ??
    readString(input.approved_batch) ??
    readString(projectDirectorReport?.approved_batch) ??
    getJobBatchCode(job);
  const failureCode =
    effectiveFinalStatus === "failed"
      ? normalizeFailureCodeValue(
          readPriorityReportField(terminalSources, "failure_code", "failureCode", "error_code", "errorCode") ??
            input.failureCode ??
            input.failure_code ??
            readString(projectDirectorReport?.failure_code) ??
            readDiagnosticLine(reportText, "failure_code") ??
            readDiagnosticLine(reportText, "error_code") ??
            classifyFailureCodeFromText(reportText)
        )
      : null;
  const failureStage =
    effectiveFinalStatus === "failed"
      ? readNullableReportString(readPriorityReportField(terminalSources, "failure_stage", "failureStage")) ??
        readNullableReportString(input.failureStage) ??
        readNullableReportString(input.failure_stage) ??
        readNullableReportString(projectDirectorReport?.failure_stage) ??
        readNullableReportString(readDiagnosticLine(reportText, "failure_stage")) ??
        (failureCode === "CODEX_USAGE_LIMIT" ? "codex_execution" : null) ??
        (failureCode === "GIT_SYNC_FAILED" ? "git_sync_preflight" : null) ??
        readDiagnosticLine(reportText, "失败阶段")
      : null;
  const nextBatch =
    readNullableReportString(readPriorityReportField(terminalSources, "next_batch", "nextBatch")) ??
    readString(input.nextBatch) ??
    readString(input.next_batch) ??
    readString(projectDirectorReport?.next_batch) ??
    extractNextBatchFromText(reportText) ??
    (effectiveFinalStatus === "succeeded" ? inferNextBatchFromBatchCode(approvedBatch) : null);
  const committedFilesForFinalResult = readStringArray(
    readPriorityReportRawField(terminalSources, "committed_files", "committedFiles") ??
      input.committed_files ??
      input.committedFiles ??
      projectDirectorReport?.committed_files
  );
  const changedFilesForFinalResult =
    committedFilesForFinalResult.length > 0
      ? committedFilesForFinalResult
      : readStringArray(
          readPriorityReportRawField(terminalSources, "changed_files", "changedFiles", "files_changed", "filesChanged") ??
            input.changed_files ??
            input.files_changed ??
            projectDirectorReport?.changed_files ??
            projectDirectorReport?.files_changed
        );
  const finalResult = {
    job_id: readString(input.job_id) ?? readString(job?.id) ?? readString(job?.job_id),
    approved_batch: approvedBatch,
    worker_execution_status:
      readNullableReportString(readPriorityReportField(terminalSources, "worker_execution_status", "workerExecutionStatus")) ??
      readString(input.worker_execution_status) ??
      readString(projectDirectorReport?.worker_execution_status) ??
      readDiagnosticLine(reportText, "worker_execution_status"),
    task_goal_status:
      readNullableReportString(readPriorityReportField(terminalSources, "task_goal_status", "taskGoalStatus")) ??
      readString(input.task_goal_status) ??
      readString(projectDirectorReport?.task_goal_status) ??
      readDiagnosticLine(reportText, "task_goal_status"),
    final_report_status: normalizeTerminalStatus(
      readPriorityReportField(terminalSources, "final_report_status", "finalReportStatus") ??
        input.final_report_status ??
        input.finalReportStatus ??
        input.status
    ),
    effective_final_status: effectiveFinalStatus,
    failure_code: failureCode,
    failure_stage: failureStage,
    changed_files: changedFilesForFinalResult,
    committed_files:
      committedFilesForFinalResult.length > 0 ? committedFilesForFinalResult : changedFilesForFinalResult,
    codex_changed_files: readStringArray(
      readPriorityReportRawField(terminalSources, "codex_changed_files", "codexChangedFiles") ??
        input.codex_changed_files ??
        input.codexChangedFiles ??
        projectDirectorReport?.codex_changed_files
    ),
    worktree_changed_files: readStringArray(
      readPriorityReportRawField(terminalSources, "worktree_changed_files", "worktreeChangedFiles") ??
        input.worktree_changed_files ??
        input.worktreeChangedFiles ??
        projectDirectorReport?.worktree_changed_files
    ),
    task_changed_files: readStringArray(
      readPriorityReportRawField(terminalSources, "task_changed_files", "taskChangedFiles") ??
        input.task_changed_files ??
        input.taskChangedFiles ??
        projectDirectorReport?.task_changed_files ??
        input.changed_files ??
        input.files_changed
    ),
    unexpected_changed_files: readStringArray(
      readPriorityReportRawField(terminalSources, "unexpected_changed_files", "unexpectedChangedFiles") ??
        input.unexpected_changed_files ??
        input.unexpectedChangedFiles ??
        projectDirectorReport?.unexpected_changed_files
    ),
    git_commit_sha:
      readNullableReportString(readPriorityReportField(terminalSources, "git_commit_sha", "gitCommitSha")) ??
      readString(input.gitCommitSha) ??
      readString(input.git_commit_sha) ??
      readString(projectDirectorReport?.git_commit_sha) ??
      readString(job?.git_commit_sha),
    pushed:
      readReportPushFlag(
        readPriorityReportField(terminalSources, "git_push", "gitPush", "pushed"),
        readPriorityReportField(terminalSources, "github_push_status", "githubPushStatus"),
        readPriorityReportField(terminalSources, "deploy_status", "deployStatus"),
        input.git_push,
        input.gitPush,
        input.pushed,
        input.github_push_status,
        input.githubPushStatus,
        input.deploy_status,
        input.deployStatus,
        projectDirectorReport?.pushed
      ),
    codex_git_push:
      readNullableReportString(readPriorityReportField(terminalSources, "codex_git_push", "codexGitPush")) ??
      readString(input.codex_git_push) ??
      readString(input.codexGitPush) ??
      readString(projectDirectorReport?.codex_git_push),
    worker_git_push: readReportPushFlag(
      readPriorityReportField(terminalSources, "worker_git_push", "workerGitPush"),
      input.worker_git_push,
      input.workerGitPush,
      projectDirectorReport?.worker_git_push
    ),
    git_push:
      readReportPushFlag(
        readPriorityReportField(terminalSources, "git_push", "gitPush", "pushed"),
        readPriorityReportField(terminalSources, "github_push_status", "githubPushStatus"),
        readPriorityReportField(terminalSources, "deploy_status", "deployStatus"),
        input.git_push,
        input.gitPush,
        input.pushed,
        input.github_push_status,
        input.githubPushStatus,
        input.deploy_status,
        input.deployStatus,
        projectDirectorReport?.pushed
      ),
    pushed_branch:
      readNullableReportString(readPriorityReportField(terminalSources, "pushed_branch", "pushedBranch")) ??
      readString(input.pushed_branch) ??
      readString(input.pushedBranch) ??
      readString(projectDirectorReport?.pushed_branch),
    remote_contains_commit: readReportPushFlag(
      readPriorityReportField(terminalSources, "remote_contains_commit", "remoteContainsCommit"),
      input.remote_contains_commit,
      input.remoteContainsCommit,
      projectDirectorReport?.remote_contains_commit
    ),
    repository_clean_after_push:
      readNullableBooleanFlag(readPriorityReportField(terminalSources, "repository_clean_after_push", "repositoryCleanAfterPush")) ??
      readNullableBooleanFlag(input.repository_clean_after_push) ??
      readNullableBooleanFlag(input.repositoryCleanAfterPush) ??
      readNullableBooleanFlag(projectDirectorReport?.repository_clean_after_push) ??
      false,
    post_completion_transport_warning:
      readBooleanFlag(
        readPriorityReportField(terminalSources, "post_completion_transport_warning", "postCompletionTransportWarning")
      ) ||
      readBooleanFlag(input.post_completion_transport_warning) ||
      readBooleanFlag(input.postCompletionTransportWarning),
    post_completion_warning_count:
      Number(readPriorityReportField(terminalSources, "post_completion_warning_count", "postCompletionWarningCount")) ||
      Number(input.post_completion_warning_count ?? input.postCompletionWarningCount) ||
      0,
    next_batch: nextBatch,
    next_stage_allowed:
      typeof input.next_stage_allowed === "boolean"
        ? input.next_stage_allowed
        : readNullableBooleanFlag(input.next_stage_allowed) ??
          readNullableBooleanFlag(projectDirectorReport?.next_stage_allowed) ??
          false,
    reply_error:
      readString(input.reply_error) ??
      readString(projectDirectorReport?.reply_error) ??
      null,
    completed_at:
      readString(input.completedAt) ??
      readString(input.completed_at) ??
      readString(projectDirectorReport?.completed_at) ??
      readString(job?.completed_at),
  };
  return {
    ...finalResult,
    failure_memory_status: buildFailureMemoryStatus(finalResult),
    terminal_index: buildTerminalJobIndex(finalResult),
    auto_iteration_suggestion: buildAutoIterationSuggestion(finalResult),
  };
}

function terminalIndexKey(finalResult: Record<string, unknown>): string {
  return `${readString(finalResult.job_id) ?? "unknown-job"}::${readString(finalResult.approved_batch) ?? "unknown-batch"}`;
}

export function recordTerminalJobIndex(
  index: Record<string, unknown> | null | undefined,
  finalResult: Record<string, unknown>
): { index: Record<string, unknown>; entry: Record<string, unknown> | null; status: string; idempotent: boolean } {
  const nextIndex = index && typeof index === "object" ? { ...index } : {};
  const normalizedFinalResult = normalizeWorkerFinalResult(finalResult);
  const status = normalizeTerminalStatus(normalizedFinalResult.effective_final_status);
  if (!["succeeded", "failed", "cancelled"].includes(status ?? "")) {
    return { index: nextIndex, entry: null, status: "skipped_non_terminal", idempotent: false };
  }
  const key = terminalIndexKey(normalizedFinalResult);
  const existing = readRecord(nextIndex[key]);
  if (existing) return { index: nextIndex, entry: existing, status: "duplicate", idempotent: true };
  const entry = buildTerminalJobIndex(normalizedFinalResult);
  return { index: { ...nextIndex, [key]: entry }, entry, status: "recorded", idempotent: false };
}

export function recordFailureMemoryForFinalResult(
  memory: Record<string, unknown> | null | undefined,
  finalResult: Record<string, unknown>,
  now = new Date().toISOString()
): { memory: Record<string, unknown>; entry: Record<string, unknown> | null; status: string; recorded: boolean; idempotent: boolean } {
  const nextMemory = memory && typeof memory === "object" ? { ...memory } : {};
  const normalizedFinalResult = normalizeWorkerFinalResult(finalResult);
  const memoryStatus = buildFailureMemoryStatus(normalizedFinalResult);
  if (memoryStatus !== "recordable") {
    return { memory: nextMemory, entry: null, status: memoryStatus, recorded: false, idempotent: false };
  }
  const key = terminalIndexKey(normalizedFinalResult);
  const events = readRecord(nextMemory.__task_failure_events) ?? {};
  const existing = readRecord(events[key]);
  if (existing) {
    return { memory: nextMemory, entry: existing, status: "duplicate", recorded: false, idempotent: true };
  }
  const entry = {
    ...buildTerminalJobIndex(normalizedFinalResult),
    failure_stage: readString(normalizedFinalResult.failure_stage),
    recorded_at: now,
  };
  return {
    memory: {
      ...nextMemory,
      __task_failure_events: {
        ...events,
        [key]: entry,
      },
    },
    entry,
    status: "recorded",
    recorded: true,
    idempotent: false,
  };
}

function isActionableEngineeringFailure(errorText: string): boolean {
  return /pathspec|git add|git commit|git push|typescript|tsc|eslint|lint|build|permission|access denied|eacces/i.test(
    errorText
  );
}

function buildFailureNextStep(errorText: string): string {
  const explicitSuggestion = readDiagnosticLine(errorText, "建议修复动作");
  const explicitApproval = readDiagnosticLine(errorText, "是否建议老板回复“总管 批准修复”");

  if (explicitSuggestion) {
    return explicitApproval === "是"
      ? `${explicitSuggestion}\n建议老板回复：“总管 批准修复”。`
      : explicitSuggestion;
  }

  if (isActionableEngineeringFailure(errorText)) {
    return "这是可修复工程错误。项目总管应基于失败阶段和关键错误生成最小范围修复建议；如不涉及越权操作，建议老板回复：“总管 批准修复”。";
  }

  return "需要老板查看失败原因后决定是否重试、扩大修改范围或调整需求。";
}

function listLines(items: string[], emptyText: string, maxItems = 40): string[] {
  if (!items.length) return [`- ${emptyText}`];
  const visibleItems = items.slice(0, maxItems).map((item) => `- ${sanitizeReportText(item)}`);
  if (items.length > maxItems) {
    visibleItems.push(`- ...已截断 ${items.length - maxItems} 项`);
  }
  return visibleItems;
}

function numberedLines(items: string[], emptyText: string, maxItems = 5): string[] {
  if (!items.length) return [`1. ${emptyText}`];
  const visibleItems = items.slice(0, maxItems).map((item, index) => `${index + 1}. ${sanitizeReportText(item)}`);
  if (items.length > maxItems) {
    visibleItems.push(`${maxItems + 1}. ...已截断 ${items.length - maxItems} 项`);
  }
  return visibleItems;
}

function pathMatchesAny(path: string, prefixes: string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix));
}

function hasEnvChange(filesChanged: string[]): boolean {
  return filesChanged.some((file) => {
    const normalized = file.replace(/\\/g, "/");
    return /(^|\/)\.env(\.|$)/.test(normalized) || normalized.endsWith(".env");
  });
}

function isGithubPushSuccess(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim();
  return /^(success|succeeded|pushed)$/i.test(text) || /已推送|推送成功|push success/i.test(text);
}

function taskRequiresFileChanges(value: unknown): boolean {
  return TASK_MUTATION_PATTERN.test(String(value ?? ""));
}

function taskDeclaresReadOnly(value: unknown): boolean {
  return READ_ONLY_TASK_PATTERN.test(String(value ?? ""));
}

function readTaskModeField(...values: unknown[]): string | null {
  for (const value of values) {
    const text = readString(value)?.toLowerCase();
    if (!text) continue;
    if (Object.values(TASK_MODES).includes(text as typeof TASK_MODES[keyof typeof TASK_MODES])) {
      return text;
    }
  }
  return null;
}

function inferTaskMode(input: {
  demand: string | null;
  batchCode: string | null;
  jobPayload: Record<string, unknown> | null;
  jobResult: Record<string, unknown> | null;
  submitted?: unknown;
}): string {
  const text = [input.demand, input.batchCode].filter(Boolean).join("\n");

  // Forced read-only batches must outrank stale/polluted task_mode fields.
  // REPORT_FORCED_READ_ONLY_BEFORE_FIELD_MODE
  if (input.batchCode && READ_ONLY_BATCH_PATTERN.test(input.batchCode)) {
    return TASK_MODES.READ_ONLY;
  }
  const contractExplicitTextMode =
    normalizeTaskMode(readLatestWorkerContextField(text, "task_mode")) ??
    normalizeTaskMode(text.match(/\btask[_\s-]*mode\s*[:=]\s*[`'"“”]?([a-z_]+)[`'"“”]?/i)?.[1]);
  const contractExplicitReadOnlyMode = readNullableBooleanFlag(
    readLatestWorkerContextField(text, "read_only_mode") ??
      text.match(/\bread[_\s-]*only[_\s-]*mode\s*[:=]\s*[`'"“”]?(true|false|1|0|yes|no|on|off)[`'"“”]?/i)?.[1]
  );
  if (
    contractExplicitTextMode &&
    (contractExplicitReadOnlyMode === true || contractExplicitTextMode === TASK_MODES.READ_ONLY)
  ) {
    return TASK_MODES.READ_ONLY;
  }
  if (contractExplicitTextMode) {
    return contractExplicitTextMode;
  }
  if (READ_ONLY_BATCH_PATTERN.test(text) || taskDeclaresReadOnly(text)) {
    return TASK_MODES.READ_ONLY;
  }
  // Boss-provided task_mode in the original request outranks product/docs/system keyword inference.
  const explicitTextModeMatch = text.match(/\btask[_\s-]*mode\s*[:=]\s*[`'"“”]?([a-z_]+)[`'"“”]?/i);
  const explicitTextMode = explicitTextModeMatch ? explicitTextModeMatch[1].toLowerCase() : null;
  if (explicitTextMode && Object.values(TASK_MODES).includes(explicitTextMode as typeof TASK_MODES[keyof typeof TASK_MODES])) {
    return explicitTextMode;
  }

  if (
    /\bproject[_\s-]*domain\s*[:=]\s*automation_system\b/i.test(text) &&
    /(?:requested_mode|final_mode|执行模式)\s*[:：=]\s*write_allowed\b/i.test(text)
  ) {
    return TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED;
  }

  // Product repair batches must stay product even when QA/docs/system words appear in the prompt.
  if (isBatchFixProductTaskText(text)) {
    return TASK_MODES.PRODUCT_WRITE_ALLOWED;
  }

  // Explicit task mode is trusted only after forced read-only and product batch identity checks.
  const fieldMode = readTaskModeField(
    input.submitted,
    input.jobPayload?.task_mode,
    input.jobPayload?.taskMode,
    input.jobResult?.task_mode,
    input.jobResult?.taskMode
  );
  if (fieldMode) return fieldMode;

  if (
    DOCS_WRITE_TASK_PATTERN.test(text) ||
    (DOCS_WRITE_TARGET_PATTERN.test(text) && TASK_MUTATION_PATTERN.test(text))
  ) {
    return TASK_MODES.DOCS_WRITE_ALLOWED;
  }

  if (
    /BATCH-44|BATCH-45A|automation_system_write_allowed/i.test(text) ||
    (AUTOMATION_WRITE_TASK_PATTERN.test(text) && TASK_MUTATION_PATTERN.test(text))
  ) {
    return TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED;
  }

  if (input.batchCode && /^BATCH-P\d+$/i.test(input.batchCode)) {
    return TASK_MODES.PRODUCT_WRITE_ALLOWED;
  }

  return TASK_MODES.READ_ONLY;
}

function reportTextHasNoFixApplied(value: string): boolean {
  return /failure_code\s*[:=]\s*NO_FIX_APPLIED|error_code\s*[:=]\s*NO_FIX_APPLIED|no_fix_applied\s*[:=]\s*(true|yes)|NO_FIX_APPLIED\s*(?:是否触发)?\s*[:：]\s*(?:是|yes|true)|Task goal status:\s*failed_no_fix_applied/i.test(value);
}

function reportTextHasReadOnlyViolation(value: string): boolean {
  return /READ_ONLY_MODE_VIOLATION|read_only_mode_violation\s*[:=]\s*(true|yes)|Read-only violation:\s*yes/i.test(value);
}

function reportTextHasOutOfScope(value: string): boolean {
  return /OUT_OF_SCOPE_BUSINESS_CHANGE|out_of_scope_business_change\s*[:=]\s*(true|yes)|Out-of-scope business change:\s*yes/i.test(value);
}

function reportTextHasFailedTaskGoal(value: string): boolean {
  return /MISSING_REQUIRED_DOCS|INSUFFICIENT_DOC_OUTPUT|INCOMPLETE_QA_REPORT|WORKER_READONLY_CONTEXT_INCOMPLETE|TASK_MODE_MISMATCH|task_goal_status\s*[:=]\s*(failed|failed_[a-z_]+|no_fix_applied|read_only_violation|out_of_scope_business_change|task_mode_mismatch|missing_required_docs|insufficient_doc_output|incomplete_qa_report|worker_readonly_context_incomplete)|Task goal status:\s*(failed|failed_[a-z_]+|no_fix_applied|read_only_violation|out_of_scope_business_change|task_mode_mismatch|missing_required_docs|insufficient_doc_output|incomplete_qa_report|worker_readonly_context_incomplete)|任务目标状态[:：]\s*(failed|失败|未完成)/i.test(value);
}

function buildSafetyBoundary(filesChanged: string[], deployStatus?: string | null): string[] {
  const businessPageChanged = filesChanged.some((file) =>
    pathMatchesAny(file, ["src/app/page.tsx", "src/app/partners", "src/app/post"])
  );
  const databaseChanged = filesChanged.some((file) =>
    pathMatchesAny(file, ["docs/setup-supabase.sql", "docs/setup-hermes-jobs.sql", "docs/setup-hermes-v2-schema.sql", "supabase"])
  );

  return [
    `是否修改业务页面：首页//partners//post：${businessPageChanged ? "是" : "否"}`,
    `是否修改数据库：${databaseChanged ? "是" : "否"}`,
    `是否修改 .env：${hasEnvChange(filesChanged) ? "是" : "否"}`,
    `是否部署：${deployStatus ? deployStatus : "否"}`,
    "是否启动 dev server：否",
  ];
}

function extractCompletionItems(summary: string): string[] {
  return summary
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 5);
}

export function getProjectDirectorJobCorrelation(job: JobRecord | null | undefined): {
  boss_request_id: string | null;
  plan_id: string | null;
  task_key: string | null;
  original_demand: string | null;
} {
  const payload = readRecord(job?.payload);
  const requestText = readString(job?.request_text) ?? readString(job?.prompt) ?? "";

  return {
    boss_request_id:
      readString(payload?.boss_request_id) ?? readLineValue(requestText, "boss_request_id"),
    plan_id:
      readString(payload?.plan_id) ??
      readString(payload?.task_tree_id) ??
      readLineValue(requestText, "plan_id"),
    task_key:
      readString(payload?.task_key) ??
      readString(job?.task_code) ??
      readLineValue(requestText, "task_key"),
    original_demand:
      readString(payload?.original_demand) ?? readLineValue(requestText, "original_demand"),
  };
}

function getJobBatchCode(job: JobRecord | null | undefined): string | null {
  return extractCurrentExecutionBatchCode(job);
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

function textHasWriteChangeIntent(text: unknown): boolean {
  return /修复|修改|实现|增加|新增|删除|重构|迁移|fix|repair|modify|implement|add|delete|refactor|migrat/i.test(
    String(text ?? "")
  );
}

function isWriteExecutionMode(value: unknown): boolean {
  return [
    TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED,
    TASK_MODES.PRODUCT_WRITE_ALLOWED,
    TASK_MODES.DOCS_WRITE_ALLOWED,
    "write_allowed",
    "automation_system_write_allowed",
  ].includes(String(value ?? "").trim());
}

function defaultCodeChangesRequiredForPolicy(contract: Record<string, unknown>): boolean {
  const taskType = readString(contract.task_type) ?? "";
  const executionText = [
    readString(contract.execution_intent),
    readString(contract.task_goal),
    readString(contract.original_request_text),
  ]
    .filter(Boolean)
    .join("\n");

  return Boolean(
    CODE_CHANGE_REQUIRED_TASK_TYPES.has(taskType) ||
      isWriteExecutionMode(contract.task_mode) ||
      isWriteExecutionMode(contract.final_mode) ||
      (isWriteExecutionMode(contract.requested_mode) && textHasWriteChangeIntent(executionText))
  );
}

function allowsVerificationOnlyNoChangeSuccess(contract: Record<string, unknown>): boolean {
  return Boolean(
    readBooleanFlag(contract.verification_only) &&
      readBooleanFlag(contract.allow_no_change_success) &&
      contract.code_changes_required === false &&
      contract.codex_required === false &&
      contract.git_commit_required === false &&
      contract.git_push_required === false
  );
}

export function buildWorkerJobPayloadContract(input: {
  job?: JobRecord | null;
  requestText?: unknown;
  payload?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  projectDomain?: string | null;
  taskType?: string | null;
  requestedMode?: string | null;
  finalMode?: string | null;
  taskMode?: string | null;
  readOnlyMode?: boolean | null;
  repairMode?: boolean | null;
  repairScope?: unknown;
  verificationOnly?: boolean | null;
  workerOnly?: boolean | null;
  allowNoChangeSuccess?: boolean | null;
  executionIntent?: string | null;
  codeChangesRequired?: boolean | null;
  codexRequired?: boolean | null;
  gitCommitRequired?: boolean | null;
  gitPushRequired?: boolean | null;
  approvalRequired?: boolean | null;
  allowedScope?: unknown;
  exactAllowedScope?: unknown;
  exactAllowedScopeCount?: unknown;
  writableScope?: unknown;
  readableScope?: unknown;
  readOnlyOperations?: unknown;
  forbiddenOperations?: unknown;
  forbiddenScope?: unknown;
  taskGoal?: unknown;
  requiredOutputFields?: unknown;
  acceptanceConditions?: unknown;
  originalRequestText?: string | null;
  route?: string | null;
  approvedBatch?: string | null;
  attemptId?: string | null;
  workerStage?: string | null;
  workflowStage?: string | null;
  finalReportStatus?: string | null;
  effectiveFinalStatus?: string | null;
  failureCode?: string | null;
  failureStage?: string | null;
  changedFiles?: unknown;
  gitCommitSha?: string | null;
  nextBatch?: string | null;
  completedAt?: string | null;
  pushed?: boolean | null;
  deployStatus?: string | null;
}): Record<string, unknown> {
  const job = input.job ?? null;
  const payload = input.payload ?? readRecord(job?.payload);
  const result = input.result ?? readRecord(job?.result);
  const jobContextText = readWorkerJobContextText(job, payload, result);
  const requestText =
    readString(input.requestText) ??
    readString(job?.request_text) ??
    readString(job?.prompt) ??
    readString(job?.description) ??
    jobContextText;
  const fallbackOriginalRequest =
    readString(input.originalRequestText) ??
    (readPayloadContextField(payload, "original_request_text") as string | null) ??
    (readPayloadContextField(result, "original_request_text") as string | null) ??
    readString(job?.original_request_text) ??
    readString(job?.originalRequestText) ??
    decodeOriginalRequestTextBase64(job?.original_request_text_base64) ??
    decodeOriginalRequestTextBase64(job?.originalRequestTextBase64) ??
    null;
  const sourceText = [
    requestText,
    fallbackOriginalRequest,
    jobContextText,
  ]
    .filter(Boolean)
    .join("\n");
  const explicitContext = selectPreferredHermesContext(sourceText);
  const explicitFields = explicitContext?.fields ?? {};
  const explicitOriginalRequestText = readLatestOriginalRequestText(sourceText);
  const originalRequestText =
    readString(explicitFields.original_request_text) ??
    explicitOriginalRequestText ??
    fallbackOriginalRequest ??
    readTextContextField(requestText, "original_request_text") ??
    requestText;
  const originalRequestTextPreserved = Boolean(
    readString(explicitFields.original_request_text) ??
      explicitOriginalRequestText ??
      fallbackOriginalRequest ??
      readTextContextField(requestText, "original_request_text")
  );
  const originalRequestTextFields: Record<string, string | null> = {
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
  const requestTextFields: Record<string, string | null> = {
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
  const overrideFields: Record<string, unknown> = {
    project_domain: input.projectDomain,
    task_type: input.taskType,
    requested_mode: input.requestedMode,
    final_mode: input.finalMode,
    task_mode: input.taskMode,
    read_only_mode: input.readOnlyMode,
    repair_mode: input.repairMode,
    repair_scope: readScopeText(input.repairScope),
    verification_only: input.verificationOnly,
    worker_only: input.workerOnly,
    allow_no_change_success: input.allowNoChangeSuccess,
    execution_intent: input.executionIntent,
    code_changes_required: input.codeChangesRequired,
    codex_required: input.codexRequired,
    git_commit_required: input.gitCommitRequired,
    git_push_required: input.gitPushRequired,
    approval_required: input.approvalRequired,
    allowed_scope: readScopeText(input.allowedScope),
    exact_allowed_scope: readScopeText(input.exactAllowedScope),
    exact_allowed_scope_count: input.exactAllowedScopeCount,
    writable_scope: readContractText(input.writableScope),
    readable_scope: readContractText(input.readableScope),
    read_only_operations: readContractText(input.readOnlyOperations),
    forbidden_operations: readContractText(input.forbiddenOperations),
    forbidden_scope: readScopeText(input.forbiddenScope),
    task_goal: readContractText(input.taskGoal),
    required_output_fields: readContractText(input.requiredOutputFields),
    acceptance_conditions: readContractText(input.acceptanceConditions),
    route: input.route,
    approved_batch: input.approvedBatch,
  };
  const structuredPayload = hasStructuredPayloadContext(payload);
  const payloadField = (fieldName: string): unknown => {
    const payloadValue = readPayloadContextField(payload, fieldName);
    return payloadValue !== null && payloadValue !== undefined
      ? payloadValue
      : readPayloadContextField(result, fieldName);
  };
  const readPriorityField = (fieldName: string): unknown =>
    firstPresentValue(
      readString(explicitFields[fieldName]),
      structuredPayload ? payloadField(fieldName) : null,
      readString(originalRequestTextFields[fieldName]),
      readString(requestTextFields[fieldName]),
      !structuredPayload ? payloadField(fieldName) : null,
      overrideFields[fieldName]
    );
  const explicitTaskMode = normalizeTaskMode(readPriorityField("task_mode"));
  const explicitReadOnlyMode =
    readNullableBooleanFlag(explicitFields.read_only_mode) ??
    (structuredPayload ? readNullableBooleanFlag(payloadField("read_only_mode")) : null) ??
    readNullableBooleanFlag(originalRequestTextFields.read_only_mode) ??
    readNullableBooleanFlag(requestTextFields.read_only_mode) ??
    (typeof input.readOnlyMode === "boolean" ? input.readOnlyMode : null);
  const batchCode =
    readString(explicitFields.approved_batch) ??
    readString(originalRequestTextFields.approved_batch) ??
    readString(requestTextFields.approved_batch) ??
    getJobBatchCode(job) ??
    findBatchCodes(sourceText)[0] ??
    readString(payloadField("approved_batch")) ??
    null;
  const payloadPolicyBatchCode =
    readString(payloadField("approved_batch")) ??
    readString(payloadField("batch_code")) ??
    null;
  const policyPayloadMatchesCurrentBatch =
    !payloadPolicyBatchCode || !batchCode || payloadPolicyBatchCode === batchCode;
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
  const normalizeExecutionPolicyCandidate = (fieldName: string, value: unknown): unknown => {
    if (!booleanExecutionPolicyFields.has(fieldName)) return readString(value);
    return readNullableBooleanFlag(value);
  };
  const readExecutionPolicyField = (fieldName: string): unknown =>
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
    ? createHash("sha256").update(originalRequestText, "utf8").digest("hex")
    : null;
  const inferredTaskMode = inferTaskMode({
    demand: [originalRequestText, requestText].filter(Boolean).join("\n"),
    batchCode,
    jobPayload: payload,
    jobResult: result,
    submitted: input.taskMode,
  });
  const classificationText = [originalRequestText, requestText, batchCode].filter(Boolean).join("\n");
  const currentBatchIsQa = Boolean(batchCode && QA_BATCH_PATTERN.test(batchCode));
  const productRepairRequest = !currentBatchIsQa && isBatchFixProductTaskText(classificationText);
  const forceReadOnlyMode =
    explicitReadOnlyMode === true &&
    !(productRepairRequest && !isReadOnlyTaskMode(explicitTaskMode));
  const taskMode =
    forceReadOnlyMode || isReadOnlyTaskMode(explicitTaskMode)
      ? (isReadOnlyTaskMode(explicitTaskMode) ? explicitTaskMode : TASK_MODES.READ_ONLY)
      : explicitTaskMode ?? inferredTaskMode;
  const readOnlyMode =
    productRepairRequest && !isReadOnlyTaskMode(explicitTaskMode)
      ? false
      : explicitReadOnlyMode ?? isReadOnlyTaskMode(taskMode);
  const projectDomain =
    readString(readPriorityField("project_domain")) ??
    classifyWorkerTaskDomain([originalRequestText, requestText].filter(Boolean).join("\n"));
  const taskType = readString(readPriorityField("task_type")) ?? null;
  const requestedMode = readString(readExecutionPolicyField("requested_mode")) ?? null;
  const finalMode = readString(readExecutionPolicyField("final_mode")) ?? null;
  const executionIntent = readString(readExecutionPolicyField("execution_intent")) ?? null;
  const explicitRepairMode = readNullableBooleanFlag(readExecutionPolicyField("repair_mode"));
  const systemRepairMode = isSystemRepairMode({
    projectDomain,
    taskType,
    batchCode,
  });
  const repairMode = systemRepairMode && explicitRepairMode !== false;
  const repairScope = repairMode
    ? readString(readExecutionPolicyField("repair_scope")) ?? SYSTEM_REPAIR_SCOPE_TEXT
    : readString(readExecutionPolicyField("repair_scope")) ?? null;
  const explicitVerificationOnly = readNullableBooleanFlag(readExecutionPolicyField("verification_only"));
  const explicitWorkerOnly = readNullableBooleanFlag(readExecutionPolicyField("worker_only"));
  const explicitAllowNoChangeSuccess = readNullableBooleanFlag(
    readExecutionPolicyField("allow_no_change_success")
  );
  const verificationOnly = explicitVerificationOnly === true;
  const workerOnly = explicitWorkerOnly === true;
  const taskGoalPolicyText = readContractText(readExecutionPolicyField("task_goal"));
  const defaultCodeChangesRequired = defaultCodeChangesRequiredForPolicy({
    task_type: taskType,
    requested_mode: requestedMode,
    final_mode: finalMode,
    ["task_" + "mode"]: taskMode,
    execution_intent: executionIntent,
    task_goal: taskGoalPolicyText,
    original_request_text: originalRequestText,
  });
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
    /^(?:code[_ -]?change[_ -]?required|code[_ -]?changes?[_ -]?required)$/i.test(executionIntent ?? "") &&
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
  const rawAllowedScope = readString(readPriorityField("allowed_scope")) ?? null;
  const rawExactAllowedScope = readString(readExecutionPolicyField("exact_allowed_scope")) ?? null;
  const allowedScope = repairMode ? SYSTEM_REPAIR_SCOPE_TEXT : rawAllowedScope;
  const exactAllowedScope = repairMode ? SYSTEM_REPAIR_SCOPE_TEXT : rawExactAllowedScope;
  const exactAllowedScopeCountValue = readPriorityField("exact_allowed_scope_count");
  const exactAllowedScopeCount =
    (exactAllowedScopeCountValue !== null &&
    exactAllowedScopeCountValue !== undefined &&
    String(exactAllowedScopeCountValue).trim() !== ""
      ? String(exactAllowedScopeCountValue).trim()
      : null) ??
    (exactAllowedScope ? String(readStringArray(exactAllowedScope).length || 1) : null);
  const forbiddenScope = readString(readExecutionPolicyField("forbidden_scope")) ?? null;
  const workerReadOnlyMode = taskMode === TASK_MODES.WORKER_READ_ONLY;
  const writableScope = workerReadOnlyMode
    ? "[]"
    : readContractText(readPriorityField("writable_scope")) ?? allowedScope;
  const readableScope =
    readContractText(readPriorityField("readable_scope")) ??
    (workerReadOnlyMode
      ? "code, configuration, logs, and explicitly specified external read-only resources required by the original task"
      : null);
  const readOnlyOperations =
    readContractText(readPriorityField("read_only_operations")) ??
    (workerReadOnlyMode
      ? "non-destructive diagnostics requested by original_request_text"
      : null);
  const forbiddenOperations =
    readContractText(readPriorityField("forbidden_operations")) ??
    (workerReadOnlyMode
      ? "file writes, apply_patch, git add, git commit, git push, checkout, merge, rebase, reset, deployment, database writes"
      : null);
  const taskGoal =
    readContractText(readPriorityField("task_goal")) ??
    extractTaskGoalFromText(originalRequestText) ??
    null;
  const requiredOutputFields =
    readContractText(readPriorityField("required_output_fields")) ??
    extractRequiredOutputFieldsFromText(originalRequestText) ??
    null;
  const acceptanceConditions =
    readContractText(readPriorityField("acceptance_conditions")) ??
    extractAcceptanceConditionsFromText(originalRequestText) ??
    null;
  const changedFiles = readStringArray(
    input.changedFiles ??
      payloadField("changed_files")
  );
  const gitCommitSha =
    readString(input.gitCommitSha) ??
    readString(payloadField("git_commit_sha")) ??
    readString(job?.git_commit_sha);
  const pushed =
    typeof input.pushed === "boolean"
      ? input.pushed
      : readNullableBooleanFlag(payloadField("pushed")) ??
        false;
  const workerStage =
    readString(input.workerStage) ??
    readString(input.workflowStage) ??
    readString(readPriorityField("worker_stage"));
  const contextSource = explicitContext
    ? "explicit_hermes_worker_context"
    : structuredPayload || hasPayloadContext(payload)
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
  const contextReconstructFailed = Boolean(
      !projectDomain ||
      !taskMode ||
      readOnlyMode === null ||
      (!isReadOnlyTaskMode(taskMode) && !allowedScope) ||
      (workerReadOnlyMode &&
        (!batchCode ||
          !projectDomain ||
          taskMode !== TASK_MODES.WORKER_READ_ONLY ||
          readOnlyMode !== true ||
          !originalRequestTextPreserved ||
          !originalRequestText ||
          !taskGoal ||
          !requiredOutputFields ||
          !acceptanceConditions ||
          !forbiddenScope))
  );

  return {
    context_source: contextSource,
    context_reconstruct_failed: contextReconstructFailed,
    context_warnings: contextWarnings,
    project_domain: projectDomain,
    task_type: taskType,
    requested_mode: requestedMode,
    final_mode: finalMode,
    task_mode: taskMode,
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
    execution_policy_batch_code: batchCode,
    execution_policy_context_id:
      readString(readExecutionPolicyField("execution_policy_context_id")) ??
      readString(readExecutionPolicyField("context_id")) ??
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
    route:
      readString(readPriorityField("route")) ??
      null,
    payload: payload ?? null,
    approved_batch: batchCode,
    batch_code: batchCode,
    attempt_id:
      readString(input.attemptId) ??
      readString(readPriorityField("attempt_id")) ??
      null,
    worker_stage: workerStage,
    workflow_stage:
      workerStage,
    final_report_status:
      readString(input.finalReportStatus) ??
      readString(readPriorityField("final_report_status")) ??
      null,
    effective_final_status:
      readString(input.effectiveFinalStatus) ??
      readString(readPriorityField("effective_final_status")) ??
      null,
    failure_code:
      readString(input.failureCode) ??
      readString(readPriorityField("failure_code")) ??
      null,
    failure_stage:
      readString(input.failureStage) ??
      readString(readPriorityField("failure_stage")) ??
      null,
    changed_files: changedFiles,
    git_commit_sha: gitCommitSha ?? null,
    next_batch:
      readString(input.nextBatch) ??
      readString(readPriorityField("next_batch")) ??
      null,
    completed_at:
      readString(input.completedAt) ??
      readString(readPriorityField("completed_at")) ??
      readString(job?.completed_at) ??
      null,
    pushed,
    deploy_status:
      readString(input.deployStatus) ??
      readString(readPriorityField("deploy_status")) ??
      null,
  };
}

function getMissingWorkerReadOnlyContextFields(contract: Record<string, unknown>): string[] {
  if (contract.task_mode !== TASK_MODES.WORKER_READ_ONLY) return [];

  const missing: string[] = [];
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
  return [...new Set(missing)].sort();
}

export function buildProjectDirectorWorkerReport(input: {
  job: JobRecord | null;
  workerId: string;
  attemptId: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  projectName?: string | null;
  projectDir?: string | null;
  resultText?: string | null;
  output?: string | null;
  filesChanged?: unknown;
  validationResults?: unknown;
  gitCommitSha?: string | null;
  githubPushStatus?: string | null;
  readOnlyMode?: unknown;
  deployStatus?: string | null;
  buildPassed?: boolean | null;
  testPassed?: boolean | null;
  errorText?: string | null;
  failureCode?: string | null;
  failureStage?: string | null;
  workerExecutionStatus?: string | null;
  taskGoalStatus?: string | null;
  effectiveFinalStatus?: string | null;
}): { text: string; data: Record<string, unknown> } {
  const correlation = getProjectDirectorJobCorrelation(input.job);
  const batchCode = getJobBatchCode(input.job);
  const filesChanged = readStringArray(input.filesChanged);
  const submittedValidationResults = readStringArray(input.validationResults);
  const validation = [
    ...(submittedValidationResults.length > 0 ? submittedValidationResults : []),
    `build=${input.buildPassed === undefined || input.buildPassed === null ? "未提供" : input.buildPassed ? "通过" : "失败"}`,
    `test=${input.testPassed === undefined || input.testPassed === null ? "未提供" : input.testPassed ? "通过" : "失败"}`,
  ];
  let needsBossConfirmation = input.status === "succeeded";
  const summary =
    input.resultText?.trim() ||
    input.output?.trim() ||
    (input.status === "failed" ? input.errorText?.trim() : "") ||
    "未提供";
  const demand =
    correlation.original_demand ??
    readString(input.job?.request_text) ??
    readString(input.job?.prompt) ??
    null;
  const jobPayload = readRecord(input.job?.payload);
  const jobResult = readRecord(input.job?.result);
  const contract = buildWorkerJobPayloadContract({
    job: input.job,
    requestText: demand ?? input.job?.request_text,
    payload: jobPayload,
    result: jobResult,
    attemptId: input.attemptId,
    workflowStage: input.status === "succeeded" ? "completed" : input.status === "failed" ? "failed" : input.status,
    finalReportStatus: input.status,
    changedFiles: input.filesChanged,
    gitCommitSha: input.gitCommitSha,
    pushed: isGithubPushSuccess(input.githubPushStatus ?? null),
    deployStatus: input.deployStatus,
  });
  const taskTextForClassification = [
    readString(contract.original_request_text),
    demand,
    readString(jobPayload?.original_request_text),
    readString(jobPayload?.originalRequestText),
    decodeOriginalRequestTextBase64(jobPayload?.original_request_text_base64),
    decodeOriginalRequestTextBase64(jobPayload?.originalRequestTextBase64),
    readString(jobResult?.original_request_text),
    readString(jobResult?.originalRequestText),
    decodeOriginalRequestTextBase64(jobResult?.original_request_text_base64),
    decodeOriginalRequestTextBase64(jobResult?.originalRequestTextBase64),
    readString(input.job?.title),
    readString(input.job?.job_type),
  ]
    .filter(Boolean)
    .join("\n");
  const taskDomain = classifyWorkerTaskDomain(
    taskTextForClassification
  );
  const jobId = readString(input.job?.id) ?? readString(input.job?.job_id);
  const workerStatusTitle =
    input.status === "succeeded"
      ? "✅ Codex 任务执行成功"
      : input.status === "failed"
        ? "❌ Codex 任务执行失败"
        : `Codex 任务状态：${input.status}`;
  const gitCommitSha = input.gitCommitSha ?? readString(input.job?.git_commit_sha);
  const githubPushStatus = input.githubPushStatus ?? "未提供";
  const completionItems = input.status === "failed" ? [] : extractCompletionItems(summary);
  const safetyBoundary = buildSafetyBoundary(filesChanged, input.deployStatus);
  const sanitizedError = input.errorText ? sanitizeReportText(input.errorText) : "";
  const combinedReportText = [summary, sanitizedError, ...validation].join("\n");
  const taskMode = readString(contract.task_mode) ?? TASK_MODES.READ_ONLY;
  const readOnlyMode = Boolean(contract.read_only_mode);
  const missingWorkerReadOnlyContextFields = getMissingWorkerReadOnlyContextFields(contract);
  const missingWorkerReadOnlyRequiredOutputFields =
    taskMode === TASK_MODES.WORKER_READ_ONLY && input.status === "succeeded"
      ? getMissingWorkerReadOnlyRequiredOutputFields(contract, combinedReportText)
      : [];
  const workerReadOnlyContextIncomplete =
    missingWorkerReadOnlyContextFields.length > 0 ||
    missingWorkerReadOnlyRequiredOutputFields.length > 0;
  const readOnlyViolation = reportTextHasReadOnlyViolation(combinedReportText);
  const verificationOnlyNoChangeSuccess =
    input.status === "succeeded" &&
    filesChanged.length === 0 &&
    allowsVerificationOnlyNoChangeSuccess(contract);
  const writeAllowedNoFixApplied =
    input.status === "succeeded" &&
    !isReadOnlyTaskMode(taskMode) &&
    !verificationOnlyNoChangeSuccess &&
    filesChanged.length === 0;
  const noFixApplied =
    reportTextHasNoFixApplied(combinedReportText) || writeAllowedNoFixApplied;
  const outOfScopeBusinessChange = reportTextHasOutOfScope(combinedReportText);
  const failedTaskGoal =
    reportTextHasFailedTaskGoal(combinedReportText) || workerReadOnlyContextIncomplete;
  const requiredDocsTotal = readDiagnosticLine(combinedReportText, "required_docs_total") ?? "0";
  const requiredDocsPresent = readDiagnosticLine(combinedReportText, "required_docs_present") ?? "0";
  const requiredDocsChanged = readDiagnosticLine(combinedReportText, "required_docs_changed") ?? "0";
  const missingRequiredDocs = readDiagnosticLine(combinedReportText, "missing_required_docs") ?? "none";
  const insufficientDocOutput =
    /INSUFFICIENT_DOC_OUTPUT|insufficient_doc_output\s*[:=]\s*(yes|true)/i.test(combinedReportText);
  const taskGoalFailureCode =
    workerReadOnlyContextIncomplete
      ? WORKER_READONLY_CONTEXT_INCOMPLETE
      : readOnlyViolation
      ? "READ_ONLY_MODE_VIOLATION"
      : noFixApplied
        ? "NO_FIX_APPLIED"
        : outOfScopeBusinessChange
          ? "OUT_OF_SCOPE_CHANGE"
          : insufficientDocOutput
            ? "INSUFFICIENT_DOC_OUTPUT"
            : failedTaskGoal
              ? classifyFailureCodeFromText(combinedReportText)
              : null;
  const failedTaskGoalStatus = taskGoalFailureCode
    ? `failed_${taskGoalFailureCode.toLowerCase()}`
    : "failed";
  const noOpRun =
    noFixApplied ||
    (input.status === "succeeded" &&
      taskRequiresFileChanges(taskTextForClassification || demand) &&
      filesChanged.length === 0 &&
      !gitCommitSha &&
      !verificationOnlyNoChangeSuccess);
  const committed = Boolean(gitCommitSha);
  const pushed = isGithubPushSuccess(githubPushStatus);
  const legacyEffectiveFinalStatus =
    readOnlyViolation ||
    noFixApplied ||
    outOfScopeBusinessChange ||
    failedTaskGoal ||
    workerReadOnlyContextIncomplete ||
    (readOnlyMode && (filesChanged.length > 0 || committed || pushed))
      ? "failed"
      : input.status === "succeeded"
        ? "succeeded"
        : input.status;
  const rawFailureStage = input.status === "failed"
    ? readDiagnosticLine(sanitizedError, "failure_stage") ??
      readDiagnosticLine(sanitizedError, "失败阶段") ??
      "not_provided"
    : legacyEffectiveFinalStatus === "failed"
      ? "task_goal_validation"
      : null;
  const normalizedFinalResult = normalizeWorkerFinalResult({
    job: input.job,
    status: input.status,
    finalReportStatus: input.status,
    effectiveFinalStatus: input.effectiveFinalStatus ?? legacyEffectiveFinalStatus,
    resultText: summary,
    errorText: sanitizedError,
    failureCode:
      legacyEffectiveFinalStatus === "failed"
        ? input.failureCode ?? taskGoalFailureCode ?? classifyFailureCodeFromText(combinedReportText)
        : null,
    failureStage: input.failureStage ?? rawFailureStage,
    gitCommitSha,
    nextBatch: extractNextBatchFromText(combinedReportText),
    completedAt: input.status === "succeeded" || input.status === "failed"
      ? new Date().toISOString()
      : null,
    approvedBatch: readString(contract.approved_batch) ?? batchCode,
  });
  const effectiveFinalStatus = readString(normalizedFinalResult.effective_final_status) ?? legacyEffectiveFinalStatus;
  const finalReportStatus = readString(normalizedFinalResult.final_report_status) ?? input.status;
  const failureCode = readString(normalizedFinalResult.failure_code);
  const nextBatch = readString(normalizedFinalResult.next_batch);
  const failureMemoryStatus = readString(normalizedFinalResult.failure_memory_status) ?? "skipped_non_terminal";
  const terminalIndex =
    readRecord(normalizedFinalResult.terminal_index) ?? buildTerminalJobIndex(normalizedFinalResult);
  const autoIterationSuggestion =
    readRecord(normalizedFinalResult.auto_iteration_suggestion) ??
    buildAutoIterationSuggestion(normalizedFinalResult);
  const terminalChangedFiles = readStringArray(normalizedFinalResult.changed_files);
  const terminalCommittedFiles = readStringArray(
    normalizedFinalResult.committed_files ?? terminalChangedFiles
  );
  const terminalTaskChangedFiles = readStringArray(
    normalizedFinalResult.task_changed_files ?? terminalChangedFiles
  );
  const terminalWorktreeChangedFiles = readStringArray(normalizedFinalResult.worktree_changed_files);
  const terminalUnexpectedChangedFiles = readStringArray(normalizedFinalResult.unexpected_changed_files);
  const terminalGitCommitSha = readString(normalizedFinalResult.git_commit_sha) ?? gitCommitSha;
  const terminalGitPush = readReportPushFlag(normalizedFinalResult.git_push, normalizedFinalResult.pushed, pushed);
  const terminalCommitted = Boolean(terminalGitCommitSha);
  needsBossConfirmation = effectiveFinalStatus === "succeeded";
  const failureStage = effectiveFinalStatus === "failed"
    ? readString(normalizedFinalResult.failure_stage) ?? "task_goal_validation"
    : null;
  const statusTitle =
    effectiveFinalStatus === "succeeded"
      ? "✅ 任务最终完成"
      : effectiveFinalStatus === "failed" && input.status === "succeeded"
        ? "❌ 任务目标验收失败"
        : effectiveFinalStatus === "failed"
          ? "❌ Codex 任务执行失败"
          : effectiveFinalStatus === "cancelled"
            ? "任务已取消"
            : `任务最终状态：${effectiveFinalStatus}`;
  const keyError = effectiveFinalStatus === "failed"
    ? readDiagnosticLine(sanitizedError, "关键错误") ?? truncateText(sanitizedError || summary, 500)
    : null;
  const failureSuggestion = effectiveFinalStatus === "failed"
    ? buildFailureNextStep(sanitizedError)
    : null;
  const failureDetail =
    effectiveFinalStatus === "failed"
      ? readDiagnosticLine(combinedReportText, "failure_detail") ??
        (failureCode === "CODEX_USAGE_LIMIT"
          ? sanitizeDiagnosticsErrorSummary(sanitizedError || summary)
          : null)
      : null;
  const codexCalled = readNullableBooleanFlag(readDiagnosticLine(combinedReportText, "codex_called"));
  const codexExecutableExists = readNullableBooleanFlag(
    readDiagnosticLine(combinedReportText, "codex_executable_exists")
  );
  const codexExecutableIsAppAlias = readNullableBooleanFlag(
    readDiagnosticLine(combinedReportText, "codex_executable_is_app_alias")
  );
  const codexDiagnostics = {
    codex_resolution_source: readDiagnosticLine(combinedReportText, "codex_resolution_source"),
    codex_requested_path: readDiagnosticLine(combinedReportText, "codex_requested_path"),
    codex_executable_resolved: readDiagnosticLine(combinedReportText, "codex_executable_resolved"),
    codex_executable_exists: codexExecutableExists,
    codex_executable_file_type: readDiagnosticLine(combinedReportText, "codex_executable_file_type"),
    codex_executable_version: readDiagnosticLine(combinedReportText, "codex_executable_version"),
    codex_executable_is_app_alias: codexExecutableIsAppAlias,
    codex_preflight_status: readDiagnosticLine(combinedReportText, "codex_preflight_status"),
    stdin_transport_verified: readDiagnosticLine(combinedReportText, "stdin_transport_verified"),
    prompt_in_spawnargs: readDiagnosticLine(combinedReportText, "prompt_in_spawnargs"),
  };
  const nextStageAllowed =
    readNullableBooleanFlag(readDiagnosticLine(combinedReportText, "next_stage_allowed")) ?? false;
  const reportedWorkerExecutionStatus =
    readString(normalizedFinalResult.worker_execution_status) ??
    readString(input.workerExecutionStatus);
  const workerExecutionStatus =
    reportedWorkerExecutionStatus ??
    (workerReadOnlyContextIncomplete
      ? "succeeded_until_worker_readonly_context_validation"
      : readOnlyViolation
      ? "succeeded_until_read_only_validation"
      : noFixApplied
        ? "succeeded_until_task_goal_validation"
        : outOfScopeBusinessChange
          ? "succeeded_until_scope_validation"
          : failedTaskGoal
            ? "succeeded_until_task_goal_validation"
            : input.status === "failed"
              ? "failed"
              : input.status === "succeeded"
                ? "succeeded"
                : input.status);
  const reportedTaskGoalStatus =
    readString(normalizedFinalResult.task_goal_status) ??
    readString(input.taskGoalStatus);
  const taskGoalStatus =
    reportedTaskGoalStatus ??
    (workerReadOnlyContextIncomplete
      ? "failed_worker_readonly_context_incomplete"
      : readOnlyViolation
      ? "failed_read_only_mode_violation"
      : noFixApplied
        ? "failed_no_fix_applied"
        : outOfScopeBusinessChange
          ? "failed_out_of_scope_business_change"
        : failedTaskGoal
          ? failedTaskGoalStatus
        : input.status === "succeeded"
          ? readOnlyMode && filesChanged.length === 0
            ? "completed_read_only_no_file_changes"
            : "completed"
        : input.status === "failed"
          ? "failed"
          : "running");
  const iterationNextStep = needsBossConfirmation
    ? nextBatch
      ? `Continue with ${nextBatch}.`
      : "Succeeded; no next_batch was provided."
    : readString(autoIterationSuggestion.suggested_batch)
      ? `Create minimal repair batch ${autoIterationSuggestion.suggested_batch} for ${failureCode ?? "unknown_failure"}.`
      : failureSuggestion ?? "No automatic repair batch is generated for this terminal state.";

  const diagnostics = buildWorkerFailureDiagnostics({
    job: input.job,
    contract,
    normalizedFinalResult,
    workerExecutionStatus,
    taskGoalStatus,
    effectiveFinalStatus,
    failureCode,
    failureStage,
    batchCode,
    attemptId: input.attemptId,
    completedAt: readString(normalizedFinalResult.completed_at),
    errorText: sanitizedError || null,
    summary,
  });
  const data = {
    job_id: jobId,
    batch_code: batchCode,
    boss_request_id: correlation.boss_request_id,
    plan_id: correlation.plan_id,
    task_key: correlation.task_key,
    original_demand: demand,
    project_name: input.projectName ?? "同城搭子网站",
    project_dir: input.projectDir ?? "未提供",
    worker_id: input.workerId,
    attempt_id: input.attemptId,
    status: input.status,
    original_worker_status: input.status,
    final_report_status: finalReportStatus,
    effective_final_status: effectiveFinalStatus,
    failure_memory_status: failureMemoryStatus,
    failure_code: failureCode,
    terminal_index: terminalIndex,
    next_batch: nextBatch,
    completed_at: readString(normalizedFinalResult.completed_at),
    auto_iteration_suggestion: autoIterationSuggestion,
    status_title: statusTitle,
    worker_status_title: workerStatusTitle,
    context_source: readString(contract.context_source),
    context_reconstruct_failed: Boolean(contract.context_reconstruct_failed),
    context_warnings: contract.context_warnings ?? [],
    project_domain: readString(contract.project_domain),
    task_type: readString(contract.task_type),
    requested_mode: readString(contract.requested_mode),
    final_mode: readString(contract.final_mode),
    task_domain: taskDomain,
    task_mode: taskMode,
    execution_intent: contract.execution_intent,
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
    payload: jobPayload ?? null,
    approved_batch: contract.approved_batch ?? batchCode,
    worker_stage: contract.worker_stage,
    workflow_stage:
      input.status === "succeeded" ? "completed" : input.status === "failed" ? "failed" : input.status,
    worker_execution_status: workerExecutionStatus,
    task_goal_status: taskGoalStatus,
    read_only_mode: readOnlyMode,
    verification_only: readBooleanFlag(contract.verification_only),
    allow_no_change_success: readBooleanFlag(contract.allow_no_change_success),
    codex_called: codexCalled,
    ...codexDiagnostics,
    worker_readonly_context_complete: !workerReadOnlyContextIncomplete,
    missing_worker_readonly_context_fields: missingWorkerReadOnlyContextFields,
    missing_required_output_fields: missingWorkerReadOnlyRequiredOutputFields,
    read_only_violation: readOnlyViolation,
    no_fix_applied: noFixApplied,
    out_of_scope_business_change: outOfScopeBusinessChange,
    required_docs_total: requiredDocsTotal,
    required_docs_present: requiredDocsPresent,
    required_docs_changed: requiredDocsChanged,
    missing_required_docs: missingRequiredDocs,
    insufficient_doc_output: insufficientDocOutput,
    no_op_run: noOpRun,
    committed: terminalCommitted,
    pushed: terminalGitPush,
    git_push: terminalGitPush,
    codex_git_push: readString(normalizedFinalResult.codex_git_push) ?? "not_run_by_codex",
    worker_git_push: readReportPushFlag(normalizedFinalResult.worker_git_push),
    pushed_branch: readString(normalizedFinalResult.pushed_branch),
    remote_contains_commit: readReportPushFlag(normalizedFinalResult.remote_contains_commit),
    repository_clean_after_push: readBooleanFlag(normalizedFinalResult.repository_clean_after_push),
    post_completion_transport_warning: readBooleanFlag(normalizedFinalResult.post_completion_transport_warning),
    post_completion_warning_count: Number(normalizedFinalResult.post_completion_warning_count) || 0,
    what_changed: sanitizeReportText(summary),
    changed_files: terminalChangedFiles,
    files_changed: terminalChangedFiles,
    committed_files: terminalCommittedFiles,
    codex_changed_files: readStringArray(normalizedFinalResult.codex_changed_files),
    worktree_changed_files: terminalWorktreeChangedFiles,
    task_changed_files: terminalTaskChangedFiles,
    unexpected_changed_files: terminalUnexpectedChangedFiles,
    validation_result: validation,
    git_commit_sha: terminalGitCommitSha ?? null,
    commit_hash: terminalGitCommitSha ?? null,
    github_push_status: githubPushStatus,
    deploy_status: input.deployStatus ?? null,
    next_stage_allowed: nextStageAllowed,
    safety_boundary: safetyBoundary,
    needs_boss_confirmation: needsBossConfirmation,
    next_step: iterationNextStep,
    failure_stage: failureStage,
    failure_detail: failureDetail,
    diagnostics,
    key_error: keyError,
    repair_suggestion: failureSuggestion,
    error: sanitizedError || null,
  };

  const requiredHeader = [
    statusTitle,
    `Worker 执行标题：${workerStatusTitle}`,
    `任务编号：${placeholder(jobId)}`,
    `job_id：${placeholder(jobId)}`,
    `实际执行批次：${placeholder(batchCode)}`,
    `attempt_id：${placeholder(input.attemptId)}`,
    `需求：${placeholder(truncateText(sanitizeReportText(demand), 800))}`,
    `项目名称：${placeholder(input.projectName ?? "同城搭子网站")}`,
    `项目目录：${placeholder(input.projectDir)}`,
    `任务分类：${taskDomain}`,
    `Worker 执行状态：${workerExecutionStatus}`,
    `任务目标状态：${taskGoalStatus}`,
    `Original worker status: ${input.status}`,
    `Effective final status: ${effectiveFinalStatus}`,
    `Task mode: ${taskMode}`,
    `context_source: ${placeholder(readString(contract.context_source))}`,
    `context_reconstruct_failed: ${Boolean(contract.context_reconstruct_failed) ? "true" : "false"}`,
    `project_domain: ${placeholder(readString(contract.project_domain))}`,
    `task_type: ${placeholder(readString(contract.task_type))}`,
    `requested_mode: ${placeholder(readString(contract.requested_mode))}`,
    `final_mode: ${placeholder(readString(contract.final_mode))}`,
    `task_mode: ${taskMode}`,
    `read_only_mode: ${readOnlyMode ? "true" : "false"}`,
    `verification_only: ${readBooleanFlag(contract.verification_only) ? "true" : "false"}`,
    `allow_no_change_success: ${readBooleanFlag(contract.allow_no_change_success) ? "true" : "false"}`,
    `execution_intent: ${placeholder(readString(contract.execution_intent))}`,
    `code_changes_required: ${contract.code_changes_required === true ? "true" : "false"}`,
    `codex_required: ${contract.codex_required === true ? "true" : "false"}`,
    `git_commit_required: ${contract.git_commit_required === true ? "true" : "false"}`,
    `git_push_required: ${contract.git_push_required === true ? "true" : "false"}`,
    `approval_required: ${
      contract.approval_required === null || contract.approval_required === undefined
        ? "null"
        : contract.approval_required === true
          ? "true"
          : "false"
    }`,
    `execution_policy_source: ${placeholder(readString(contract.execution_policy_source))}`,
    `execution_policy_batch_code: ${placeholder(readString(contract.execution_policy_batch_code))}`,
    `execution_policy_context_id: ${placeholder(readString(contract.execution_policy_context_id))}`,
    `execution_policy_request_hash: ${placeholder(readString(contract.execution_policy_request_hash))}`,
    `execution_policy_inherited: ${contract.execution_policy_inherited === true ? "true" : "false"}`,
    `execution_policy_inheritance_rejected_reason: ${placeholder(readString(contract.execution_policy_inheritance_rejected_reason))}`,
    `codex_called: ${codexCalled === null ? "null" : codexCalled ? "true" : "false"}`,
    `codex_resolution_source: ${codexDiagnostics.codex_resolution_source ?? "null"}`,
    `codex_requested_path: ${codexDiagnostics.codex_requested_path ?? "null"}`,
    `codex_executable_resolved: ${codexDiagnostics.codex_executable_resolved ?? "null"}`,
    `codex_executable_exists: ${
      codexDiagnostics.codex_executable_exists === null
        ? "null"
        : codexDiagnostics.codex_executable_exists
          ? "true"
          : "false"
    }`,
    `codex_executable_file_type: ${codexDiagnostics.codex_executable_file_type ?? "null"}`,
    `codex_executable_version: ${codexDiagnostics.codex_executable_version ?? "null"}`,
    `codex_executable_is_app_alias: ${
      codexDiagnostics.codex_executable_is_app_alias === null
        ? "null"
        : codexDiagnostics.codex_executable_is_app_alias
          ? "true"
          : "false"
    }`,
    `codex_preflight_status: ${codexDiagnostics.codex_preflight_status ?? "null"}`,
    `stdin_transport_verified: ${codexDiagnostics.stdin_transport_verified ?? "null"}`,
    `prompt_in_spawnargs: ${codexDiagnostics.prompt_in_spawnargs ?? "null"}`,
    `allowed_scope: ${placeholder(readString(contract.allowed_scope))}`,
    `exact_allowed_scope: ${placeholder(readString(contract.exact_allowed_scope))}`,
    `exact_allowed_scope_count: ${placeholder(readString(contract.exact_allowed_scope_count))}`,
    `writable_scope: ${placeholder(readString(contract.writable_scope))}`,
    `readable_scope: ${placeholder(readString(contract.readable_scope))}`,
    `read_only_operations: ${placeholder(readString(contract.read_only_operations))}`,
    `forbidden_operations: ${placeholder(readString(contract.forbidden_operations))}`,
    `forbidden_scope: ${placeholder(readString(contract.forbidden_scope))}`,
    `task_goal: ${placeholder(readString(contract.task_goal))}`,
    `required_output_fields: ${placeholder(readString(contract.required_output_fields))}`,
    `acceptance_conditions: ${placeholder(readString(contract.acceptance_conditions))}`,
    `original_request_text_preserved: ${contract.original_request_text_preserved ? "true" : "false"}`,
    `route: ${placeholder(readString(contract.route))}`,
    `approved_batch: ${placeholder(readString(contract.approved_batch) ?? batchCode)}`,
    `batch_code: ${placeholder(readString(contract.approved_batch) ?? batchCode)}`,
    `worker_stage: ${placeholder(readString(contract.worker_stage))}`,
    `workflow_stage: ${data.workflow_stage}`,
    `final_report_status: ${finalReportStatus}`,
    `effective_final_status: ${effectiveFinalStatus}`,
    `failure_memory_status: ${failureMemoryStatus}`,
    `failure_code: ${failureCode ?? "null"}`,
    `failure_stage: ${failureStage ?? "null"}`,
    `failure_detail: ${failureDetail ?? "null"}`,
    `next_batch: ${nextBatch ?? "null"}`,
    `next_stage_allowed: ${nextStageAllowed ? "true" : "false"}`,
    `completed_at: ${readString(normalizedFinalResult.completed_at) ?? "null"}`,
    `changed_files: ${terminalChangedFiles.length ? terminalChangedFiles.join(", ") : "[]"}`,
    `committed_files: ${terminalCommittedFiles.length ? terminalCommittedFiles.join(", ") : "[]"}`,
    `task_changed_files: ${terminalTaskChangedFiles.length ? terminalTaskChangedFiles.join(", ") : "[]"}`,
    `worktree_changed_files: ${terminalWorktreeChangedFiles.length ? terminalWorktreeChangedFiles.join(", ") : "[]"}`,
    `unexpected_changed_files: ${terminalUnexpectedChangedFiles.length ? terminalUnexpectedChangedFiles.join(", ") : "[]"}`,
    `git_commit_sha: ${terminalGitCommitSha ?? "null"}`,
    `pushed: ${terminalGitPush ? "true" : "false"}`,
    `git_push: ${terminalGitPush ? "true" : "false"}`,
    `codex_git_push: ${readString(normalizedFinalResult.codex_git_push) ?? "not_run_by_codex"}`,
    `worker_git_push: ${readReportPushFlag(normalizedFinalResult.worker_git_push) ? "true" : "false"}`,
    `pushed_branch: ${readString(normalizedFinalResult.pushed_branch) ?? "null"}`,
    `remote_contains_commit: ${readReportPushFlag(normalizedFinalResult.remote_contains_commit) ? "true" : "false"}`,
    `repository_clean_after_push: ${readBooleanFlag(normalizedFinalResult.repository_clean_after_push) ? "true" : "false"}`,
    `post_completion_transport_warning: ${
      readBooleanFlag(normalizedFinalResult.post_completion_transport_warning) ? "true" : "false"
    }`,
    `post_completion_warning_count: ${Number(normalizedFinalResult.post_completion_warning_count) || 0}`,
    `deploy_status: ${input.deployStatus ?? "null"}`,
    `Worker execution status: ${workerExecutionStatus}`,
    `Task goal status: ${taskGoalStatus}`,
    `Read-only mode: ${readOnlyMode ? "yes" : "no"}`,
    `worker_readonly_context_complete: ${workerReadOnlyContextIncomplete ? "false" : "true"}`,
    `missing_worker_readonly_context_fields: ${
      missingWorkerReadOnlyContextFields.length ? missingWorkerReadOnlyContextFields.join(", ") : "none"
    }`,
    `missing_required_output_fields: ${
      missingWorkerReadOnlyRequiredOutputFields.length ? missingWorkerReadOnlyRequiredOutputFields.join(", ") : "none"
    }`,
    `NO_FIX_APPLIED: ${noFixApplied ? "yes" : "no"}`,
    `Read-only violation: ${readOnlyViolation ? "yes" : "no"}`,
    `Out-of-scope business change: ${outOfScopeBusinessChange ? "yes" : "no"}`,
    `required_docs_total: ${requiredDocsTotal}`,
    `required_docs_present: ${requiredDocsPresent}`,
    `required_docs_changed: ${requiredDocsChanged}`,
    `missing_required_docs: ${missingRequiredDocs}`,
    `insufficient_doc_output: ${insufficientDocOutput ? "yes" : "no"}`,
    `No-op run: ${noOpRun ? "yes" : "no"}`,
    `Committed: ${terminalCommitted ? "yes" : "no"}`,
    `Pushed: ${terminalGitPush ? "yes" : "no"}`,
    "",
    "本阶段性质：",
    batchCode
      ? `${taskDomain} ${batchCode}：Worker/Codex 任务执行结果`
      : `${taskDomain}：Worker/Codex 任务执行结果`,
    "",
    "执行结果摘要：",
    truncateText(sanitizeReportText(summary), 1200),
    input.status === "failed" ? `失败阶段：${failureStage}` : "",
    input.status === "failed" ? `关键错误：${keyError || "未提供"}` : "",
    "",
    "修改文件：",
    ...listLines(terminalChangedFiles, "未提供"),
    "",
    "完成内容：",
    ...numberedLines(completionItems, input.status === "failed" ? "任务失败，未生成完成内容" : "未提供"),
    "",
    "验证结果：",
    ...listLines(validation, "未提供"),
    "",
    "安全边界：",
    ...listLines(safetyBoundary, "未提供"),
    "",
    "Git 自动备份：",
    `commit SHA：${terminalGitCommitSha || "未生成"}`,
    `GitHub 推送状态：${placeholder(githubPushStatus)}`,
    "",
    "下一步建议：",
    data.next_step,
  ];

  const sourceRequestId =
    readString(input.job?.source_message_id) ??
    readString(input.job?.feishu_message_id) ??
    readString(jobPayload?.message_id);
  const shadowObservation = sourceRequestId
    ? getCompletedHermesShadowObservation(sourceRequestId)
    : null;
  if (!shadowObservation) {
    return { text: requiredHeader.join("\n"), data };
  }

  const finalData = attachHermesShadowToFinalReport(data, shadowObservation);
  const shadowLines = shadowObservation.observed
    ? [
        "",
        "Hermes Shadow Comparison:",
        `comparison_id: ${shadowObservation.report.comparison_id}`,
        `difference_count: ${shadowObservation.report.difference_count}`,
        `severity: ${shadowObservation.report.severity}`,
      ]
    : [
        "",
        "Hermes Shadow Comparison:",
        `shadow_error: ${"shadow_error" in shadowObservation ? shadowObservation.shadow_error : shadowObservation.reason}`,
      ];
  return { text: [...requiredHeader, ...shadowLines].join("\n"), data: finalData };
}

export function buildAttemptPayload(
  job: JobRecord | null | undefined,
  attempt: {
    attempt_id: string;
    job_id: string;
    worker_id: string;
    status: string;
    started_at?: string;
    heartbeat_at?: string;
    updated_at: string;
  }
): Record<string, unknown> {
  const payload = readRecord(job?.payload) ?? {};
  const contract = buildWorkerJobPayloadContract({
    job,
    requestText: job?.request_text,
    payload,
    attemptId: attempt.attempt_id,
    workerStage: "execution",
    workflowStage: "execution",
    finalReportStatus: null,
    effectiveFinalStatus: "running",
  });
  return {
    ...payload,
    ...contract,
    attempt_id: attempt.attempt_id,
    active_attempt: {
      ...(readRecord(payload.active_attempt) ?? {}),
      ...attempt,
    },
  };
}

export function isTerminalWorkerStatus(value: unknown): boolean {
  return ["terminal_success", "terminal_failed", "terminal_cancelled"].includes(
    normalizeCanonicalJobState(value)
  );
}

export function getDisabledTerminalJobStatus(
  job: JobRecord | null | undefined
): string | null {
  return getCanonicalTerminalWorkerJobStatus(job);
}

export function getCanonicalTerminalWorkerJobStatus(
  job: JobRecord | null | undefined
): string | null {
  const state = normalizeCanonicalJobState(job);
  if (state === "terminal_success") return "succeeded";
  if (state === "terminal_failed") return "failed";
  if (state === "terminal_cancelled") return "cancelled";
  return null;
}

export function isCanonicalTerminalWorkerJob(job: JobRecord | null | undefined): boolean {
  return inspectCanonicalJobState(job).terminal === true;
}

interface CanonicalInvariantResult {
  ok: boolean;
  failure_code: string | null;
  violations: Array<{ code: string; detail?: string }>;
  snapshot: Record<string, unknown>;
}

interface CanonicalTransitionResult {
  ok: boolean;
  failure_code?: string | null;
  failure_stage?: string;
  violations?: Array<{ code: string; detail?: string }>;
  patch?: JobRecord | null;
  attempt?: JobRecord;
  lease?: JobRecord;
  compare_and_set?: JobRecord;
  idempotent?: boolean;
  terminal_immutable?: boolean;
  conflict?: boolean;
  existing_state?: string;
  incoming_state?: string;
  terminal?: boolean;
  rollback_applied?: boolean;
  rollback_skipped_reason?: string | null;
  terminal_report_won?: boolean;
}

export function validateJobStateInvariant(
  job: JobRecord | null | undefined,
  now?: string
): CanonicalInvariantResult {
  return validateCanonicalJobStateInvariant(job, now ? { now } : {}) as CanonicalInvariantResult;
}

export function isJobSelectable(job: JobRecord | null | undefined, now?: string): boolean {
  return isCanonicalJobSelectable(job, now ? { now } : {});
}

export function isCanonicalClaimPersisted(job: JobRecord, attemptId: string): boolean {
  return canonicalClaimIsPersisted(job, attemptId);
}

export function buildCanonicalClaimTransition(
  job: JobRecord,
  input: { worker_id: string; attempt_id: string; lease_id?: string; now: string; expires_at: string }
) {
  return buildCanonicalClaim(job, input) as CanonicalTransitionResult;
}

export function buildCanonicalFinalizeTransition(
  job: JobRecord,
  input: {
    attempt_id?: string | null;
    worker_execution_status?: string | null;
    task_goal_status?: string | null;
    effective_final_status?: string | null;
    now?: string;
  }
) {
  return buildCanonicalFinalization(job, input) as CanonicalTransitionResult;
}

export function buildCanonicalHeartbeatTransition(
  job: JobRecord,
  input: {
    worker_id: string;
    attempt_id: string | null;
    now: string;
    expires_at: string;
    status_message?: string | null;
  }
) {
  return buildCanonicalHeartbeat(job, input) as CanonicalTransitionResult;
}

export function buildCanonicalProgressTransition(
  job: JobRecord,
  input: {
    worker_id: string;
    attempt_id: string | null;
    now: string;
    progress_percent: number;
    current_step: string;
    status_message?: string | null;
  }
) {
  return buildCanonicalProgress(job, input) as CanonicalTransitionResult;
}

export function buildCanonicalStaleAttemptRecovery(
  job: JobRecord,
  input: {
    now?: string;
    worker_available?: boolean;
    expected_attempt_id?: string;
    expected_worker_id?: string;
    retry_allowed?: boolean;
    reason?: string;
  }
) {
  return buildCanonicalStaleRecovery(job, input) as CanonicalTransitionResult;
}

export function buildCanonicalFailedClaimRollback(
  job: JobRecord,
  input: {
    job_id: string;
    worker_id: string;
    attempt_id: string;
    expected_updated_at?: string | null;
    now?: string;
  }
) {
  return canonicalRollbackFailedClaim(job, input) as CanonicalTransitionResult;
}

export function buildTerminalJobCleanupFields(
  job: JobRecord | null | undefined,
  status: string,
  now = new Date().toISOString()
): JobRecord {
  const cleanup = buildCanonicalTerminalCleanup({ ...(job ?? {}), status }, now);
  const cleanupFields = (cleanup.patch ?? { status }) as JobRecord;
  if (!job) return cleanupFields;
  return Object.fromEntries(
    Object.entries(cleanupFields).filter(
      ([field]) => field === "status" || field === "result" || field in job
    )
  );
}

export function terminalJobHasRuntimeState(job: JobRecord | null | undefined): boolean {
  if (!job) return false;
  const snapshot = inspectCanonicalJobState(job);
  const payload = readRecord(job.payload);
  return Boolean(
    snapshot.claimed_by ||
      snapshot.active_attempt ||
      snapshot.active_lease ||
      readString(payload?.running_job_id) ||
      readBooleanFlag(job.retry_requested) ||
      readBooleanFlag(job.retry_pending) ||
      readBooleanFlag(job.should_retry) ||
      readBooleanFlag(payload?.retry_requested) ||
      readBooleanFlag(payload?.retry_pending) ||
      readBooleanFlag(payload?.should_retry)
  );
}

export function assertWorkerOwnsJob(
  job: JobRecord | null,
  workerId: string
): NextResponse | null {
  const claimedBy = getClaimedBy(job);
  if (!claimedBy || claimedBy === workerId) return null;

  return NextResponse.json(
    {
      ok: false,
      error: "worker does not own this job",
      claimed_by: claimedBy,
      worker_id: workerId,
    },
    { status: 409 }
  );
}

export function assertWorkerAttemptMatchesJob(
  job: JobRecord | null,
  attemptId: string | null
): NextResponse | null {
  const activeAttemptId = getActiveAttemptId(job);
  if (!activeAttemptId) return null;
  if (attemptId === activeAttemptId) return null;

  return NextResponse.json(
    {
      ok: false,
      failure_code: "WORKER_ATTEMPT_MISMATCH",
      failure_stage: "worker_attempt_validation",
      error: attemptId
        ? "attempt_id does not match active job attempt"
        : "attempt_id is required for active job attempt",
      stale_attempt: true,
      active_attempt_id: activeAttemptId,
      attempt_id: attemptId,
    },
    { status: 409 }
  );
}

export function assertWorkerAuthorized(req: NextRequest): NextResponse | null {
  const expected =
    process.env.WORKER_TOKEN?.trim() ??
    process.env.WORKER_API_TOKEN?.trim() ??
    process.env.HERMES_WORKER_TOKEN?.trim() ??
    "";
  if (!expected) {
    return NextResponse.json(
      {
        ok: false,
        error: "worker token not configured",
        failure_code: "WORKER_TOKEN_NOT_CONFIGURED",
      },
      { status: 503 }
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function getWorkerSupabase(): Promise<SupabaseClient | NextResponse> {
  const supabase = await getSupabaseService();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "service client not available" }, { status: 500 });
  }
  return supabase;
}

export async function parseJsonBody<T>(req: NextRequest): Promise<T | NextResponse> {
  const rawText = new TextDecoder("utf-8", { fatal: false }).decode(await req.arrayBuffer());
  try {
    return JSON.parse(rawText) as T;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
}

export function responseFromMaybe<T>(value: T | NextResponse): value is NextResponse {
  return value instanceof NextResponse;
}

export function normalizeFeishuTaskText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

async function findDuplicateByRequestText(
  supabase: SupabaseClient,
  requestText: string,
  createdAfter: string
): Promise<{ data: DuplicateFeishuJob | null; error: SupabaseWriteError | null }> {
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("id, job_id, request_text, created_at")
    .eq("source", "feishu")
    .in("status", ["queued", "running"])
    .eq("request_text", requestText)
    .gte("created_at", createdAfter)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return { data: (data as DuplicateFeishuJob | null) ?? null, error };
}

async function findDuplicateByEmbeddedRequestText(
  supabase: SupabaseClient,
  requestText: string,
  createdAfter: string
): Promise<{ data: DuplicateFeishuJob | null; error: SupabaseWriteError | null }> {
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("id, job_id, request_text, created_at")
    .eq("source", "feishu")
    .in("status", ["queued", "running"])
    .gte("created_at", createdAfter)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return { data: null, error };

  const normalizedNeedle = normalizeFeishuTaskText(requestText);
  const duplicate =
    (data as DuplicateFeishuJob[] | null | undefined)?.find((job) => {
      const normalizedRequestText = normalizeFeishuTaskText(job.request_text ?? "");
      return normalizedRequestText.includes(normalizedNeedle);
    }) ?? null;

  return { data: duplicate, error: null };
}

export async function findRecentDuplicateFeishuJob(
  supabase: SupabaseClient,
  rawText: string,
  now = Date.now()
): Promise<DuplicateFeishuJobCheckResult> {
  const normalizedText = normalizeFeishuTaskText(rawText);
  if (!normalizedText) return { duplicate: null, normalizedText, error: null };

  const createdAfter = new Date(now - 30 * 60 * 1000).toISOString();
  const candidates = [normalizedText];
  if (rawText !== normalizedText) candidates.push(rawText);

  for (const candidate of candidates) {
    const { data, error } = await findDuplicateByRequestText(supabase, candidate, createdAfter);
    if (error) return { duplicate: null, normalizedText, error };
    if (data) return { duplicate: data, normalizedText, error: null };
  }

  const { data: embeddedDuplicate, error: embeddedError } = await findDuplicateByEmbeddedRequestText(
    supabase,
    normalizedText,
    createdAfter
  );
  if (embeddedError) return { duplicate: null, normalizedText, error: embeddedError };
  if (embeddedDuplicate) return { duplicate: embeddedDuplicate, normalizedText, error: null };

  return { duplicate: null, normalizedText, error: null };
}

function isMissingColumnError(error: SupabaseWriteError | null): boolean {
  const message = error?.message ?? "";
  return error?.code === "PGRST204" || /column .* does not exist/i.test(message);
}

function extractMissingColumn(error: SupabaseWriteError | null): string | null {
  const message = error?.message ?? "";
  const quoted = message.match(/'([^']+)' column/);
  if (quoted) return quoted[1];
  const plain = message.match(/column "([^"]+)"/i);
  return plain ? plain[1] : null;
}

function isCheckConstraintError(error: SupabaseWriteError | null): boolean {
  const text = `${error?.code ?? ""}\n${error?.message ?? ""}\n${error?.details ?? ""}\n${error?.hint ?? ""}`;
  return error?.code === "23514" || /check constraint|violates check/i.test(text);
}

function shouldRetryPendingStatus(error: SupabaseWriteError | null, rows: JobRecord[]): boolean {
  if (!isCheckConstraintError(error)) return false;
  if (!rows.some((row) => row.status === "queued")) return false;
  const text = `${error?.message ?? ""}\n${error?.details ?? ""}\n${error?.hint ?? ""}`;
  return /status|queued|pending|hermes_jobs/i.test(text);
}

function shouldRetryTextPriority(error: SupabaseWriteError | null, rows: JobRecord[]): boolean {
  if (!isCheckConstraintError(error)) return false;
  if (!rows.some((row) => typeof row.priority === "number")) return false;
  const text = `${error?.message ?? ""}\n${error?.details ?? ""}\n${error?.hint ?? ""}`;
  return /priority|P0|P1|P2|hermes_jobs/i.test(text);
}

function normalizeLegacyHermesPriority(value: unknown): string {
  if (typeof value === "string" && /^P[0-2]$/i.test(value.trim())) {
    return value.trim().toUpperCase();
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric <= 5) return "P0";
    if (numeric <= 20) return "P1";
  }
  return "P2";
}

function summarizeHermesInsertRows(rows: JobRecord[]): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const payload = row.payload && typeof row.payload === "object"
      ? (row.payload as Record<string, unknown>)
      : null;
    return {
      fields: Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          {
            type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
            is_null: value === null,
          },
        ])
      ),
      status: row.status ?? null,
      priority: row.priority ?? null,
      batch:
        row.dispatch_batch ??
        row.task_code ??
        payload?.approved_batch ??
        payload?.batch_code ??
        null,
      task_mode: payload?.task_mode ?? null,
      payload_fields: payload ? Object.keys(payload).sort() : [],
    };
  });
}

function formatHermesJobInsertError(
  label: string,
  error: SupabaseWriteError | null,
  rows: JobRecord[],
  skippedColumns: string[],
  adjustedFields: string[]
): string {
  return `${label}: ${JSON.stringify({
    stage: "hermes_jobs_insert",
    http_status: null,
    code: error?.code ?? null,
    message: error?.message ?? null,
    details: error?.details ?? null,
    hint: error?.hint ?? null,
    skipped_columns: skippedColumns,
    adjusted_fields: adjustedFields,
    insert_payload_shape: summarizeHermesInsertRows(rows),
  })}`;
}

export async function createHermesJobs(
  supabase: SupabaseClient,
  rowsInput: JobRecord[],
  failureLabel = "create hermes job failed"
): Promise<HermesJobInsertResult> {
  let rows = rowsInput.map((row) => ({ ...row }));
  const skippedColumns: string[] = [];
  const adjustedFields: string[] = [];
  const replayedTerminalIdentities = new Set<string>();
  for (const row of rows) {
    const stableId = readString(row.id);
    const requestText = stripAttemptContextFromRequestText(row.request_text);
    if (!stableId && !requestText) continue;
    let query = supabase.from("hermes_jobs").select("*");
    query = stableId ? query.eq("id", stableId) : query.eq("request_text", requestText);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(20);
    if (error) throw new Error(`${failureLabel}: terminal identity check failed: ${error.message}`);
    if ((data as JobRecord[] | null)?.some((existingJob) => isCanonicalTerminalWorkerJob(existingJob))) {
      replayedTerminalIdentities.add(stableId ?? requestText);
    }
  }
  if (replayedTerminalIdentities.size > 0) {
    rows = rows.filter((row) => {
      const identity = readString(row.id) ?? stripAttemptContextFromRequestText(row.request_text);
      return !replayedTerminalIdentities.has(identity);
    });
    adjustedFields.push("terminal_identity_replay_suppressed");
  }
  if (rows.length === 0) {
    return { insertedCount: 0, skippedColumns, adjustedFields, jobIds: [] };
  }
  let retriedPendingStatus = false;
  let retriedTextPriority = false;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const { data, error } = await supabase.from("hermes_jobs").insert(rows).select("id, job_id");
    if (!error) {
      const jobIds = Array.isArray(data)
        ? data
            .map((row) => row?.job_id ?? row?.id)
            .filter((value): value is string => typeof value === "string" && value.length > 0)
        : [];
      return { insertedCount: rows.length, skippedColumns, adjustedFields, jobIds };
    }

    if (isMissingColumnError(error)) {
      const missingColumn = extractMissingColumn(error);
      if (!missingColumn || !rows.some((row) => missingColumn in row)) {
        throw new Error(
          formatHermesJobInsertError(failureLabel, error, rows, skippedColumns, adjustedFields)
        );
      }
      skippedColumns.push(missingColumn);
      rows = rows.map((row) => {
        const next = { ...row };
        delete next[missingColumn];
        return next;
      });
      continue;
    }

    if (!retriedPendingStatus && shouldRetryPendingStatus(error, rows)) {
      retriedPendingStatus = true;
      adjustedFields.push("status:queued->pending");
      rows = rows.map((row) => (row.status === "queued" ? { ...row, status: "pending" } : row));
      continue;
    }

    if (!retriedTextPriority && shouldRetryTextPriority(error, rows)) {
      retriedTextPriority = true;
      adjustedFields.push("priority:number->P0/P1/P2");
      rows = rows.map((row) =>
        typeof row.priority === "number"
          ? { ...row, priority: normalizeLegacyHermesPriority(row.priority) }
          : row
      );
      continue;
    }

    throw new Error(
      formatHermesJobInsertError(failureLabel, error, rows, skippedColumns, adjustedFields)
    );
  }

  throw new Error(
    `${failureLabel}: ${JSON.stringify({
      stage: "hermes_jobs_insert",
      message: "too many hermes_jobs insert compatibility retries",
      skipped_columns: skippedColumns,
      adjusted_fields: adjustedFields,
      insert_payload_shape: summarizeHermesInsertRows(rows),
    })}`
  );
}

export async function createHermesJob(
  supabase: SupabaseClient,
  row: JobRecord,
  failureLabel = "create hermes job failed"
): Promise<HermesJobInsertResult> {
  return createHermesJobs(supabase, [row], failureLabel);
}

const CANONICAL_JOB_CREATION_FORBIDDEN_FIELDS = [
  "claimed_by",
  "attempt_id",
  "active_attempt_id",
  "lease_id",
  "active_lease_id",
  "running_job_id",
  "terminal_state",
] as const;

export async function canonicalCreateJob(
  supabase: SupabaseClient,
  row: JobRecord,
  admission: CanonicalCanaryAdmissionEvidence,
  failureLabel = "canonical create job failed"
): Promise<HermesJobInsertResult> {
  const forbidden = CANONICAL_JOB_CREATION_FORBIDDEN_FIELDS.filter((field) => {
    const value = row[field];
    return value !== undefined && value !== null && value !== false;
  });
  if (forbidden.length) {
    throw new Error(`CANONICAL_JOB_INITIAL_STATE_FORBIDDEN:${forbidden.join(",")}`);
  }
  const transition = initializeCanonicalQueuedJob(row, { now: new Date().toISOString() }) as {
    ok: boolean;
    patch: JobRecord | null;
    failure_code: string | null;
  };
  if (!transition.ok || !transition.patch) {
    throw new Error(transition.failure_code ?? "CANONICAL_JOB_INITIALIZATION_FAILED");
  }
  const payload = readRecord(row.payload) ?? {};
  const canonicalRow: JobRecord = {
    ...row,
    ...transition.patch,
    canonical_job_state: "queued",
    canonical_revision: 0,
    requested_mode: readString(row.requested_mode) ?? readString(payload.requested_mode),
    plan_id: readString(row.plan_id) ?? readString(payload.plan_id),
    subtask_id: readString(row.subtask_id) ?? readString(payload.subtask_id),
    terminal_at: null,
    source: readString(row.source) ?? "canonical_orchestration",
    payload,
  };
  const insertContract = buildCanonicalJobInsertContract(canonicalRow, admission);
  const { data, error } = await supabase.rpc("canonical_admit_canary_job", {
    p_policy_id: admission.policy_id,
    p_owner_open_id: admission.trusted_owner_id,
    p_batch_code: admission.batch_code,
    p_requested_mode: admission.requested_mode,
    p_event_id: admission.event_id,
    p_request_id: admission.request_id,
    p_job: insertContract,
  });
  if (error) {
    console.warn(
      "[canonical-canary-persistence-admission]",
      buildCanonicalCanaryPersistenceAuditRecord(admission, {
        allowed: false,
        reason_code: "CANONICAL_AUTHORITATIVE_WRITE_OUTCOME_UNKNOWN",
      })
    );
    throw new Error(
      `${failureLabel}:CANONICAL_AUTHORITATIVE_WRITE_OUTCOME_UNKNOWN:${readString(error.code) ?? "RPC_FAILED"}`
    );
  }
  const result = readRecord(data);
  if (!result || result.allowed !== true) {
    const reasonCode = readString(result?.reason_code) ?? "INVALID_RESPONSE";
    console.warn(
      "[canonical-canary-persistence-admission]",
      buildCanonicalCanaryPersistenceAuditRecord(admission, { allowed: false, reason_code: reasonCode })
    );
    throw new Error(`CANONICAL_CANARY_PERSISTENCE_DENIED:${reasonCode}`);
  }
  const jobId = readString(result.job_id);
  if (!jobId) throw new Error("CANONICAL_CANARY_PERSISTENCE_JOB_ID_REQUIRED");
  return {
    insertedCount: result.idempotent === true ? 0 : 1,
    skippedColumns: [],
    adjustedFields: [],
    jobIds: [jobId],
  };
}

export interface CanonicalWorkerProtocolResult {
  job: JobRecord;
  job_id: string;
  worker_task_id: string;
  attempt_id: string;
  lease_id: string;
  canonical_revision: number;
  lease_expires_at: string;
  requested_mode: string;
  scope: unknown;
  acceptance: unknown;
  execution_intent: unknown;
}

interface CanonicalProtocolMutationIdentity {
  job_id: string;
  attempt_id: string;
  lease_id: string;
  worker_id: string;
  expected_revision: number;
}

function canonicalRpcClient(supabase: SupabaseClient): CanonicalPersistenceRpcClient {
  return supabase as unknown as CanonicalPersistenceRpcClient;
}

function canonicalRevision(value: unknown): number {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("CANONICAL_REVISION_INVALID");
  return revision;
}

function canonicalPayload(job: JobRecord): JobRecord {
  const result = readRecord(job.result);
  return readRecord(job.payload) ?? readRecord(result?.canonical_context) ?? {};
}

export function canonicalCanaryAdmissionAllowsWorkerClaim(
  job: JobRecord,
  env: Record<string, string | undefined> = process.env
): boolean {
  const evidence = readRecord(canonicalPayload(job).canonical_canary_admission);
  if (!evidence) return false;
  return evaluateCanonicalCanaryAdmission({
    trusted_owner_id: readString(evidence.trusted_owner_id),
    batch_code: readString(evidence.batch_code),
    requested_mode: readString(evidence.requested_mode),
    event_id: readString(evidence.event_id) ?? "",
    request_id: readString(evidence.request_id) ?? "",
    expected_policy_id: readString(evidence.policy_id),
  }, env).allowed;
}

export function isCanonicalPersistenceJob(job: JobRecord | null | undefined): boolean {
  return Boolean(
    job &&
      readString(job.canonical_job_state) &&
      Number.isSafeInteger(Number(job.canonical_revision))
  );
}

export function canonicalPersistenceRuntimeEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return isCanonicalDatabasePersistenceEnabled(env);
}

async function loadCanonicalOwnership(supabase: SupabaseClient, jobId: string) {
  const { data: job, error: jobError } = await supabase
    .from("hermes_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (jobError) throw new Error(`CANONICAL_JOB_READ_FAILED:${jobError.message}`);
  if (!job) throw new Error("CANONICAL_JOB_NOT_FOUND");

  const { data: attempts, error: attemptError } = await supabase
    .from("hermes_job_attempts")
    .select("*")
    .eq("job_id", jobId)
    .in("attempt_state", ["claimed", "running"])
    .limit(2);
  if (attemptError) throw new Error(`CANONICAL_ATTEMPT_READ_FAILED:${attemptError.message}`);

  const { data: leases, error: leaseError } = await supabase
    .from("hermes_job_leases")
    .select("*")
    .eq("job_id", jobId)
    .eq("lease_state", "active")
    .limit(2);
  if (leaseError) throw new Error(`CANONICAL_LEASE_READ_FAILED:${leaseError.message}`);

  const { data: terminal, error: terminalError } = await supabase
    .from("hermes_job_terminals")
    .select("*")
    .eq("job_id", jobId)
    .maybeSingle();
  if (terminalError) throw new Error(`CANONICAL_TERMINAL_READ_FAILED:${terminalError.message}`);

  return {
    job: job as JobRecord,
    attempt: ((attempts as JobRecord[] | null) ?? [])[0] ?? null,
    lease: ((leases as JobRecord[] | null) ?? [])[0] ?? null,
    terminal: (terminal as JobRecord | null) ?? null,
    active_attempt_count: ((attempts as JobRecord[] | null) ?? []).length,
    active_lease_count: ((leases as JobRecord[] | null) ?? []).length,
  };
}

function requestedCanonicalTerminalIdentity(
  input: CanonicalTerminalReportInput
): CanonicalTerminalSemanticIdentity {
  return {
    job_id: input.job_id,
    attempt_id: input.attempt_id,
    worker_id: input.worker_id,
    report_identity: input.report_identity,
    worker_execution_status: readString(input.worker_execution_status) ?? "failed",
    task_goal_status: readString(input.task_goal_status) ?? "failed",
    effective_final_status: readString(input.effective_final_status) ?? "failed",
    failure_code: readString(input.failure_code),
    failure_stage: readString(input.failure_stage),
  };
}

function assertCanonicalTerminalReplay(
  terminal: JobRecord,
  input: CanonicalTerminalReportInput
): void {
  if (
    !canonicalTerminalSemanticsMatch(
      terminal as unknown as CanonicalTerminalSemanticIdentity,
      requestedCanonicalTerminalIdentity(input)
    )
  ) {
    throw new Error("CANONICAL_TERMINAL_CONFLICT");
  }
}

function assertCanonicalMutationIdentity(
  ownership: Awaited<ReturnType<typeof loadCanonicalOwnership>>,
  input: CanonicalProtocolMutationIdentity
) {
  if (canonicalRevision(ownership.job.canonical_revision) !== input.expected_revision) {
    throw new Error("STALE_REVISION");
  }
  if (ownership.active_attempt_count !== 1 || !ownership.attempt) throw new Error("ACTIVE_ATTEMPT_REQUIRED");
  if (ownership.active_lease_count !== 1 || !ownership.lease) throw new Error("ACTIVE_LEASE_REQUIRED");
  if (readString(ownership.attempt.attempt_id) !== input.attempt_id) throw new Error("ATTEMPT_IDENTITY_MISMATCH");
  if (readString(ownership.lease.lease_id) !== input.lease_id) throw new Error("LEASE_IDENTITY_MISMATCH");
  if (readString(ownership.lease.attempt_id) !== input.attempt_id) throw new Error("LEASE_ATTEMPT_MISMATCH");
  if (
    readString(ownership.attempt.worker_id) !== input.worker_id ||
    readString(ownership.lease.worker_id) !== input.worker_id
  ) {
    throw new Error("WORKER_OWNERSHIP_MISMATCH");
  }
}

async function canonicalDependenciesReady(supabase: SupabaseClient, job: JobRecord): Promise<boolean> {
  const payload = canonicalPayload(job);
  const dependencies = Array.isArray(payload.dependencies)
    ? payload.dependencies.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  const planId = readString(job.plan_id) ?? readString(payload.plan_id);
  if (!dependencies.length) return true;
  if (!planId) throw new Error("CANONICAL_PLAN_ID_REQUIRED");
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("subtask_id,canonical_job_state")
    .eq("plan_id", planId)
    .in("subtask_id", dependencies);
  if (error) throw new Error(`CANONICAL_DEPENDENCY_READ_FAILED:${error.message}`);
  const states = new Map(
    ((data as JobRecord[] | null) ?? []).map((row) => [readString(row.subtask_id), readString(row.canonical_job_state)])
  );
  return dependencies.every((dependency) => states.get(dependency) === "terminal_success");
}

export async function claimNextCanonicalHermesJob(
  supabase: SupabaseClient,
  workerId: string,
  now = new Date()
): Promise<CanonicalWorkerProtocolResult | null> {
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("*")
    .eq("canonical_job_state", "queued")
    .is("terminal_at", null)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(`CANONICAL_JOB_SELECTION_FAILED:${error.message}`);

  for (const candidate of (data as JobRecord[] | null) ?? []) {
    if (!canonicalCanaryAdmissionAllowsWorkerClaim(candidate)) continue;
    if (!(await canonicalDependenciesReady(supabase, candidate))) continue;
    const jobId = readString(candidate.id);
    if (!jobId) continue;
    const attemptId = createWorkerAttemptId(jobId, workerId);
    const leaseId = `lease:${attemptId}`;
    const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    const expectedRevision = canonicalRevision(candidate.canonical_revision);
    try {
      const result = await canonicalAcquireAttemptLease(canonicalRpcClient(supabase), {
        job_id: jobId,
        worker_id: workerId,
        attempt_id: attemptId,
        lease_id: leaseId,
        expected_revision: expectedRevision,
        now: now.toISOString(),
        expires_at: leaseExpiresAt,
      });
      const revision = canonicalRevision(result.revision);
      const payload = canonicalPayload(candidate);
      return {
        job: {
          ...candidate,
          payload,
          canonical_job_state: "claimed",
          canonical_revision: revision,
          status: "running",
          claimed_by: workerId,
          projection_only: true,
        },
        job_id: jobId,
        worker_task_id: readString(candidate.job_id) ?? jobId,
        attempt_id: attemptId,
        lease_id: leaseId,
        canonical_revision: revision,
        lease_expires_at: leaseExpiresAt,
        requested_mode: readString(candidate.requested_mode) ?? readString(payload.requested_mode) ?? "",
        scope: payload.allowed_paths ?? payload.allowed_scope ?? [],
        acceptance: payload.acceptance_criteria ?? candidate.acceptance ?? [],
        execution_intent: payload.execution_intent ?? null,
      };
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      if (/STALE_REVISION|JOB_NOT_QUEUED|ACTIVE_ATTEMPT_EXISTS|ACTIVE_LEASE_EXISTS/.test(message)) continue;
      throw errorValue;
    }
  }
  return null;
}

export async function persistCanonicalWorkerRuntimeSignal(
  supabase: SupabaseClient,
  input: CanonicalProtocolMutationIdentity & {
    signal: "heartbeat" | "progress";
    now?: string;
    lease_expires_at?: string | null;
  }
) {
  const ownership = await loadCanonicalOwnership(supabase, input.job_id);
  if (ownership.terminal) {
    return {
      ok: true,
      terminal_noop: true,
      idempotent: true,
      revision: canonicalRevision(ownership.job.canonical_revision),
      job: ownership.job,
    };
  }
  assertCanonicalMutationIdentity(ownership, input);
  const now = input.now ?? new Date().toISOString();
  const result = await canonicalPersistRuntimeSignal(canonicalRpcClient(supabase), {
    ...input,
    now,
    new_expires_at: input.signal === "heartbeat" ? input.lease_expires_at ?? null : null,
  });
  const revision = canonicalRevision(result.revision);
  return {
    ...result,
    revision,
    job: {
      ...ownership.job,
      canonical_job_state: "running",
      canonical_revision: revision,
      status: "running",
      projection_only: true,
    },
  };
}

export async function finalizeCanonicalPersistenceJobSafely(
  supabase: SupabaseClient,
  input: CanonicalTerminalReportInput & {
    lease_id: string;
    expected_revision: number;
  }
): Promise<CanonicalTerminalReportResult & { revision?: number }> {
  const ownership = await loadCanonicalOwnership(supabase, input.job_id);
  if (ownership.terminal) {
    assertCanonicalTerminalReplay(ownership.terminal, input);
  } else {
    assertCanonicalMutationIdentity(ownership, input);
  }
  const effectiveStatus = readString(input.effective_final_status) ?? "failed";
  const taskGoalStatus = readString(input.task_goal_status) ?? "failed";
  const workerStatus = readString(input.worker_execution_status) ?? "failed";
  if (taskGoalStatus === "failed" && effectiveStatus === "succeeded") {
    throw new Error("TASK_FAILURE_CANNOT_SUCCEED");
  }
  const terminalState =
    effectiveStatus === "succeeded"
      ? "terminal_success"
      : effectiveStatus === "cancelled"
        ? "terminal_cancelled"
        : "terminal_failed";
  const result = await canonicalFinalizeTerminal(canonicalRpcClient(supabase), {
    job_id: input.job_id,
    attempt_id: input.attempt_id,
    lease_id: input.lease_id,
    worker_id: input.worker_id,
    expected_revision: input.expected_revision,
    now: input.now ?? new Date().toISOString(),
    report_identity: input.report_identity,
    terminal_job_state: terminalState,
    final_attempt_state: terminalState === "terminal_success" ? "finished" : terminalState === "terminal_cancelled" ? "abandoned" : "failed",
    worker_execution_status: workerStatus,
    task_goal_status: taskGoalStatus,
    effective_final_status: effectiveStatus,
    failure_code: readString(input.failure_code),
    failure_stage: readString(input.failure_stage),
    canonical_report: input.report_fields,
  });
  if (result.idempotent === true && !ownership.terminal) {
    const replayOwnership = await loadCanonicalOwnership(supabase, input.job_id);
    if (!replayOwnership.terminal) throw new Error("CANONICAL_TERMINAL_RECORD_MISSING");
    assertCanonicalTerminalReplay(replayOwnership.terminal, input);
  }
  const revision = canonicalRevision(result.revision);
  const terminalStatus = terminalState === "terminal_success" ? "succeeded" : terminalState === "terminal_cancelled" ? "cancelled" : "failed";
  return {
    ok: true,
    terminal_applied: result.idempotent !== true,
    idempotent: result.idempotent === true,
    conflict: false,
    terminal_immutable: true,
    failure_code: null,
    failure_stage: "terminal_report_finalization",
    revision,
    job: {
      ...ownership.job,
      canonical_job_state: terminalState,
      canonical_revision: revision,
      terminal_at: input.now ?? new Date().toISOString(),
      status: terminalStatus,
      claimed_by: null,
      result: input.report_fields.result ?? input.report_fields,
      projection_only: true,
    },
  };
}

export async function recoverCanonicalExpiredLeases(
  supabase: SupabaseClient,
  now = new Date().toISOString(),
  limit = 100
) {
  const { data, error } = await supabase
    .from("hermes_job_leases")
    .select("*")
    .eq("lease_state", "active")
    .lte("expires_at", now)
    .order("expires_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`CANONICAL_STALE_LEASE_READ_FAILED:${error.message}`);
  const recovered: Array<Record<string, unknown>> = [];
  for (const lease of (data as JobRecord[] | null) ?? []) {
    const jobId = readString(lease.job_id);
    const attemptId = readString(lease.attempt_id);
    const leaseId = readString(lease.lease_id);
    const workerId = readString(lease.worker_id);
    if (!jobId || !attemptId || !leaseId || !workerId) continue;
    const ownership = await loadCanonicalOwnership(supabase, jobId);
    if (ownership.terminal) continue;
    const result = await persistCanonicalStaleAttempt(canonicalRpcClient(supabase), {
      job_id: jobId,
      attempt_id: attemptId,
      lease_id: leaseId,
      worker_id: workerId,
      expected_revision: canonicalRevision(ownership.job.canonical_revision),
      now,
    });
    recovered.push(result);
  }
  return recovered;
}

function subtaskFromCanonicalJob(job: JobRecord): HermesExecutionSubtask {
  const payload = canonicalPayload(job);
  return {
    subtask_id: readString(job.subtask_id) ?? readString(payload.subtask_id) ?? "",
    title: readString(payload.subtask_title) ?? readString(job.title) ?? "Canonical subtask",
    objective: readString(payload.objective) ?? readString(job.request_text) ?? "Canonical subtask",
    dependencies: Array.isArray(payload.dependencies) ? payload.dependencies.filter((value): value is string => typeof value === "string") : [],
    recommended_agent: readString(payload.recommended_agent) ?? "codex_agent",
    required_capabilities: Array.isArray(payload.required_capabilities) ? payload.required_capabilities.filter((value): value is string => typeof value === "string") : [],
    execution_intent: readString(payload.execution_intent) ?? "verification",
    allowed_paths: Array.isArray(payload.allowed_paths) ? payload.allowed_paths.filter((value): value is string => typeof value === "string") : [],
    forbidden_paths: Array.isArray(payload.forbidden_paths) ? payload.forbidden_paths.filter((value): value is string => typeof value === "string") : [],
    acceptance_criteria: Array.isArray(payload.acceptance_criteria) ? payload.acceptance_criteria.filter((value): value is string => typeof value === "string") : [],
    validation_requirements: Array.isArray(payload.validation_requirements) ? payload.validation_requirements.filter((value): value is string => typeof value === "string") : [],
    git_commit_required: payload.git_commit_required === true,
    git_push_required: payload.git_push_required === true,
    deployment_required: payload.deployment_required === true,
  };
}

export async function buildCanonicalPlanFinalReportProjection(
  supabase: SupabaseClient,
  planId: string
) {
  const { data: jobs, error: jobsError } = await supabase
    .from("hermes_jobs")
    .select("*")
    .eq("plan_id", planId)
    .order("created_at", { ascending: true });
  if (jobsError) throw new Error(`CANONICAL_PLAN_JOBS_READ_FAILED:${jobsError.message}`);
  const jobRows = (jobs as JobRecord[] | null) ?? [];
  if (!jobRows.length) return null;
  const jobIds = jobRows.map((job) => readString(job.id)).filter((value): value is string => Boolean(value));
  const { data: terminals, error: terminalsError } = await supabase
    .from("hermes_job_terminals")
    .select("*")
    .in("job_id", jobIds);
  if (terminalsError) throw new Error(`CANONICAL_PLAN_TERMINALS_READ_FAILED:${terminalsError.message}`);
  const terminalRows = (terminals as JobRecord[] | null) ?? [];
  const terminalByJob = new Map(terminalRows.map((terminal) => [readString(terminal.job_id), terminal]));
  const jobBySubtask = new Map(jobRows.map((job) => [readString(job.subtask_id), job]));
  for (const job of jobRows) {
    if (terminalByJob.has(readString(job.id))) continue;
    const blocked = subtaskFromCanonicalJob(job).dependencies.some((dependency) => {
      const dependencyJob = jobBySubtask.get(dependency);
      const terminal = dependencyJob ? terminalByJob.get(readString(dependencyJob.id)) : null;
      return terminal && readString(terminal.effective_final_status) !== "succeeded";
    });
    if (!blocked) return null;
  }

  const first = jobRows[0];
  const payload = canonicalPayload(first);
  const requestedMode = (readString(first.requested_mode) ?? readString(payload.requested_mode)) as HermesRequestedMode;
  const plan = normalizeExecutionPlan(
    {
      schema_version: readString(payload.plan_schema_version) ?? "1.0",
      plan_id: planId,
      plan_revision: Number(payload.plan_revision) || 1,
      original_request_text: readString(payload.original_request_text) ?? readString(first.request_text) ?? "Canonical plan",
      project_domain: readString(first.project_domain) ?? readString(payload.project_domain) ?? "unknown",
      requested_mode: requestedMode,
      approval_context: readRecord(payload.approval_context) ?? {},
      objective: readString(payload.plan_objective) ?? readString(payload.objective) ?? "Canonical plan",
      aggregation_policy: payload.aggregation_policy === "best_effort" ? "best_effort" : "all_required",
      subtasks: jobRows.map(subtaskFromCanonicalJob),
    },
    requestedMode
  ) as HermesExecutionPlan;
  const results: CanonicalSubtaskResult[] = terminalRows.map((terminal) => {
    const job = jobRows.find((candidate) => readString(candidate.id) === readString(terminal.job_id));
    return {
      subtask_id: readString(job?.subtask_id) ?? "",
      report_identity: readString(terminal.report_identity) ?? "",
      worker_status: readString(terminal.worker_execution_status) ?? "failed",
      task_goal_status: readString(terminal.task_goal_status) ?? "failed",
      effective_final_status: readString(terminal.effective_final_status) ?? "failed",
      failure_code: readString(terminal.failure_code),
      failure_stage: readString(terminal.failure_stage),
    };
  });
  return buildProjectDirectorFinalReport(aggregatePlanResults({ plan, job_results: results }));
}

export async function updateHermesJob(
  supabase: SupabaseClient,
  jobId: string,
  fields: JobRecord
): Promise<{ data: JobRecord | null; error: SupabaseWriteError | null; skippedColumns: string[] }> {
  let pendingFields = { ...fields };
  const skippedColumns: string[] = [];

  for (let attempt = 0; attempt < 8; attempt++) {
    const { data, error } = await supabase
      .from("hermes_jobs")
      .update(pendingFields)
      .eq("id", jobId)
      .select("*")
      .maybeSingle();

    if (!error) return { data: (data as JobRecord | null) ?? null, error: null, skippedColumns };
    if (!isMissingColumnError(error)) return { data: null, error, skippedColumns };

    const missingColumn = extractMissingColumn(error);
    if (!missingColumn || !(missingColumn in pendingFields)) {
      return { data: null, error, skippedColumns };
    }
    skippedColumns.push(missingColumn);
    const rest = { ...pendingFields };
    delete rest[missingColumn];
    pendingFields = rest;
  }

  return {
    data: null,
    error: { message: "too many missing columns while updating hermes_jobs" },
    skippedColumns,
  };
}

export interface CanonicalRuntimeSignalPersistenceResult {
  ok: boolean;
  applied: boolean;
  terminal: boolean;
  idempotent: boolean;
  race_lost: boolean;
  failure_code: string | null;
  failure_stage: "runtime_signal_persistence";
  data: JobRecord | null;
  error: SupabaseWriteError | null;
}

interface CanonicalRuntimeSignalPersistenceInput {
  job_id: string;
  worker_id: string;
  attempt_id: string;
  signal: "heartbeat" | "progress";
  expected_job: JobRecord;
  patch: JobRecord;
}

function runtimeSignalPersistenceFailure(
  failureCode: string,
  data: JobRecord | null = null,
  error: SupabaseWriteError | null = null,
  raceLost = false
): CanonicalRuntimeSignalPersistenceResult {
  return {
    ok: false,
    applied: false,
    terminal: false,
    idempotent: false,
    race_lost: raceLost,
    failure_code: failureCode,
    failure_stage: "runtime_signal_persistence",
    data,
    error,
  };
}

function terminalRuntimeSignalNoop(job: JobRecord): CanonicalRuntimeSignalPersistenceResult {
  return {
    ok: true,
    applied: false,
    terminal: true,
    idempotent: true,
    race_lost: true,
    failure_code: null,
    failure_stage: "runtime_signal_persistence",
    data: job,
    error: null,
  };
}

export async function persistCanonicalRuntimeSignalSafely(
  supabase: SupabaseClient,
  input: CanonicalRuntimeSignalPersistenceInput
): Promise<CanonicalRuntimeSignalPersistenceResult> {
  if (!input.job_id || !input.worker_id || !input.attempt_id) {
    return runtimeSignalPersistenceFailure("RUNTIME_SIGNAL_IDENTITY_REQUIRED");
  }

  const expectedJob = input.expected_job;
  const expectedInvariant = validateCanonicalJobStateInvariant(expectedJob) as CanonicalInvariantResult;
  if (expectedInvariant.snapshot.terminal) return terminalRuntimeSignalNoop(expectedJob);
  if (!expectedInvariant.ok) {
    return runtimeSignalPersistenceFailure(
      expectedInvariant.failure_code ?? "JOB_STATE_INVARIANT_VIOLATION",
      expectedJob
    );
  }

  const expectedSnapshot = expectedInvariant.snapshot;
  const expectedAttempt = getCanonicalActiveAttempt(expectedJob);
  const expectedLease = expectedSnapshot.active_lease as Record<string, unknown> | null;
  if (!["claimed", "running"].includes(String(expectedSnapshot.state ?? ""))) {
    return runtimeSignalPersistenceFailure("RUNTIME_SIGNAL_JOB_NOT_ACTIVE", expectedJob);
  }
  if (
    expectedSnapshot.claimed_by !== input.worker_id ||
    readString(expectedAttempt?.worker_id) !== input.worker_id ||
    readString(expectedLease?.worker_id) !== input.worker_id
  ) {
    return runtimeSignalPersistenceFailure("RUNTIME_SIGNAL_WORKER_OWNERSHIP_MISMATCH", expectedJob);
  }
  if (
    readString(expectedAttempt?.id) !== input.attempt_id ||
    readString(expectedLease?.attempt_id) !== input.attempt_id
  ) {
    return runtimeSignalPersistenceFailure("RUNTIME_SIGNAL_ATTEMPT_MISMATCH", expectedJob);
  }

  const proposedJob = { ...expectedJob, ...input.patch };
  const proposedInvariant = validateCanonicalJobStateInvariant(proposedJob) as CanonicalInvariantResult;
  if (
    !proposedInvariant.ok ||
    proposedInvariant.snapshot.terminal ||
    !["claimed", "running"].includes(String(proposedInvariant.snapshot.state ?? ""))
  ) {
    return runtimeSignalPersistenceFailure(
      proposedInvariant.failure_code ?? "RUNTIME_SIGNAL_POST_TRANSITION_INVALID",
      expectedJob
    );
  }

  const expectedStatus = readString(expectedJob.status);
  const expectedUpdatedAt = readString(expectedJob.updated_at);
  if (!expectedStatus || !expectedUpdatedAt || isTerminalWorkerStatus(expectedStatus)) {
    return runtimeSignalPersistenceFailure("RUNTIME_SIGNAL_STATE_REVISION_REQUIRED", expectedJob);
  }
  if (
    readString(expectedJob.claimed_by) !== input.worker_id ||
    readString(expectedJob.attempt_id) !== input.attempt_id ||
    readString(expectedJob.active_attempt_id) !== input.attempt_id
  ) {
    return runtimeSignalPersistenceFailure("RUNTIME_SIGNAL_CAS_IDENTITY_REQUIRED", expectedJob);
  }

  const { data, error } = await supabase
    .from("hermes_jobs")
    .update(input.patch)
    .eq("id", input.job_id)
    .eq("status", expectedStatus)
    .eq("claimed_by", input.worker_id)
    .eq("attempt_id", input.attempt_id)
    .eq("active_attempt_id", input.attempt_id)
    .eq("updated_at", expectedUpdatedAt)
    .select("*")
    .maybeSingle();
  if (error) {
    return runtimeSignalPersistenceFailure("RUNTIME_SIGNAL_COMPARE_AND_SET_FAILED", expectedJob, error);
  }
  if (data) {
    const persistedJob = data as JobRecord;
    const persistedInvariant = validateCanonicalJobStateInvariant(persistedJob) as CanonicalInvariantResult;
    if (!persistedInvariant.ok || persistedInvariant.snapshot.terminal) {
      return runtimeSignalPersistenceFailure(
        persistedInvariant.failure_code ?? "RUNTIME_SIGNAL_PERSISTED_STATE_INVALID",
        persistedJob
      );
    }
    return {
      ok: true,
      applied: true,
      terminal: false,
      idempotent: false,
      race_lost: false,
      failure_code: null,
      failure_stage: "runtime_signal_persistence",
      data: persistedJob,
      error: null,
    };
  }

  const raceRead = await findHermesJob(supabase, input.job_id);
  if (raceRead.error) {
    return runtimeSignalPersistenceFailure("RUNTIME_SIGNAL_RACE_READ_FAILED", null, raceRead.error, true);
  }
  if (!raceRead.data) {
    return runtimeSignalPersistenceFailure("RUNTIME_SIGNAL_JOB_NOT_FOUND", null, null, true);
  }
  const racedJob = raceRead.data;
  const racedInvariant = validateCanonicalJobStateInvariant(racedJob) as CanonicalInvariantResult;
  if (racedInvariant.snapshot.terminal) return terminalRuntimeSignalNoop(racedJob);
  if (!racedInvariant.ok) {
    return runtimeSignalPersistenceFailure(
      racedInvariant.failure_code ?? "JOB_STATE_INVARIANT_VIOLATION",
      racedJob,
      null,
      true
    );
  }
  const racedAttempt = getCanonicalActiveAttempt(racedJob);
  const racedLease = racedInvariant.snapshot.active_lease as Record<string, unknown> | null;
  if (
    racedInvariant.snapshot.claimed_by !== input.worker_id ||
    readString(racedAttempt?.worker_id) !== input.worker_id ||
    readString(racedLease?.worker_id) !== input.worker_id
  ) {
    return runtimeSignalPersistenceFailure("RUNTIME_SIGNAL_WORKER_OWNERSHIP_CHANGED", racedJob, null, true);
  }
  if (
    readString(racedAttempt?.id) !== input.attempt_id ||
    readString(racedLease?.attempt_id) !== input.attempt_id
  ) {
    return runtimeSignalPersistenceFailure("RUNTIME_SIGNAL_ATTEMPT_CHANGED", racedJob, null, true);
  }
  return runtimeSignalPersistenceFailure("RUNTIME_SIGNAL_COMPARE_AND_SET_RACE_LOST", racedJob, null, true);
}

export async function claimHermesJob(
  supabase: SupabaseClient,
  jobId: string,
  workerId: string,
  fields: JobRecord,
  expected: { updated_at?: string | null } = {}
): Promise<{ data: JobRecord | null; error: SupabaseWriteError | null; skippedColumns: string[] }> {
  const claimedFields = { ...fields };
  const skippedColumns: string[] = [];

  for (let attempt = 0; attempt < 8; attempt++) {
    let query = supabase
      .from("hermes_jobs")
      .update(claimedFields)
      .eq("id", jobId)
      .in("status", ["queued", "pending"]);

    if (expected.updated_at) query = query.eq("updated_at", expected.updated_at);

    query = isSafePostgrestFilterValue(workerId)
      ? query.or(`claimed_by.is.null,claimed_by.eq.${workerId}`)
      : query.is("claimed_by", null);

    const { data, error } = await query.select("*").maybeSingle();

    if (!error) return { data: (data as JobRecord | null) ?? null, error: null, skippedColumns };
    if (!isMissingColumnError(error)) return { data: null, error, skippedColumns };

    const missingColumn = extractMissingColumn(error);
    if (!missingColumn || !(missingColumn in claimedFields)) {
      return { data: null, error, skippedColumns };
    }
    skippedColumns.push(missingColumn);
    delete claimedFields[missingColumn];
  }

  return {
    data: null,
    error: { message: "too many missing columns while claiming hermes_jobs" },
    skippedColumns,
  };
}

export async function findHermesJob(
  supabase: SupabaseClient,
  jobId: string
): Promise<{ data: JobRecord | null; error: SupabaseWriteError | null }> {
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  return { data: (data as JobRecord | null) ?? null, error };
}

export interface CanonicalTerminalReportResult {
  ok: boolean;
  terminal_applied: boolean;
  idempotent: boolean;
  conflict: boolean;
  terminal_immutable: boolean;
  failure_code: string | null;
  failure_stage: "terminal_report_finalization";
  job: JobRecord | null;
}

interface CanonicalTerminalReportInput {
  job_id: string;
  worker_id: string;
  attempt_id: string;
  report_identity: string;
  worker_execution_status: string | null;
  task_goal_status: string | null;
  effective_final_status: string | null;
  failure_code?: string | null;
  failure_stage?: string | null;
  report_fields: JobRecord;
  now?: string;
}

export async function finalizeCanonicalJobReportSafely(
  supabase: SupabaseClient,
  input: CanonicalTerminalReportInput
): Promise<CanonicalTerminalReportResult> {
  return (await finalizeSharedCanonicalJobReportSafely(
    supabase,
    input
  )) as CanonicalTerminalReportResult;
}

export interface FailedClaimRollbackResult {
  ok: boolean;
  rollback_applied: boolean;
  rollback_skipped_reason: string | null;
  terminal_report_won: boolean;
  failure_code: string | null;
  failure_stage: "failed_claim_rollback";
  job: JobRecord | null;
}

function failedClaimRollbackFailure(
  failureCode: string,
  job: JobRecord | null = null
): FailedClaimRollbackResult {
  return {
    ok: false,
    rollback_applied: false,
    rollback_skipped_reason: null,
    terminal_report_won: false,
    failure_code: failureCode,
    failure_stage: "failed_claim_rollback",
    job,
  };
}

export async function rollbackFailedClaimSafely(
  supabase: SupabaseClient,
  input: { job_id: string; worker_id: string; attempt_id: string; now?: string }
): Promise<FailedClaimRollbackResult> {
  const currentRead = await findHermesJob(supabase, input.job_id);
  if (currentRead.error) return failedClaimRollbackFailure("ROLLBACK_STATE_READ_FAILED");
  if (!currentRead.data) return failedClaimRollbackFailure("ROLLBACK_JOB_NOT_FOUND");

  const currentJob = currentRead.data;
  const expectedUpdatedAt = readString(currentJob.updated_at);
  const transition = buildCanonicalFailedClaimRollback(currentJob, {
    ...input,
    expected_updated_at: expectedUpdatedAt,
    now: input.now ?? new Date().toISOString(),
  });
  if (transition.terminal_report_won || transition.rollback_skipped_reason === "JOB_ALREADY_TERMINAL") {
    return {
      ok: true,
      rollback_applied: false,
      rollback_skipped_reason: "JOB_ALREADY_TERMINAL",
      terminal_report_won: true,
      failure_code: null,
      failure_stage: "failed_claim_rollback",
      job: currentJob,
    };
  }
  if (!transition.ok || !transition.patch || !transition.compare_and_set) {
    return failedClaimRollbackFailure(transition.failure_code ?? "ROLLBACK_TRANSITION_REJECTED", currentJob);
  }

  const expected = transition.compare_and_set;
  let query = supabase
    .from("hermes_jobs")
    .update(transition.patch)
    .eq("id", input.job_id)
    .eq("status", String(expected.status))
    .eq("claimed_by", input.worker_id)
    .eq("attempt_id", input.attempt_id)
    .eq("active_attempt_id", input.attempt_id);
  if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select("*").maybeSingle();
  if (error) return failedClaimRollbackFailure("ROLLBACK_COMPARE_AND_SET_FAILED", currentJob);
  if (data) {
    return {
      ok: true,
      rollback_applied: true,
      rollback_skipped_reason: null,
      terminal_report_won: false,
      failure_code: null,
      failure_stage: "failed_claim_rollback",
      job: data as JobRecord,
    };
  }

  const raceRead = await findHermesJob(supabase, input.job_id);
  if (raceRead.error) return failedClaimRollbackFailure("ROLLBACK_RACE_READ_FAILED");
  if (!raceRead.data) return failedClaimRollbackFailure("ROLLBACK_JOB_NOT_FOUND");
  const racedJob = raceRead.data;
  if (inspectCanonicalJobState(racedJob).terminal) {
    return {
      ok: true,
      rollback_applied: false,
      rollback_skipped_reason: "JOB_ALREADY_TERMINAL",
      terminal_report_won: true,
      failure_code: null,
      failure_stage: "failed_claim_rollback",
      job: racedJob,
    };
  }
  const invariant = validateCanonicalJobStateInvariant(racedJob);
  if (!invariant.ok) {
    return failedClaimRollbackFailure(invariant.failure_code ?? "JOB_STATE_INVARIANT_VIOLATION", racedJob);
  }
  const snapshot = inspectCanonicalJobState(racedJob);
  const activeAttempt = getCanonicalActiveAttempt(racedJob);
  const activeLease = snapshot.active_lease as Record<string, unknown> | null;
  if (
    snapshot.claimed_by !== input.worker_id ||
    readString(activeAttempt?.id) !== input.attempt_id ||
    readString(activeLease?.attempt_id) !== input.attempt_id ||
    readString(activeLease?.worker_id) !== input.worker_id
  ) {
    return failedClaimRollbackFailure("ROLLBACK_OWNERSHIP_CHANGED", racedJob);
  }
  if (expectedUpdatedAt && readString(racedJob.updated_at) !== expectedUpdatedAt) {
    return failedClaimRollbackFailure("ROLLBACK_VERSION_CHANGED", racedJob);
  }
  return failedClaimRollbackFailure("ROLLBACK_COMPARE_AND_SET_FAILED", racedJob);
}

function readNestedRecordId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of RECORD_ID_KEYS) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function isStoredTerminalJobRecord(value: unknown): boolean {
  const record = readRecord(value);
  if (!record) return false;
  if (!isTerminalWorkerStatus(record.status)) return false;
  const result = readRecord(record.result);
  return Boolean(result?.project_director_report_text || result?.project_director_report);
}

export function getBitableRecordId(...sources: unknown[]): string | null {
  if (sources.length === 2 && isStoredTerminalJobRecord(sources[1])) {
    return null;
  }

  for (const source of sources) {
    const direct = readNestedRecordId(source);
    if (direct) return direct;
    if (source && typeof source === "object") {
      const record = source as Record<string, unknown>;
      const payload = readNestedRecordId(record.payload);
      if (payload) return payload;
      const result = readNestedRecordId(record.result);
      if (result) return result;
      const raw = readNestedRecordId(record.raw);
      if (raw) return raw;
    }
  }
  return null;
}

export function normalizeWorkerStatus(
  value: unknown
): "queued" | "running" | "succeeded" | "failed" | "cancelled" {
  if (value === "failed" || value === "error") return "failed";
  if (value === "succeeded" || value === "success" || value === "completed") return "succeeded";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  if (value === "queued" || value === "pending") return "queued";
  return "running";
}

export function clampProgress(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}
