/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require("crypto");
const { evaluateCanonicalCanaryAdmission } = require("./canonical-canary-scope-core");

const CANONICAL_DATABASE_PERSISTENCE_ENV = "CANONICAL_DATABASE_PERSISTENCE_ENABLED";

function enabled(env = process.env) {
  return String(env[CANONICAL_DATABASE_PERSISTENCE_ENV] || "").trim().toLowerCase() === "true";
}

function revision(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("CANONICAL_REVISION_INVALID");
  return parsed;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isCanonicalJob(job) {
  return Boolean(job && text(job.canonical_job_state) && Number.isSafeInteger(Number(job.canonical_revision)));
}

function canaryAdmissionAllowsClaim(job, env = process.env) {
  const payload = job && job.payload && typeof job.payload === "object" ? job.payload : {};
  const evidence = payload.canonical_canary_admission;
  if (!evidence || typeof evidence !== "object") return false;
  return evaluateCanonicalCanaryAdmission({
    trusted_owner_id: text(evidence.trusted_owner_id),
    batch_code: text(evidence.batch_code),
    requested_mode: text(evidence.requested_mode),
    event_id: text(evidence.event_id) || "",
    request_id: text(evidence.request_id) || "",
    expected_policy_id: text(evidence.policy_id),
  }, env).allowed;
}

const TERMINAL_SEMANTIC_FIELDS = [
  "job_id",
  "attempt_id",
  "worker_id",
  "report_identity",
  "worker_execution_status",
  "task_goal_status",
  "effective_final_status",
  "failure_code",
  "failure_stage",
];

function terminalValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function terminalSemanticsMatch(existing, requested) {
  return TERMINAL_SEMANTIC_FIELDS.every(
    (field) => terminalValue(existing[field]) === terminalValue(requested[field])
  );
}

function assertTerminalReplay(existing, input) {
  if (!terminalSemanticsMatch(existing, input)) throw new Error("CANONICAL_TERMINAL_CONFLICT");
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name}:${error.code || "RPC_FAILED"}:${error.message || "unknown"}`);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${name}:INVALID_RESPONSE`);
  return data;
}

async function loadOwnership(client, jobId) {
  const { data: job, error: jobError } = await client.from("hermes_jobs").select("*").eq("id", jobId).maybeSingle();
  if (jobError) throw new Error(`CANONICAL_JOB_READ_FAILED:${jobError.message}`);
  if (!job) throw new Error("CANONICAL_JOB_NOT_FOUND");
  const { data: attempts, error: attemptError } = await client
    .from("hermes_job_attempts").select("*").eq("job_id", jobId)
    .in("attempt_state", ["claimed", "running"]).limit(2);
  if (attemptError) throw new Error(`CANONICAL_ATTEMPT_READ_FAILED:${attemptError.message}`);
  const { data: leases, error: leaseError } = await client
    .from("hermes_job_leases").select("*").eq("job_id", jobId).eq("lease_state", "active").limit(2);
  if (leaseError) throw new Error(`CANONICAL_LEASE_READ_FAILED:${leaseError.message}`);
  const { data: terminal, error: terminalError } = await client
    .from("hermes_job_terminals").select("*").eq("job_id", jobId).maybeSingle();
  if (terminalError) throw new Error(`CANONICAL_TERMINAL_READ_FAILED:${terminalError.message}`);
  return {
    job,
    attempt: (attempts || [])[0] || null,
    lease: (leases || [])[0] || null,
    terminal: terminal || null,
    attemptCount: (attempts || []).length,
    leaseCount: (leases || []).length,
  };
}

function assertIdentity(ownership, input) {
  if (revision(ownership.job.canonical_revision) !== revision(input.expected_revision)) throw new Error("STALE_REVISION");
  if (ownership.attemptCount !== 1 || !ownership.attempt) throw new Error("ACTIVE_ATTEMPT_REQUIRED");
  if (ownership.leaseCount !== 1 || !ownership.lease) throw new Error("ACTIVE_LEASE_REQUIRED");
  if (ownership.attempt.attempt_id !== input.attempt_id) throw new Error("ATTEMPT_IDENTITY_MISMATCH");
  if (ownership.lease.lease_id !== input.lease_id) throw new Error("LEASE_IDENTITY_MISMATCH");
  if (ownership.lease.attempt_id !== input.attempt_id) throw new Error("LEASE_ATTEMPT_MISMATCH");
  if (ownership.attempt.worker_id !== input.worker_id || ownership.lease.worker_id !== input.worker_id) {
    throw new Error("WORKER_OWNERSHIP_MISMATCH");
  }
}

async function dependenciesReady(client, job) {
  const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
  const dependencies = Array.isArray(payload.dependencies) ? payload.dependencies.filter(text) : [];
  if (!dependencies.length) return true;
  const planId = text(job.plan_id) || text(payload.plan_id);
  if (!planId) throw new Error("CANONICAL_PLAN_ID_REQUIRED");
  const { data, error } = await client.from("hermes_jobs").select("subtask_id,canonical_job_state")
    .eq("plan_id", planId).in("subtask_id", dependencies);
  if (error) throw new Error(`CANONICAL_DEPENDENCY_READ_FAILED:${error.message}`);
  const states = new Map((data || []).map((row) => [row.subtask_id, row.canonical_job_state]));
  return dependencies.every((dependency) => states.get(dependency) === "terminal_success");
}

