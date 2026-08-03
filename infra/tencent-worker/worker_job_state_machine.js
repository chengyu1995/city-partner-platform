"use strict";

// This module is loaded by the CommonJS production Worker API.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTerminalWorkerJobDescriptor } = require("./worker_terminal_policy");

const STATE_MACHINE_VERSION = 1;
const TERMINAL_JOB_STATES = new Set([
  "terminal_success",
  "terminal_failed",
  "terminal_cancelled",
]);
const TERMINAL_ATTEMPT_STATES = new Set([
  "finished",
  "failed",
  "abandoned",
  "superseded",
]);
const POLICY_BOOLEAN_FIELDS = [
  "verification_only",
  "allow_no_change_success",
  "code_changes_required",
  "codex_required",
  "git_commit_required",
  "git_push_required",
];

function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  if (/^(?:true|1|yes|on)$/i.test(value.trim())) return true;
  if (/^(?:false|0|no|off)$/i.test(value.trim())) return false;
  return null;
}

function readNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseAttemptContext(requestText) {
  const text = String(requestText || "");
  const marker = text.lastIndexOf("HERMES_WORKER_ATTEMPT_CONTEXT:");
  if (marker < 0) return null;
  const context = {};
  for (const match of text.slice(marker).matchAll(/`([^=`\r\n]+)=([^`\r\n]*)`/g)) {
    context[match[1]] = match[2];
  }
  const attemptId = readString(context.active_attempt_id) || readString(context.attempt_id);
  if (!attemptId) return null;
  return {
    id: attemptId,
    job_id: null,
    worker_id: readString(context.worker_id),
    state: "running",
    started_at: readString(context.claimed_at),
    updated_at: readString(context.claimed_at),
    source: "legacy_request_context",
  };
}

function getResult(job) {
  return asRecord(job && job.result);
}

function getStateMachine(job) {
  const result = getResult(job);
  return asRecord(result.job_state_machine);
}

function normalizeJobState(value) {
  const job = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (job) {
    const machine = getStateMachine(job);
    const machineState = readString(machine.job_state);
    if (machineState) return normalizeJobState(machineState);
    const terminal = getTerminalWorkerJobDescriptor(job);
    if (terminal) return normalizeJobState(terminal.terminalState);
    return normalizeJobState(job.state || job.status || "created");
  }
  const normalized = String(value || "created").trim().toLowerCase();
  if (["created", "new", "draft"].includes(normalized)) return "created";
  if (["pending", "queued", "ready"].includes(normalized)) return "queued";
  if (["claimed", "assigned"].includes(normalized)) return "claimed";
  if (["running", "in_progress", "executing"].includes(normalized)) return "running";
  if (["succeeded", "success", "completed", "reported", "terminal_success"].includes(normalized)) {
    return "terminal_success";
  }
  if (["failed", "failure", "superseded", "terminal_failed"].includes(normalized)) {
    return "terminal_failed";
  }
  if (["cancelled", "canceled", "terminal_cancelled"].includes(normalized)) {
    return "terminal_cancelled";
  }
  return "invalid";
}

function normalizeAttemptState(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/^attempt_/, "");
  return ["created", "claimed", "running", "finished", "failed", "abandoned", "superseded"].includes(normalized)
    ? normalized
    : null;
}

function normalizeLeaseState(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/^lease_/, "");
  return ["active", "expired", "released"].includes(normalized) ? normalized : null;
}

function getActiveAttempt(job) {
  if (!job) return null;
  const machine = getStateMachine(job);
  const hasCanonicalState = Boolean(readString(machine.job_state));
  const machineAttempt = asRecord(machine.active_attempt);
  const machineAttemptId = readString(machineAttempt.id || machineAttempt.attempt_id);
  const machineAttemptState = normalizeAttemptState(machineAttempt.state || machineAttempt.status);
  if (machineAttemptId && !TERMINAL_ATTEMPT_STATES.has(machineAttemptState)) {
    return {
      ...machineAttempt,
      id: machineAttemptId,
      state: machineAttemptState || "running",
      source: "canonical_state_machine",
    };
  }
  if (hasCanonicalState) return null;

  const payload = asRecord(job.payload || job.metadata || job.task_payload);
  const payloadAttempt = asRecord(payload.active_attempt);
  const attemptId =
    readString(job.active_attempt_id) ||
    readString(job.attempt_id) ||
    readString(payloadAttempt.id || payloadAttempt.attempt_id) ||
    readString(payload.attempt_id);
  if (attemptId) {
    return {
      ...payloadAttempt,
      id: attemptId,
      job_id: readString(payloadAttempt.job_id) || readString(job.id),
      worker_id: readString(payloadAttempt.worker_id) || readString(job.claimed_by),
      state: normalizeAttemptState(payloadAttempt.state || payloadAttempt.status) || "running",
      source: "legacy_job_fields",
    };
  }
  const requestAttempt = parseAttemptContext(job.request_text);
  return requestAttempt ? { ...requestAttempt, job_id: readString(job.id) } : null;
}

