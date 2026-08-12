import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const core = await import("../../tencent-worker/canonical-canary-scope-core.js");
const boundary = await import("../../../src/lib/feishu-application-boundary.ts");
const cutover = await import("../../../src/lib/hermes/cutover-control.ts");
const jobInsert = await import("../../../src/lib/hermes/canonical-job-insert-contract.ts");
const tencentPersistence = await import("../../tencent-worker/worker_canonical_persistence.js");
const workerJobsSource = readFileSync(join(root, "src/lib/worker-jobs.ts"), "utf8");
const migrationSource = readFileSync(join(root, "supabase/migrations/202608110001_canonical_canary_admission_control.sql"), "utf8");

const OWNER = "ou_owner123";
const BATCH = "BATCH-ARCH-COMPLETE-03C-3B-CANARY-01";
const POLICY = "CANARY-01";

function env(overrides = {}) {
  return {
    HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true",
    CANONICAL_DATABASE_PERSISTENCE_ENABLED: "true",
    HERMES_CANONICAL_CANARY_SCOPE_ENABLED: "true",
    HERMES_CANONICAL_CANARY_DURABLE_ADMISSION_ENABLED: "true",
    HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS: OWNER,
    HERMES_CANONICAL_CANARY_ALLOWED_BATCH_CODES: BATCH,
    HERMES_CANONICAL_CANARY_ALLOWED_MODES: "worker_read_only",
    HERMES_CANONICAL_CANARY_POLICY_ID: POLICY,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    trusted_owner_id: OWNER,
    batch_code: BATCH,
    requested_mode: "worker_read_only",
    event_id: "event-1",
    request_id: "message-1",
    ...overrides,
  };
}

function canonicalRow(overrides = {}) {
  return {
    source: "hermes_canonical_orchestration",
    title: "Inspect package metadata",
    request_text: "Inspect package metadata\n\nRead package.json and report its name.",
    requested_mode: "worker_read_only",
    plan_id: "plan-1",
    subtask_id: "subtask-1",
    payload: {
      canonical_runtime: true,
      plan_id: "plan-1",
      subtask_id: "subtask-1",
    },
    result: { job_state: "queued" },
    ...overrides,
  };
}

function admission(overrides = {}) {
  return {
    policy_id: POLICY,
    trusted_owner_id: OWNER,
    batch_code: BATCH,
    requested_mode: "worker_read_only",
    event_id: "event-1",
    request_id: "message-1",
    ...overrides,
  };
}

test("scope environment contract is explicit and server controlled", () => {
  assert.deepEqual(Object.values(core.CANONICAL_CANARY_ENV), [
    "HERMES_CANONICAL_ORCHESTRATION_ENABLED",
    "CANONICAL_DATABASE_PERSISTENCE_ENABLED",
    "HERMES_CANONICAL_CANARY_SCOPE_ENABLED",
    "HERMES_CANONICAL_CANARY_DURABLE_ADMISSION_ENABLED",
    "HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS",
    "HERMES_CANONICAL_CANARY_ALLOWED_BATCH_CODES",
    "HERMES_CANONICAL_CANARY_ALLOWED_MODES",
    "HERMES_CANONICAL_CANARY_POLICY_ID",
  ]);
});

test("DENY reason taxonomy exposes distinct configuration mismatch and durable classes", () => {
  const reasons = core.CANONICAL_CANARY_DENY_REASON_CODES;
  assert.equal(new Set(reasons).size, reasons.length);
  for (const reason of [
    "MISSING_CONFIGURATION",
    "MALFORMED_CONFIGURATION",
    "EMPTY_OWNER_ALLOWLIST",
    "EMPTY_BATCH_ALLOWLIST",
    "EMPTY_MODE_ALLOWLIST",
    "OWNER_NOT_ALLOWED",
    "BATCH_NOT_ALLOWED",
    "MODE_NOT_ALLOWED",
    "POLICY_MISMATCH",
    "DURABLE_ADMISSION_REJECTED",
    "CANARY_ALREADY_CONSUMED",
  ]) {
    assert.equal(reasons.includes(reason), true, reason);
  }
});

test("global flag alone cannot route Canonical", () => {
  const route = boundary.resolveFeishuApplicationFeatureRoute({
    HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true",
  });
  assert.equal(route.canonical_enabled, false);
  assert.equal(route.legacy_primary, true);
});

