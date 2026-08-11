import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const cutover = await import("../../../src/lib/hermes/cutover-control.ts");
const orchestration = await import("../../../src/lib/hermes/orchestration-adapter.ts");
const capabilities = await import("../../../src/lib/openclaw/capability-gateway.ts");

const source = (file) => readFileSync(join(root, file), "utf8");
const allowedAdmission = { allowed: true, reason_code: "ALLOW" };

test("production cutover defaults keep Canonical and Shadow off", () => {
  const config = cutover.resolveHermesCanonicalCutoverConfig({ NODE_ENV: "production" });
  assert.equal(config.canonical_enabled, false);
  assert.equal(config.shadow_enabled, false);
  assert.equal(config.legacy_primary, true);
  assert.equal(orchestration.HERMES_CANONICAL_ORCHESTRATION_ENABLED_DEFAULT, false);
});

test("canonical switch can be prepared without changing its default", () => {
  const config = cutover.resolveHermesCanonicalCutoverConfig({
    HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true",
    HERMES_CANONICAL_SHADOW_ENABLED: "false",
  });
  assert.equal(config.canonical_requested, true);
  assert.equal(config.canonical_enabled, true);
  assert.equal(config.legacy_primary, false);
});

test("rollback switch immediately restores Legacy primary", async () => {
  let canonicalCalled = false;
  const result = await cutover.attemptHermesCanonicalCutover({
    env: {
      HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true",
      HERMES_CANONICAL_ROLLBACK_TO_LEGACY: "true",
    },
    async executeCanonical() {
      canonicalCalled = true;
    },
  });
  assert.equal(result.path, "legacy_primary");
  assert.equal(result.reason, "rollback_switch_enabled");
  assert.equal(canonicalCalled, false);
});

test("Canonical and Shadow flag conflict fails closed to Legacy", async () => {
  const result = await cutover.attemptHermesCanonicalCutover({
    env: {
      HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true",
      HERMES_CANONICAL_SHADOW_ENABLED: "true",
    },
    async executeCanonical() {
      throw new Error("must not run");
    },
  });
  assert.equal(result.path, "legacy_primary");
  assert.equal(result.reason, "flag_conflict");
});