function getLease(job, now = new Date().toISOString()) {
  if (!job) return null;
  const machine = getStateMachine(job);
  const hasCanonicalState = Boolean(readString(machine.job_state));
  const machineLease = asRecord(machine.active_lease);
  const state = normalizeLeaseState(machineLease.state || machineLease.status);
  const expiresAt = readString(machineLease.expires_at);
  const machineLeaseId = readString(machineLease.id || machineLease.lease_id);
  if (machineLeaseId && state === "active") {
    return {
      ...machineLease,
      id: machineLeaseId,
      state: expiresAt && Date.parse(expiresAt) <= Date.parse(now) ? "expired" : "active",
      expires_at: expiresAt,
      source: "canonical_state_machine",
    };
  }
  if (hasCanonicalState) return null;

  const legacyExpiresAt = readString(job.lease_expires_at || job.expires_at);
  const legacyLeaseId = readString(job.lease_id || job.lease) || (legacyExpiresAt ? `legacy:${job.id || "job"}` : null);
  if (!legacyLeaseId) return null;
  return {
    id: legacyLeaseId,
    job_id: readString(job.id),
    attempt_id: getActiveAttempt(job)?.id || null,
    worker_id: readString(job.claimed_by),
    state: legacyExpiresAt && Date.parse(legacyExpiresAt) <= Date.parse(now) ? "expired" : "active",
    expires_at: legacyExpiresAt,
    source: "legacy_job_fields",
  };
}

function isRetryAllowed(job, now = new Date().toISOString()) {
  const result = getResult(job);
  const nextRetryAt = readString(job && job.next_retry_at) || readString(result.next_retry_at);
  if (nextRetryAt && Date.parse(nextRetryAt) > Date.parse(now)) return false;
  const attempts = readNumber(job && (job.attempt_count ?? job.retry_count)) ?? readNumber(result.retry_count) ?? 0;
  const maxAttempts = readNumber(job && job.max_attempts);
  if (maxAttempts !== null && attempts >= maxAttempts) return false;
  const retryable = readBoolean(job && job.retryable) ?? readBoolean(result.retryable);
  if (retryable === false && attempts > 0) return false;
  return true;
}

function inspectJobState(job, options = {}) {
  const now = options.now || new Date().toISOString();
  const state = normalizeJobState(job);
  const terminal = TERMINAL_JOB_STATES.has(state);
  const activeAttempt = getActiveAttempt(job);
  const lease = getLease(job, now);
  const activeLease = lease && lease.state === "active" ? lease : null;
  const claimedBy = readString(job && job.claimed_by);
  const retryable = readBoolean(job && job.retryable) ?? readBoolean(getResult(job).retryable);
  const retryAllowed = isRetryAllowed(job, now);
  return {
    state,
    terminal,
    claimed_by: claimedBy,
    active_attempt: activeAttempt,
    lease,
    active_lease: activeLease,
    retryable,
    retry_allowed: retryAllowed,
  };
}

