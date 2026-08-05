import {
  normalizeAttemptState,
  normalizeJobState,
  normalizeLeaseState,
} from "../../infra/tencent-worker/worker_job_state_machine.js";

export const CANONICAL_PERSISTENCE_SCHEMA_VERSION = 1;
export const CANONICAL_DATABASE_PERSISTENCE_ENABLED_DEFAULT = false;
export const CANONICAL_DATABASE_PERSISTENCE_ENV = "CANONICAL_DATABASE_PERSISTENCE_ENABLED";

export const CANONICAL_PERSISTENCE_TABLES = {
  jobs: "hermes_jobs",
  attempts: "hermes_job_attempts",
  leases: "hermes_job_leases",
  terminals: "hermes_job_terminals",
} as const;

export interface CanonicalJobRecord {
  job_id: string;
  job_state: string;
  revision: number;
  requested_mode: string;
  plan_id: string | null;
  subtask_id: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

export const CANONICAL_JOB_DATABASE_COLUMN_MAP = {
  job_id: "id",
  job_state: "canonical_job_state",
  revision: "canonical_revision",
  requested_mode: "requested_mode",
  plan_id: "plan_id",
  subtask_id: "subtask_id",
  created_at: "created_at",
  updated_at: "updated_at",
  terminal_at: "terminal_at",
} as const satisfies Record<keyof CanonicalJobRecord, string>;

export interface CanonicalJobDatabaseRow {
  id: string;
  canonical_job_state: string;
  canonical_revision: number;
  requested_mode: string;
  plan_id: string | null;
  subtask_id: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

export function mapCanonicalJobDatabaseRow(row: CanonicalJobDatabaseRow): CanonicalJobRecord {
  return {
    job_id: row.id,
    job_state: row.canonical_job_state,
    revision: row.canonical_revision,
    requested_mode: row.requested_mode,
    plan_id: row.plan_id,
    subtask_id: row.subtask_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    terminal_at: row.terminal_at,
  };
}

export interface CanonicalAttemptRecord {
  attempt_id: string;
  job_id: string;
  attempt_number: number;
  worker_id: string;
  attempt_state: string;
  started_at: string | null;
  last_activity_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanonicalLeaseRecord {
  lease_id: string;
  job_id: string;
  attempt_id: string;
  worker_id: string;
  lease_state: string;
  acquired_at: string;
  heartbeat_at: string | null;
  expires_at: string;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanonicalTerminalRecord {
  terminal_id: string;
  job_id: string;
  attempt_id: string;
  worker_id: string;
  report_identity: string;
  worker_execution_status: string;
  task_goal_status: string;
  effective_final_status: string;
  failure_code: string | null;
  failure_stage: string | null;
  terminal_at: string;
  canonical_report: Record<string, unknown>;
  created_at: string;
}

export interface CanonicalPersistenceSnapshot {
  job: CanonicalJobRecord;
  active_attempt: CanonicalAttemptRecord | null;
  active_lease: CanonicalLeaseRecord | null;
  terminal: CanonicalTerminalRecord | null;
}

export interface CanonicalOwnershipGuard {
  job_id: string;
  attempt_id: string;
  lease_id: string;
  worker_id: string;
  expected_revision: number;
  now: string;
}

export interface CanonicalWorkerProtocolIdentity {
  job_id: string;
  worker_task_id: string;
  attempt_id: string;
  lease_id: string;
  canonical_revision: number;
  lease_expires_at: string;
}

export interface CanonicalPersistenceGuardResult {
  ok: boolean;
  terminal_noop: boolean;
  idempotent: boolean;
  failure_code: string | null;
}

export interface CanonicalClaimInput {
  job_id: string;
  worker_id: string;
  attempt_id: string;
  lease_id: string;
  expected_revision: number;
  now: string;
  expires_at: string;
}

export interface CanonicalRuntimeSignalInput extends CanonicalOwnershipGuard {
  signal: "heartbeat" | "progress";
  new_expires_at?: string | null;
}

export interface CanonicalTerminalInput extends CanonicalOwnershipGuard {
  report_identity: string;
  terminal_job_state: "terminal_success" | "terminal_failed" | "terminal_cancelled";
  final_attempt_state: "finished" | "failed" | "abandoned";
  worker_execution_status: string;
  task_goal_status: string;
  effective_final_status: string;
  failure_code: string | null;
  failure_stage: string | null;
  canonical_report: Record<string, unknown>;
}

export type CanonicalTerminalSemanticIdentity = Pick<
  CanonicalTerminalRecord,
  | "job_id"
  | "attempt_id"
  | "worker_id"
  | "report_identity"
  | "worker_execution_status"
  | "task_goal_status"
  | "effective_final_status"
  | "failure_code"
  | "failure_stage"
>;

const CANONICAL_TERMINAL_SEMANTIC_FIELDS = [
  "job_id",
  "attempt_id",
  "worker_id",
  "report_identity",
  "worker_execution_status",
  "task_goal_status",
  "effective_final_status",
  "failure_code",
  "failure_stage",
] as const satisfies readonly (keyof CanonicalTerminalSemanticIdentity)[];

function normalizedTerminalSemanticValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function canonicalTerminalSemanticsMatch(
  existing: CanonicalTerminalSemanticIdentity,
  requested: CanonicalTerminalSemanticIdentity
): boolean {
  return CANONICAL_TERMINAL_SEMANTIC_FIELDS.every(
    (field) =>
      normalizedTerminalSemanticValue(existing[field]) ===
      normalizedTerminalSemanticValue(requested[field])
  );
}

export interface CanonicalStaleRecoveryInput extends CanonicalOwnershipGuard {
  lease_id: string;
}

interface PersistenceRpcError {
  message?: string;
  code?: string;
}

export interface CanonicalPersistenceRpcClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: PersistenceRpcError | null }>;
}

function guardFailure(failureCode: string): CanonicalPersistenceGuardResult {
  return { ok: false, terminal_noop: false, idempotent: false, failure_code: failureCode };
}

function isTerminalJob(job: CanonicalJobRecord, terminal: CanonicalTerminalRecord | null): boolean {
  return Boolean(terminal || job.terminal_at || String(normalizeJobState(job.job_state)).startsWith("terminal_"));
}

function revisionMatches(job: CanonicalJobRecord, expectedRevision: number): boolean {
  return Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 && job.revision === expectedRevision;
}

function parseTime(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateOwnership(
  snapshot: CanonicalPersistenceSnapshot,
  input: CanonicalOwnershipGuard,
  requireActiveLease: boolean
): CanonicalPersistenceGuardResult {
  if (!revisionMatches(snapshot.job, input.expected_revision)) return guardFailure("STALE_REVISION");
  if (snapshot.job.job_id !== input.job_id) return guardFailure("JOB_IDENTITY_MISMATCH");
  if (!snapshot.active_attempt || snapshot.active_attempt.attempt_id !== input.attempt_id) {
    return guardFailure("ATTEMPT_IDENTITY_MISMATCH");
  }
  if (snapshot.active_attempt.worker_id !== input.worker_id) return guardFailure("WORKER_OWNERSHIP_MISMATCH");
  if (requireActiveLease && !snapshot.active_lease) return guardFailure("ACTIVE_LEASE_REQUIRED");
  if (snapshot.active_lease) {
    if (snapshot.active_lease.lease_id !== input.lease_id) return guardFailure("LEASE_IDENTITY_MISMATCH");
    if (snapshot.active_lease.attempt_id !== input.attempt_id) return guardFailure("LEASE_ATTEMPT_MISMATCH");
    if (snapshot.active_lease.worker_id !== input.worker_id) return guardFailure("LEASE_WORKER_MISMATCH");
    if (snapshot.active_lease.job_id !== input.job_id) return guardFailure("LEASE_JOB_MISMATCH");
  }
  return { ok: true, terminal_noop: false, idempotent: false, failure_code: null };
}

function activeAttemptState(snapshot: CanonicalPersistenceSnapshot): boolean {
  return ["claimed", "running"].includes(normalizeAttemptState(snapshot.active_attempt?.attempt_state) ?? "");
}

export function isCanonicalDatabasePersistenceEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[CANONICAL_DATABASE_PERSISTENCE_ENV]?.trim().toLowerCase() === "true";
}

export function validateAtomicClaimContract(
  snapshot: CanonicalPersistenceSnapshot,
  input: CanonicalClaimInput
): CanonicalPersistenceGuardResult {
  if (isTerminalJob(snapshot.job, snapshot.terminal)) return guardFailure("TERMINAL_JOB_IMMUTABLE");
  if (!revisionMatches(snapshot.job, input.expected_revision)) return guardFailure("STALE_REVISION");
  if (snapshot.job.job_id !== input.job_id) return guardFailure("JOB_IDENTITY_MISMATCH");
  if (normalizeJobState(snapshot.job.job_state) !== "queued") return guardFailure("JOB_NOT_QUEUED");
  if (snapshot.active_attempt) return guardFailure("ACTIVE_ATTEMPT_EXISTS");
  if (snapshot.active_lease) return guardFailure("ACTIVE_LEASE_EXISTS");
  if (!input.attempt_id || !input.lease_id || !input.worker_id) return guardFailure("CLAIM_IDENTITY_REQUIRED");
  const now = parseTime(input.now);
  const expiresAt = parseTime(input.expires_at);
  if (now === null || expiresAt === null || expiresAt <= now) return guardFailure("LEASE_EXPIRY_INVALID");
  return { ok: true, terminal_noop: false, idempotent: false, failure_code: null };
}

export function validateRuntimeSignalContract(
  snapshot: CanonicalPersistenceSnapshot,
  input: CanonicalRuntimeSignalInput
): CanonicalPersistenceGuardResult {
  if (isTerminalJob(snapshot.job, snapshot.terminal)) {
    return { ok: true, terminal_noop: true, idempotent: true, failure_code: null };
  }
  if (!["claimed", "running"].includes(normalizeJobState(snapshot.job.job_state))) {
    return guardFailure("JOB_NOT_ACTIVE");
  }
  const ownership = validateOwnership(snapshot, input, true);
  if (!ownership.ok) return ownership;
  if (!activeAttemptState(snapshot)) return guardFailure("ATTEMPT_NOT_ACTIVE");
  if (normalizeLeaseState(snapshot.active_lease?.lease_state) !== "active") {
    return guardFailure("LEASE_NOT_ACTIVE");
  }
  const now = parseTime(input.now);
  const expiresAt = parseTime(snapshot.active_lease?.expires_at ?? "");
  if (now === null || expiresAt === null || expiresAt <= now) return guardFailure("LEASE_EXPIRED");
  return ownership;
}

export function validateTerminalPersistenceContract(
  snapshot: CanonicalPersistenceSnapshot,
  input: CanonicalTerminalInput
): CanonicalPersistenceGuardResult {
  if (isTerminalJob(snapshot.job, snapshot.terminal)) {
    return { ok: true, terminal_noop: true, idempotent: true, failure_code: null };
  }
  const ownership = validateOwnership(snapshot, input, true);
  if (!ownership.ok) return ownership;
  if (!activeAttemptState(snapshot)) return guardFailure("ATTEMPT_NOT_ACTIVE");
  if (normalizeLeaseState(snapshot.active_lease?.lease_state) !== "active") {
    return guardFailure("LEASE_NOT_ACTIVE");
  }
  if (input.task_goal_status === "failed" && input.effective_final_status === "succeeded") {
    return guardFailure("TASK_FAILURE_CANNOT_SUCCEED");
  }
  return ownership;
}

export function validateStaleRecoveryContract(
  snapshot: CanonicalPersistenceSnapshot,
  input: CanonicalStaleRecoveryInput
): CanonicalPersistenceGuardResult {
  if (isTerminalJob(snapshot.job, snapshot.terminal)) return guardFailure("TERMINAL_JOB_IMMUTABLE");
  const ownership = validateOwnership(snapshot, input, true);
  if (!ownership.ok) return ownership;
  if (!activeAttemptState(snapshot)) return guardFailure("ATTEMPT_NOT_ACTIVE");
  if (snapshot.active_lease?.lease_id !== input.lease_id) return guardFailure("LEASE_IDENTITY_MISMATCH");
  if (normalizeLeaseState(snapshot.active_lease.lease_state) !== "active") return guardFailure("LEASE_NOT_ACTIVE");
  const now = parseTime(input.now);
  const expiresAt = parseTime(snapshot.active_lease.expires_at);
  if (now === null || expiresAt === null) return guardFailure("LEASE_EXPIRY_INVALID");
  if (expiresAt > now) return guardFailure("LEASE_NOT_EXPIRED");
  return ownership;
}

export function buildLegacyJobProjection(snapshot: CanonicalPersistenceSnapshot) {
  return {
    projection_only: true as const,
    source: "canonical_persistence" as const,
    status: snapshot.job.job_state,
    claimed_by: snapshot.active_attempt?.worker_id ?? null,
    attempt_id: snapshot.active_attempt?.attempt_id ?? null,
    lease_id: snapshot.active_lease?.lease_id ?? null,
    expires_at: snapshot.active_lease?.expires_at ?? null,
  };
}

async function callPersistenceRpc(
  client: CanonicalPersistenceRpcClient,
  functionName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc(functionName, args);
  if (error) throw new Error(`${functionName}:${error.code ?? "RPC_FAILED"}:${error.message ?? "unknown"}`);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${functionName}:INVALID_RESPONSE`);
  return data as Record<string, unknown>;
}

export function canonicalAcquireAttemptLease(
  client: CanonicalPersistenceRpcClient,
  input: CanonicalClaimInput
): Promise<Record<string, unknown>> {
  return callPersistenceRpc(client, "canonical_acquire_attempt_lease", {
    p_job_id: input.job_id,
    p_worker_id: input.worker_id,
    p_attempt_id: input.attempt_id,
    p_lease_id: input.lease_id,
    p_expected_revision: input.expected_revision,
    p_now: input.now,
    p_expires_at: input.expires_at,
  });
}

export function canonicalPersistRuntimeSignal(
  client: CanonicalPersistenceRpcClient,
  input: CanonicalRuntimeSignalInput
): Promise<Record<string, unknown>> {
  return callPersistenceRpc(client, "canonical_record_runtime_signal", {
    p_job_id: input.job_id,
    p_attempt_id: input.attempt_id,
    p_worker_id: input.worker_id,
    p_expected_revision: input.expected_revision,
    p_signal: input.signal,
    p_now: input.now,
    p_new_expires_at: input.new_expires_at ?? null,
  });
}

export function canonicalFinalizeTerminal(
  client: CanonicalPersistenceRpcClient,
  input: CanonicalTerminalInput
): Promise<Record<string, unknown>> {
  return callPersistenceRpc(client, "canonical_finalize_terminal", {
    p_job_id: input.job_id,
    p_attempt_id: input.attempt_id,
    p_worker_id: input.worker_id,
    p_expected_revision: input.expected_revision,
    p_report_identity: input.report_identity,
    p_terminal_job_state: input.terminal_job_state,
    p_final_attempt_state: input.final_attempt_state,
    p_worker_execution_status: input.worker_execution_status,
    p_task_goal_status: input.task_goal_status,
    p_effective_final_status: input.effective_final_status,
    p_failure_code: input.failure_code,
    p_failure_stage: input.failure_stage,
    p_canonical_report: input.canonical_report,
    p_now: input.now,
  });
}

export function canonicalRecoverStaleAttempt(
  client: CanonicalPersistenceRpcClient,
  input: CanonicalStaleRecoveryInput
): Promise<Record<string, unknown>> {
  return callPersistenceRpc(client, "canonical_recover_stale_attempt", {
    p_job_id: input.job_id,
    p_attempt_id: input.attempt_id,
    p_lease_id: input.lease_id,
    p_worker_id: input.worker_id,
    p_expected_revision: input.expected_revision,
    p_now: input.now,
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`CANONICAL_PROTOCOL_FIELD_REQUIRED:${field}`);
  return value.trim();
}

function requiredRevision(value: unknown): number {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("CANONICAL_PROTOCOL_REVISION_INVALID");
  }
  return revision;
}

export function buildCanonicalWorkerProtocolIdentity(input: {
  job_id: unknown;
  worker_task_id?: unknown;
  attempt_id: unknown;
  lease_id: unknown;
  revision: unknown;
  lease_expires_at: unknown;
}): CanonicalWorkerProtocolIdentity {
  const jobId = requiredString(input.job_id, "job_id");
  return {
    job_id: jobId,
    worker_task_id: requiredString(input.worker_task_id ?? jobId, "worker_task_id"),
    attempt_id: requiredString(input.attempt_id, "attempt_id"),
    lease_id: requiredString(input.lease_id, "lease_id"),
    canonical_revision: requiredRevision(input.revision),
    lease_expires_at: requiredString(input.lease_expires_at, "lease_expires_at"),
  };
}

export function readCanonicalRpcRevision(result: Record<string, unknown>): number {
  return requiredRevision(result.revision);
}
