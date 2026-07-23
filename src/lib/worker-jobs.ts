import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseService } from "@/lib/env";

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

const TERMINAL_WORKER_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
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
export const WORKER_JOB_CONTRACT_FIELDS = [
  "context_source",
  "context_reconstruct_failed",
  "project_domain",
  "task_mode",
  "read_only_mode",
  "allowed_scope",
  "exact_allowed_scope",
  "forbidden_scope",
  "original_request_text",
  "original_request_text_base64",
  "route",
  "payload",
  "approved_batch",
  "attempt_id",
  "worker_stage",
  "workflow_stage",
  "final_report_status",
  "effective_final_status",
  "failure_code",
  "failure_stage",
  "changed_files",
  "git_commit_sha",
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
  "TEST_FAILED",
  "TYPESCRIPT_FAILED",
  "OUT_OF_SCOPE_CHANGE",
  "CONTEXT_RECONSTRUCT_FAILED",
  "GIT_COMMIT_FAILED",
  "GIT_PUSH_FAILED",
  "GIT_SYNC_FAILED",
  "CODEX_QUOTA_EXHAUSTED",
  "CODEX_IDLE_TIMEOUT",
  "APPROVAL_CONTEXT_SAVE_FAILED",
  "AGENT_PAUSED",
  "EXACT_ALLOWED_SCOPE_MISSING",
  "TASK_INSERT_FAILED",
  "GIT_SYNC_PREFLIGHT_FAILED",
  "CHANGED_FILES_PARSE_FAILED",
  "UTF8_REPLY_CORRUPTED",
  "DEPLOYMENT_FAILED",
  "TERMINAL_REPORT_DUPLICATE",
  "WORKER_REPORT_CONTRACT_INCOMPLETE",
  "UNKNOWN_FAILURE",
] as const;
const IMPLEMENTED_DIAGNOSTICS_FAILURE_STAGES = [
  "intake",
  "approval_context",
  "worker_creation",
  "worker_claim",
  "codex_execution",
  "validation",
  "git",
  "git_sync_preflight",
  "push",
  "report",
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
  /\b(?:context_source|context_reconstruct_failed|project_domain|task_mode|read_only_mode|allowed_scope|exact_allowed_scope|forbidden_scope|original_request_text(?:_base64)?|route|approved_batch|attempt_id|worker_stage|workflow_stage|final_report_status|effective_final_status|failure_code|failure_stage|changed_files|git_commit_sha|next_batch|completed_at|pushed|deploy_status)\s*[:=]/i;

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

function readTextValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(readTextValue).filter(Boolean).join("\n");
  if (typeof value === "object") return Object.values(value).map(readTextValue).filter(Boolean).join("\n");
  return String(value);
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
  "task_mode",
  "read_only_mode",
  "allowed_scope",
  "exact_allowed_scope",
  "forbidden_scope",
  "original_request_text",
  "original_request_text_base64",
  "route",
  "approved_batch",
  "attempt_id",
  "worker_stage",
  "workflow_stage",
  "final_report_status",
  "effective_final_status",
  "failure_code",
  "failure_stage",
  "changed_files",
  "git_commit_sha",
  "next_batch",
  "completed_at",
  "pushed",
  "deploy_status",
];

const WORKER_CONTEXT_CORE_FIELDS = [
  "project_domain",
  "task_mode",
  "read_only_mode",
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
    task_mode: ["task_mode", "taskMode"],
    read_only_mode: ["read_only_mode", "readOnlyMode", "readonly", "read_only"],
    allowed_scope: ["allowed_scope", "allowedScope", "allowed_files", "allowedFiles"],
    exact_allowed_scope: ["exact_allowed_scope", "exactAllowedScope", "exact_allowed_paths", "exactAllowedPaths"],
    forbidden_scope: ["forbidden_scope", "forbiddenScope", "forbidden_files", "forbiddenFiles"],
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
    git_commit_sha: ["git_commit_sha", "gitCommitSha"],
    next_batch: ["next_batch", "nextBatch"],
    completed_at: ["completed_at", "completedAt"],
    pushed: ["pushed"],
    deploy_status: ["deploy_status", "deployStatus"],
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
  if (!job) return null;
  const payload = readRecord(job.payload);
  const activeAttempt = readRecord(payload?.active_attempt);

  return (
    readString(job.active_attempt_id) ??
    readString(job.attempt_id) ??
    readString(activeAttempt?.attempt_id) ??
    readString(payload?.attempt_id)
  );
}