function validateJobStateInvariant(job, options = {}) {
  const snapshot = inspectJobState(job, options);
  const violations = [];
  const add = (code, detail) => violations.push({ code, detail });
  if (snapshot.state === "invalid") add("INVALID_JOB_STATE", "job state cannot be normalized");
  if (snapshot.state === "queued" && snapshot.active_attempt) {
    add("QUEUED_WITH_ACTIVE_ATTEMPT", "queued job has an active attempt");
  }
  if (snapshot.state === "queued" && snapshot.active_lease) {
    add("QUEUED_WITH_ACTIVE_LEASE", "queued job has a valid lease");
  }
  if (snapshot.state === "claimed" && !snapshot.claimed_by) {
    add("CLAIMED_WITHOUT_OWNER", "claimed job has no claimed_by");
  }
  if (snapshot.state === "claimed" && !snapshot.active_attempt) {
    add("CLAIMED_WITHOUT_ACTIVE_ATTEMPT", "claimed job has no active attempt");
  }
  if (snapshot.state === "claimed" && !snapshot.active_lease) {
    add("CLAIMED_WITHOUT_ACTIVE_LEASE", "claimed job has no valid lease");
  }
  if (snapshot.state === "running" && !snapshot.active_attempt) {
    add("RUNNING_WITHOUT_ACTIVE_ATTEMPT", "running job has no active attempt");
  }
  if (snapshot.state === "running" && !snapshot.active_lease) {
    add("RUNNING_WITHOUT_ACTIVE_LEASE", "running job has no valid lease");
  }
  if (["claimed", "running"].includes(snapshot.state) && snapshot.active_attempt && snapshot.claimed_by) {
    const attemptOwner = readString(snapshot.active_attempt.worker_id);
    if (!attemptOwner) add("ACTIVE_ATTEMPT_OWNER_MISSING", "active attempt has no worker owner");
    else if (attemptOwner !== snapshot.claimed_by) {
      add("ACTIVE_ATTEMPT_OWNER_MISMATCH", "active attempt owner does not match claimed_by");
    }
  }
  if (["claimed", "running"].includes(snapshot.state) && snapshot.active_attempt && snapshot.active_lease) {
    const attemptId = readString(snapshot.active_attempt.id);
    const attemptOwner = readString(snapshot.active_attempt.worker_id);
    const leaseAttemptId = readString(snapshot.active_lease.attempt_id);
    const leaseOwner = readString(snapshot.active_lease.worker_id);
    if (leaseAttemptId !== attemptId) {
      add("ACTIVE_LEASE_ATTEMPT_MISMATCH", "active lease does not belong to the active attempt");
    }
    if (!leaseOwner || !attemptOwner || leaseOwner !== attemptOwner) {
      add("ACTIVE_LEASE_OWNER_MISMATCH", "active lease owner does not match the active attempt owner");
    }
  }
  if (snapshot.terminal && snapshot.claimed_by) {
    add("TERMINAL_WITH_OWNER", "terminal job still has claimed_by");
  }
  if (snapshot.terminal && snapshot.active_attempt) {
    add("TERMINAL_WITH_ACTIVE_ATTEMPT", "terminal job still has an active attempt");
  }
  if (snapshot.terminal && snapshot.active_lease) {
    add("TERMINAL_WITH_ACTIVE_LEASE", "terminal job still has a valid lease");
  }
  if (snapshot.terminal && snapshot.retryable === true) {
    add("TERMINAL_RETRYABLE", "terminal job is retryable");
  }
  const machine = getStateMachine(job);
  if (snapshot.terminal && readBoolean(job && job.selectable) === true) {
    add("TERMINAL_SELECTABLE", "terminal job has selectable=true");
  }
  if (snapshot.terminal && readBoolean(machine.selectable) === true) {
    add("TERMINAL_SELECTABLE", "terminal state machine has selectable=true");
  }
  return {
    ok: violations.length === 0,
    failure_code: violations.length ? "JOB_STATE_INVARIANT_VIOLATION" : null,
    violations,
    snapshot,
  };
}

function isJobSelectable(job, options = {}) {
  const validation = validateJobStateInvariant(job, options);
  const snapshot = validation.snapshot;
  return validation.ok
    && snapshot.state === "queued"
    && !snapshot.terminal
    && !snapshot.claimed_by
    && !snapshot.active_attempt
    && !snapshot.active_lease
    && snapshot.retry_allowed;
}

function isTerminalJob(job) {
  return inspectJobState(job).terminal;
}

function isCanonicalClaimPersisted(job, attemptId) {
  const machine = getStateMachine(job);
  const attempt = asRecord(machine.active_attempt);
  const lease = asRecord(machine.active_lease);
  return ["claimed", "running"].includes(normalizeJobState(machine.job_state))
    && readString(attempt.id || attempt.attempt_id) === attemptId
    && !TERMINAL_ATTEMPT_STATES.has(normalizeAttemptState(attempt.state || attempt.status))
    && readString(lease.attempt_id) === attemptId
    && normalizeLeaseState(lease.state || lease.status) === "active";
}

function appendUnique(items, value, key = "id") {
  const list = Array.isArray(items) ? [...items] : [];
  const valueKey = value && value[key];
  const index = list.findIndex((item) => item && item[key] === valueKey);
  if (index >= 0) list[index] = value;
  else list.push(value);
  return list;
}

function buildMachineResult(job, update) {
  const result = getResult(job);
  const machine = getStateMachine(job);
  return {
    ...result,
    job_state_machine: {
      ...machine,
      version: STATE_MACHINE_VERSION,
      ...update,
    },
  };
}

function buildClaimedPayload(job, attempt) {
  const payload = asRecord(job && (job.payload || job.metadata || job.task_payload));
  return {
    ...payload,
    attempt_id: attempt.id,
    active_attempt: {
      ...attempt,
      attempt_id: attempt.id,
      status: attempt.state,
    },
    running_job_id: readString(job && job.id),
    retry_requested: false,
    retry_pending: false,
    should_retry: false,
  };
}

function buildReleasedRuntimePayload(job, terminalState = null) {
  const payload = asRecord(job && (job.payload || job.metadata || job.task_payload));
  return {
    ...payload,
    attempt_id: null,
    active_attempt: null,
    running_job_id: null,
    retry_requested: false,
    retry_pending: false,
    should_retry: false,
    ...(terminalState ? { terminal_state: terminalState } : {}),
  };
}

