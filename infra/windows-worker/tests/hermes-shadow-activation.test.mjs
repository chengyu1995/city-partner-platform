import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const shadow = require(join(root, "src", "lib", "hermes", "shadow-runtime.ts"));
const delegation = require(join(root, "src", "lib", "project-director-hermes-delegation.ts"));
const finalReport = require(join(root, "src", "lib", "project-director-final-report.ts"));
const capabilities = require(join(root, "src", "lib", "openclaw", "capability-gateway.ts"));

function approvedRequest(overrides = {}) {
  return {
    request_id: "request-shadow-1",
    original_request_text: "Inspect the approved source scope.",
    project_domain: "automation_system",
    requested_mode: "worker_read_only",
    approval_context: { approval_id: "approval-shadow-1", approved_by: "boss" },
    objective: "Compare the legacy and canonical plans.",
    ...overrides,
  };
}

function draft(overrides = {}) {
  return {
    objective: "Inspect and validate.",
    aggregation_policy: "all_required",
    subtasks: [
      {
        subtask_id: "shadow-task-1",
        title: "Inspect source",
        objective: "Read the approved source scope.",
        dependencies: [],
        required_capabilities: ["code_read"],
        execution_intent: "verification_only",
        allowed_paths: ["src/**"],
        forbidden_paths: [".env"],
        acceptance_criteria: ["Validation passes"],
        validation_requirements: ["npm test"],
        git_commit_required: false,
        git_push_required: false,
        deployment_required: false,
      },
    ],
    ...overrides,
  };
}

function legacyPlan(overrides = {}) {
  return {
    request_id: "request-shadow-1",
    task_types: ["code_read"],
    selected_agents: ["code_review_agent"],
    execution_modes: ["verification_only"],
    allowed_paths: ["src/**"],
    forbidden_paths: [".env"],
    acceptance_criteria: ["Validation passes"],
    risk_levels: ["low"],
    ...overrides,
  };
}

function planner(value = draft()) {
  return { plan: async () => value };
}

function shadowEnv(overrides = {}) {
  return {
    HERMES_CANONICAL_SHADOW_ENABLED: "true",
    HERMES_CANONICAL_ORCHESTRATION_ENABLED: "false",
    ...overrides,
  };
}

async function observe(overrides = {}) {
  return delegation.runApprovedRequestThroughHermesShadow(
    overrides.request ?? approvedRequest(),
    overrides.legacyPlan ?? legacyPlan(),
    overrides.planner ?? planner(),
    overrides.gateway ?? new capabilities.RegistryCapabilityGateway(),
    overrides.env ?? shadowEnv()
  );
}

test("Hermes canonical shadow flag defaults off", () => {
  assert.equal(shadow.HERMES_CANONICAL_SHADOW_ENABLED_DEFAULT, false);
  assert.equal(shadow.isHermesCanonicalShadowEnabled({}), false);
});

test("Hermes canonical shadow flag enables independently", () => {
  assert.equal(shadow.isHermesCanonicalShadowEnabled(shadowEnv()), true);
});

test("disabled shadow does not call the Hermes planner", async () => {
  let plannerCalled = false;
  const result = await observe({
    env: {},
    planner: { plan: async () => { plannerCalled = true; return draft(); } },
  });
  assert.equal(result.reason, "shadow_disabled");
  assert.equal(plannerCalled, false);
});

