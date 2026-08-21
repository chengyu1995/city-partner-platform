import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const canonical = await import("../../tencent-worker/worker_canonical_persistence.js");
const adapter = await import("../../../src/lib/hermes/orchestration-adapter.ts");
const delegation = await import("../../../src/lib/project-director-hermes-delegation.ts");
const executionPlan = await import("../../../src/lib/hermes/execution-plan.ts");
const persistenceContract = await import("../../../src/lib/worker-job-persistence-contract.ts");

const source = (file) => readFileSync(join(root, file), "utf8");
const workerSource = source("infra/windows-worker/local_worker.js");
const workerApiSource = source("infra/tencent-worker/worker_api.js");
const canonicalSource = source("infra/tencent-worker/worker_canonical_persistence.js");
const nextSource = source("src/app/api/worker/next/route.ts");
const heartbeatSource = source("src/app/api/worker/heartbeat/route.ts");
const progressSource = source("src/app/api/worker/progress/route.ts");
const reportSource = source("src/app/api/worker/report/route.ts");
const feishuSource = source("src/app/api/feishu/event/route.ts");
const hermesAgentSource = source("src/lib/hermes-agent.ts");
const workerJobsSource = source("src/lib/worker-jobs.ts");

Object.assign(process.env, {
  HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true",
  CANONICAL_DATABASE_PERSISTENCE_ENABLED: "true",
  HERMES_CANONICAL_CANARY_SCOPE_ENABLED: "true",
  HERMES_CANONICAL_CANARY_DURABLE_ADMISSION_ENABLED: "true",
  HERMES_CANONICAL_CANARY_ALLOWED_OWNER_IDS: "ou_owner123",
  HERMES_CANONICAL_CANARY_ALLOWED_BATCH_CODES: "BATCH-CANARY-01",
  HERMES_CANONICAL_CANARY_ALLOWED_MODES: "worker_read_only",
  HERMES_CANONICAL_CANARY_POLICY_ID: "CANARY-01",
});

function exportedFunctionBlock(sourceText, name) {
  const start = sourceText.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = sourceText.indexOf("\nexport ", start + 1);
  return sourceText.slice(start, end === -1 ? sourceText.length : end);
}

function terminalIdentity(overrides = {}) {
  return {
    job_id: "job-03c1",
    attempt_id: "attempt-03c1",
    worker_id: "worker-03c1",
    report_identity: "report-03c1",
    worker_execution_status: "succeeded",
    task_goal_status: "succeeded",
    effective_final_status: "succeeded",
    failure_code: null,
    failure_stage: null,
    ...overrides,
  };
}

class Query {
  constructor(rows) {
    this.rows = rows;
    this.filters = [];
    this.max = null;
  }
  select() { return this; }
  eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
  is(key, value) { this.filters.push((row) => row[key] === value); return this; }
  in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
  lte(key, value) { this.filters.push((row) => String(row[key]) <= String(value)); return this; }
  order() { return this; }
  limit(value) { this.max = value; return this; }
  values() {
    const filtered = this.filters.reduce((rows, filter) => rows.filter(filter), this.rows);
    return this.max === null ? filtered : filtered.slice(0, this.max);
  }
  maybeSingle() { return Promise.resolve({ data: this.values()[0] ?? null, error: null }); }
  then(resolve, reject) { return Promise.resolve({ data: this.values(), error: null }).then(resolve, reject); }
}

