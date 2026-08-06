export type CanonicalRequestedMode = "manager_read_only" | "worker_read_only" | "write_allowed";

export interface CanonicalApprovalContextInput {
  approval_text: string;
  saved_context_text?: string | null;
  original_request_text?: string | null;
  request_id: string;
  approved_by: string;
  approved_at: string;
  feishu_chat_id: string;
  feishu_event_id: string;
}

export interface CanonicalApprovalContextResult {
  ok: boolean;
  canonical_context_builder_used: true;
  legacy_context_builder_used: false;
  batch_code: string | null;
  requested_mode: CanonicalRequestedMode | null;
  original_request_text: string | null;
  project_domain: string | null;
  failure_code: string | null;
  failure_stage: string | null;
  approval_context: Record<string, unknown>;
}

export interface CanonicalWorkerContextPayload {
  canonical_context_builder_used: true;
  legacy_context_builder_used: false;
  canonical_worker_context_version: "1.0";
  job_id: "assigned_by_canonical_create_job";
  plan_id: string;
  subtask_id: string;
  requested_mode: CanonicalRequestedMode;
  canonical_revision: 0;
  worker_identity: "assigned_by_canonical_claim";
  lease_identity: "assigned_by_canonical_claim";
  approved_batch: string;
  batch_code: string;
  context_source: "canonical_approval_context";
}

const BATCH_PATTERN = /\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i;

function readContextField(text: string | null | undefined, fieldName: string): string | null {
  if (!text) return null;
  const pattern = new RegExp(`^\\s*${fieldName}\\s*[:\\uFF1A=]\\s*(.+?)\\s*$`, "im");
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

function readOriginalRequestText(text: string | null | undefined): string | null {
  const explicit = readContextField(text, "original_request_text");
  if (explicit) return explicit;

  const encoded = readContextField(text, "original_request_text_base64");
  if (encoded) {
    try {
      return Buffer.from(encoded, "base64").toString("utf8").trim() || null;
    } catch {
      return null;
    }
  }

  return null;
}

function readBatchCode(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    const explicit = readContextField(text, "approved_batch") ?? readContextField(text, "batch_code");
    if (explicit) return explicit.toUpperCase();
    const match = text?.match(BATCH_PATTERN);
    if (match) return match[0].toUpperCase();
  }
  return null;
}

function readRequestedMode(...texts: Array<string | null | undefined>): CanonicalRequestedMode | null {
  for (const text of texts) {
    const value =
      readContextField(text, "requested_mode") ??
      readContextField(text, "final_mode") ??
      readContextField(text, "task_mode");
    const normalized = value?.trim().toLowerCase();
    if (normalized === "manager_read_only") return "manager_read_only";
    if (normalized === "worker_read_only" || normalized === "read_only" || normalized === "automation_system_worker_read_only") {
      return "worker_read_only";
    }
    if (normalized === "write_allowed" || normalized === "automation_system_write_allowed") return "write_allowed";
  }
  return null;
}

function readProjectDomain(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    const explicit = readContextField(text, "project_domain");
    if (explicit) return explicit;
  }
  return "automation_system";
}

export function buildCanonicalApprovalContext(
  input: CanonicalApprovalContextInput
): CanonicalApprovalContextResult {
  const originalRequestText =
    input.original_request_text?.trim() ||
    readOriginalRequestText(input.saved_context_text) ||
    readOriginalRequestText(input.approval_text);
  const batchCode = readBatchCode(input.approval_text, input.saved_context_text, originalRequestText);
  const requestedMode = readRequestedMode(input.approval_text, input.saved_context_text, originalRequestText);
  const projectDomain = readProjectDomain(input.saved_context_text, originalRequestText, input.approval_text);

  const missing = [
    batchCode ? null : "batch_code",
    requestedMode ? null : "requested_mode",
    originalRequestText ? null : "original_request_text",
  ].filter((field): field is string => Boolean(field));

  if (missing.length > 0) {
    return {
      ok: false,
      canonical_context_builder_used: true,
      legacy_context_builder_used: false,
      batch_code: batchCode,
      requested_mode: requestedMode,
      original_request_text: originalRequestText ?? null,
      project_domain: projectDomain,
      failure_code: "CANONICAL_APPROVAL_CONTEXT_INCOMPLETE",
      failure_stage: "canonical_approval_context_validation",
      approval_context: {
        approval_id: input.request_id,
        missing_fields: missing,
        canonical_context_builder_used: true,
        legacy_context_builder_used: false,
      },
    };
  }

  return {
    ok: true,
    canonical_context_builder_used: true,
    legacy_context_builder_used: false,
    batch_code: batchCode,
    requested_mode: requestedMode,
    original_request_text: originalRequestText,
    project_domain: projectDomain,
    failure_code: null,
    failure_stage: null,
    approval_context: {
      approved_by: input.approved_by,
      approved_at: input.approved_at,
      approval_id: input.request_id,
      feishu_chat_id: input.feishu_chat_id,
      feishu_event_id: input.feishu_event_id,
      batch_code: batchCode,
      requested_mode: requestedMode,
      canonical_context_builder_used: true,
      legacy_context_builder_used: false,
      context_source: input.saved_context_text ? "saved_approval_context" : "approved_request",
    },
  };
}

export function buildCanonicalWorkerContextPayload(input: {
  plan_id: string;
  subtask_id: string;
  requested_mode: CanonicalRequestedMode;
  batch_code: string;
}): CanonicalWorkerContextPayload {
  return {
    canonical_context_builder_used: true,
    legacy_context_builder_used: false,
    canonical_worker_context_version: "1.0",
    job_id: "assigned_by_canonical_create_job",
    plan_id: input.plan_id,
    subtask_id: input.subtask_id,
    requested_mode: input.requested_mode,
    canonical_revision: 0,
    worker_identity: "assigned_by_canonical_claim",
    lease_identity: "assigned_by_canonical_claim",
    approved_batch: input.batch_code,
    batch_code: input.batch_code,
    context_source: "canonical_approval_context",
  };
}