function validateRuntimeSignalOwnership(job, snapshot, input) {
  const attempt = snapshot.active_attempt;
  const lease = snapshot.active_lease;
  const jobId = readString(job && job.id);
  const claimedBy = snapshot.claimed_by;
  const attemptId = readString(attempt && attempt.id);
  const attemptOwner = readString(attempt && attempt.worker_id);
  const leaseJobId = readString(lease && lease.job_id);
  const leaseAttemptId = readString(lease && lease.attempt_id);
  const leaseOwner = readString(lease && lease.worker_id);
  if (!readString(input.worker_id) || !readString(input.attempt_id)) {
    return transitionFailure("RUNTIME_SIGNAL_IDENTITY_REQUIRED");
  }
  if (!claimedBy || !attemptId || !attemptOwner || !lease) {
    return transitionFailure("RUNTIME_OWNERSHIP_UNVERIFIABLE");
  }
  if (attemptOwner !== claimedBy || (input.worker_id && input.worker_id !== claimedBy)) {
    return transitionFailure("RUNTIME_ATTEMPT_OWNER_MISMATCH");
  }
  if (input.attempt_id && input.attempt_id !== attemptId) {
    return transitionFailure("WORKER_ATTEMPT_MISMATCH");
  }
  if ((leaseJobId && jobId && leaseJobId !== jobId) || leaseAttemptId !== attemptId) {
    return transitionFailure("RUNTIME_LEASE_IDENTITY_MISMATCH");
  }
  if (!leaseOwner || leaseOwner !== attemptOwner) {
    return transitionFailure("RUNTIME_LEASE_OWNER_MISMATCH");
  }
  return { ok: true, attempt, lease, claimed_by: claimedBy };
}

function applyRuntimeSignal(job, input, signal) {
  const now = input.now || new Date().toISOString();
  const validation = validateJobStateInvariant(job, { now });
  const snapshot = validation.snapshot;
  if (snapshot.terminal) {
    return {
      ok: true,
      idempotent: true,
      terminal: true,
      terminal_immutable: true,
      violations: validation.violations,
      patch: null,
    };
  }
  if (!validation.ok) return transitionFailure(validation.failure_code, validation.violations);
  if (!["claimed", "running"].includes(snapshot.state)) {
    return transitionFailure("RUNTIME_SIGNAL_JOB_NOT_ACTIVE");
  }
  const ownership = validateRuntimeSignalOwnership(job, snapshot, input);
  if (!ownership.ok) return ownership;
  const machine = getStateMachine(job);
  const attempt = {
    ...ownership.attempt,
    state: "running",
    started_at: ownership.attempt.started_at || now,
    ...(signal === "heartbeat" ? { heartbeat_at: now } : { last_progress_at: now }),
    updated_at: now,
  };
  const lease = {
    ...ownership.lease,
    state: "active",
    expires_at: input.expires_at || ownership.lease.expires_at,
    updated_at: now,
  };
  const result = buildMachineResult(job, {
    job_state: "running",
    selectable: false,
    active_attempt: attempt,
    active_lease: lease,
    attempt_history: appendUnique(machine.attempt_history, attempt),
    lease_history: appendUnique(machine.lease_history, lease),
    last_transition: { name: signal, at: now, attempt_id: attempt.id },
  });
  return {
    ok: true,
    idempotent: false,
    terminal: false,
    patch: {
      status: compatibilityStatus("running"),
      claimed_by: ownership.claimed_by,
      attempt_id: attempt.id,
      active_attempt_id: attempt.id,
      lease_id: lease.id,
      active_lease_id: lease.id,
      expires_at: lease.expires_at,
      heartbeat_at: signal === "heartbeat" ? now : job.heartbeat_at || null,
      ...(signal === "progress"
        ? {
            progress_percent: input.progress_percent,
            current_step: input.current_step,
            status_message: input.status_message || null,
            last_progress_at: now,
          }
        : { status_message: input.status_message || job.status_message || null }),
      payload: buildClaimedPayload(job, attempt),
      result,
      updated_at: now,
    },
  };
}

function applyHeartbeat(job, input = {}) {
  return applyRuntimeSignal(job, input, "heartbeat");
}

function applyProgress(job, input = {}) {
  return applyRuntimeSignal(job, input, "progress");
}

function transitionFailure(code, violations = [], detail = null) {
  return {
    ok: false,
    failure_code: code,
    failure_stage: "job_state_machine",
    violations,
    detail,
    patch: null,
  };
}

