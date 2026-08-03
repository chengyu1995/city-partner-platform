import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const executionPlan = require(join(root, "src", "lib", "hermes", "execution-plan.ts"));
const orchestration = require(join(root, "src", "lib", "hermes", "orchestration-adapter.ts"));
const capabilities = require(join(root, "src", "lib", "openclaw", "capability-gateway.ts"));
const aggregation = require(join(root, "src", "lib", "hermes", "result-aggregator.ts"));
const finalReport = require(join(root, "src", "lib", "project-director-final-report.ts"));
const delegation = require(join(root, "src", "lib", "project-director-hermes-delegation.ts"));
const stateMachine = require(join(root, "infra", "tencent-worker", "worker_job_state_machine.js"));

function draftSubtask(overrides = {}) {
  return {
    subtask_id: "task-a",
    title: "Read and verify",
    objective: "Inspect the approved scope and run validation.",
    dependencies: [],
    required_capabilities: ["code_read"],
    execution_intent: "verification_only",
    allowed_paths: ["src/lib/**"],
    forbidden_paths: [".env"],
    acceptance_criteria: ["Validation passes"],
    validation_requirements: ["npm test"],
    git_commit_required: false,
    git_push_required: false,
    deployment_required: false,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    schema_version: "1.0",
    plan_id: "plan-test",
    plan_revision: 1,
    original_request_text: "Approved request",
    project_domain: "automation_system",
    requested_mode: "worker_read_only",
    approval_context: { approval_id: "approval-1", deployment_approved: false },
    objective: "Verify the orchestration contract",
    aggregation_policy: "all_required",
    subtasks: [{ ...draftSubtask(), recommended_agent: "code_review_agent" }],
    ...overrides,
  };
}

function plan(overrides = {}) {
  return executionPlan.normalizeExecutionPlan(candidate(overrides), overrides.requested_mode ?? "worker_read_only");
}

function result(subtaskId, overrides = {}) {
  return {
    subtask_id: subtaskId,
    report_identity: `report:${subtaskId}:1`,
    worker_status: "succeeded",
    task_goal_status: "succeeded",
    effective_final_status: "succeeded",
    failure_code: null,
    failure_stage: null,
    ...overrides,
  };
}

test("HermesExecutionPlan schema validates a complete plan", () => {
  const value = plan();
  assert.equal(value.schema_version, "1.0");
  assert.deepEqual(executionPlan.validateExecutionPlan(value, "worker_read_only"), { ok: true, errors: [] });
});

test("duplicate subtask ids are rejected", () => {
  const value = plan({ subtasks: [draftSubtask(), draftSubtask()] });
  assert.match(executionPlan.validateExecutionPlan(value, "worker_read_only").errors.join("\n"), /DUPLICATE_SUBTASK_ID/);
});

test("missing dependencies are rejected", () => {
  const value = plan({ subtasks: [draftSubtask({ dependencies: ["missing"] })] });
  assert.match(executionPlan.validateExecutionPlan(value, "worker_read_only").errors.join("\n"), /MISSING_DEPENDENCY/);
});

test("cyclic DAG dependencies are rejected", () => {
  const value = plan({
    subtasks: [
      draftSubtask({ subtask_id: "task-a", dependencies: ["task-b"] }),
      draftSubtask({ subtask_id: "task-b", dependencies: ["task-a"] }),
    ],
  });
  assert.match(executionPlan.validateExecutionPlan(value, "worker_read_only").errors.join("\n"), /CYCLIC_DAG/);
});

test("requested mode escalation from a planner is rejected", async () => {
  const planner = { plan: async () => ({ requested_mode: "write_allowed", objective: "bad", subtasks: [draftSubtask()] }) };
  await assert.rejects(
    orchestration.planApprovedRequest(
      { request_id: "request-1", original_request_text: "x", project_domain: "automation_system", requested_mode: "worker_read_only", approval_context: {}, objective: "x" },
      planner
    ),
    /REQUESTED_MODE_ESCALATION/
  );
});

test("approval context is preserved exactly across GM delegation", async () => {
  const approval = { approval_id: "approval-1", approved_by: "boss", deployment_approved: false, custom: "keep" };
  const value = await orchestration.planApprovedRequest(
    { request_id: "request-1", original_request_text: "x", project_domain: "automation_system", requested_mode: "worker_read_only", approval_context: approval, objective: "x" },
    { plan: async () => ({ objective: "x", subtasks: [draftSubtask()] }) }
  );
  assert.deepEqual(value.approval_context, approval);
});

test("plan hash is deterministic and content sensitive", () => {
  const value = plan();
  assert.equal(executionPlan.calculatePlanHash(value), executionPlan.calculatePlanHash({ ...value }));
  assert.notEqual(executionPlan.calculatePlanHash(value), executionPlan.calculatePlanHash({ ...value, objective: "changed" }));
});