function fixture(options = {}) {
  const job = {
    id: "job-03c1",
    job_id: "worker-task-03c1",
    canonical_job_state: options.jobState ?? "queued",
    canonical_revision: options.revision ?? 0,
    terminal_at: null,
    requested_mode: "worker_read_only",
    plan_id: "plan-03c1",
    subtask_id: "subtask-1",
    created_at: "2026-08-05T00:00:00.000Z",
    payload: {
      dependencies: [], execution_intent: "verification", allowed_paths: [], acceptance_criteria: [],
      canonical_canary_admission: {
        policy_id: "CANARY-01", trusted_owner_id: "ou_owner123", batch_code: "BATCH-CANARY-01",
        requested_mode: "worker_read_only", event_id: "event-1", request_id: "request-1",
      },
    },
  };
  const tables = {
    hermes_jobs: [job],
    hermes_job_attempts: [],
    hermes_job_leases: [],
    hermes_job_terminals: [],
  };
  const rpcCalls = [];
  const client = {
    from(name) { return new Query(tables[name] ?? []); },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (name === "canonical_acquire_attempt_lease") {
        if (job.canonical_job_state !== "queued" || job.canonical_revision !== args.p_expected_revision) {
          return { data: null, error: { code: "P0001", message: "STALE_REVISION" } };
        }
        job.canonical_job_state = "claimed";
        job.canonical_revision += 1;
        tables.hermes_job_attempts.push({
          attempt_id: args.p_attempt_id, job_id: job.id, worker_id: args.p_worker_id, attempt_state: "claimed",
        });
        tables.hermes_job_leases.push({
          lease_id: args.p_lease_id, job_id: job.id, attempt_id: args.p_attempt_id,
          worker_id: args.p_worker_id, lease_state: "active", expires_at: args.p_expires_at,
        });
        return { data: { ok: true, revision: job.canonical_revision }, error: null };
      }
      if (name === "canonical_record_runtime_signal") {
        job.canonical_job_state = "running";
        job.canonical_revision += 1;
        return { data: { ok: true, revision: job.canonical_revision }, error: null };
      }
      if (name === "canonical_finalize_terminal") {
        if (tables.hermes_job_terminals.length) {
          return { data: { ok: true, idempotent: true, revision: job.canonical_revision }, error: null };
        }
        job.canonical_job_state = args.p_terminal_job_state;
        job.terminal_at = args.p_now;
        job.canonical_revision += 1;
        tables.hermes_job_terminals.push({
          job_id: job.id,
          attempt_id: args.p_attempt_id,
          worker_id: args.p_worker_id,
          report_identity: args.p_report_identity,
          worker_execution_status: args.p_worker_execution_status,
          task_goal_status: args.p_task_goal_status,
          effective_final_status: args.p_effective_final_status,
          failure_code: args.p_failure_code,
          failure_stage: args.p_failure_stage,
        });
        return { data: { ok: true, idempotent: false, revision: job.canonical_revision }, error: null };
      }
      if (name === "canonical_recover_stale_attempt") {
        job.canonical_job_state = "queued";
        job.canonical_revision += 1;
        tables.hermes_job_attempts[0].attempt_state = "abandoned";
        tables.hermes_job_leases[0].lease_state = "expired";
        return { data: { ok: true, revision: job.canonical_revision }, error: null };
      }
      return { data: null, error: { code: "UNKNOWN_RPC", message: name } };
    },
  };
  return { client, job, tables, rpcCalls };
}

async function claimedFixture() {
  const state = fixture();
  const claim = await canonical.claimNext(state.client, "worker-03c1", new Date("2026-08-05T00:00:00.000Z"));
  return { ...state, claim };
}

test("canonical persistence feature defaults off", () => assert.equal(canonical.enabled({}), false));
test("canonical persistence requires explicit true", () => assert.equal(canonical.enabled({ CANONICAL_DATABASE_PERSISTENCE_ENABLED: "true" }), true));
test("canonical job identity is recognized", () => assert.equal(canonical.isCanonicalJob(fixture().job), true));
test("legacy job is not treated as canonical", () => assert.equal(canonical.isCanonicalJob({ id: "legacy", status: "queued" }), false));

test("production helper claims through canonical RPC", async () => {
  const state = fixture();
  await canonical.claimNext(state.client, "worker-03c1", new Date("2026-08-05T00:00:00.000Z"));
  assert.equal(state.rpcCalls[0].name, "canonical_acquire_attempt_lease");
});

test("claim returns attempt lease and monotonic revision", async () => {
  const { claim } = await claimedFixture();
  assert.match(claim.attempt_id, /^attempt:/);
  assert.match(claim.lease_id, /^lease:attempt:/);
  assert.equal(claim.canonical_revision, 1);
});

test("claim creates canonical attempt history", async () => {
  const state = await claimedFixture();
  assert.equal(state.tables.hermes_job_attempts.length, 1);
  assert.equal(state.tables.hermes_job_attempts[0].attempt_id, state.claim.attempt_id);
});

test("claim creates canonical lease history", async () => {
  const state = await claimedFixture();
  assert.equal(state.tables.hermes_job_leases.length, 1);
  assert.equal(state.tables.hermes_job_leases[0].lease_id, state.claim.lease_id);
});