function initializeQueuedJob(job = {}, input = {}) {
  const current = inspectJobState(job, { now: input.now });
  if (!["created", "queued"].includes(current.state) || current.terminal) {
    return transitionFailure("JOB_INITIALIZATION_STATE_FORBIDDEN");
  }
  if (current.claimed_by || current.active_attempt || current.active_lease) {
    return transitionFailure("JOB_INITIALIZATION_RUNTIME_STATE_FORBIDDEN");
  }
  const now = input.now || new Date().toISOString();
  const result = buildMachineResult(job, {
    job_state: "queued",
    selectable: true,
    active_attempt: null,
    active_lease: null,
    attempt_history: [],
    lease_history: [],
    last_transition: { name: "initialize_queued", at: now, attempt_id: null },
  });
  const patch = {
    status: compatibilityStatus("queued"),
    claimed_by: null,
    attempt_id: null,
    active_attempt_id: null,
    lease_id: null,
    active_lease_id: null,
    expires_at: null,
    selectable: true,
    retryable: true,
    retry_requested: false,
    retry_pending: false,
    should_retry: false,
    running_job_id: null,
    result,
    updated_at: now,
  };
  const validation = validateJobStateInvariant({ ...job, ...patch }, { now });
  if (!validation.ok || !isJobSelectable({ ...job, ...patch }, { now })) {
    return transitionFailure(validation.failure_code || "JOB_INITIALIZATION_INVALID", validation.violations);
  }
  return { ok: true, patch, failure_code: null, failure_stage: "job_state_machine" };
}

function claimJob(job, input) {
  const validation = validateJobStateInvariant(job, { now: input.now });
  if (!validation.ok) return transitionFailure(validation.failure_code, validation.violations);
  if (!isJobSelectable(job, { now: input.now })) return transitionFailure("JOB_NOT_SELECTABLE");
  const now = input.now || new Date().toISOString();
  const attempt = {
    id: input.attempt_id,
    job_id: readString(job.id),
    worker_id: input.worker_id,
    state: "claimed",
    created_at: now,
    claimed_at: now,
    updated_at: now,
  };
  const lease = {
    id: input.lease_id || `lease:${input.attempt_id}`,
    job_id: readString(job.id),
    attempt_id: input.attempt_id,
    worker_id: input.worker_id,
    state: "active",
    created_at: now,
    expires_at: input.expires_at,
    updated_at: now,
  };
  const machine = getStateMachine(job);
  const result = buildMachineResult(job, {
    job_state: "claimed",
    selectable: false,
    active_attempt: attempt,
    active_lease: lease,
    attempt_history: appendUnique(machine.attempt_history, attempt),
    lease_history: appendUnique(machine.lease_history, lease),
    last_transition: { name: "claim", at: now, attempt_id: input.attempt_id },
  });
  return {
    ok: true,
    failure_code: null,
    attempt,
    lease,
    compare_and_set: {
      id: readString(job.id),
      status: readString(job.status),
      updated_at: readString(job.updated_at),
    },
    patch: {
      status: "running",
      claimed_by: input.worker_id,
      claimed_at: now,
      attempt_id: input.attempt_id,
      active_attempt_id: input.attempt_id,
      lease_id: lease.id,
      active_lease_id: lease.id,
      expires_at: input.expires_at,
      payload: buildClaimedPayload(job, attempt),
      result,
      updated_at: now,
    },
  };
}

function rollbackFailedClaim(job, input = {}) {
  const now = input.now || new Date().toISOString();
  const jobId = readString(job && job.id);
  const workerId = readString(input.worker_id);
  const attemptId = readString(input.attempt_id);
  const expectedJobId = readString(input.job_id);
  const currentState = normalizeJobState(job);
  if (TERMINAL_JOB_STATES.has(currentState)) {
    return {
      ok: true,
      rollback_applied: false,
      rollback_skipped_reason: "JOB_ALREADY_TERMINAL",
      terminal_report_won: true,
      terminal_immutable: true,
      patch: null,
    };
  }
  if (!jobId || !workerId || !attemptId || (expectedJobId && expectedJobId !== jobId)) {
    return transitionFailure("ROLLBACK_CLAIM_IDENTITY_REQUIRED");
  }
  const validation = validateJobStateInvariant(job, { now });
  if (!validation.ok) return transitionFailure(validation.failure_code, validation.violations);
  const snapshot = validation.snapshot;
  if (!["claimed", "running"].includes(snapshot.state)) {
    return transitionFailure("ROLLBACK_JOB_NOT_CLAIMED");
  }
  if (snapshot.claimed_by !== workerId) {
    return transitionFailure("ROLLBACK_OWNERSHIP_CHANGED");
  }
  const activeAttemptId = readString(snapshot.active_attempt && snapshot.active_attempt.id);
  const attemptOwner = readString(snapshot.active_attempt && snapshot.active_attempt.worker_id);
  if (activeAttemptId !== attemptId || attemptOwner !== workerId) {
    return transitionFailure("ROLLBACK_ATTEMPT_CHANGED");
  }
  const lease = snapshot.active_lease;
  const leaseAttemptId = readString(lease && lease.attempt_id);
  const leaseOwner = readString(lease && lease.worker_id);
  if (!lease || leaseAttemptId !== attemptId || leaseOwner !== workerId) {
    return transitionFailure("ROLLBACK_LEASE_CHANGED");
  }
  const currentUpdatedAt = readString(job && job.updated_at);
  if (input.expected_updated_at && input.expected_updated_at !== currentUpdatedAt) {
    return transitionFailure("ROLLBACK_VERSION_CHANGED");
  }

  const machine = getStateMachine(job);
  const abandonedAttempt = abandonAttempt(snapshot.active_attempt, now, "failed_claim");
  const releasedLease = releaseLease(lease, now, "released");
  const result = buildMachineResult(job, {
    job_state: "queued",
    selectable: true,
    active_attempt: null,
    active_lease: null,
    attempt_history: appendUnique(machine.attempt_history, abandonedAttempt),
    lease_history: appendUnique(machine.lease_history, releasedLease),
    last_transition: { name: "rollback_failed_claim", at: now, attempt_id: attemptId },
  });
  return {
    ok: true,
    rollback_applied: false,
    rollback_skipped_reason: null,
    terminal_report_won: false,
    abandoned_attempt: abandonedAttempt,
    released_lease: releasedLease,
    compare_and_set: {
      id: jobId,
      status: readString(job.status),
      claimed_by: workerId,
      attempt_id: attemptId,
      active_attempt_id: attemptId,
      updated_at: currentUpdatedAt,
    },
    patch: {
      status: "queued",
      claimed_by: null,
      claimed_at: null,
      attempt_id: null,
      active_attempt_id: null,
      lease_id: null,
      active_lease_id: null,
      expires_at: null,
      heartbeat_at: null,
      last_progress_at: null,
      running_job_id: null,
      progress_percent: 0,
      current_step: null,
      status_message: null,
      payload: buildReleasedRuntimePayload(job),
      result,
      updated_at: now,
    },
  };
}

