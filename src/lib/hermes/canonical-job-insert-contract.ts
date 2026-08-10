import type { CanonicalCanaryAdmissionEvidence } from "./canonical-canary-scope.ts";

export const CANONICAL_JOB_INSERT_SCHEMA = "canonical_canary_job_insert_v1" as const;

export interface CanonicalJobInsertContract extends Record<string, unknown> {
  schema: typeof CANONICAL_JOB_INSERT_SCHEMA;
  source: "hermes_canonical_orchestration";
  title: string;
  request_text: string;
  requested_mode: "worker_read_only";
  plan_id: string;
  subtask_id: string;
  payload: Record<string, unknown>;
  state_snapshot: Record<string, unknown>;
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function requiredExactText(value: unknown, code: string): string {
  const normalized = requiredText(value, code);
  if (normalized !== value) throw new Error(code);
  return normalized;
}

function requiredRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

export function buildCanonicalJobInsertContract(
  row: Record<string, unknown>,
  admission: CanonicalCanaryAdmissionEvidence
): CanonicalJobInsertContract {
  requiredExactText(admission.policy_id, "CANONICAL_JOB_POLICY_ID_REQUIRED");
  requiredExactText(admission.trusted_owner_id, "CANONICAL_JOB_OWNER_ID_REQUIRED");
  requiredExactText(admission.batch_code, "CANONICAL_JOB_BATCH_CODE_REQUIRED");
  requiredExactText(admission.event_id, "CANONICAL_JOB_EVENT_ID_REQUIRED");
  requiredExactText(admission.request_id, "CANONICAL_JOB_REQUEST_ID_REQUIRED");
  if (row.source !== "hermes_canonical_orchestration") {
    throw new Error("CANONICAL_JOB_SOURCE_INVALID");
  }
  const requestedMode = requiredText(row.requested_mode, "CANONICAL_JOB_REQUESTED_MODE_REQUIRED");
  if (requestedMode !== "worker_read_only" || admission.requested_mode !== requestedMode) {
    throw new Error("CANONICAL_JOB_REQUESTED_MODE_INVALID");
  }

  const payload = requiredRecord(row.payload, "CANONICAL_JOB_PAYLOAD_REQUIRED");
  if (payload.canonical_runtime !== true) throw new Error("CANONICAL_JOB_RUNTIME_MARKER_REQUIRED");
  const stateSnapshot = requiredRecord(row.result, "CANONICAL_JOB_STATE_SNAPSHOT_REQUIRED");
  const planId = requiredText(row.plan_id ?? payload.plan_id, "CANONICAL_JOB_PLAN_ID_REQUIRED");
  const subtaskId = requiredText(row.subtask_id ?? payload.subtask_id, "CANONICAL_JOB_SUBTASK_ID_REQUIRED");

  return {
    schema: CANONICAL_JOB_INSERT_SCHEMA,
    source: "hermes_canonical_orchestration",
    title: requiredText(row.title, "CANONICAL_JOB_TITLE_REQUIRED"),
    request_text: requiredText(row.request_text, "CANONICAL_JOB_REQUEST_TEXT_REQUIRED"),
    requested_mode: "worker_read_only",
    plan_id: planId,
    subtask_id: subtaskId,
    payload: {
      ...payload,
      canonical_canary_admission: { ...admission },
    },
    state_snapshot: { ...stateSnapshot },
  };
}