test("all exact server-side prerequisites allow worker_read_only", () => {
  const decision = core.evaluateCanonicalCanaryAdmission(candidate(), env());
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason_code, "ALLOW");
  assert.equal(decision.one_shot_available, true);
  assert.equal(decision.admission.trusted_owner_id, OWNER);
});

test("missing scope configuration defaults deny", () => {
  for (const key of [
    "HERMES_CANONICAL_CANARY_SCOPE_ENABLED",
    "HERMES_CANONICAL_CANARY_DURABLE_ADMISSION_ENABLED",
    "HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS",
    "HERMES_CANONICAL_CANARY_ALLOWED_BATCH_CODES",
    "HERMES_CANONICAL_CANARY_ALLOWED_MODES",
    "HERMES_CANONICAL_CANARY_POLICY_ID",
  ]) {
    const inputEnv = env();
    delete inputEnv[key];
    assert.equal(core.evaluateCanonicalCanaryAdmission(candidate(), inputEnv).allowed, false, key);
  }
});

test("missing configuration has a distinct reason and private policy correlation", () => {
  for (const key of [
    "HERMES_CANONICAL_CANARY_SCOPE_ENABLED",
    "HERMES_CANONICAL_CANARY_DURABLE_ADMISSION_ENABLED",
    "HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS",
    "HERMES_CANONICAL_CANARY_ALLOWED_BATCH_CODES",
    "HERMES_CANONICAL_CANARY_ALLOWED_MODES",
    "HERMES_CANONICAL_CANARY_POLICY_ID",
  ]) {
    const inputEnv = env();
    delete inputEnv[key];
    const decision = core.evaluateCanonicalCanaryAdmission(candidate(), inputEnv);
    const record = core.buildCanonicalCanaryAuditRecord(decision);
    assert.equal(decision.reason_code, "MISSING_CONFIGURATION", key);
    assert.match(record.policy_correlation_hash, /^[a-f0-9]{32}$/);
    assert.equal(record.policy_correlation_source, "SERVER_SIDE_CONFIG_CANDIDATE");
    assert.equal(decision.admission, null);
    if (key === "HERMES_CANONICAL_CANARY_POLICY_ID") assert.equal(record.policy_id, null);
  }
});

test("malformed configuration has a distinct reason and no raw config", () => {
  const malformed = [
    ["HERMES_CANONICAL_CANARY_SCOPE_ENABLED", "TRUE"],
    ["HERMES_CANONICAL_CANARY_DURABLE_ADMISSION_ENABLED", "enabled"],
    ["HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS", `${OWNER},`],
    ["HERMES_CANONICAL_CANARY_ALLOWED_BATCH_CODES", ` ${BATCH}`],
    ["HERMES_CANONICAL_CANARY_ALLOWED_MODES", "worker_read_only,write_allowed"],
    ["HERMES_CANONICAL_CANARY_POLICY_ID", "raw malformed policy"],
  ];
  for (const [key, value] of malformed) {
    const decision = core.evaluateCanonicalCanaryAdmission(candidate(), env({ [key]: value }));
    const record = core.buildCanonicalCanaryAuditRecord(decision);
    assert.equal(decision.reason_code, "MALFORMED_CONFIGURATION", `${key}=${value}`);
    assert.match(record.policy_correlation_hash, /^[a-f0-9]{32}$/);
    if (key === "HERMES_CANONICAL_CANARY_POLICY_ID") assert.equal(record.policy_id, null);
    assert.equal(JSON.stringify(record).includes(value), false);
  }
});

test("empty allowlists have field-specific reasons and policy correlation", () => {
  for (const [key, reason] of [
    ["HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS", "EMPTY_OWNER_ALLOWLIST"],
    ["HERMES_CANONICAL_CANARY_ALLOWED_BATCH_CODES", "EMPTY_BATCH_ALLOWLIST"],
    ["HERMES_CANONICAL_CANARY_ALLOWED_MODES", "EMPTY_MODE_ALLOWLIST"],
  ]) {
    const decision = core.evaluateCanonicalCanaryAdmission(candidate(), env({ [key]: "" }));
    const record = core.buildCanonicalCanaryAuditRecord(decision);
    assert.equal(decision.reason_code, reason);
    assert.equal(record.policy_id, POLICY);
    assert.match(record.policy_correlation_hash, /^[a-f0-9]{32}$/);
  }
});