test("two canonical claimers have one winner", async () => {
  const state = fixture();
  const [first, second] = await Promise.all([
    canonical.claimNext(state.client, "worker-a"),
    canonical.claimNext(state.client, "worker-b"),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal(state.tables.hermes_job_attempts.length, 1);
  assert.equal(state.tables.hermes_job_leases.length, 1);
});

test("claim returns approved execution contract", async () => {
  const { claim } = await claimedFixture();
  assert.equal(claim.requested_mode, "worker_read_only");
  assert.equal(claim.execution_intent, "verification");
});

test("Production result.canonical_context projects a consumable Worker payload", async () => {
  const state = fixture();
  state.job.result = { canonical_context: state.job.payload };
  delete state.job.payload;
  const claim = await canonical.claimNext(state.client, "worker-03c1", new Date("2026-08-05T00:00:00.000Z"));
  assert.equal(claim.requested_mode, "worker_read_only");
  assert.equal(claim.execution_intent, "verification");
  assert.equal(claim.job.payload.canonical_canary_admission.policy_id, "CANARY-01");
});

test("unmet DAG dependency is not claimed", async () => {
  const state = fixture();
  state.job.payload.dependencies = ["missing"];
  const result = await canonical.claimNext(state.client, "worker-03c1");
  assert.equal(result, null);
  assert.equal(state.rpcCalls.length, 0);
});

test("heartbeat uses canonical runtime RPC", async () => {
  const state = await claimedFixture();
  await canonical.recordSignal(state.client, {
    job_id: state.job.id, attempt_id: state.claim.attempt_id, lease_id: state.claim.lease_id,
    worker_id: "worker-03c1", expected_revision: 1, signal: "heartbeat",
    new_expires_at: "2099-08-05T00:05:00.000Z",
  });
  assert.equal(state.rpcCalls.at(-1).name, "canonical_record_runtime_signal");
});

test("progress shares canonical runtime RPC", async () => {
  const state = await claimedFixture();
  await canonical.recordSignal(state.client, {
    job_id: state.job.id, attempt_id: state.claim.attempt_id, lease_id: state.claim.lease_id,
    worker_id: "worker-03c1", expected_revision: 1, signal: "progress",
  });
  assert.equal(state.rpcCalls.at(-1).args.p_signal, "progress");
});

test("wrong lease is rejected before RPC", async () => {
  const state = await claimedFixture();
  await assert.rejects(() => canonical.recordSignal(state.client, {
    job_id: state.job.id, attempt_id: state.claim.attempt_id, lease_id: "wrong",
    worker_id: "worker-03c1", expected_revision: 1, signal: "heartbeat",
  }), /LEASE_IDENTITY_MISMATCH/);
  assert.equal(state.rpcCalls.length, 1);
});

test("wrong attempt is rejected before heartbeat RPC", async () => {
  const state = await claimedFixture();
  await assert.rejects(() => canonical.recordSignal(state.client, {
    job_id: state.job.id, attempt_id: "wrong", lease_id: state.claim.lease_id,
    worker_id: "worker-03c1", expected_revision: 1, signal: "heartbeat",
  }), /ATTEMPT_IDENTITY_MISMATCH/);
  assert.equal(state.rpcCalls.length, 1);
});

test("wrong worker is rejected before RPC", async () => {
  const state = await claimedFixture();
  await assert.rejects(() => canonical.recordSignal(state.client, {
    job_id: state.job.id, attempt_id: state.claim.attempt_id, lease_id: state.claim.lease_id,
    worker_id: "other", expected_revision: 1, signal: "heartbeat",
  }), /WORKER_OWNERSHIP_MISMATCH/);
});

test("stale revision is rejected before RPC", async () => {
  const state = await claimedFixture();
  await assert.rejects(() => canonical.recordSignal(state.client, {
    job_id: state.job.id, attempt_id: state.claim.attempt_id, lease_id: state.claim.lease_id,
    worker_id: "worker-03c1", expected_revision: 0, signal: "progress",
  }), /STALE_REVISION/);
});

test("progress rejects a stale revision", async () => {
  const state = await claimedFixture();
  await assert.rejects(() => canonical.recordSignal(state.client, {
    job_id: state.job.id, attempt_id: state.claim.attempt_id, lease_id: state.claim.lease_id,
    worker_id: "worker-03c1", expected_revision: 99, signal: "progress",
  }), /STALE_REVISION/);
});

test("terminal heartbeat is an idempotent no-op", async () => {
  const state = await claimedFixture();
  state.tables.hermes_job_terminals.push({ job_id: state.job.id });
  const result = await canonical.recordSignal(state.client, {
    job_id: state.job.id, attempt_id: state.claim.attempt_id, lease_id: state.claim.lease_id,
    worker_id: "worker-03c1", expected_revision: 1, signal: "heartbeat",
  });
  assert.equal(result.terminal_noop, true);
  assert.equal(state.rpcCalls.length, 1);
});

test("terminal report uses canonical finalizer RPC", async () => {
  const state = await claimedFixture();
  await canonical.finalize(state.client, {
    job_id: state.job.id, attempt_id: state.claim.attempt_id, lease_id: state.claim.lease_id,
    worker_id: "worker-03c1", expected_revision: 1, report_identity: "report-1",
    worker_execution_status: "succeeded", task_goal_status: "succeeded",
    effective_final_status: "succeeded", canonical_report: {},
  });
  assert.equal(state.rpcCalls.at(-1).name, "canonical_finalize_terminal");
});

test("worker success cannot override task failure", async () => {
  const state = await claimedFixture();
  await assert.rejects(() => canonical.finalize(state.client, {
    job_id: state.job.id, attempt_id: state.claim.attempt_id, lease_id: state.claim.lease_id,
    worker_id: "worker-03c1", expected_revision: 1, report_identity: "report-1",
    worker_execution_status: "succeeded", task_goal_status: "failed",
    effective_final_status: "succeeded", canonical_report: {},
  }), /TASK_FAILURE_CANNOT_SUCCEED/);
});

test("duplicate terminal report is idempotent", async () => {
  const state = await claimedFixture();
  const input = {
    job_id: state.job.id, attempt_id: state.claim.attempt_id, lease_id: state.claim.lease_id,
    worker_id: "worker-03c1", expected_revision: 1, report_identity: "report-1",
    worker_execution_status: "succeeded", task_goal_status: "succeeded",
    effective_final_status: "succeeded", canonical_report: {},
  };
  await canonical.finalize(state.client, input);
  const duplicate = await canonical.finalize(state.client, { ...input, expected_revision: 2 });
  assert.equal(duplicate.idempotent, true);
});

test("conflicting terminal report cannot overwrite first truth", async () => {
  const state = await claimedFixture();
  const common = {
    job_id: state.job.id, attempt_id: state.claim.attempt_id, lease_id: state.claim.lease_id,
    worker_id: "worker-03c1", expected_revision: 1, report_identity: "report-first",
    worker_execution_status: "succeeded", task_goal_status: "succeeded",
    effective_final_status: "succeeded", canonical_report: {},
  };
  await canonical.finalize(state.client, common);
  await assert.rejects(() => canonical.finalize(state.client, {
    ...common, expected_revision: 2, report_identity: "report-conflict",
    worker_execution_status: "failed", task_goal_status: "failed", effective_final_status: "failed",
  }), /CANONICAL_TERMINAL_CONFLICT/);
  assert.equal(state.job.canonical_job_state, "terminal_success");
});

test("canonicalCreateJob never calls the legacy createHermesJob helper", () => {
  const block = exportedFunctionBlock(workerJobsSource, "canonicalCreateJob");
  assert.doesNotMatch(block, /\bcreateHermesJob\s*\(/);
});

test("canonicalCreateJob uses one strict Canary admission RPC", () => {
  const block = exportedFunctionBlock(workerJobsSource, "canonicalCreateJob");
  assert.match(block, /supabase\.rpc\("canonical_admit_canary_job"/);
  assert.doesNotMatch(block, /\.from\("hermes_jobs"\)[\s\S]*\.insert\(/);
  assert.doesNotMatch(block, /isMissingColumnError|shouldRetryPendingStatus|shouldRetryTextPriority/);
});

test("terminal semantic identity accepts an exact duplicate", () => {
  const terminal = terminalIdentity();
  assert.equal(persistenceContract.canonicalTerminalSemanticsMatch(terminal, { ...terminal }), true);
});

test("terminal semantic identity rejects a changed terminal result", () => {
  const terminal = terminalIdentity();
  assert.equal(persistenceContract.canonicalTerminalSemanticsMatch(terminal, {
    ...terminal,
    report_identity: "report-conflict",
    worker_execution_status: "failed",
    task_goal_status: "failed",
    effective_final_status: "failed",
  }), false);
});

test("concurrent conflicting terminal finalizers preserve one winner", async () => {
  const state = await claimedFixture();
  const common = {
    job_id: state.job.id, attempt_id: state.claim.attempt_id, lease_id: state.claim.lease_id,
    worker_id: "worker-03c1", expected_revision: 1, report_identity: "report-success",
    worker_execution_status: "succeeded", task_goal_status: "succeeded",
    effective_final_status: "succeeded", canonical_report: {},
  };
  const results = await Promise.allSettled([
    canonical.finalize(state.client, common),
    canonical.finalize(state.client, {
      ...common,
      report_identity: "report-failed",
      worker_execution_status: "failed",
      task_goal_status: "failed",
      effective_final_status: "failed",
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(state.tables.hermes_job_terminals.length, 1);
  assert.equal(state.job.canonical_job_state, "terminal_success");
});

test("expired lease recovery uses canonical RPC", async () => {
  const state = await claimedFixture();
  state.tables.hermes_job_leases[0].expires_at = "2026-08-05T00:01:00.000Z";
  const recovered = await canonical.recoverExpired(state.client, "2026-08-05T00:02:00.000Z");
  assert.equal(recovered.length, 1);
  assert.equal(state.rpcCalls.at(-1).name, "canonical_recover_stale_attempt");
});

test("stale recovery preserves attempt and lease history rows", async () => {
  const state = await claimedFixture();
  state.tables.hermes_job_leases[0].expires_at = "2026-08-05T00:01:00.000Z";
  await canonical.recoverExpired(state.client, "2026-08-05T00:02:00.000Z");
  assert.equal(state.tables.hermes_job_attempts.length, 1);
  assert.equal(state.tables.hermes_job_attempts[0].attempt_state, "abandoned");
  assert.equal(state.tables.hermes_job_leases.length, 1);
  assert.equal(state.tables.hermes_job_leases[0].lease_state, "expired");
});

test("legacy projection cannot mutate canonical truth", () => {
  assert.doesNotMatch(canonicalSource, /\.update\s*\(|\.insert\s*\(|\.delete\s*\(/);
  assert.match(canonicalSource, /canonical_acquire_attempt_lease/);
});

test("valid lease is not recovered", async () => {
  const state = await claimedFixture();
  const recovered = await canonical.recoverExpired(state.client, "2026-08-04T00:00:00.000Z");
  assert.equal(recovered.length, 0);
});

test("production canonical helper never updates legacy job status", () => {
  assert.doesNotMatch(canonicalSource, /\.from\("hermes_jobs"\)\.update|claimed_by\s*:/);
});
test("Next claim route calls canonical production boundary", () => assert.match(nextSource, /claimNextCanonicalHermesJob/));
test("Next legacy selector excludes canonical jobs", () => assert.match(nextSource, /\.is\("canonical_job_state", null\)/));
test("Tencent legacy selector excludes canonical jobs", () => assert.match(workerApiSource, /\.is\("canonical_job_state", null\)/));
test("Worker API fails closed when worker token is not configured", () => {
  assert.match(workerJobsSource, /WORKER_TOKEN_NOT_CONFIGURED/);
  assert.doesNotMatch(workerJobsSource, /if \(!expected\) return null/);
});
test("heartbeat route requires lease and revision", () => assert.match(heartbeatSource, /lease_id[\s\S]*expected_revision/));
test("progress route requires lease and revision", () => assert.match(progressSource, /lease_id[\s\S]*expected_revision/));
test("report route uses canonical terminal RPC boundary", () => assert.match(reportSource, /finalizeCanonicalPersistenceJobSafely/));
test("report route invokes Hermes plan aggregation", () => assert.match(reportSource, /buildCanonicalPlanFinalReportProjection/));
test("Windows Worker tracks attempt lease and revision", () => {
  assert.match(workerSource, /currentAttemptId/);
  assert.match(workerSource, /currentLeaseId/);
  assert.match(workerSource, /currentCanonicalRevision/);
});
test("Windows Worker serializes canonical mutations", () => assert.match(workerSource, /runCanonicalMutation/));
test("Windows Worker clears canonical identity after execution", () => assert.match(workerSource, /currentLeaseId = null;[\s\S]*currentCanonicalRevision = null;/));
test("GM approved execution delegates to Hermes", () => assert.match(feishuSource, /runApprovedRequestThroughCanonicalHermes/));
test("ordinary direct Worker bypass is gated", () => assert.match(feishuSource, /canonicalHermesAllowsDirectWorkerBypass/));
test("legacy Hermes agent is blocked when canonical feature is on", () => assert.match(feishuSource, /HERMES_APPROVAL_REQUIRED/));
test("canonical planning provider calls the LLM without tools", () => assert.match(hermesAgentSource, /createCanonicalHermesPlanningProvider[\s\S]*\],\s*\[\]/));
test("canonical planning provider forbids execution state", () => assert.match(hermesAgentSource, /Never include job, attempt, lease, claim, retry, or terminal state fields/));
test("Hermes plan payload preserves aggregation inputs", () => {
  const plan = executionPlan.normalizeExecutionPlan({
    schema_version: "1.0", plan_id: "plan", plan_revision: 1,
    original_request_text: "request", project_domain: "automation_system",
    requested_mode: "worker_read_only", approval_context: {}, objective: "objective",
    aggregation_policy: "all_required", subtasks: [{
      subtask_id: "one", title: "One", objective: "Verify", dependencies: [],
      recommended_agent: "test_agent", required_capabilities: ["test"],
      execution_intent: "verification", allowed_paths: [], forbidden_paths: [],
      acceptance_criteria: ["passes"], validation_requirements: ["tests"],
      git_commit_required: false, git_push_required: false, deployment_required: false,
    }],
  }, "worker_read_only");
  const admission = {
    policy_id: "CANARY-01", trusted_owner_id: "ou_owner", batch_code: "BATCH-CANARY-01",
    requested_mode: "worker_read_only", event_id: "event-1", request_id: "request-1",
  };
  const [command] = adapter.buildCanonicalJobCommands(plan, admission);
  assert.equal(command.title, "One");
  assert.equal(command.payload.original_request_text, "request");
  assert.equal(command.payload.plan_objective, "objective");
  assert.equal(command.payload.aggregation_policy, "all_required");
  assert.deepEqual(command.payload.canonical_canary_admission, admission);
});
test("canonical runtime delegation fails closed without persistence", async () => {
  await assert.rejects(() => delegation.runApprovedRequestThroughCanonicalHermes(
    {}, {}, {}, async () => null,
    {
      env: { HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true" },
      canonicalPersistenceReady: false,
      canaryAdmission: { allowed: true, reason_code: "ALLOW" },
    }
  ), /CANONICAL_PERSISTENCE_RUNTIME_REQUIRED/);
});
test("first Canary approval creates exactly one admitted Hermes job", async () => {
  const created = [];
  const result = await delegation.runApprovedRequestThroughCanonicalHermes(
    {
      request_id: "approval-03c1", original_request_text: "verify runtime",
      project_domain: "automation_system", requested_mode: "worker_read_only",
      approval_context: { approved_by: "boss" }, objective: "verify runtime",
    },
    { async plan() { return {
      objective: "verify runtime", aggregation_policy: "all_required",
      subtasks: [
        { subtask_id: "inspect", title: "Inspect", objective: "Inspect", dependencies: [], recommended_agent: "test_agent", required_capabilities: ["test"], execution_intent: "verification", allowed_paths: [], forbidden_paths: [], acceptance_criteria: ["ok"], validation_requirements: ["tests"], git_commit_required: false, git_push_required: false, deployment_required: false },
      ],
    }; } },
    { async resolveAgentCapabilities(request) { return { selected_agent: request.required_capabilities[0] === "test" ? "test_agent" : "documentation_agent", provider: "registry", model: null, capabilities: request.required_capabilities, confidence: 1, reason: "test" }; } },
    async (command) => { created.push(command); return { id: command.payload.subtask_id }; },
    {
      env: { HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true" },
      canonicalPersistenceReady: true,
      canaryAdmission: {
        allowed: true, reason_code: "ALLOW", policy_id: "CANARY-01",
        trusted_owner_match: true, batch_match: true, mode_match: true, one_shot_available: true,
        admission: {
          policy_id: "CANARY-01", trusted_owner_id: "ou_owner", batch_code: "BATCH-CANARY-01",
          requested_mode: "worker_read_only", event_id: "event-1", request_id: "approval-03c1",
        },
      },
    }
  );
  assert.equal(result.reason, "canonical_jobs_created");
  assert.equal(created.length, 1);
  assert.equal(created.every((command) => command.source === "hermes_canonical_orchestration"), true);
});
test("canonical direct bypass only permits explicit maintenance", () => {
  assert.equal(delegation.canonicalHermesAllowsDirectWorkerBypass({ featureEnabled: true, explicitMaintenanceOperation: false }), false);
  assert.equal(delegation.canonicalHermesAllowsDirectWorkerBypass({ featureEnabled: true, explicitMaintenanceOperation: true }), true);
});
