"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */

const {
  finalizeJob,
  getActiveAttempt,
  inspectJobState,
  validateJobStateInvariant,
} = require("./worker_job_state_machine");

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readString(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function readBoolean(value) {
  return value === true;
}

function terminalReportFailure(failureCode, job = null, conflict = false) {
  return {
    ok: false,
    terminal_applied: false,
    idempotent: false,
    conflict,
    terminal_immutable: true,
    failure_code: failureCode,
    failure_stage: "terminal_report_finalization",
    job,
  };
}

function getStoredTerminalAttemptId(job) {
  const activeAttempt = getActiveAttempt(job);
  const result = asRecord(job && job.result);
  const terminalResult = asRecord(asRecord(result.job_state_machine).terminal_result);
  return readString(activeAttempt && (activeAttempt.id || activeAttempt.attempt_id))
    || readString(terminalResult.attempt_id)
    || readString(result.attempt_id);
}

function getStoredTerminalWorkerId(job) {
  const result = asRecord(job && job.result);
  const canonical = asRecord(result.canonical_worker_report);
  const terminalResult = asRecord(asRecord(result.job_state_machine).terminal_result);
  return readString(terminalResult.worker_id)
    || readString(result.terminal_report_worker_id)
    || readString(canonical.worker_id)
    || readString(canonical.worker_instance_id)
    || readString(result.worker_id);
}

function terminalAttemptMatches(job, attemptId) {
  const storedAttemptId = getStoredTerminalAttemptId(job);
  return storedAttemptId ? storedAttemptId === attemptId : !attemptId;
}

function terminalJobHasRuntimeState(job) {
  const snapshot = inspectJobState(job);
  const payload = asRecord(job && job.payload);
  return Boolean(
    snapshot.claimed_by
      || snapshot.active_attempt
      || snapshot.active_lease
      || readString(payload.running_job_id)
      || readBoolean(job && job.retry_requested)
      || readBoolean(job && job.retry_pending)
      || readBoolean(job && job.should_retry)
      || readBoolean(payload.retry_requested)
      || readBoolean(payload.retry_pending)
      || readBoolean(payload.should_retry)
  );
}

function buildAuthoritativeTerminalReportPatch(transitionPatch, reportFields, input) {
  const lifecycleResult = asRecord(transitionPatch.result);
  const reportResult = asRecord(reportFields.result);
  const lifecycleMachine = asRecord(lifecycleResult.job_state_machine);
  const terminalResult = asRecord(lifecycleMachine.terminal_result);
  return {
    ...reportFields,
    ...transitionPatch,
    status: transitionPatch.status,
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
    result: {
      ...lifecycleResult,
      ...reportResult,
      attempt_id: input.attempt_id,
      terminal_report_identity: input.report_identity,
      terminal_report_worker_id: input.worker_id,
      ...(Object.keys(lifecycleMachine).length > 0
        ? {
            job_state_machine: {
              ...lifecycleMachine,
              terminal_result: {
                ...terminalResult,
                worker_id: input.worker_id,
                report_identity: input.report_identity,
              },
            },
          }
        : {}),
      terminal_state: lifecycleResult.terminal_state,
    },
    updated_at: transitionPatch.updated_at,
  };
}

async function findJob(supabase, jobId) {
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  return { data: data || null, error: error || null };
}

function classifyTerminalReportRace(job, input) {
  const inspection = inspectJobState(job);
  if (inspection.terminal) {
    if (!terminalAttemptMatches(job, input.attempt_id)) {
      return terminalReportFailure("STALE_ATTEMPT_TERMINAL_REPORT", job);
    }
    const storedWorkerId = getStoredTerminalWorkerId(job);
    if (storedWorkerId && storedWorkerId !== input.worker_id) {
      return terminalReportFailure("FOREIGN_WORKER_TERMINAL_REPORT", job);
    }
    const replay = finalizeJob(job, {
      attempt_id: input.attempt_id,
      worker_execution_status: input.worker_execution_status,
      task_goal_status: input.task_goal_status,
      effective_final_status: input.effective_final_status,
      now: input.now,
    });
    if (!replay.ok) {
      return terminalReportFailure(replay.failure_code || "TERMINAL_REPORT_CONFLICT", job, true);
    }
    return {
      ok: true,
      terminal_applied: false,
      idempotent: true,
      conflict: false,
      terminal_immutable: true,
      failure_code: null,
      failure_stage: "terminal_report_finalization",
      job,
    };
  }

  const invariant = validateJobStateInvariant(job);
  if (!invariant.ok) {
    return terminalReportFailure(invariant.failure_code || "JOB_STATE_INVARIANT_VIOLATION", job);
  }
  const activeAttempt = getActiveAttempt(job);
  const activeLease = invariant.snapshot.active_lease;
  if (
    invariant.snapshot.claimed_by !== input.worker_id
      || readString(activeAttempt && activeAttempt.worker_id) !== input.worker_id
  ) {
    return terminalReportFailure("TERMINAL_REPORT_OWNERSHIP_CHANGED", job);
  }
  if (
    readString(activeAttempt && activeAttempt.id) !== input.attempt_id
      || readString(activeLease && activeLease.attempt_id) !== input.attempt_id
      || readString(activeLease && activeLease.worker_id) !== input.worker_id
  ) {
    return terminalReportFailure("TERMINAL_REPORT_ATTEMPT_CHANGED", job);
  }
  return terminalReportFailure("TERMINAL_REPORT_COMPARE_AND_SET_FAILED", job);
}

async function finalizeCanonicalJobReportSafely(supabase, input) {
  if (!input || !input.job_id || !input.worker_id || !input.attempt_id || !input.report_identity) {
    return terminalReportFailure("TERMINAL_REPORT_IDENTITY_REQUIRED");
  }
  const currentRead = await findJob(supabase, input.job_id);
  if (currentRead.error) return terminalReportFailure("TERMINAL_REPORT_STATE_READ_FAILED");
  if (!currentRead.data) return terminalReportFailure("TERMINAL_REPORT_JOB_NOT_FOUND");

  const currentJob = currentRead.data;
  const currentInspection = inspectJobState(currentJob);
  if (currentInspection.terminal) {
    if (!terminalAttemptMatches(currentJob, input.attempt_id)) {
      return terminalReportFailure("STALE_ATTEMPT_TERMINAL_REPORT", currentJob);
    }
    const storedWorkerId = getStoredTerminalWorkerId(currentJob);
    if (storedWorkerId && storedWorkerId !== input.worker_id) {
      return terminalReportFailure("FOREIGN_WORKER_TERMINAL_REPORT", currentJob);
    }
  } else {
    const preInvariant = validateJobStateInvariant(currentJob);
    if (!preInvariant.ok) {
      return terminalReportFailure(preInvariant.failure_code || "JOB_STATE_INVARIANT_VIOLATION", currentJob);
    }
    const activeAttempt = getActiveAttempt(currentJob);
    const activeLease = preInvariant.snapshot.active_lease;
    if (!["claimed", "running"].includes(String(preInvariant.snapshot.state || ""))) {
      return terminalReportFailure("TERMINAL_REPORT_JOB_NOT_ACTIVE", currentJob);
    }
    if (
      preInvariant.snapshot.claimed_by !== input.worker_id
        || readString(activeAttempt && activeAttempt.worker_id) !== input.worker_id
    ) {
      return terminalReportFailure("FOREIGN_WORKER_TERMINAL_REPORT", currentJob);
    }
    if (
      readString(activeAttempt && activeAttempt.id) !== input.attempt_id
        || readString(activeLease && activeLease.attempt_id) !== input.attempt_id
        || readString(activeLease && activeLease.worker_id) !== input.worker_id
    ) {
      return terminalReportFailure("STALE_ATTEMPT_TERMINAL_REPORT", currentJob);
    }
  }

  const transition = finalizeJob(currentJob, {
    attempt_id: input.attempt_id,
    worker_execution_status: input.worker_execution_status,
    task_goal_status: input.task_goal_status,
    effective_final_status: input.effective_final_status,
    now: input.now || new Date().toISOString(),
  });
  if (!transition.ok || !transition.patch) {
    return terminalReportFailure(
      transition.failure_code || "TERMINAL_REPORT_TRANSITION_REJECTED",
      currentJob,
      transition.conflict === true
    );
  }

  if (currentInspection.terminal && !terminalJobHasRuntimeState(currentJob)) {
    return {
      ok: true,
      terminal_applied: false,
      idempotent: true,
      conflict: false,
      terminal_immutable: true,
      failure_code: null,
      failure_stage: "terminal_report_finalization",
      job: currentJob,
    };
  }

  const patch = currentInspection.terminal
    ? transition.patch
    : buildAuthoritativeTerminalReportPatch(transition.patch, asRecord(input.report_fields), input);
  const proposedInvariant = validateJobStateInvariant({ ...currentJob, ...patch });
  if (!proposedInvariant.ok || !proposedInvariant.snapshot.terminal) {
    return terminalReportFailure(
      proposedInvariant.failure_code || "TERMINAL_REPORT_POST_TRANSITION_INVALID",
      currentJob
    );
  }

  const expectedStatus = readString(currentJob.status);
  const expectedUpdatedAt = readString(currentJob.updated_at);
  if (!expectedStatus || !expectedUpdatedAt) {
    return terminalReportFailure("TERMINAL_REPORT_REVISION_REQUIRED", currentJob);
  }

  let query = supabase
    .from("hermes_jobs")
    .update(patch)
    .eq("id", input.job_id)
    .eq("status", expectedStatus)
    .eq("updated_at", expectedUpdatedAt);
  if (!currentInspection.terminal) {
    if (
      readString(currentJob.claimed_by) !== input.worker_id
        || readString(currentJob.attempt_id) !== input.attempt_id
        || readString(currentJob.active_attempt_id) !== input.attempt_id
    ) {
      return terminalReportFailure("TERMINAL_REPORT_ATTEMPT_COLUMNS_REQUIRED", currentJob);
    }
    query = query
      .eq("claimed_by", input.worker_id)
      .eq("attempt_id", input.attempt_id)
      .eq("active_attempt_id", input.attempt_id);
  }
  const { data, error } = await query.select("*").maybeSingle();
  if (error) return terminalReportFailure("TERMINAL_REPORT_COMPARE_AND_SET_FAILED", currentJob);
  if (!data) {
    const raceRead = await findJob(supabase, input.job_id);
    if (raceRead.error) return terminalReportFailure("TERMINAL_REPORT_RACE_READ_FAILED");
    if (!raceRead.data) return terminalReportFailure("TERMINAL_REPORT_JOB_NOT_FOUND");
    return classifyTerminalReportRace(raceRead.data, input);
  }

  const postInvariant = validateJobStateInvariant(data);
  if (!postInvariant.ok || !postInvariant.snapshot.terminal) {
    return terminalReportFailure(
      postInvariant.failure_code || "TERMINAL_REPORT_PERSISTED_STATE_INVALID",
      data
    );
  }
  return {
    ok: true,
    terminal_applied: !currentInspection.terminal,
    idempotent: currentInspection.terminal,
    conflict: false,
    terminal_immutable: true,
    failure_code: null,
    failure_stage: "terminal_report_finalization",
    job: data,
  };
}

module.exports = {
  finalizeCanonicalJobReportSafely,
};