test("scope disabled remains distinct and correlated without admission", () => {
  const decision = core.evaluateCanonicalCanaryAdmission(
    candidate(),
    env({ HERMES_CANONICAL_CANARY_SCOPE_ENABLED: "false" })
  );
  const record = core.buildCanonicalCanaryAuditRecord(decision);
  assert.equal(decision.reason_code, "CANARY_SCOPE_DISABLED");
  assert.equal(decision.admission, null);
  assert.equal(record.policy_id, POLICY);
  assert.match(record.policy_correlation_hash, /^[a-f0-9]{32}$/);
});

test("empty and malformed allowlists fail closed", () => {
  const malformed = [
    ["HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS", ""],
    ["HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS", `${OWNER},`],
    ["HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS", `${OWNER},${OWNER}`],
    ["HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS", "owner123"],
    ["HERMES_CANONICAL_CANARY_ALLOWED_BATCH_CODES", ` ${BATCH}`],
    ["HERMES_CANONICAL_CANARY_ALLOWED_BATCH_CODES", "batch-canary-01"],
    ["HERMES_CANONICAL_CANARY_ALLOWED_MODES", "worker_read_only,write_allowed"],
    ["HERMES_CANONICAL_CANARY_POLICY_ID", "canary 01"],
  ];
  for (const [key, value] of malformed) {
    const decision = core.evaluateCanonicalCanaryAdmission(candidate(), env({ [key]: value }));
    assert.equal(decision.allowed, false, `${key}=${value}`);
  }
});

test("owner allowlist uses case-sensitive exact matching", () => {
  for (const owner of [`${OWNER}x`, `x${OWNER}`, OWNER.toUpperCase(), ` ${OWNER}`, OWNER.slice(0, -1)]) {
    const decision = core.evaluateCanonicalCanaryAdmission(candidate({ trusted_owner_id: owner }), env());
    assert.equal(decision.allowed, false, owner);
    assert.equal(decision.reason_code, "OWNER_NOT_ALLOWED");
  }
});

test("message-declared batch still requires exact server allowlist equality", () => {
  for (const batch of [`${BATCH}0`, `foo-${BATCH}`, BATCH.toLowerCase(), ` ${BATCH}`, BATCH.slice(0, -1)]) {
    const decision = core.evaluateCanonicalCanaryAdmission(candidate({ batch_code: batch }), env());
    assert.equal(decision.allowed, false, batch);
    assert.equal(decision.reason_code, "BATCH_NOT_ALLOWED");
  }
});

test("write_allowed, manager_read_only, and unknown modes are denied", () => {
  for (const mode of ["write_allowed", "manager_read_only", "unknown", null]) {
    const decision = core.evaluateCanonicalCanaryAdmission(candidate({ requested_mode: mode }), env());
    assert.equal(decision.allowed, false, String(mode));
    assert.equal(decision.reason_code, "MODE_NOT_ALLOWED");
  }
});

test("Application and persistence policy id mismatch is denied", () => {
  const decision = core.evaluateCanonicalCanaryAdmission(
    candidate({ expected_policy_id: "CANARY-02" }),
    env()
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason_code, "POLICY_MISMATCH");
});

test("scope miss executes zero Canonical writes", async () => {
  let writes = 0;
  const decision = core.evaluateCanonicalCanaryAdmission(candidate({ trusted_owner_id: "ou_other" }), env());
  const result = await cutover.attemptHermesCanonicalCutover({
    env: env(),
    canaryAdmission: decision,
    async executeCanonical(guard) { guard.recordAuthoritativeWrite(); writes += 1; },
  });
  assert.equal(result.path, "legacy_primary");
  assert.equal(result.canonical_authoritative_writes, 0);
  assert.equal(writes, 0);
});

test("audit record hashes trusted identities and emits no raw owner or event", () => {
  const record = core.buildCanonicalCanaryAuditRecord(
    core.evaluateCanonicalCanaryAdmission(candidate(), env())
  );
  assert.equal(record.allowed, true);
  assert.equal(record.policy_id, POLICY);
  assert.notEqual(record.owner_id_hash, OWNER);
  assert.notEqual(record.event_id_hash, "event-1");
  assert.equal(JSON.stringify(record).includes(OWNER), false);
});