function beginAttempt(job, input = {}) {
  const validation = validateJobStateInvariant(job, { now: input.now });
  if (!validation.ok) return transitionFailure(validation.failure_code, validation.violations);
  const snapshot = validation.snapshot;
  if (!snapshot.active_attempt || !["claimed", "running"].includes(snapshot.state)) {
    return transitionFailure("ACTIVE_ATTEMPT_REQUIRED");
  }
  const now = input.now || new Date().toISOString();
  const attempt = { ...snapshot.active_attempt, state: "running", started_at: snapshot.active_attempt.started_at || now, updated_at: now };
  const machine = getStateMachine(job);
  return {
    ok: true,
    patch: {
      status: "running",
      result: buildMachineResult(job, {
        job_state: "running",
        active_attempt: attempt,
        attempt_history: appendUnique(machine.attempt_history, attempt),
        last_transition: { name: "begin_attempt", at: now, attempt_id: attempt.id },
      }),
      updated_at: now,
    },
  };
}

function finishAttempt(attempt, outcome, now = new Date().toISOString()) {
  const state = outcome === "success" ? "finished" : outcome === "abandoned" ? "abandoned" : "failed";
  return { ...attempt, state, finished_at: now, updated_at: now };
}

function abandonAttempt(attempt, now = new Date().toISOString(), reason = "stale_attempt") {
  return { ...attempt, state: "abandoned", abandoned_at: now, abandon_reason: reason, updated_at: now };
}

function releaseLease(lease, now = new Date().toISOString(), reason = "released") {
  if (!lease) return null;
  const state = reason === "expired" ? "expired" : "released";
  return { ...lease, state, released_at: now, updated_at: now };
}

function resolveEffectiveFinalStatus(input) {
  const explicit = normalizeJobState(input.effective_final_status);
  const taskGoal = String(input.task_goal_status || "").trim().toLowerCase();
  const worker = String(input.worker_execution_status || "").trim().toLowerCase();
  if (/^(?:failed|failure|incomplete|no_fix_applied|read_only_violation)/.test(taskGoal)) return "terminal_failed";
  if (explicit === "terminal_failed" || explicit === "terminal_cancelled") return explicit;
  if (/^(?:failed|failure|crashed|timed_out)$/.test(worker)) return "terminal_failed";
  return explicit === "terminal_success" ? explicit : "terminal_failed";
}

function compatibilityStatus(state) {
  if (state === "terminal_success") return "succeeded";
  if (state === "terminal_cancelled") return "cancelled";
  if (state === "terminal_failed") return "failed";
  if (state === "queued") return "queued";
  return "running";
}