test("authoritative canonical mode and shadow mode cannot run together", async () => {
  const result = await observe({
    env: shadowEnv({ HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true" }),
  });
  assert.equal(result.observed, false);
  assert.equal(result.reason, "canonical_authoritative_enabled");
});

test("enabled shadow generates a canonical plan and comparison report", async () => {
  const result = await observe();
  assert.equal(result.observed, true);
  assert.equal(result.reason, "shadow_comparison_created");
  assert.equal(result.report.request_id, "request-shadow-1");
  assert.equal(result.report.shadow_plan_id, result.plan.plan_id);
});

test("shadow creates no real canonical job", async () => {
  const result = await observe();
  assert.equal(result.safety.authoritative_execution, false);
  assert.equal(result.safety.real_job_created, false);
});

test("shadow creates no attempt, lease, or terminal", async () => {
  const result = await observe();
  assert.equal(result.safety.attempt_created, false);
  assert.equal(result.safety.lease_created, false);
  assert.equal(result.safety.terminal_created, false);
});

test("shadow has no Worker, database, or state machine authority", async () => {
  const result = await observe();
  assert.equal(result.safety.direct_worker_access, false);
  assert.equal(result.safety.database_write, false);
  assert.equal(result.safety.state_machine_created, false);
});

test("OpenClaw shadow lookup is capability-only", async () => {
  const result = await observe();
  assert.equal(result.observed, true);
  assert.equal(result.plan.subtasks[0].recommended_agent, "code_review_agent");
  const source = readFileSync(join(root, "src", "lib", "openclaw", "capability-gateway.ts"), "utf8");
  assert.doesNotMatch(source, /hermes_jobs|canonicalCreateJob|SupabaseClient|\/api\/worker/);
});

test("equal legacy and canonical projections produce severity NONE", async () => {
  const result = await observe();
  assert.equal(result.report.difference_count, 0);
  assert.equal(result.report.severity, "NONE");
});

test("comparison report calculates HIGH severity for scope differences", async () => {
  const result = await observe({ legacyPlan: legacyPlan({ allowed_paths: ["docs/**"] }) });
  assert.equal(result.report.differences.some((item) => item.dimension === "execution_scope"), true);
  assert.equal(result.report.severity, "HIGH");
});

test("comparison report records both runtime paths and correlation ids", async () => {
  const result = await observe();
  assert.equal(result.report.legacy_path, "legacy_runtime");
  assert.equal(result.report.canonical_path, "hermes_canonical_shadow");
  assert.equal(result.report.source_request_id, "request-shadow-1");
  assert.match(result.report.comparison_id, /^shadow-comparison:request-shadow-1:/);
});

test("GM report keeps Legacy as the primary source", async () => {
  const observation = await observe();
  const report = finalReport.attachHermesShadowComparison(
    { effective_final_status: "succeeded", source: "legacy" },
    observation
  );
  assert.equal(report.gm_report_primary_source, "legacy_runtime");
  assert.equal(report.gm_report_shadow_source, "hermes_shadow_comparison");
  assert.equal(report.primary_result.effective_final_status, "succeeded");
});

test("shadow planning failure does not affect Legacy success", async () => {
  const observation = await observe({ planner: { plan: async () => { throw new Error("planner unavailable"); } } });
  const report = finalReport.attachHermesShadowComparison(
    { effective_final_status: "succeeded" },
    observation
  );
  assert.equal(observation.reason, "shadow_planning_failed");
  assert.equal(report.primary_result.effective_final_status, "succeeded");
});

test("Legacy failure remains failed when shadow succeeds", async () => {
  const report = finalReport.attachHermesShadowComparison(
    { effective_final_status: "failed", failure_code: "LEGACY_FAILED" },
    await observe()
  );
  assert.equal(report.primary_result.effective_final_status, "failed");
  assert.equal(report.primary_result.failure_code, "LEGACY_FAILED");
});

test("shadow runtime source has no authoritative persistence or Worker dependency", () => {
  const source = readFileSync(join(root, "src", "lib", "hermes", "shadow-runtime.ts"), "utf8");
  assert.doesNotMatch(source, /canonicalCreateJob|canonicalAcquire|canonical_acquire|SupabaseClient|\/api\/worker|\.from\(|\.insert\(|\.update\(/);
});

test("shadow delegation accepts no canonical job creator", () => {
  const source = readFileSync(join(root, "src", "lib", "project-director-hermes-delegation.ts"), "utf8");
  const shadowFunction = source.slice(source.indexOf("export async function runApprovedRequestThroughHermesShadow"));
  assert.doesNotMatch(shadowFunction, /CanonicalJobCreator|createCanonicalJobsForPlan|canonicalCreateJob/);
});

test("Feishu approved execution keeps Legacy dispatch and adds shadow observation", () => {
  const source = readFileSync(join(root, "src", "app", "api", "feishu", "event", "route.ts"), "utf8");
  const shadowIndex = source.indexOf("runApprovedRequestThroughHermesShadow(");
  const legacyWriteIndex = source.indexOf("insertApprovedAgentDispatchJobsWithContract(supabase", shadowIndex);
  assert.notEqual(shadowIndex, -1);
  assert.equal(legacyWriteIndex > shadowIndex, true);
  assert.match(source, /hermes_shadow_report:/);
});

test("Shadow and Legacy produce no silent dual authoritative write", async () => {
  const result = await observe();
  assert.equal(result.safety.projection_only, true);
  assert.equal(result.safety.authoritative_execution, false);
  assert.equal(result.safety.database_write, false);
});