test("DENY audit preserves pseudonymous owner batch mode and event correlation", () => {
  const candidates = [
    candidate({ trusted_owner_id: "ou_wrong", event_id: "event-denied" }),
    candidate({ batch_code: "BATCH-DENIED", event_id: "event-denied" }),
    candidate({ requested_mode: "write_allowed", event_id: "event-denied" }),
  ];
  const records = candidates.map((value) => core.buildCanonicalCanaryAuditRecord(
    core.evaluateCanonicalCanaryAdmission(value, env())
  ));
  for (const record of records) {
    assert.match(record.owner_id_hash, /^[a-f0-9]{16}$/);
    assert.match(record.batch_code_hash, /^[a-f0-9]{16}$/);
    assert.match(record.event_id_hash, /^[a-f0-9]{16}$/);
    assert.match(record.requested_mode_hash, /^[a-f0-9]{16}$/);
  }
  assert.equal(records[0].event_id_hash, records[1].event_id_hash);
  assert.equal(records[1].event_id_hash, records[2].event_id_hash);
});

test("policy and malformed configuration DENY records retain candidate hashes", () => {
  for (const inputEnv of [
    env({ HERMES_CANONICAL_CANARY_SCOPE_ENABLED: "false" }),
    env({ HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS: "" }),
    env({ HERMES_CANONICAL_CANARY_POLICY_ID: "CANARY-02" }),
  ]) {
    const value = candidate({ expected_policy_id: POLICY });
    const record = core.buildCanonicalCanaryAuditRecord(core.evaluateCanonicalCanaryAdmission(value, inputEnv));
    assert.match(record.owner_id_hash, /^[a-f0-9]{16}$/);
    assert.match(record.batch_code_hash, /^[a-f0-9]{16}$/);
    assert.match(record.event_id_hash, /^[a-f0-9]{16}$/);
    assert.match(record.policy_correlation_hash, /^[a-f0-9]{32}$/);
  }
});

test("mismatch reasons remain distinct and share the evaluated policy correlation", () => {
  const decisions = [
    core.evaluateCanonicalCanaryAdmission(candidate({ trusted_owner_id: "ou_other" }), env()),
    core.evaluateCanonicalCanaryAdmission(candidate({ batch_code: "BATCH-OTHER" }), env()),
    core.evaluateCanonicalCanaryAdmission(candidate({ requested_mode: "write_allowed" }), env()),
    core.evaluateCanonicalCanaryAdmission(candidate({ expected_policy_id: "CANARY-02" }), env()),
  ];
  assert.deepEqual(decisions.map((decision) => decision.reason_code), [
    "OWNER_NOT_ALLOWED",
    "BATCH_NOT_ALLOWED",
    "MODE_NOT_ALLOWED",
    "POLICY_MISMATCH",
  ]);
  assert.equal(new Set(decisions.map((decision) => decision.audit_context.policy_correlation_hash)).size, 1);
});

test("policy and candidate audit hashes are deterministic and context-sensitive", () => {
  const first = core.evaluateCanonicalCanaryAdmission(candidate(), env()).audit_context;
  const repeated = core.evaluateCanonicalCanaryAdmission(candidate(), env()).audit_context;
  const otherOwner = core.evaluateCanonicalCanaryAdmission(candidate({ trusted_owner_id: "ou_other" }), env()).audit_context;
  const otherEvent = core.evaluateCanonicalCanaryAdmission(candidate({ event_id: "event-2" }), env()).audit_context;
  const otherPolicyConfig = core.evaluateCanonicalCanaryAdmission(
    candidate(),
    env({ HERMES_CANONICAL_CANARY_ALLOWED_BATCH_CODES: `${BATCH},BATCH-OTHER` })
  ).audit_context;
  assert.deepEqual(first, repeated);
  assert.notEqual(first.owner_id_hash, otherOwner.owner_id_hash);
  assert.notEqual(first.event_id_hash, otherEvent.event_id_hash);
  assert.notEqual(first.policy_correlation_hash, otherPolicyConfig.policy_correlation_hash);
});

