import assert from "node:assert/strict";
import test from "node:test";

const TERMINAL_JOBS = new Set([
  "terminal_success",
  "terminal_failed",
  "terminal_cancelled",
]);
const TERMINAL_ATTEMPTS = new Set([
  "attempt_finished",
  "attempt_failed",
  "attempt_abandoned",
]);

function selectable(snapshot) {
  return snapshot.jobState === "queued"
    && !snapshot.terminal
    && snapshot.claimedBy === null
    && snapshot.activeAttempt === null
    && snapshot.activeLease === null;
}

function validate(snapshot) {
  const errors = [];
  const terminal = TERMINAL_JOBS.has(snapshot.jobState);
  if (snapshot.jobState === "queued" && snapshot.activeAttempt !== null) {
    errors.push("QUEUED_WITH_ACTIVE_ATTEMPT");
  }
  if (snapshot.jobState === "claimed" && snapshot.claimedBy === null) {
    errors.push("CLAIMED_WITHOUT_OWNER");
  }
  if (snapshot.jobState === "running" && snapshot.activeAttempt === null) {
    errors.push("RUNNING_WITHOUT_ACTIVE_ATTEMPT");
  }
  if (terminal && snapshot.selectableProjection === true) errors.push("TERMINAL_SELECTABLE");
  if (terminal && snapshot.retryable) errors.push("TERMINAL_RETRYABLE");
  if (terminal && snapshot.activeLease !== null) errors.push("TERMINAL_WITH_ACTIVE_LEASE");
  return errors;
}

function recoverCrash(snapshot) {
  if (TERMINAL_JOBS.has(snapshot.jobState)) return { ...snapshot, recovered: false };
  assert.equal(snapshot.leaseState, "lease_expired");
  return {
    ...snapshot,
    jobState: "queued",
    terminal: false,
    claimedBy: null,
    activeAttempt: null,
    activeLease: null,
    attemptState: "attempt_abandoned",
    leaseState: "lease_expired",
    recovered: true,
  };
}

function canMutateFromAttempt(snapshot, attemptId) {
  return snapshot.activeAttempt === attemptId
    && !TERMINAL_ATTEMPTS.has(snapshot.attemptState)
    && snapshot.leaseState === "lease_active";
}

function mergeReport(snapshot, report) {
  if (TERMINAL_JOBS.has(snapshot.jobState)) {
    return { snapshot, idempotent: true, applied: false };
  }
  return {
    snapshot: { ...snapshot, jobState: report.effectiveFinalStatus },
    idempotent: false,
    applied: true,
  };
}

function base(overrides = {}) {
  return {
    jobState: "queued",
    terminal: false,
    claimedBy: null,
    activeAttempt: null,
    activeLease: null,
    attemptState: null,
    leaseState: null,
    retryable: false,
    ...overrides,
  };
}

test("queued with an active attempt fails aggregate validation", () => {
  assert.deepEqual(
    validate(base({ activeAttempt: "attempt-old" })),
    ["QUEUED_WITH_ACTIVE_ATTEMPT"]
  );
});

test("terminal jobs can never be selectable", () => {
  const snapshot = base({
    jobState: "terminal_success",
    terminal: true,
    selectableProjection: true,
  });
  assert.equal(selectable(snapshot), false);
  assert.equal(validate(snapshot).includes("TERMINAL_SELECTABLE"), true);
});

test("terminal jobs reject retryable state", () => {
  const errors = validate(base({ jobState: "terminal_failed", terminal: true, retryable: true }));
  assert.equal(errors.includes("TERMINAL_RETRYABLE"), true);
});

test("worker crash recovery abandons the attempt and uses a new future claim", () => {
  const recovered = recoverCrash(base({
    jobState: "running",
    claimedBy: "worker-a",
    activeAttempt: "attempt-a",
    activeLease: "lease-a",
    attemptState: "attempt_running",
    leaseState: "lease_expired",
  }));
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.attemptState, "attempt_abandoned");
  assert.equal(recovered.activeAttempt, null);
  assert.equal(selectable(recovered), true);
});

test("an abandoned stale attempt cannot execute or report again", () => {
  const snapshot = base({
    attemptState: "attempt_abandoned",
    leaseState: "lease_expired",
  });
  assert.equal(canMutateFromAttempt(snapshot, "attempt-old"), false);
});

test("duplicate report cannot change an existing terminal outcome", () => {
  const terminal = base({ jobState: "terminal_failed", terminal: true });
  const merged = mergeReport(terminal, { effectiveFinalStatus: "terminal_success" });
  assert.equal(merged.applied, false);
  assert.equal(merged.idempotent, true);
  assert.equal(merged.snapshot.jobState, "terminal_failed");
});

test("historical SMOKE and FIX terminal records cannot re-enter the queue", () => {
  for (const id of ["SMOKE-40", "SMOKE-44", "MASTER-FAST-FORWARD-46", "SMOKE-50", "FIX-HISTORICAL"]) {
    const terminal = base({ id, jobState: "terminal_failed", terminal: true, leaseState: "lease_expired" });
    const recovered = recoverCrash(terminal);
    assert.equal(recovered.recovered, false);
    assert.equal(recovered.jobState, "terminal_failed");
    assert.equal(selectable(recovered), false);
  }
});
