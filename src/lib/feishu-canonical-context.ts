import contextCore from "../../infra/tencent-worker/feishu-canonical-context-core.js";

export type CanonicalRequestedMode = "manager_read_only" | "worker_read_only" | "write_allowed";

export interface CanonicalApprovalContextInput {
  approval_text: string;
  saved_context_text?: string | null;
  saved_context_record?: Record<string, unknown> | null;
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
  execution_intent: string | null;
  scope: string[];
  acceptance: string[];
  plan_id: string | null;
  subtask_id: string | null;
  failure_code: string | null;
  failure_stage: string | null;
  approval_context: Record<string, unknown>;
}

export interface CanonicalWorkerContextPayload {
  canonical_context_builder_used: true;
  legacy_context_builder_used: false;
  canonical_worker_context_version: "1.1";
  plan_id: string;
  subtask_id: string;
  requested_mode: CanonicalRequestedMode;
  project_domain: string;
  execution_intent: string | null;
  scope: string[];
  acceptance: string[];
  original_request_text: string | null;
  approval_context: Record<string, unknown>;
  canonical_revision: 0;
  approved_batch: string;
  batch_code: string;
  context_source: "canonical_approval_context";
}

export const buildCanonicalApprovalContext = contextCore.buildCanonicalApprovalContext as (input: CanonicalApprovalContextInput) => CanonicalApprovalContextResult;

export const buildCanonicalWorkerContextPayload = contextCore.buildCanonicalWorkerContextPayload as (input: {
  plan_id: string;
  subtask_id: string;
  requested_mode: CanonicalRequestedMode;
  batch_code: string;
  project_domain?: string | null;
  execution_intent?: string | null;
  scope?: string[] | null;
  acceptance?: string[] | null;
  original_request_text?: string | null;
  approval_context?: Record<string, unknown> | null;
}) => CanonicalWorkerContextPayload;