test("DENY audit omits raw candidate and malformed server configuration values", () => {
  const value = candidate({
    trusted_owner_id: "ou_private_owner",
    event_id: "event-private",
    request_id: "message-private",
  });
  const privateConfig = "ou_private_config,";
  const secretValues = ["feishu-app-secret-private", "verification-token-private", "supabase-key-private"];
  const record = core.buildCanonicalCanaryAuditRecord(core.evaluateCanonicalCanaryAdmission(
    value,
    env({
      HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS: privateConfig,
      FEISHU_APP_SECRET: secretValues[0],
      FEISHU_VERIFICATION_TOKEN: secretValues[1],
      SUPABASE_SERVICE_ROLE_KEY: secretValues[2],
    })
  ));
  const serialized = JSON.stringify(record);
  for (const raw of [value.trusted_owner_id, value.event_id, value.request_id, value.batch_code, privateConfig, ...secretValues]) {
    assert.equal(serialized.includes(raw), false, raw);
  }
  assert.deepEqual(Object.keys(record).sort(), [
    "allowed",
    "batch_code_hash",
    "event",
    "event_id_hash",
    "owner_id_hash",
    "policy_correlation_hash",
    "policy_correlation_source",
    "policy_id",
    "reason_code",
    "request_id_hash",
    "requested_mode",
    "requested_mode_hash",
  ]);
});

test("DENY audit never exposes raw owner event request or batch", () => {
  const value = candidate({ trusted_owner_id: "ou_denied_owner", event_id: "event-secret", request_id: "message-secret" });
  const record = core.buildCanonicalCanaryAuditRecord(core.evaluateCanonicalCanaryAdmission(value, env()));
  const serialized = JSON.stringify(record);
  for (const raw of [value.trusted_owner_id, value.event_id, value.request_id, value.batch_code]) {
    assert.equal(serialized.includes(raw), false, raw);
  }
});

test("durable admission rejection has the same private correlation contract", () => {
  const evidence = admission({ event_id: "event-second", request_id: "message-second" });
  const record = core.buildCanonicalCanaryPersistenceAuditRecord(evidence, {
    allowed: false,
    reason_code: "CANARY_ALREADY_CONSUMED",
  });
  assert.equal(record.reason_code, "CANARY_ALREADY_CONSUMED");
  assert.match(record.owner_id_hash, /^[a-f0-9]{16}$/);
  assert.match(record.batch_code_hash, /^[a-f0-9]{16}$/);
  assert.match(record.event_id_hash, /^[a-f0-9]{16}$/);
  assert.match(record.policy_correlation_hash, /^[a-f0-9]{32}$/);
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes(evidence.trusted_owner_id), false);
  assert.equal(serialized.includes(evidence.event_id), false);
  assert.match(workerJobsSource, /buildCanonicalCanaryPersistenceAuditRecord\(admission/);
  assert.match(workerJobsSource, /CANONICAL_AUTHORITATIVE_WRITE_OUTCOME_UNKNOWN/);
  const canonicalCreateBlock = workerJobsSource.slice(
    workerJobsSource.indexOf("export async function canonicalCreateJob"),
    workerJobsSource.indexOf("export interface CanonicalWorkerProtocolResult")
  );
  assert.doesNotMatch(canonicalCreateBlock, /error\.(?:message|details|hint)/);
});

test("generic durable rejection and already-consumed scope use distinct reasons", () => {
  const evidence = admission();
  const generic = core.buildCanonicalCanaryPersistenceAuditRecord(evidence, { allowed: false });
  const consumed = core.buildCanonicalCanaryPersistenceAuditRecord(evidence, {
    allowed: false,
    reason_code: "CANARY_ALREADY_CONSUMED",
  });
  assert.equal(generic.reason_code, "DURABLE_ADMISSION_REJECTED");
  assert.equal(consumed.reason_code, "CANARY_ALREADY_CONSUMED");
  assert.equal(generic.policy_correlation_hash, consumed.policy_correlation_hash);
});

test("Worker claim defense requires the same exact policy", () => {
  const job = {
    result: {
      canonical_context: {
        canonical_canary_admission: {
          policy_id: POLICY,
          trusted_owner_id: OWNER,
          batch_code: BATCH,
          requested_mode: "worker_read_only",
          event_id: "event-1",
          request_id: "message-1",
        },
      },
    },
  };
  assert.equal(tencentPersistence.canaryAdmissionAllowsClaim(job, env()), true);
  assert.equal(tencentPersistence.canaryAdmissionAllowsClaim(job, env({ HERMES_CANONICAL_CANARY_POLICY_ID: "CANARY-02" })), false);
  assert.match(workerJobsSource, /canonicalCanaryAdmissionAllowsWorkerClaim/);
  assert.match(workerJobsSource, /if \(!canonicalCanaryAdmissionAllowsWorkerClaim\(candidate\)\) continue/);
});