function cleanupTerminalJob(job, now = new Date().toISOString()) {
  const state = normalizeJobState(job);
  if (!TERMINAL_JOB_STATES.has(state)) return transitionFailure("TERMINAL_JOB_REQUIRED");
  const snapshot = inspectJobState(job, { now });
  const machine = getStateMachine(job);
  const finishedAttempt = snapshot.active_attempt
    ? finishAttempt(snapshot.active_attempt, state === "terminal_success" ? "success" : "failure", now)
    : null;
  const releasedLease = releaseLease(snapshot.lease, now, snapshot.lease && snapshot.lease.state === "expired" ? "expired" : "released");
  const result = buildMachineResult(job, {
    job_state: state,
    selectable: false,
    active_attempt: null,
    active_lease: null,
    attempt_history: finishedAttempt ? appendUnique(machine.attempt_history, finishedAttempt) : machine.attempt_history || [],
    lease_history: releasedLease ? appendUnique(machine.lease_history, releasedLease) : machine.lease_history || [],
    last_transition: { name: "terminal_cleanup", at: now, attempt_id: finishedAttempt && finishedAttempt.id || null },
  });
  result.retryable = false;
  result.retry_requested = false;
  result.retry_pending = false;
  result.should_retry = false;
  result.terminal_state = state;
  return {
    ok: true,
    terminal_immutable: true,
    patch: {
      status: compatibilityStatus(state),
      claimed_by: null,
      claimed_at: null,
      attempt_id: null,
      active_attempt_id: null,
      lease_id: null,
      active_lease_id: null,
      expires_at: null,
      heartbeat_at: null,
      last_progress_at: null,
      running_job_id: null,
      retryable: false,
      retry_requested: false,
      retry_pending: false,
      should_retry: false,
      payload: buildReleasedRuntimePayload(job, state),
      result,
      finished_at: readString(job.finished_at) || now,
      completed_at: readString(job.completed_at) || now,
      updated_at: now,
    },
  };
}

function finalizeJob(job, input) {
  const now = input.now || new Date().toISOString();
  const desiredState = resolveEffectiveFinalStatus(input);
  const currentState = normalizeJobState(job);
  if (TERMINAL_JOB_STATES.has(currentState)) {
    if (currentState !== desiredState) {
      return {
        ...transitionFailure("TERMINAL_REPORT_CONFLICT", [], "first canonical terminal result is immutable"),
        terminal_immutable: true,
        conflict: true,
        existing_state: currentState,
        incoming_state: desiredState,
      };
    }
    return {
      ok: true,
      idempotent: true,
      terminal_immutable: true,
      conflict: false,
      existing_state: currentState,
      patch: cleanupTerminalJob(job, now).patch,
    };
  }

  const snapshot = inspectJobState(job, { now });
  if (snapshot.active_attempt && input.attempt_id && snapshot.active_attempt.id !== input.attempt_id) {
    return transitionFailure("STALE_ATTEMPT_REPORT");
  }
  const machine = getStateMachine(job);
  const finishedAttempt = snapshot.active_attempt
    ? finishAttempt(snapshot.active_attempt, desiredState === "terminal_success" ? "success" : "failure", now)
    : null;
  const releasedLease = releaseLease(snapshot.lease, now, snapshot.lease && snapshot.lease.state === "expired" ? "expired" : "released");
  const result = buildMachineResult(job, {
    job_state: desiredState,
    selectable: false,
    active_attempt: null,
    active_lease: null,
    attempt_history: finishedAttempt ? appendUnique(machine.attempt_history, finishedAttempt) : machine.attempt_history || [],
    lease_history: releasedLease ? appendUnique(machine.lease_history, releasedLease) : machine.lease_history || [],
    last_transition: { name: "finalize", at: now, attempt_id: input.attempt_id || null },
    terminal_result: {
      attempt_id: input.attempt_id || null,
      worker_execution_status: input.worker_execution_status || null,
      task_goal_status: input.task_goal_status || null,
      effective_final_status: desiredState,
      finalized_at: now,
    },
  });
  result.retryable = false;
  result.retry_requested = false;
  result.retry_pending = false;
  result.should_retry = false;
  result.terminal_state = desiredState;
  return {
    ok: true,
    idempotent: false,
    terminal_immutable: true,
    effective_final_status: desiredState,
    patch: {
      status: compatibilityStatus(desiredState),
      claimed_by: null,
      claimed_at: null,
      attempt_id: null,
      active_attempt_id: null,
      lease_id: null,
      active_lease_id: null,
      expires_at: null,
      heartbeat_at: null,
      last_progress_at: null,
      running_job_id: null,
      retryable: false,
      retry_requested: false,
      retry_pending: false,
      should_retry: false,
      payload: buildReleasedRuntimePayload(job, desiredState),
      result,
      finished_at: readString(job.finished_at) || now,
      completed_at: readString(job.completed_at) || now,
      updated_at: now,
    },
  };
}

