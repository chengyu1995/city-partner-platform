import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const admission = await import(
  "../../../src/lib/hermes/worker-requested-mode-admission.ts"
);
const workerNextSource = readFileSync(
  join(root, "src/app/api/worker/next/route.ts"),
  "utf8"
);
const workerJobsSource = readFileSync(join(root, "src/lib/worker-jobs.ts"), "utf8");

function policy(value) {
  const env = value === undefined
    ? {}
    : { HERMES_WORKER_ALLOWED_REQUESTED_MODES: value };
  return admission.resolveWorkerRequestedModeAdmissionPolicy(env);
}

test("unconfigured policy preserves legacy compatibility", () => {
  const resolved = policy(undefined);
  assert.equal(resolved.configured, false);
  assert.equal(resolved.enforced, false);
  assert.equal(resolved.valid, true);
  assert.equal(resolved.reason_code, "LEGACY_COMPATIBILITY");
  assert.equal(admission.workerRequestedModeAllowed({ requested_mode: "write_allowed" }, resolved), true);
  assert.equal(admission.workerRequestedModeAllowed({}, resolved), true);
});

test("worker_read_only allowlist excludes write, unknown, and missing modes", () => {
  const resolved = policy("worker_read_only");
  assert.equal(resolved.enforced, true);
  assert.equal(resolved.valid, true);
  assert.deepEqual(resolved.allowed_modes, ["worker_read_only"]);
  assert.equal(admission.workerRequestedModeAllowed({ requested_mode: "worker_read_only" }, resolved), true);
  for (const requested_mode of ["write_allowed", "manager_read_only", "unknown", null]) {
    assert.equal(
      admission.workerRequestedModeAllowed({ requested_mode }, resolved),
      false,
      String(requested_mode)
    );
  }
  assert.equal(admission.workerRequestedModeAllowed({}, resolved), false);
});

test("empty and malformed allowlists fail closed without exposing raw values", () => {
  for (const value of [
    "",
    "worker_read_only,",
    "worker_read_only,worker_read_only",
    " worker_read_only",
    "worker_read_only ",
    "unknown",
  ]) {
    const resolved = policy(value);
    assert.equal(resolved.enforced, true, value);
    assert.equal(resolved.valid, false, value);
    assert.deepEqual(resolved.allowed_modes, [], value);
    assert.equal(
      admission.workerRequestedModeAllowed({ requested_mode: "worker_read_only" }, resolved),
      false,
      value
    );
    assert.equal(JSON.stringify(resolved).includes(value) && value !== "", false, value);
  }
});

test("supported multi-mode allowlists use exact matching", () => {
  const resolved = policy("manager_read_only,worker_read_only");
  assert.equal(resolved.valid, true);
  assert.equal(admission.workerRequestedModeAllowed({ requested_mode: "manager_read_only" }, resolved), true);
  assert.equal(admission.workerRequestedModeAllowed({ requested_mode: "worker_read_only" }, resolved), true);
  assert.equal(admission.workerRequestedModeAllowed({ requested_mode: "write_allowed" }, resolved), false);
});

test("worker next applies query, candidate, and pre-claim admission barriers", () => {
  assert.match(workerNextSource, /queuedJobsQuery\.in\("requested_mode"/);
  assert.match(workerNextSource, /workerRequestedModeAllowed\(queuedJob, requestedModePolicy\)/);
  assert.match(workerNextSource, /workerRequestedModeAllowed\(preClaimJob \?\? job, requestedModePolicy\)/);
  assert.match(workerNextSource, /requested_mode: readWorkerRequestedMode\(preClaimJob \?\? job\)/);
  assert.match(workerNextSource, /requested_mode_policy_invalid/);
});

test("claim compare-and-set and Canonical selection enforce the same mode policy", () => {
  assert.match(workerJobsSource, /query = query\.eq\("requested_mode", expected\.requested_mode\)/);
  assert.match(workerJobsSource, /query = query\.in\("requested_mode", \[\.\.\.requestedModePolicy\.allowed_modes\]\)/);
  assert.match(workerJobsSource, /workerRequestedModeAllowed\(candidate, requestedModePolicy\)/);
  assert.match(workerJobsSource, /canonicalCanaryAdmissionAllowsWorkerClaim\(candidate\)/);
});