test("direct persistence bypass is denied by the service-role RPC result", async () => {
  const sql = readFileSync(join(root, "supabase/migrations/202608110001_canonical_canary_admission_control.sql"), "utf8");
  assert.match(workerJobsSource, /supabase\.rpc\("canonical_admit_canary_job"/);
  assert.match(workerJobsSource, /CANONICAL_CANARY_PERSISTENCE_DENIED/);
  assert.match(sql, /return jsonb_build_object\('allowed', false, 'reason_code', 'POLICY_MISMATCH'\)/);
});

test("same-event persistence retry returns the existing job without another write", async () => {
  const sql = readFileSync(join(root, "supabase/migrations/202608110001_canonical_canary_admission_control.sql"), "utf8");
  assert.match(sql, /if v_admission\.event_id <> p_event_id[\s\S]*CANARY_ALREADY_CONSUMED/i);
  assert.match(sql, /if v_admission\.job_id is not null[\s\S]*ALLOW_IDEMPOTENT_RETRY/i);
  assert.match(workerJobsSource, /insertedCount: result\.idempotent === true \? 0 : 1/);
});

test("migration defines atomic one-shot, same-event idempotency, and service-role-only RPC", () => {
  const sql = readFileSync(join(root, "supabase/migrations/202608110001_canonical_canary_admission_control.sql"), "utf8");
  assert.match(sql, /hermes_canonical_canary_one_scope_once[\s\S]*unique \(policy_id, owner_open_id, batch_code, requested_mode\)/i);
  assert.match(sql, /hermes_canonical_canary_same_event_idempotent[\s\S]*unique \(policy_id, event_id\)/i);
  assert.match(sql, /on conflict on constraint hermes_canonical_canary_one_scope_once do nothing/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /CANARY_ALREADY_CONSUMED/);
  assert.match(sql, /ALLOW_IDEMPOTENT_RETRY/);
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function[\s\S]*to service_role/i);
});

test("two distinct concurrent events have one simulated durable winner", async () => {
  let consumedEvent = null;
  let winnerCount = 0;
  async function atomicAdmit(eventId) {
    await Promise.resolve();
    if (consumedEvent === null) {
      consumedEvent = eventId;
      winnerCount += 1;
      return "ALLOW";
    }
    return consumedEvent === eventId ? "ALLOW_IDEMPOTENT_RETRY" : "CANARY_ALREADY_CONSUMED";
  }
  const results = await Promise.all([atomicAdmit("event-a"), atomicAdmit("event-b")]);
  assert.equal(winnerCount, 1);
  assert.equal(results.filter((value) => value === "ALLOW").length, 1);
  assert.equal(results.filter((value) => value === "CANARY_ALREADY_CONSUMED").length, 1);
});

