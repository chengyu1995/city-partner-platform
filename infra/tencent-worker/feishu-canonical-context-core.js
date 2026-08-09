"use strict";

const BATCH_PATTERN = /\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i;
const REQUESTED_MODES = new Set(["manager_read_only", "worker_read_only", "write_allowed"]);

function readContextField(text, fieldName) {
  if (!text) return null;
  const pattern = new RegExp(`^\\s*${fieldName}\\s*[:\\uFF1A=]\\s*(.+?)\\s*$`, "im");
  const match = String(text).match(pattern);
  return match?.[1]?.trim() || null;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(record, ...keys) {
  if (!record || typeof record !== "object") return null;
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return null;
}

function listValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string") {
    return value.split(/[\r\n,;]+/g).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function firstList(record, ...keys) {
  if (!record || typeof record !== "object") return [];
  for (const key of keys) {
    const values = listValue(record[key]);
    if (values.length > 0) return values;
  }
  return [];
}

function decodeBase64(value) {
  if (!stringValue(value)) return null;
  try {
    return Buffer.from(value, "base64").toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

function readOriginalRequestText(text, record) {
  return (
    recordValue(record, "original_request_text", "request_text") ||
    decodeBase64(recordValue(record, "original_request_text_base64")) ||
    readContextField(text, "original_request_text") ||
    decodeBase64(readContextField(text, "original_request_text_base64"))
  );
}

function readBatchCode(record, ...texts) {
  const explicit = recordValue(record, "approved_batch", "batch_code");
  if (explicit) return explicit.toUpperCase();
  for (const text of texts) {
    const field = readContextField(text, "approved_batch") || readContextField(text, "batch_code");
    if (field) return field.toUpperCase();
    const match = String(text || "").match(BATCH_PATTERN);
    if (match) return match[0].toUpperCase();
  }
  return null;
}

function normalizeRequestedMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "read_only" || normalized === "automation_system_worker_read_only") {
    return "worker_read_only";
  }
  if (normalized === "automation_system_write_allowed") return "write_allowed";
  return REQUESTED_MODES.has(normalized) ? normalized : null;
}

function readRequestedMode(record, ...texts) {
  const fromRecord = normalizeRequestedMode(recordValue(record, "requested_mode", "final_mode", "task_mode"));
  if (fromRecord) return fromRecord;
  for (const text of texts) {
    const mode = normalizeRequestedMode(
      readContextField(text, "requested_mode") || readContextField(text, "final_mode") || readContextField(text, "task_mode")
    );
    if (mode) return mode;
  }
  return null;
}

function readProjectDomain(record, ...texts) {
  const fromRecord = recordValue(record, "project_domain");
  if (fromRecord) return fromRecord;
  for (const text of texts) {
    const value = readContextField(text, "project_domain");
    if (value) return value;
  }
  return "automation_system";
}

function buildCanonicalApprovalContext(input) {
  const savedRecord = input.saved_context_record && typeof input.saved_context_record === "object" ? input.saved_context_record : null;
  const savedText = input.saved_context_text || null;
  const originalRequestText = stringValue(input.original_request_text) || readOriginalRequestText(savedText, savedRecord) || readOriginalRequestText(input.approval_text, null);
  const batchCode = readBatchCode(savedRecord, input.approval_text, savedText, originalRequestText);
  const requestedMode = readRequestedMode(savedRecord, input.approval_text, savedText, originalRequestText);
  const projectDomain = readProjectDomain(savedRecord, savedText, originalRequestText, input.approval_text);
  const executionIntent = recordValue(savedRecord, "execution_intent") || readContextField(originalRequestText, "execution_intent");
  const scope = firstList(savedRecord, "exact_allowed_scope", "allowed_scope", "scope");
  const acceptance = firstList(savedRecord, "acceptance_conditions", "acceptance_criteria", "required_output_fields");
  const planId = recordValue(savedRecord, "plan_id");
  const subtaskId = recordValue(savedRecord, "subtask_id");
  const missing = [batchCode ? null : "batch_code", requestedMode ? null : "requested_mode", originalRequestText ? null : "original_request_text"].filter(Boolean);
  const approvalContext = {
    ...(savedRecord || {}),
    approved_by: input.approved_by,
    approved_at: input.approved_at,
    approval_id: input.request_id,
    feishu_chat_id: input.feishu_chat_id,
    feishu_event_id: input.feishu_event_id,
    batch_code: batchCode,
    requested_mode: requestedMode,
    project_domain: projectDomain,
    execution_intent: executionIntent,
    scope,
    acceptance,
    plan_id: planId,
    subtask_id: subtaskId,
    canonical_context_builder_used: true,
    legacy_context_builder_used: false,
    context_source: savedRecord || savedText ? "saved_approval_context" : "approved_request",
  };
  const common = {
    canonical_context_builder_used: true,
    legacy_context_builder_used: false,
    batch_code: batchCode,
    requested_mode: requestedMode,
    original_request_text: originalRequestText,
    project_domain: projectDomain,
    execution_intent: executionIntent,
    scope,
    acceptance,
    plan_id: planId,
    subtask_id: subtaskId,
  };
  if (missing.length > 0) {
    return {
      ...common,
      ok: false,
      failure_code: "CANONICAL_APPROVAL_CONTEXT_INCOMPLETE",
      failure_stage: "canonical_approval_context_validation",
      approval_context: { ...approvalContext, missing_fields: missing },
    };
  }
  return { ...common, ok: true, failure_code: null, failure_stage: null, approval_context: approvalContext };
}

function buildCanonicalWorkerContextPayload(input) {
  return {
    canonical_context_builder_used: true,
    legacy_context_builder_used: false,
    canonical_worker_context_version: "1.1",
    plan_id: input.plan_id,
    subtask_id: input.subtask_id,
    requested_mode: input.requested_mode,
    project_domain: input.project_domain || "automation_system",
    execution_intent: input.execution_intent || null,
    scope: listValue(input.scope),
    acceptance: listValue(input.acceptance),
    original_request_text: input.original_request_text || null,
    approval_context: input.approval_context || {},
    canonical_revision: 0,
    approved_batch: input.batch_code,
    batch_code: input.batch_code,
    context_source: "canonical_approval_context",
  };
}

module.exports = { buildCanonicalApprovalContext, buildCanonicalWorkerContextPayload };