function recoverStaleAttempt(job, input = {}) {
  const now = input.now || new Date().toISOString();
  const currentState = normalizeJobState(job);
  if (TERMINAL_JOB_STATES.has(currentState)) {
    return {
      ok: true,
      recovered: false,
      terminal_immutable: true,
      patch: null,
    };
  }
  const snapshot = inspectJobState(job, { now });
  if (!snapshot.active_attempt) return transitionFailure("ACTIVE_ATTEMPT_REQUIRED");
  const attemptId = readString(snapshot.active_attempt.id);
  const attemptOwner = readString(snapshot.active_attempt.worker_id);
  const claimedBy = snapshot.claimed_by;
  const lease = snapshot.lease;
  const leaseId = readString(lease && lease.id);
  const leaseJobId = readString(lease && lease.job_id);
  const leaseAttemptId = readString(lease && lease.attempt_id);
  const leaseOwner = readString(lease && lease.worker_id);
  const leaseExpiresAt = readString(lease && lease.expires_at);
  if (!attemptId || (input.expected_attempt_id && input.expected_attempt_id !== attemptId)) {
    return transitionFailure("STALE_ATTEMPT_IDENTITY_MISMATCH");
  }
  if (!attemptOwner || !claimedBy) {
    return transitionFailure("STALE_ATTEMPT_OWNERSHIP_UNVERIFIABLE");
  }
  if (attemptOwner !== claimedBy || (input.expected_worker_id && input.expected_worker_id !== attemptOwner)) {
    return transitionFailure("STALE_ATTEMPT_OWNER_MISMATCH");
  }
  if (!leaseId || !leaseAttemptId || !leaseOwner || !leaseExpiresAt) {
    return transitionFailure("STALE_ATTEMPT_LEASE_UNVERIFIABLE");
  }
  if ((leaseJobId && readString(job.id) && leaseJobId !== readString(job.id)) || leaseAttemptId !== attemptId) {
    return transitionFailure("STALE_ATTEMPT_LEASE_IDENTITY_MISMATCH");
  }
  if (leaseOwner !== attemptOwner) {
    return transitionFailure("STALE_ATTEMPT_LEASE_OWNER_MISMATCH");
  }
  const leaseExpiry = Date.parse(leaseExpiresAt);
  if (!Number.isFinite(leaseExpiry)) return transitionFailure("STALE_ATTEMPT_LEASE_UNVERIFIABLE");
  if (leaseExpiry > Date.parse(now)) return transitionFailure("STALE_ATTEMPT_LEASE_ACTIVE");
  const machine = getStateMachine(job);
  const abandoned = abandonAttempt(snapshot.active_attempt, now, input.reason || "stale_attempt");
  const released = releaseLease(lease, now, "expired");
  const retryAllowed = input.retry_allowed !== undefined ? input.retry_allowed === true : snapshot.retry_allowed;
  const nextState = retryAllowed ? "queued" : "terminal_failed";
  const result = buildMachineResult(job, {
    job_state: nextState,
    selectable: retryAllowed,
    active_attempt: null,
    active_lease: null,
    attempt_history: appendUnique(machine.attempt_history, abandoned),
    lease_history: released ? appendUnique(machine.lease_history, released) : machine.lease_history || [],
    last_transition: { name: "recover_stale_attempt", at: now, attempt_id: abandoned.id },
  });
  if (!retryAllowed) result.retryable = false;
  return {
    ok: true,
    recovered: true,
    abandoned_attempt: abandoned,
    released_lease: released,
    patch: {
      status: compatibilityStatus(nextState),
      claimed_by: null,
      claimed_at: null,
      attempt_id: null,
      active_attempt_id: null,
      lease_id: null,
      active_lease_id: null,
      expires_at: null,
      heartbeat_at: null,
      last_progress_at: null,
      running_job_id: null,
      retryable: retryAllowed,
      retry_requested: false,
      retry_pending: false,
      should_retry: false,
      payload: buildReleasedRuntimePayload(job, retryAllowed ? null : nextState),
      result,
      updated_at: now,
    },
  };
}

function mergeExecutionPolicy(explicitPolicy, inheritedPolicy) {
  const explicit = asRecord(explicitPolicy);
  const inherited = asRecord(inheritedPolicy);
  const merged = { ...inherited };
  for (const field of POLICY_BOOLEAN_FIELDS) {
    const explicitValue = readBoolean(explicit[field]);
    const inheritedValue = readBoolean(inherited[field]);
    merged[field] = explicitValue === null ? inheritedValue : explicitValue;
  }
  return merged;
}

module.exports = {
  POLICY_BOOLEAN_FIELDS,
  STATE_MACHINE_VERSION,
  TERMINAL_ATTEMPT_STATES,
  TERMINAL_JOB_STATES,
  abandonAttempt,
  applyHeartbeat,
  applyProgress,
  beginAttempt,
  claimJob,
  cleanupTerminalJob,
  finalizeJob,
  finishAttempt,
  getActiveAttempt,
  getLease,
  getStateMachine,
  inspectJobState,
  initializeQueuedJob,
  isCanonicalClaimPersisted,
  isJobSelectable,
  isRetryAllowed,
  isTerminalJob,
  mergeExecutionPolicy,
  normalizeAttemptState,
  normalizeJobState,
  normalizeLeaseState,
  recoverStaleAttempt,
  releaseLease,
  rollbackFailedClaim,
  resolveEffectiveFinalStatus,
  validateJobStateInvariant,
};
