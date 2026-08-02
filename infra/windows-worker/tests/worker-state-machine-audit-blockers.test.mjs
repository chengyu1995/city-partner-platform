import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(import.meta.url);
const machine = require(path.join(root, "infra", "tencent-worker", "worker_job_state_machine.js"));
const workerApi = fs.readFileSync(path.join(root, "infra", "tencent-worker", "worker_api.js"), "utf8");
const heartbeatRoute = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "heartbeat", "route.ts"), "utf8");
const progressRoute = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "progress", "route.ts"), "utf8");

const NOW = "2026-08-02T08:00:00.000Z";
const EXPIRED = "2026-08-02T07:00:00.000Z";
const ACTIVE = "2026-08-02T09:00:00.000Z";

function canonicalJob({
  state = "running",
  claimedBy = "Worker-A",
  attemptOwner = "Worker-A",
  leaseOwner = "Worker-A",
  leaseExpiresAt = ACTIVE,
  attempt = true,
  lease = true,
  status,
  requestText,
} = {}) {
  const activeAttempt = attempt
    ? { id: "attempt-a", job_id: "job-a", worker_id: attemptOwner, state: "running" }
    : null;
  const activeLease = lease
    ? {
        id: "lease-a",
        job_id: "job-a",
        attempt_id: "attempt-a",
        worker_id: leaseOwner,
        state: "active",
        expires_at: leaseExpiresAt,
      }
    : null;
  return {
    id: "job-a",
    status: status ?? (state === "queued" ? "queued" : state.startsWith("terminal_") ? "failed" : "running"),
    claimed_by: claimedBy,
    updated_at: "2026-08-02T06:00:00.000Z",
    request_text: requestText || "ordinary worker task",
    result: {
      job_state_machine: {
        version: 1,
        job_state: state,
        selectable: state === "queued",
        active_attempt: activeAttempt,
        active_lease: activeLease,
        attempt_history: activeAttempt ? [activeAttempt] : [],
        lease_history: activeLease ? [activeLease] : [],
      },
    },
  };
}

function terminalJob(state = "terminal_success", projections = {}) {
  return {
    ...canonicalJob({ state, claimedBy: null, attempt: false, lease: false }),
    ...projections,
  };
}

function recoverableJob(overrides = {}) {
  return canonicalJob({ leaseExpiresAt: EXPIRED, ...overrides });
}

function recover(job, overrides = {}) {
  return machine.recoverStaleAttempt(job, {
    now: NOW,
    worker_available: false,
    expected_attempt_id: "attempt-a",
    expected_worker_id: "Worker-A",
    retry_allowed: true,
    ...overrides,
  });
}

test("terminal heartbeat is a no-op with no state mutation", () => {
  const job = terminalJob();
  const before = structuredClone(job);
  const result = machine.applyHeartbeat(job, { worker_id: "Worker-A", attempt_id: "attempt-a", now: NOW, expires_at: ACTIVE });
  assert.equal(result.terminal, true);
  assert.equal(result.patch, null);
  assert.deepEqual(job, before);
});

test("terminal progress is a no-op with no state mutation", () => {
  const job = terminalJob("terminal_failed");
  const result = machine.applyProgress(job, { worker_id: "Worker-A", attempt_id: "attempt-a", now: NOW, progress_percent: 99, current_step: "running" });
  assert.equal(result.terminal, true);
  assert.equal(result.patch, null);
});

test("legacy status projection cannot override canonical terminal", () => {
  const job = terminalJob("terminal_success", { status: "running" });
  assert.equal(machine.normalizeJobState(job), "terminal_success");
  assert.equal(machine.applyHeartbeat(job, { worker_id: "Worker-A", attempt_id: "attempt-a", now: NOW, expires_at: ACTIVE }).patch, null);
});

test("legacy lease projection cannot override canonical terminal", () => {
  const job = terminalJob("terminal_cancelled", { lease_id: "legacy-lease", expires_at: ACTIVE });
  assert.equal(machine.getLease(job, NOW), null);
  assert.equal(machine.normalizeJobState(job), "terminal_cancelled");
});