test("successful cutover records canonical authoritative writes", async () => {
  const result = await cutover.attemptHermesCanonicalCutover({
    env: { HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true" },
    canaryAdmission: allowedAdmission,
    async executeCanonical(guard) {
      guard.enterAuthoritativeWriteBoundary();
      guard.recordAuthoritativeWrite(2);
      return { jobs: 2 };
    },
  });
  assert.equal(result.path, "canonical_primary");
  assert.equal(result.canonical_authoritative_writes, 2);
  assert.deepEqual(result.canonical_result, { jobs: 2 });
});

test("canonical prewrite failure safely falls back to Legacy", async () => {
  const result = await cutover.attemptHermesCanonicalCutover({
    env: { HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true" },
    canaryAdmission: allowedAdmission,
    async executeCanonical() {
      throw new Error("planner unavailable");
    },
  });
  assert.equal(result.path, "legacy_fallback");
  assert.equal(result.failure_code, "CANONICAL_PREWRITE_FAILURE");
  assert.equal(result.canonical_authoritative_writes, 0);
});

test("canonical failure after an authoritative write cannot fall back", async () => {
  await assert.rejects(
    () => cutover.attemptHermesCanonicalCutover({
      env: { HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true" },
      canaryAdmission: allowedAdmission,
      async executeCanonical(guard) {
        guard.enterAuthoritativeWriteBoundary();
        guard.recordAuthoritativeWrite();
        throw new Error("second subtask failed");
      },
    }),
    /CANONICAL_CUTOVER_PARTIAL_WRITE_FAIL_CLOSED/
  );
});

test("global Canonical flag alone cannot enter the Canonical executor", async () => {
  let canonicalCalled = false;
  const result = await cutover.attemptHermesCanonicalCutover({
    env: { HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true" },
    async executeCanonical() { canonicalCalled = true; },
  });
  assert.equal(result.path, "legacy_primary");
  assert.equal(result.reason, "canary_admission_denied");
  assert.equal(result.canonical_authoritative_writes, 0);
  assert.equal(canonicalCalled, false);
});

test("Feishu production path uses guarded cutover and canonicalCreateJob", () => {
  const route = source("src/app/api/feishu/event/route.ts");
  assert.match(route, /attemptHermesCanonicalCutover\(\{/);
  assert.match(route, /runApprovedRequestThroughCanonicalHermes\(/);
  assert.match(route, /canonicalCreateJob\(supabase/);
  assert.equal((route.match(/writeGuard\.enterAuthoritativeWriteBoundary\(\)/g) || []).length, 2);
  assert.equal(
    (route.match(/writeGuard\.enterAuthoritativeWriteBoundary\(\);\s*const created = await canonicalCreateJob\(supabase/g) || []).length,
    2
  );
  assert.match(route, /writeGuard\.recordAuthoritativeWrite\(created\.insertedCount\)/);
  assert.match(route, /canonicalCutover\.path === "canonical_primary"/);
});

async function runCutoverWithLegacy(executeCanonical, options = {}) {
  const state = { legacy_creator_calls: 0 };
  const result = await cutover.attemptHermesCanonicalCutover({
    env: options.env ?? { HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true" },
    canaryAdmission: options.canaryAdmission ?? allowedAdmission,
    executeCanonical,
  });
  if (result.path !== "canonical_primary") state.legacy_creator_calls += 1;
  return { result, state };
}

test("commit success and response success stays Canonical with zero Legacy calls", async () => {
  const order = [];
  const { result, state } = await runCutoverWithLegacy(async (guard) => {
    guard.enterAuthoritativeWriteBoundary();
    order.push("enter_boundary");
    order.push("canonical_rpc");
    guard.recordAuthoritativeWrite();
    return { job_id: "job-1" };
  });
  assert.deepEqual(order, ["enter_boundary", "canonical_rpc"]);
  assert.equal(result.path, "canonical_primary");
  assert.equal(result.canonical_authoritative_boundary_entered, true);
  assert.equal(state.legacy_creator_calls, 0);
});

test("commit success with response lost fails closed before Legacy", async () => {
  let databaseCommitted = false;
  let legacyCreatorCalls = 0;
  await assert.rejects(
    async () => {
      const result = await cutover.attemptHermesCanonicalCutover({
        env: { HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true" },
        canaryAdmission: allowedAdmission,
        async executeCanonical(guard) {
          guard.enterAuthoritativeWriteBoundary();
          databaseCommitted = true;
          throw new Error("response lost after commit");
        },
      });
      if (result.path !== "canonical_primary") legacyCreatorCalls += 1;
    },
    /CANONICAL_AUTHORITATIVE_WRITE_OUTCOME_UNKNOWN/
  );
  assert.equal(databaseCommitted, true);
  assert.equal(legacyCreatorCalls, 0);
});

for (const [name, error] of [
  ["timeout outcome unknown", new Error("RPC timeout")],
  ["transport failure outcome unknown", new TypeError("fetch failed")],
  ["explicit RPC rejection after boundary", new Error("RPC rejected")],
]) {
  test(`${name} fails closed with zero Legacy calls`, async () => {
    let legacyCreatorCalls = 0;
    await assert.rejects(
      async () => {
        const result = await cutover.attemptHermesCanonicalCutover({
          env: { HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true" },
          canaryAdmission: allowedAdmission,
          async executeCanonical(guard) {
            guard.enterAuthoritativeWriteBoundary();
            throw error;
          },
        });
        if (result.path !== "canonical_primary") legacyCreatorCalls += 1;
      },
      /CANONICAL_AUTHORITATIVE_WRITE_OUTCOME_UNKNOWN/
    );
    assert.equal(legacyCreatorCalls, 0);
  });
}

test("scope deny remains before the write boundary and preserves Legacy policy", async () => {
  let canonicalRpcCalls = 0;
  const { result, state } = await runCutoverWithLegacy(
    async () => { canonicalRpcCalls += 1; },
    { canaryAdmission: { allowed: false, reason_code: "OWNER_NOT_ALLOWED" } }
  );
  assert.equal(result.reason, "canary_admission_denied");
  assert.equal(result.canonical_authoritative_boundary_entered, false);
  assert.equal(canonicalRpcCalls, 0);
  assert.equal(state.legacy_creator_calls, 1);
});

test("global Canonical disabled never enters the boundary and preserves Legacy", async () => {
  let canonicalRpcCalls = 0;
  const { result, state } = await runCutoverWithLegacy(
    async () => { canonicalRpcCalls += 1; },
    { env: {}, canaryAdmission: allowedAdmission }
  );
  assert.equal(result.reason, "canonical_disabled");
  assert.equal(result.canonical_authoritative_boundary_entered, false);
  assert.equal(canonicalRpcCalls, 0);
  assert.equal(state.legacy_creator_calls, 1);
});

test("same-event external retry remains Canonical and idempotent", async () => {
  const durable = { job_id: null };
  let legacyCreatorCalls = 0;
  async function invoke() {
    const result = await cutover.attemptHermesCanonicalCutover({
      env: { HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true" },
      canaryAdmission: allowedAdmission,
      async executeCanonical(guard) {
        guard.enterAuthoritativeWriteBoundary();
        const idempotent = durable.job_id !== null;
        durable.job_id ??= "job-stable";
        guard.recordAuthoritativeWrite(idempotent ? 0 : 1);
        return { job_id: durable.job_id, idempotent };
      },
    });
    if (result.path !== "canonical_primary") legacyCreatorCalls += 1;
    return result;
  }
  const first = await invoke();
  const retry = await invoke();
  assert.equal(first.canonical_result.job_id, retry.canonical_result.job_id);
  assert.equal(retry.canonical_result.idempotent, true);
  assert.equal(legacyCreatorCalls, 0);
});

test("Windows and Tencent Worker protocols carry canonical ownership identity", () => {
  const windowsWorker = source("infra/windows-worker/local_worker.js");
  const tencentPersistence = source("infra/tencent-worker/worker_canonical_persistence.js");
  for (const field of ["attempt_id", "lease_id", "canonical_revision"]) {
    assert.match(windowsWorker, new RegExp(field));
    assert.match(tencentPersistence, new RegExp(field));
  }
  assert.match(windowsWorker, /lease_expires_at|lease_expiry/);
  assert.match(tencentPersistence, /expected_revision/);
});

test("terminal first truth remains immutable after cutover preparation", () => {
  const finalizer = source("infra/tencent-worker/worker_terminal_finalizer.js");
  const reportRoute = source("src/app/api/worker/report/route.ts");
  const migration = source("supabase/migrations/202608030001_canonical_attempt_lease_foundation.sql");
  assert.match(finalizer, /terminal_immutable:\s*true/);
  assert.match(migration, /hermes_job_terminals_first_truth_per_job/);
  assert.match(reportRoute, /finalizeCanonicalPersistenceJobSafely/);
  assert.match(reportRoute, /finalizeCanonicalJobReportSafely/);
});

test("OpenClaw production gateway is capability-only and default-disabled", async () => {
  assert.equal(capabilities.OPENCLAW_CAPABILITY_GATEWAY_ENABLED_DEFAULT, false);
  const disabled = capabilities.createProductionCapabilityGateway({});
  assert.equal(disabled instanceof capabilities.RegistryCapabilityGateway, true);

  const gateway = capabilities.createProductionCapabilityGateway({
    OPENCLAW_CAPABILITY_GATEWAY_ENABLED: "true",
  });
  assert.equal(gateway.gateway_role, "openclaw_production_capability_gateway");
  assert.equal(gateway.direct_worker_access, false);
  assert.equal(gateway.direct_database_access, false);
  assert.equal(gateway.state_machine_present, false);
  const resolution = await gateway.resolveAgentCapabilities({
    required_capabilities: ["test"],
    execution_intent: "verification",
    requested_mode: "worker_read_only",
  });
  assert.equal(resolution.selected_agent, "test_agent");
});

test("rollback plan preserves canonical history without destructive reversal", () => {
  const rollback = source("docs/architecture/hermes-canonical-cutover-rollback.md");
  assert.match(rollback, /HERMES_CANONICAL_ROLLBACK_TO_LEGACY=true/);
  assert.match(rollback, /Preserve all canonical Job, Attempt, Lease, and Terminal records/);
  assert.match(rollback, /Do not delete attempts, leases, terminals, or canonical jobs/);
  assert.match(rollback, /Do not run a reverse migration or destructive schema rollback/);
});

test("cutover preparation does not hard-code production enable", () => {
  const control = source("src/lib/hermes/cutover-control.ts");
  const route = source("src/app/api/feishu/event/route.ts");
  assert.doesNotMatch(control, /HERMES_CANONICAL_ORCHESTRATION_ENABLED\s*=\s*["']true/);
  assert.doesNotMatch(route, /HERMES_CANONICAL_ORCHESTRATION_ENABLED\s*=\s*["']true/);
});