test("plan ids are unique for independent approved requests", async () => {
  const input = { request_id: "request-1", original_request_text: "x", project_domain: "automation_system", requested_mode: "worker_read_only", approval_context: {}, objective: "x" };
  const planner = { plan: async () => ({ objective: "x", subtasks: [draftSubtask()] }) };
  const first = await orchestration.planApprovedRequest(input, planner);
  const second = await orchestration.planApprovedRequest(input, planner);
  assert.notEqual(first.plan_id, second.plan_id);
});

test("capability lookup is deterministic", () => {
  const request = { required_capabilities: ["code_read", "code_review"], execution_intent: "review", requested_mode: "worker_read_only" };
  assert.deepEqual(capabilities.resolveAgentCapabilities(request), capabilities.resolveAgentCapabilities(request));
  assert.equal(capabilities.resolveAgentCapabilities(request).selected_agent, "code_review_agent");
});

test("unknown capability fails closed", () => {
  assert.throws(
    () => capabilities.resolveAgentCapabilities({ required_capabilities: ["unknown"], execution_intent: "x", requested_mode: "worker_read_only" }),
    /UNKNOWN_AGENT_CAPABILITY/
  );
});

test("OpenClaw contract has no Worker or database access", () => {
  const source = readFileSync(join(root, "src", "lib", "openclaw", "capability-gateway.ts"), "utf8");
  assert.doesNotMatch(source, /hermes_jobs|Supabase|\/api\/worker|createHermesJob|canonicalCreateJob/);
  assert.equal(capabilities.isOpenClawCapabilityGatewayEnabled({}), false);
});