async function claimNext(client, workerId, now = new Date()) {
  const { data, error } = await client.from("hermes_jobs").select("*")
    .eq("canonical_job_state", "queued").is("terminal_at", null)
    .order("created_at", { ascending: true }).limit(50);
  if (error) throw new Error(`CANONICAL_JOB_SELECTION_FAILED:${error.message}`);
  for (const job of data || []) {
    if (!canaryAdmissionAllowsClaim(job)) continue;
    if (!(await dependenciesReady(client, job))) continue;
    const attemptId = `attempt:${job.id}:${workerId}:${crypto.randomUUID()}`;
    const leaseId = `lease:${attemptId}`;
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    try {
      const result = await rpc(client, "canonical_acquire_attempt_lease", {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_attempt_id: attemptId,
        p_lease_id: leaseId,
        p_expected_revision: revision(job.canonical_revision),
        p_now: now.toISOString(),
        p_expires_at: expiresAt,
      });
      const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
      return {
        job: { ...job, canonical_job_state: "claimed", canonical_revision: revision(result.revision), projection_only: true },
        job_id: job.id,
        worker_task_id: job.job_id || job.id,
        attempt_id: attemptId,
        lease_id: leaseId,
        canonical_revision: revision(result.revision),
        lease_expires_at: expiresAt,
        requested_mode: job.requested_mode || payload.requested_mode || "",
        scope: payload.allowed_paths || [],
        acceptance: payload.acceptance_criteria || [],
        execution_intent: payload.execution_intent || null,
      };
    } catch (errorValue) {
      if (/STALE_REVISION|JOB_NOT_QUEUED|ACTIVE_ATTEMPT_EXISTS|ACTIVE_LEASE_EXISTS/.test(String(errorValue.message))) continue;
      throw errorValue;
    }
  }
  return null;
}

async function recordSignal(client, input) {
  const ownership = await loadOwnership(client, input.job_id);
  if (ownership.terminal) {
    return { ok: true, terminal_noop: true, idempotent: true, revision: revision(ownership.job.canonical_revision) };
  }
  assertIdentity(ownership, input);
  const result = await rpc(client, "canonical_record_runtime_signal", {
    p_job_id: input.job_id,
    p_attempt_id: input.attempt_id,
    p_worker_id: input.worker_id,
    p_expected_revision: input.expected_revision,
    p_signal: input.signal,
    p_now: input.now || new Date().toISOString(),
    p_new_expires_at: input.signal === "heartbeat" ? input.new_expires_at || null : null,
  });
  return { ...result, canonical_revision: revision(result.revision), lease_id: input.lease_id };
}

async function finalize(client, input) {
  const ownership = await loadOwnership(client, input.job_id);
  if (ownership.terminal) assertTerminalReplay(ownership.terminal, input);
  else assertIdentity(ownership, input);
  if (input.task_goal_status === "failed" && input.effective_final_status === "succeeded") {
    throw new Error("TASK_FAILURE_CANNOT_SUCCEED");
  }
  const terminalState = input.effective_final_status === "succeeded"
    ? "terminal_success"
    : input.effective_final_status === "cancelled" ? "terminal_cancelled" : "terminal_failed";
  const result = await rpc(client, "canonical_finalize_terminal", {
    p_job_id: input.job_id,
    p_attempt_id: input.attempt_id,
    p_worker_id: input.worker_id,
    p_expected_revision: input.expected_revision,
    p_report_identity: input.report_identity,
    p_terminal_job_state: terminalState,
    p_final_attempt_state: terminalState === "terminal_success" ? "finished" : terminalState === "terminal_cancelled" ? "abandoned" : "failed",
    p_worker_execution_status: input.worker_execution_status,
    p_task_goal_status: input.task_goal_status,
    p_effective_final_status: input.effective_final_status,
    p_failure_code: input.failure_code || null,
    p_failure_stage: input.failure_stage || null,
    p_canonical_report: input.canonical_report || {},
    p_now: input.now || new Date().toISOString(),
  });
  if (result.idempotent === true && !ownership.terminal) {
    const replayOwnership = await loadOwnership(client, input.job_id);
    if (!replayOwnership.terminal) throw new Error("CANONICAL_TERMINAL_RECORD_MISSING");
    assertTerminalReplay(replayOwnership.terminal, input);
  }
  return { ...result, canonical_revision: revision(result.revision), lease_id: input.lease_id };
}

async function recoverExpired(client, now = new Date().toISOString(), limit = 100) {
  const { data, error } = await client.from("hermes_job_leases").select("*")
    .eq("lease_state", "active").lte("expires_at", now)
    .order("expires_at", { ascending: true }).limit(limit);
  if (error) throw new Error(`CANONICAL_STALE_LEASE_READ_FAILED:${error.message}`);
  const recovered = [];
  for (const lease of data || []) {
    const ownership = await loadOwnership(client, lease.job_id);
    if (ownership.terminal) continue;
    assertIdentity(ownership, {
      job_id: lease.job_id,
      attempt_id: lease.attempt_id,
      lease_id: lease.lease_id,
      worker_id: lease.worker_id,
      expected_revision: revision(ownership.job.canonical_revision),
    });
    recovered.push(await rpc(client, "canonical_recover_stale_attempt", {
      p_job_id: lease.job_id,
      p_attempt_id: lease.attempt_id,
      p_lease_id: lease.lease_id,
      p_worker_id: lease.worker_id,
      p_expected_revision: revision(ownership.job.canonical_revision),
      p_now: now,
    }));
  }
  return recovered;
}

module.exports = {
  enabled,
  isCanonicalJob,
  canaryAdmissionAllowsClaim,
  claimNext,
  recordSignal,
  finalize,
  recoverExpired,
};
