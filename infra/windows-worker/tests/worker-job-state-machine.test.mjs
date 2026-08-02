import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..", "..", "..");
const require = createRequire(import.meta.url);
const machine = require(path.join(root, "infra", "tencent-worker", "worker_job_state_machine.js"));
const nextRoute = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "next", "route.ts"), "utf8");
const reportRoute = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "report", "route.ts"), "utf8");
const productionApi = fs.readFileSync(path.join(root, "infra", "tencent-worker", "worker_api.js"), "utf8");

const NOW = "2026-08-02T08:00:00.000Z";
const EXPIRES = "2026-08-02T08:05:00.000Z";
const EXPIRED = "2026-08-02T07:55:00.000Z";

function queued(overrides = {}) {
  return {
    id: "job-1",
    status: "queued",
    claimed_by: null,
    attempt_count: 0,
    max_attempts: 3,
    updated_at: "2026-08-02T07:59:00.000Z",
    request_text: "approved task",
    result: {},
    ...overrides,
  };
}

function claim(job = queued()) {
  const transition = machine.claimJob(job, {
    worker_id: "worker-a",
    attempt_id: "attempt-a",
    lease_id: "lease-a",
    now: NOW,
    expires_at: EXPIRES,
  });
  assert.equal(transition.ok, true);
  return { ...job, ...transition.patch };
}

function terminal(status, state) {
  return {
    id: "terminal-job",
    status,
    claimed_by: null,
    retryable: false,
    result: {
      retryable: false,
      job_state_machine: {
        version: 1,
        job_state: state,
        selectable: false,
        active_attempt: null,
        active_lease: null,
      },
    },
  };
}

test("clean queued job is selectable", () => {
  assert.equal(machine.validateJobStateInvariant(queued(), { now: NOW }).ok, true);
  assert.equal(machine.isJobSelectable(queued(), { now: NOW }), true);
});

test("queued job with active attempt is invalid and not selectable", () => {
  const job = queued({
    request_text: "approved task\n\nHERMES_WORKER_ATTEMPT_CONTEXT:\n`attempt_id=attempt-old`\n`active_attempt_id=attempt-old`\n`worker_id=worker-a`\n`claimed_at=2026-08-02T07:00:00.000Z`",
  });
  const validation = machine.validateJobStateInvariant(job, { now: NOW });
  assert.equal(validation.ok, false);
  assert.equal(validation.failure_code, "JOB_STATE_INVARIANT_VIOLATION");
  assert.equal(validation.violations.some((item) => item.code === "QUEUED_WITH_ACTIVE_ATTEMPT"), true);
  assert.equal(machine.isJobSelectable(job, { now: NOW }), false);
});

test("queued job with active lease is invalid and not selectable", () => {
  const job = queued({
    result: { job_state_machine: { job_state: "queued", active_lease: { id: "lease-a", state: "active", expires_at: EXPIRES } } },
  });
  const validation = machine.validateJobStateInvariant(job, { now: NOW });
  assert.equal(validation.violations.some((item) => item.code === "QUEUED_WITH_ACTIVE_LEASE"), true);
  assert.equal(machine.isJobSelectable(job, { now: NOW }), false);
});

test("terminal success is not selectable", () => {
  assert.equal(machine.isJobSelectable(terminal("succeeded", "terminal_success"), { now: NOW }), false);
});

test("terminal failure is not selectable", () => {
  assert.equal(machine.isJobSelectable(terminal("failed", "terminal_failed"), { now: NOW }), false);
});

test("terminal cancellation is not selectable", () => {
  assert.equal(machine.isJobSelectable(terminal("cancelled", "terminal_cancelled"), { now: NOW }), false);
});

test("retry recovery cannot reactivate a terminal job", () => {
  const recovery = machine.recoverStaleAttempt(terminal("failed", "terminal_failed"), { now: NOW, retry_allowed: true });
  assert.equal(recovery.recovered, false);
  assert.equal(recovery.terminal_immutable, true);
  assert.equal(recovery.patch, null);
});

test("lease expiry cannot reactivate a terminal job", () => {
  const job = terminal("succeeded", "terminal_success");
  job.expires_at = EXPIRED;
  const recovery = machine.recoverStaleAttempt(job, { now: NOW, worker_available: false });
  assert.equal(recovery.recovered, false);
  assert.equal(machine.normalizeJobState(job), "terminal_success");
});

test("duplicate terminal report is idempotent", () => {
  const duplicate = machine.finalizeJob(terminal("failed", "terminal_failed"), {
    attempt_id: "attempt-a",
    worker_execution_status: "failed",
    task_goal_status: "failed",
    effective_final_status: "failed",
    now: NOW,
  });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.terminal_immutable, true);
});