test("Hermes adapter cannot write Worker execution state", () => {
  const source = readFileSync(join(root, "src", "lib", "hermes", "orchestration-adapter.ts"), "utf8");
  assert.doesNotMatch(source, /\.from\(|\.insert\(|\.update\(|claimed_by|active_attempt|active_lease|terminal_state/);
  assert.equal(executionPlan.validatePlanningStateBoundary({ subtasks: [{ subtask_id: "x", status: "running" }] }).ok, false);
});

test("canonicalCreateJob is the unique recommended persistence boundary", () => {
  const workerJobs = readFileSync(join(root, "src", "lib", "worker-jobs.ts"), "utf8");
  const adapter = readFileSync(join(root, "src", "lib", "hermes", "orchestration-adapter.ts"), "utf8");
  assert.match(workerJobs, /export async function canonicalCreateJob\(/);
  assert.match(adapter, /createCanonicalJobsForPlan/);
  assert.doesNotMatch(adapter, /createHermesJobs?|hermes_jobs/);
});

test("canonical creation initializes only a selectable queued job", () => {
  const initialized = stateMachine.initializeQueuedJob({ id: "job-1", status: "created", result: {} }, { now: "2026-08-03T01:00:00.000Z" });
  assert.equal(initialized.ok, true);
  assert.equal(initialized.patch.result.job_state_machine.job_state, "queued");
  assert.equal(initialized.patch.result.job_state_machine.active_attempt, null);
  assert.equal(initialized.patch.result.job_state_machine.active_lease, null);
  assert.equal(stateMachine.isJobSelectable({ id: "job-1", ...initialized.patch }), true);
});

test("new canonical orchestration never calls legacy Hermes queue", () => {
  const sources = ["execution-plan.ts", "orchestration-adapter.ts", "result-aggregator.ts"]
    .map((file) => readFileSync(join(root, "src", "lib", "hermes", file), "utf8"))
    .join("\n");
  assert.doesNotMatch(sources, /hermes_queue|task_results/);
  assert.match(readFileSync(join(root, "scripts", "hermes_decompose_runner.py"), "utf8"), /DEPRECATED legacy Hermes queue runner/);
});

test("all successful canonical results aggregate to success", () => {
  const value = plan({ subtasks: [draftSubtask({ subtask_id: "a" }), draftSubtask({ subtask_id: "b", dependencies: ["a"] })] });
  const aggregate = aggregation.aggregatePlanResults({ plan: value, job_results: [result("a"), result("b")] });
  assert.equal(aggregate.aggregation_status, "all_success");
  assert.equal(aggregate.effective_final_status, "succeeded");
});

test("partial failure cannot aggregate to success", () => {
  const value = plan({ subtasks: [draftSubtask({ subtask_id: "a" }), draftSubtask({ subtask_id: "b" })] });
  const aggregate = aggregation.aggregatePlanResults({ plan: value, job_results: [result("a"), result("b", { worker_status: "failed", task_goal_status: "failed", effective_final_status: "failed", failure_code: "TEST_FAILED" })] });
  assert.equal(aggregate.aggregation_status, "partial_failure");
  assert.equal(aggregate.effective_final_status, "failed");
});

test("Worker success cannot override task goal failure", () => {
  const aggregate = aggregation.aggregatePlanResults({
    plan: plan(),
    job_results: [result("task-a", { worker_status: "succeeded", task_goal_status: "failed", effective_final_status: "succeeded", failure_code: "GOAL_FAILED" })],
  });
  assert.equal(aggregate.effective_final_status, "failed");
  assert.equal(aggregate.failure_code, "GOAL_FAILED");
});

test("required dependency failure blocks a dependent subtask", () => {
  const value = plan({ subtasks: [draftSubtask({ subtask_id: "a" }), draftSubtask({ subtask_id: "b", dependencies: ["a"] })] });
  const aggregate = aggregation.aggregatePlanResults({ plan: value, job_results: [result("a", { worker_status: "failed", task_goal_status: "failed", effective_final_status: "failed", failure_code: "A_FAILED" })] });
  assert.equal(aggregate.aggregation_status, "blocked_dependency");
  assert.equal(aggregate.results.find((item) => item.subtask_id === "b").failure_code, "DEPENDENCY_TERMINAL_FAILURE");
});

test("duplicate terminal reports preserve first terminal truth", () => {
  const aggregate = aggregation.aggregatePlanResults({
    plan: plan(),
    job_results: [
      result("task-a", { report_identity: "first", effective_final_status: "succeeded" }),
      result("task-a", { report_identity: "duplicate", worker_status: "failed", task_goal_status: "failed", effective_final_status: "failed" }),
    ],
  });
  assert.equal(aggregate.effective_final_status, "succeeded");
  assert.equal(aggregate.results[0].report_identity, "first");
  assert.equal(aggregate.results[0].duplicate_terminal_reports_ignored, 1);
  assert.equal(aggregate.first_terminal_truth_preserved, true);
});

test("GM final report separates Worker status from task status", () => {
  const aggregate = aggregation.aggregatePlanResults({
    plan: plan(),
    job_results: [result("task-a", { worker_status: "succeeded", task_goal_status: "failed", effective_final_status: "failed", failure_code: "GOAL_FAILED" })],
  });
  const report = finalReport.buildProjectDirectorFinalReport(aggregate);
  assert.match(report.worker_status_title, /Worker execution status/);
  assert.match(report.task_status_title, /Task goal status/);
  assert.notEqual(report.worker_status_title, report.task_status_title);
  assert.equal(report.feishu_projection.projection_only, true);
});

test("feature flag off preserves legacy GM behavior and never calls planner", async () => {
  let plannerCalls = 0;
  const response = await delegation.delegateApprovedRequestToHermes(
    { request_id: "request-1", original_request_text: "x", project_domain: "automation_system", requested_mode: "worker_read_only", approval_context: {}, objective: "x" },
    { plan: async () => { plannerCalls += 1; return { objective: "x", subtasks: [draftSubtask()] }; } },
    new capabilities.RegistryCapabilityGateway(),
    {}
  );
  assert.deepEqual(response, { delegated: false, reason: "feature_disabled", plan: null });
  assert.equal(plannerCalls, 0);
});

test("new Hermes path has no direct-worker bypass", () => {
  const adapter = readFileSync(join(root, "src", "lib", "hermes", "orchestration-adapter.ts"), "utf8");
  const route = readFileSync(join(root, "src", "app", "api", "feishu", "event", "route.ts"), "utf8");
  assert.doesNotMatch(adapter, /isDirectWorkerTaskRequest|insertDirectWorkerTask|\/api\/worker/);
  assert.match(route, /isDirectWorkerTaskRequest/);
});

test("canonical orchestration does not duplicate execution state machines", () => {
  const files = [
    join(root, "src", "lib", "hermes", "execution-plan.ts"),
    join(root, "src", "lib", "hermes", "orchestration-adapter.ts"),
    join(root, "src", "lib", "hermes", "result-aggregator.ts"),
    join(root, "src", "lib", "openclaw", "capability-gateway.ts"),
  ];
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /function\s+(claimJob|applyHeartbeat|applyProgress|finalizeJob|recoverStaleAttempt)\b/);
  assert.doesNotMatch(source, /active_attempt_id|active_lease_id|lease_expires_at/);
});

test("production feature flags default off", () => {
  assert.equal(orchestration.HERMES_CANONICAL_ORCHESTRATION_ENABLED_DEFAULT, false);
  assert.equal(orchestration.isHermesCanonicalOrchestrationEnabled({}), false);
  assert.equal(capabilities.OPENCLAW_CAPABILITY_GATEWAY_ENABLED_DEFAULT, false);
  assert.equal(capabilities.isOpenClawCapabilityGatewayEnabled({}), false);
});

test("capability registry exposes all eight required agent contracts", () => {
  assert.equal(capabilities.AGENT_CAPABILITY_REGISTRY.length, 8);
  assert.deepEqual(
    capabilities.AGENT_CAPABILITY_REGISTRY.map((entry) => entry.agent).sort(),
    ["bug_triage_agent", "code_review_agent", "codex_agent", "deployment_agent", "documentation_agent", "product_agent", "research_agent", "test_agent"]
  );
});