test("heartbeat handlers use the canonical validator command", () => {
  assert.match(workerApi, /canonicalApplyHeartbeat\(existingJob/);
  assert.match(heartbeatRoute, /buildCanonicalHeartbeatTransition\(existingJob/);
  assert.doesNotMatch(heartbeatRoute, /isTerminalWorkerStatus\(existingJob\.status\)/);
});

test("progress handlers use the canonical validator command", () => {
  assert.match(workerApi, /canonicalApplyProgress\(existingJob/);
  assert.match(progressRoute, /buildCanonicalProgressTransition\(existingJob/);
  assert.doesNotMatch(progressRoute, /status:\s*body\.status/);
});

test("heartbeat cannot reactivate canonical terminal", () => {
  const result = machine.applyHeartbeat(terminalJob("terminal_failed", { status: "queued" }), { worker_id: "Worker-A", attempt_id: "attempt-a", now: NOW, expires_at: ACTIVE });
  assert.equal(result.patch, null);
  assert.equal(result.terminal_immutable, true);
});

test("progress cannot reactivate canonical terminal", () => {
  const result = machine.applyProgress(terminalJob("terminal_cancelled", { status: "queued" }), { worker_id: "Worker-A", attempt_id: "attempt-a", now: NOW, progress_percent: 1, current_step: "queued" });
  assert.equal(result.patch, null);
  assert.equal(result.terminal_immutable, true);
});

test("proven owner and expired lease allow stale recovery", () => {
  assert.equal(recover(recoverableJob()).recovered, true);
});

test("attempt owner mismatch fails closed", () => {
  const result = recover(recoverableJob({ attemptOwner: "Worker-B", leaseOwner: "Worker-B" }));
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "STALE_ATTEMPT_OWNER_MISMATCH");
  assert.equal(result.patch, null);
});

test("lease owner mismatch fails closed", () => {
  const result = recover(recoverableJob({ leaseOwner: "Worker-B" }));
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "STALE_ATTEMPT_LEASE_OWNER_MISMATCH");
});

test("worker unavailable is insufficient while lease is valid", () => {
  const result = recover(canonicalJob({ leaseExpiresAt: ACTIVE }));
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "STALE_ATTEMPT_LEASE_ACTIVE");
});

test("worker unavailable is insufficient when ownership is unknown", () => {
  const result = recover(recoverableJob({ claimedBy: null }), { expected_worker_id: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "STALE_ATTEMPT_OWNERSHIP_UNVERIFIABLE");
});

test("expired lease with proven ownership abandons stale attempt", () => {
  const result = recover(recoverableJob());
  assert.equal(result.abandoned_attempt.state, "abandoned");
  assert.equal(result.patch.result.job_state_machine.active_attempt, null);
});

test("stale recovery preserves attempt history", () => {
  const result = recover(recoverableJob());
  const history = result.patch.result.job_state_machine.attempt_history;
  assert.equal(history.length, 1);
  assert.equal(history[0].id, "attempt-a");
  assert.equal(history[0].state, "abandoned");
});

test("production policy contains no historical task hardcoding", () => {
  const productionFiles = [
    path.join(root, "infra", "tencent-worker", "worker_api.js"),
    path.join(root, "infra", "tencent-worker", "worker_job_state_machine.js"),
    path.join(root, "infra", "tencent-worker", "worker_terminal_policy.js"),
    path.join(root, "src", "lib", "worker-jobs.ts"),
    path.join(root, "src", "app", "api", "worker", "next", "route.ts"),
    path.join(root, "src", "app", "api", "worker", "report", "route.ts"),
    path.join(root, "src", "app", "api", "worker", "heartbeat", "route.ts"),
    path.join(root, "src", "app", "api", "worker", "progress", "route.ts"),
  ];
  const source = productionFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /SMOKE-(?:40|44|50)|FIX-51/);
  assert.doesNotMatch(source, /(?:eaaee4df|ef2453ed|3365b4ec|6e06c8f4|3ca92636)-/i);
  assert.doesNotMatch(source, /MANUALLY_CLOSED_WORKER_JOBS|manual_terminal_registry/);
});

test("SMOKE-40 name has no special runtime behavior", () => {
  assert.equal(machine.isJobSelectable(canonicalJob({ state: "queued", claimedBy: null, attempt: false, lease: false, requestText: "SMOKE-40" }), { now: NOW }), true);
});

test("SMOKE-44 name has no special runtime behavior", () => {
  assert.equal(machine.isJobSelectable(canonicalJob({ state: "queued", claimedBy: null, attempt: false, lease: false, requestText: "SMOKE-44" }), { now: NOW }), true);
});

test("FIX-51 name has no special runtime behavior", () => {
  assert.equal(machine.isJobSelectable(canonicalJob({ state: "queued", claimedBy: null, attempt: false, lease: false, requestText: "FIX-51" }), { now: NOW }), true);
});

test("arbitrary historical batch follows only canonical state", () => {
  const named = canonicalJob({ state: "queued", claimedBy: null, attempt: false, lease: false, requestText: "BATCH-HISTORICAL-ANY" });
  const ordinary = canonicalJob({ state: "queued", claimedBy: null, attempt: false, lease: false, requestText: "ordinary" });
  assert.equal(machine.isJobSelectable(named, { now: NOW }), machine.isJobSelectable(ordinary, { now: NOW }));
});

test("terminal retry cannot reactivate", () => {
  const result = machine.recoverStaleAttempt(terminalJob("terminal_failed"), { now: NOW, retry_allowed: true });
  assert.equal(result.patch, null);
  assert.equal(result.terminal_immutable, true);
});

test("terminal stale recovery cannot reactivate", () => {
  const result = recover(terminalJob("terminal_success"));
  assert.equal(result.recovered, false);
  assert.equal(result.patch, null);
});

test("terminal lease expiry cannot reactivate", () => {
  const job = terminalJob("terminal_cancelled", { lease_id: "legacy", expires_at: EXPIRED });
  const result = machine.recoverStaleAttempt(job, { now: NOW, worker_available: false, retry_allowed: true });
  assert.equal(result.patch, null);
  assert.equal(machine.normalizeJobState(job), "terminal_cancelled");
});