test("conflicting terminal report cannot overwrite first terminal truth", () => {
  const conflict = machine.finalizeJob(terminal("failed", "terminal_failed"), {
    attempt_id: "attempt-a",
    worker_execution_status: "succeeded",
    task_goal_status: "completed",
    effective_final_status: "succeeded",
    now: NOW,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.failure_code, "TERMINAL_REPORT_CONFLICT");
  assert.equal(conflict.patch, null);
  assert.equal(conflict.existing_state, "terminal_failed");
});

test("worker crash converts the old attempt to abandoned", () => {
  const running = claim();
  running.result.job_state_machine.job_state = "running";
  running.result.job_state_machine.active_attempt.state = "running";
  running.result.job_state_machine.active_lease.expires_at = EXPIRED;
  const recovery = machine.recoverStaleAttempt(running, { now: NOW, worker_available: false, retry_allowed: true });
  assert.equal(recovery.ok, true);
  assert.equal(recovery.abandoned_attempt.state, "abandoned");
});

test("stale attempt recovery clears runtime references and requeues", () => {
  const running = claim();
  running.result.job_state_machine.job_state = "running";
  running.result.job_state_machine.active_attempt.state = "running";
  running.result.job_state_machine.active_lease.expires_at = EXPIRED;
  const recovery = machine.recoverStaleAttempt(running, { now: NOW, worker_available: false, retry_allowed: true });
  assert.equal(recovery.patch.status, "queued");
  assert.equal(recovery.patch.claimed_by, null);
  assert.equal(recovery.patch.active_attempt_id, null);
  assert.equal(recovery.patch.expires_at, null);
  assert.equal(recovery.patch.result.job_state_machine.active_attempt, null);
});

test("claim uses updated_at compare-and-set for concurrency", () => {
  assert.match(nextRoute, /claimHermesJob\([\s\S]*updated_at:/);
  assert.match(productionApi, /guarded = guarded\.eq\("updated_at", job\.updated_at\)/);
  assert.match(productionApi, /query\.eq\("status", job\.status\)\.eq\("updated_at", job\.updated_at\)/);
});

test("claim creates job attempt and lease in one canonical patch", () => {
  const transition = machine.claimJob(queued(), {
    worker_id: "worker-a",
    attempt_id: "attempt-a",
    lease_id: "lease-a",
    now: NOW,
    expires_at: EXPIRES,
  });
  assert.equal(transition.patch.result.job_state_machine.job_state, "claimed");
  assert.equal(transition.patch.result.job_state_machine.active_attempt.id, "attempt-a");
  assert.equal(transition.patch.result.job_state_machine.active_lease.id, "lease-a");
  assert.equal(transition.patch.payload.active_attempt.attempt_id, "attempt-a");
  assert.equal(transition.patch.active_lease_id, "lease-a");
  assert.equal(machine.isCanonicalClaimPersisted({ ...queued(), ...transition.patch }, "attempt-a"), true);
  assert.equal(transition.compare_and_set.updated_at, queued().updated_at);
});

test("report finalization clears claimed owner", () => {
  const finalization = machine.finalizeJob(claim(), {
    attempt_id: "attempt-a",
    worker_execution_status: "succeeded",
    task_goal_status: "completed",
    effective_final_status: "succeeded",
    now: NOW,
  });
  assert.equal(finalization.patch.claimed_by, null);
  assert.match(reportRoute, /buildCanonicalFinalizeTransition/);
});

test("report finalization releases the active lease", () => {
  const finalization = machine.finalizeJob(claim(), {
    attempt_id: "attempt-a",
    worker_execution_status: "succeeded",
    task_goal_status: "completed",
    effective_final_status: "succeeded",
    now: NOW,
  });
  assert.equal(finalization.patch.expires_at, null);
  assert.equal(finalization.patch.result.job_state_machine.active_lease, null);
});

test("report finalization clears active attempt", () => {
  const finalization = machine.finalizeJob(claim(), {
    attempt_id: "attempt-a",
    worker_execution_status: "failed",
    task_goal_status: "failed",
    effective_final_status: "failed",
    now: NOW,
  });
  assert.equal(finalization.patch.active_attempt_id, null);
  assert.equal(finalization.patch.result.job_state_machine.active_attempt, null);
  assert.equal(finalization.patch.payload.active_attempt, null);
  assert.equal(finalization.patch.payload.running_job_id, null);
  assert.equal(finalization.patch.payload.retry_requested, false);
});

test("task failure outranks worker process success", () => {
  assert.equal(machine.resolveEffectiveFinalStatus({
    worker_execution_status: "succeeded",
    task_goal_status: "failed",
    effective_final_status: "succeeded",
  }), "terminal_failed");
});

test("explicit false policy cannot be overridden by inherited true", () => {
  const policy = machine.mergeExecutionPolicy(
    { codex_required: false, code_changes_required: false, git_commit_required: false },
    { codex_required: true, code_changes_required: true, git_commit_required: true }
  );
  assert.equal(policy.codex_required, false);
  assert.equal(policy.code_changes_required, false);
  assert.equal(policy.git_commit_required, false);
});

test("FIX-51 queued plus legacy active attempt is invalid and non-selectable", () => {
  const fix51 = queued({
    id: "6e06c8f4-9716-4b3d-a6a8-00d9f7e359d4",
    request_text: "BATCH-ARCH-COMPLETE-01-VERIFICATION-POLICY-PROPAGATION-AND-REPORT-FIX-51\n\nHERMES_WORKER_ATTEMPT_CONTEXT:\n`attempt_id=attempt-DESKTOP-B2EMBGS-6e06c8f4-msbeh8pz-1uudec`\n`active_attempt_id=attempt-DESKTOP-B2EMBGS-6e06c8f4-msbeh8pz-1uudec`\n`worker_id=DESKTOP-B2EMBGS`\n`claimed_at=2026-08-02T06:09:22.535Z`",
  });
  const validation = machine.validateJobStateInvariant(fix51, { now: NOW });
  assert.equal(validation.ok, false);
  assert.equal(machine.isJobSelectable(fix51, { now: NOW }), false);
  assert.equal(validation.snapshot.active_attempt.id.includes("6e06c8f4"), true);
});

test("SMOKE-50 terminal record remains immutable and non-selectable", () => {
  const smoke50 = terminal("failed", "terminal_failed");
  smoke50.id = "3365b4ec-c816-407b-8db9-6465670dee22";
  const inspection = machine.inspectJobState(smoke50, { now: NOW });
  assert.equal(inspection.terminal, true);
  assert.equal(inspection.retryable, false);
  assert.equal(machine.isJobSelectable(smoke50, { now: NOW }), false);
});