test("route evaluates trusted sender admission before both Canonical cutovers", () => {
  const route = readFileSync(join(root, "src/app/api/feishu/event/route.ts"), "utf8");
  assert.match(route, /const userId = ev\.sender\.sender_id\.open_id/);
  assert.equal((route.match(/evaluateCanonicalCanaryAdmission\(\{/g) || []).length, 2);
  assert.equal((route.match(/canaryAdmission,\s*executeCanonical/g) || []).length, 2);
  assert.match(route, /buildCanonicalCanaryAuditRecord\(canaryAdmission\)/);
});

test("Thin Gateway remains transport-only and owns no Canary admission", () => {
  const gateway = readFileSync(join(root, "infra/tencent-worker/feishu_gateway_canonical.js"), "utf8");
  const router = readFileSync(join(root, "infra/tencent-worker/feishu_gateway_canonical_router.js"), "utf8");
  assert.doesNotMatch(gateway + router, /CANONICAL_CANARY|canary_admission|allowed_owner/i);
});

test("Canary scope does not enable or couple Shadow", () => {
  const route = boundary.resolveFeishuApplicationFeatureRoute(env({
    HERMES_CANONICAL_ORCHESTRATION_ENABLED: "false",
    HERMES_CANONICAL_SHADOW_ENABLED: "true",
  }));
  assert.equal(route.canonical_enabled, false);
  assert.equal(route.shadow_enabled, true);
  assert.equal(route.mode, "shadow");
});

test("real 03K job shape builds the explicit persistence contract", () => {
  const contract = jobInsert.buildCanonicalJobInsertContract(canonicalRow(), admission());
  assert.equal(contract.schema, "canonical_canary_job_insert_v1");
  assert.equal(Object.hasOwn(contract, "title"), false);
  assert.equal(contract.requested_mode, "worker_read_only");
  assert.deepEqual(contract.canonical_context.canonical_canary_admission, admission());
});

test("canonical title is deterministic and normalized before persistence", () => {
  const first = jobInsert.buildCanonicalJobInsertContract(canonicalRow({ title: "  Inspect package metadata  " }), admission());
  const second = jobInsert.buildCanonicalJobInsertContract(canonicalRow(), admission());
  assert.equal(first.request_text, second.request_text);
});

test("missing or empty canonical title fails before RPC persistence", () => {
  assert.throws(
    () => jobInsert.buildCanonicalJobInsertContract(canonicalRow({ title: "" }), admission()),
    /CANONICAL_JOB_TITLE_REQUIRED/
  );
  assert.throws(
    () => jobInsert.buildCanonicalJobInsertContract(canonicalRow({ title: undefined }), admission()),
    /CANONICAL_JOB_TITLE_REQUIRED/
  );
});

test("missing request context and identifiers fail before persistence", () => {
  assert.throws(
    () => jobInsert.buildCanonicalJobInsertContract(canonicalRow({ request_text: "" }), admission()),
    /CANONICAL_JOB_REQUEST_TEXT_REQUIRED/
  );
  assert.throws(
    () => jobInsert.buildCanonicalJobInsertContract(canonicalRow({ plan_id: "", payload: { canonical_runtime: true, subtask_id: "subtask-1" } }), admission()),
    /CANONICAL_JOB_PLAN_ID_REQUIRED/
  );
  assert.throws(
    () => jobInsert.buildCanonicalJobInsertContract(canonicalRow(), admission({ event_id: "" })),
    /CANONICAL_JOB_EVENT_ID_REQUIRED/
  );
});

test("write_allowed cannot enter the canonical insert contract", () => {
  assert.throws(
    () => jobInsert.buildCanonicalJobInsertContract(canonicalRow({ requested_mode: "write_allowed" }), admission()),
    /CANONICAL_JOB_REQUESTED_MODE_INVALID/
  );
});

test("migration uses explicit columns and never whole-row JSON conversion", () => {
  assert.doesNotMatch(migrationSource, /jsonb_populate_record/i);
  assert.match(migrationSource, /insert into public\.hermes_jobs \(\s*id,\s*source,\s*request_text,\s*status,\s*result,/i);
  assert.match(migrationSource, /p_job->>'request_text',\s*'queued',/i);
  assert.match(migrationSource, /jsonb_build_object\('canonical_context', p_job->'canonical_context'\)/i);
  assert.doesNotMatch(migrationSource, /\btitle\b/i);
  assert.doesNotMatch(migrationSource, /^\s*payload,?\s*$/im);
});

test("migration validates the job contract before consuming admission", () => {
  const validationAt = migrationSource.indexOf("MALFORMED_CANONICAL_JOB_PAYLOAD");
  const admissionInsertAt = migrationSource.indexOf("insert into public.hermes_canonical_canary_admissions");
  assert.notEqual(validationAt, -1);
  assert.ok(validationAt < admissionInsertAt);
  assert.match(migrationSource, /CANARY_JOB_ADMISSION_MISMATCH/);
  assert.match(migrationSource, /p_job->>'schema' is distinct from 'canonical_canary_job_insert_v1'/i);
  assert.match(migrationSource, /canonical_context,canonical_runtime[^\n]+is distinct from 'true'/i);
  assert.match(migrationSource, /INVALID_CANARY_ADMISSION_IDENTITY/);
});

test("tracked runtime columns are additive and the migration remains inert", () => {
  assert.doesNotMatch(migrationSource, /alter table public\.hermes_jobs/i);
  assert.doesNotMatch(migrationSource, /HERMES_CANONICAL_ORCHESTRATION_ENABLED\s*=|CANONICAL_DATABASE_PERSISTENCE_ENABLED\s*=/);
  assert.doesNotMatch(migrationSource, /insert into public\.hermes_canonical_canary_policy_rules/);
});

test("admission migration introduces no second attempt, lease, or terminal state machine", () => {
  const sql = readFileSync(join(root, "supabase/migrations/202608110001_canonical_canary_admission_control.sql"), "utf8");
  assert.doesNotMatch(sql, /canonical_acquire_attempt_lease|canonical_record_runtime_signal|canonical_finalize_terminal/);
  assert.doesNotMatch(sql, /create table[^;]*(attempt|lease|terminal)/i);
});