export function getStoredTerminalAttemptId(job: JobRecord | null | undefined): string | null {
  if (!job) return null;
  const result = readRecord(job.result);
  return getActiveAttemptId(job) ?? readString(result?.attempt_id);
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
  if (!text || /^(null|none|n\/a)$/i.test(text)) return null;
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
    git_commit_sha: readString(finalResult.git_commit_sha),
    pushed:
      typeof finalResult.pushed === "boolean"
        ? finalResult.pushed
        : readNullableBooleanFlag(finalResult.pushed) ?? false,
    next_batch: readString(finalResult.next_batch),
    next_stage_allowed:
      typeof finalResult.next_stage_allowed === "boolean"
        ? finalResult.next_stage_allowed
        : readNullableBooleanFlag(finalResult.next_stage_allowed) ?? false,
    reply_error: readString(finalResult.reply_error),
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
  nextBatch?: string | null;
  next_batch?: string | null;
  completedAt?: string | null;
  completed_at?: string | null;
  approvedBatch?: string | null;
}): Record<string, unknown> {
  const job = input.job ?? null;
  const jobResult = readRecord(job?.result);
  const projectDirectorReport = readRecord(jobResult?.project_director_report);
  const reportText = [input.resultText, input.errorText].filter(Boolean).join("\n");
  const requestedStatus =
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
    readString(input.approvedBatch) ??
    readString(input.approved_batch) ??
    readString(projectDirectorReport?.approved_batch) ??
    getJobBatchCode(job);
  const failureCode =
    effectiveFinalStatus === "failed"
      ? normalizeFailureCodeValue(
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
      ? readString(input.failureStage) ??
        readString(input.failure_stage) ??
        readString(projectDirectorReport?.failure_stage) ??
        readDiagnosticLine(reportText, "failure_stage") ??
        (failureCode === "GIT_SYNC_FAILED" ? "git_sync_preflight" : null) ??
        readDiagnosticLine(reportText, "失败阶段")
      : null;
  const nextBatch =
    readString(input.nextBatch) ??
    readString(input.next_batch) ??
    readString(projectDirectorReport?.next_batch) ??
    extractNextBatchFromText(reportText) ??
    (effectiveFinalStatus === "succeeded" ? inferNextBatchFromBatchCode(approvedBatch) : null);
  const finalResult = {
    job_id: readString(input.job_id) ?? readString(job?.id) ?? readString(job?.job_id),
    approved_batch: approvedBatch,
    worker_execution_status:
      readString(input.worker_execution_status) ??
      readString(projectDirectorReport?.worker_execution_status) ??
      readDiagnosticLine(reportText, "worker_execution_status"),
    task_goal_status:
      readString(input.task_goal_status) ??
      readString(projectDirectorReport?.task_goal_status) ??
      readDiagnosticLine(reportText, "task_goal_status"),
    final_report_status: normalizeTerminalStatus(input.final_report_status ?? input.finalReportStatus ?? input.status),
    effective_final_status: effectiveFinalStatus,
    failure_code: failureCode,
    failure_stage: failureStage,
    changed_files: readStringArray(
      input.changed_files ??
        input.files_changed ??
        projectDirectorReport?.changed_files ??
        projectDirectorReport?.files_changed
    ),
    git_commit_sha:
      readString(input.gitCommitSha) ??
      readString(input.git_commit_sha) ??
      readString(projectDirectorReport?.git_commit_sha) ??
      readString(job?.git_commit_sha),
    pushed:
      typeof input.pushed === "boolean"
        ? input.pushed
        : readNullableBooleanFlag(input.pushed) ??
          readNullableBooleanFlag(projectDirectorReport?.pushed) ??
          false,
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
  return /NO_FIX_APPLIED|no_fix_applied\s*[:=]\s*(true|yes)|NO_FIX_APPLIED\s*(?:是否触发)?\s*[:：]\s*(?:是|yes|true)/i.test(value);
}

function reportTextHasReadOnlyViolation(value: string): boolean {
  return /READ_ONLY_MODE_VIOLATION|read_only_mode_violation\s*[:=]\s*(true|yes)|Read-only violation:\s*yes/i.test(value);
}

function reportTextHasOutOfScope(value: string): boolean {
  return /OUT_OF_SCOPE_BUSINESS_CHANGE|out_of_scope_business_change\s*[:=]\s*(true|yes)|Out-of-scope business change:\s*yes/i.test(value);
}

function reportTextHasFailedTaskGoal(value: string): boolean {
  return /MISSING_REQUIRED_DOCS|INSUFFICIENT_DOC_OUTPUT|INCOMPLETE_QA_REPORT|TASK_MODE_MISMATCH|task_goal_status\s*[:=]\s*(failed|failed_[a-z_]+|no_fix_applied|read_only_violation|out_of_scope_business_change|task_mode_mismatch|missing_required_docs|insufficient_doc_output|incomplete_qa_report)|Task goal status:\s*(failed|failed_[a-z_]+|no_fix_applied|read_only_violation|out_of_scope_business_change|task_mode_mismatch|missing_required_docs|insufficient_doc_output|incomplete_qa_report)|任务目标状态[:：]\s*(failed|失败|未完成)/i.test(value);
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

export function buildWorkerJobPayloadContract(input: {
  job?: JobRecord | null;
  requestText?: unknown;
  payload?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  projectDomain?: string | null;
  taskMode?: string | null;
  readOnlyMode?: boolean | null;
  allowedScope?: unknown;
  exactAllowedScope?: unknown;
  forbiddenScope?: unknown;
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
  const originalRequestTextFields: Record<string, string | null> = {
    project_domain: readTextContextField(fallbackOriginalRequest, "project_domain"),
    task_mode: readTextContextField(fallbackOriginalRequest, "task_mode"),
    read_only_mode: readTextContextField(fallbackOriginalRequest, "read_only_mode"),
    allowed_scope: readTextContextField(fallbackOriginalRequest, "allowed_scope"),
    exact_allowed_scope: readTextContextField(fallbackOriginalRequest, "exact_allowed_scope"),
    forbidden_scope: readTextContextField(fallbackOriginalRequest, "forbidden_scope"),
    route: readTextContextField(fallbackOriginalRequest, "route"),
    approved_batch: readTextContextField(fallbackOriginalRequest, "approved_batch"),
  };
  const requestTextFields: Record<string, string | null> = {
    project_domain: readTextContextField(requestText, "project_domain"),
    task_mode: readTextContextField(requestText, "task_mode"),
    read_only_mode: readTextContextField(requestText, "read_only_mode"),
    allowed_scope: readTextContextField(requestText, "allowed_scope"),
    exact_allowed_scope: readTextContextField(requestText, "exact_allowed_scope"),
    forbidden_scope: readTextContextField(requestText, "forbidden_scope"),
    route: readTextContextField(requestText, "route"),
    approved_batch: readTextContextField(requestText, "approved_batch"),
  };
  const overrideFields: Record<string, unknown> = {
    project_domain: input.projectDomain,
    task_mode: input.taskMode,
    read_only_mode: input.readOnlyMode,
    allowed_scope: readScopeText(input.allowedScope),
    exact_allowed_scope: readScopeText(input.exactAllowedScope),
    forbidden_scope: readScopeText(input.forbiddenScope),
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
    readString(explicitFields[fieldName]) ??
    (structuredPayload ? payloadField(fieldName) : null) ??
    readString(originalRequestTextFields[fieldName]) ??
    readString(requestTextFields[fieldName]) ??
    (!structuredPayload ? payloadField(fieldName) : null) ??
    readString(overrideFields[fieldName]);
  const explicitTaskMode = normalizeTaskMode(readPriorityField("task_mode"));
  const explicitReadOnlyMode =
    readNullableBooleanFlag(explicitFields.read_only_mode) ??
    (structuredPayload ? readNullableBooleanFlag(payloadField("read_only_mode")) : null) ??
    readNullableBooleanFlag(originalRequestTextFields.read_only_mode) ??
    readNullableBooleanFlag(requestTextFields.read_only_mode) ??
    (typeof input.readOnlyMode === "boolean" ? input.readOnlyMode : null);
  const batchCode =
    readString(readPriorityField("approved_batch")) ??
    getJobBatchCode(job) ??
    findBatchCodes(sourceText)[0] ??
    null;
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
  const allowedScope = readString(readPriorityField("allowed_scope")) ?? null;
  const exactAllowedScope = readString(readPriorityField("exact_allowed_scope")) ?? null;
  const forbiddenScope = readString(readPriorityField("forbidden_scope")) ?? null;
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
      (!isReadOnlyTaskMode(taskMode) && !allowedScope)
  );

  return {
    context_source: contextSource,
    context_reconstruct_failed: contextReconstructFailed,
    context_warnings: contextWarnings,
    project_domain: projectDomain,
    task_mode: taskMode,
    read_only_mode: readOnlyMode,
    allowed_scope: allowedScope,
    exact_allowed_scope: exactAllowedScope,
    forbidden_scope: forbiddenScope,
    original_request_text: originalRequestText,
    original_request_text_base64: Buffer.from(originalRequestText, "utf8").toString("base64"),
    route:
      readString(readPriorityField("route")) ??
      null,
    payload: payload ?? null,
    approved_batch: batchCode,
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
  const readOnlyViolation = reportTextHasReadOnlyViolation(combinedReportText);
  const writeAllowedNoFixApplied =
    input.status === "succeeded" &&
    !isReadOnlyTaskMode(taskMode) &&
    filesChanged.length === 0;
  const noFixApplied =
    reportTextHasNoFixApplied(combinedReportText) || writeAllowedNoFixApplied;
  const outOfScopeBusinessChange = reportTextHasOutOfScope(combinedReportText);
  const failedTaskGoal = reportTextHasFailedTaskGoal(combinedReportText);
  const requiredDocsTotal = readDiagnosticLine(combinedReportText, "required_docs_total") ?? "0";
  const requiredDocsPresent = readDiagnosticLine(combinedReportText, "required_docs_present") ?? "0";
  const requiredDocsChanged = readDiagnosticLine(combinedReportText, "required_docs_changed") ?? "0";
  const missingRequiredDocs = readDiagnosticLine(combinedReportText, "missing_required_docs") ?? "none";
  const insufficientDocOutput =
    /INSUFFICIENT_DOC_OUTPUT|insufficient_doc_output\s*[:=]\s*(yes|true)/i.test(combinedReportText);
  const taskGoalFailureCode =
    readOnlyViolation
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
      !gitCommitSha);
  const committed = Boolean(gitCommitSha);
  const pushed = isGithubPushSuccess(githubPushStatus);
  const legacyEffectiveFinalStatus =
    readOnlyViolation ||
    noFixApplied ||
    outOfScopeBusinessChange ||
    failedTaskGoal ||
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
  const failureCode = readString(normalizedFinalResult.failure_code);
  const nextBatch = readString(normalizedFinalResult.next_batch);
  const failureMemoryStatus = readString(normalizedFinalResult.failure_memory_status) ?? "skipped_non_terminal";
  const terminalIndex =
    readRecord(normalizedFinalResult.terminal_index) ?? buildTerminalJobIndex(normalizedFinalResult);
  const autoIterationSuggestion =
    readRecord(normalizedFinalResult.auto_iteration_suggestion) ??
    buildAutoIterationSuggestion(normalizedFinalResult);
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
  const reportedWorkerExecutionStatus = readString(input.workerExecutionStatus);
  const workerExecutionStatus =
    reportedWorkerExecutionStatus ??
    (readOnlyViolation
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
  const reportedTaskGoalStatus = readString(input.taskGoalStatus);
  const taskGoalStatus =
    reportedTaskGoalStatus ??
    (readOnlyViolation
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
    final_report_status: input.status,
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
    task_domain: taskDomain,
    task_mode: taskMode,
    allowed_scope: contract.allowed_scope,
    exact_allowed_scope: contract.exact_allowed_scope,
    forbidden_scope: contract.forbidden_scope,
    original_request_text: contract.original_request_text,
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
    read_only_violation: readOnlyViolation,
    no_fix_applied: noFixApplied,
    out_of_scope_business_change: outOfScopeBusinessChange,
    required_docs_total: requiredDocsTotal,
    required_docs_present: requiredDocsPresent,
    required_docs_changed: requiredDocsChanged,
    missing_required_docs: missingRequiredDocs,
    insufficient_doc_output: insufficientDocOutput,
    no_op_run: noOpRun,
    committed,
    pushed,
    what_changed: sanitizeReportText(summary),
    changed_files: filesChanged,
    files_changed: filesChanged,
    validation_result: validation,
    git_commit_sha: gitCommitSha ?? null,
    commit_hash: gitCommitSha ?? null,
    github_push_status: githubPushStatus,
    deploy_status: input.deployStatus ?? null,
    safety_boundary: safetyBoundary,
    needs_boss_confirmation: needsBossConfirmation,
    next_step: iterationNextStep,
    failure_stage: failureStage,
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
    `task_mode: ${taskMode}`,
    `read_only_mode: ${readOnlyMode ? "true" : "false"}`,
    `allowed_scope: ${placeholder(readString(contract.allowed_scope))}`,
    `exact_allowed_scope: ${placeholder(readString(contract.exact_allowed_scope))}`,
    `forbidden_scope: ${placeholder(readString(contract.forbidden_scope))}`,
    `route: ${placeholder(readString(contract.route))}`,
    `approved_batch: ${placeholder(readString(contract.approved_batch) ?? batchCode)}`,
    `worker_stage: ${placeholder(readString(contract.worker_stage))}`,
    `workflow_stage: ${data.workflow_stage}`,
    `final_report_status: ${input.status}`,
    `effective_final_status: ${effectiveFinalStatus}`,
    `failure_memory_status: ${failureMemoryStatus}`,
    `failure_code: ${failureCode ?? "null"}`,
    `next_batch: ${nextBatch ?? "null"}`,
    `completed_at: ${readString(normalizedFinalResult.completed_at) ?? "null"}`,
    `changed_files: ${filesChanged.length ? filesChanged.join(", ") : "[]"}`,
    `git_commit_sha: ${gitCommitSha ?? "null"}`,
    `pushed: ${pushed ? "true" : "false"}`,
    `deploy_status: ${input.deployStatus ?? "null"}`,
    `Worker execution status: ${workerExecutionStatus}`,
    `Task goal status: ${taskGoalStatus}`,
    `Read-only mode: ${readOnlyMode ? "yes" : "no"}`,
    `NO_FIX_APPLIED: ${noFixApplied ? "yes" : "no"}`,
    `Read-only violation: ${readOnlyViolation ? "yes" : "no"}`,
    `Out-of-scope business change: ${outOfScopeBusinessChange ? "yes" : "no"}`,
    `required_docs_total: ${requiredDocsTotal}`,
    `required_docs_present: ${requiredDocsPresent}`,
    `required_docs_changed: ${requiredDocsChanged}`,
    `missing_required_docs: ${missingRequiredDocs}`,
    `insufficient_doc_output: ${insufficientDocOutput ? "yes" : "no"}`,
    `No-op run: ${noOpRun ? "yes" : "no"}`,
    `Committed: ${committed ? "yes" : "no"}`,
    `Pushed: ${pushed ? "yes" : "no"}`,
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
    ...listLines(filesChanged, "未提供"),
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
    `commit SHA：${gitCommitSha || "未生成"}`,
    `GitHub 推送状态：${placeholder(githubPushStatus)}`,
    "",
    "下一步建议：",
    data.next_step,
  ];

  const text = requiredHeader.join("\n");

  return { text, data };
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
  return TERMINAL_WORKER_STATUSES.has(String(value || ""));
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
  if (!expected) return null;

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

export async function claimHermesJob(
  supabase: SupabaseClient,
  jobId: string,
  workerId: string,
  fields: JobRecord
): Promise<{ data: JobRecord | null; error: SupabaseWriteError | null; skippedColumns: string[] }> {
  const claimedFields = { ...fields };
  const skippedColumns: string[] = [];

  for (let attempt = 0; attempt < 8; attempt++) {
    let query = supabase
      .from("hermes_jobs")
      .update(claimedFields)
      .eq("id", jobId)
      .in("status", ["queued", "pending"]);

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

export function normalizeWorkerStatus(value: unknown): "queued" | "running" | "succeeded" | "failed" {
  if (value === "failed" || value === "error") return "failed";
  if (value === "succeeded" || value === "success" || value === "completed") return "succeeded";
  if (value === "queued" || value === "pending") return "queued";
  return "running";
}

export function clampProgress(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}
