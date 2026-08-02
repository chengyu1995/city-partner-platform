import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const machine = require(path.join(root, "infra", "tencent-worker", "worker_job_state_machine.js"));
const CLAIMED_AT = "2026-08-02T10:00:00.000Z";
const EXPIRES_AT = "2999-08-02T11:00:00.000Z";
const TERMINAL_AT = "2026-08-02T10:30:00.000Z";

function loadTypeScriptModule(file, mocks) {
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
  const compiledModule = { exports: {} };
  const localRequire = (id) => Object.hasOwn(mocks, id) ? mocks[id] : require(id);
  new Function("require", "module", "exports", output)(localRequire, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}

class MockNextResponse {
  constructor(body, status = 200) {
    this.body = body;
    this.status = status;
  }

  static json(body, options = {}) {
    return new MockNextResponse(body, options.status ?? 200);
  }
}

const nextServer = {
  NextRequest: class NextRequest {},
  NextResponse: MockNextResponse,
};

const workerJobs = loadTypeScriptModule(path.join(root, "src", "lib", "worker-jobs.ts"), {
  "next/server": nextServer,
  "@/lib/env": { getSupabaseService: async () => null },
  "../../infra/tencent-worker/worker_job_state_machine": machine,
});

function queuedJob() {
  return {
    id: "job-report-cas",
    status: "queued",
    claimed_by: null,
    updated_at: CLAIMED_AT,
    payload: {},
    result: {
      job_state_machine: {
        version: 1,
        job_state: "queued",
        selectable: true,
        active_attempt: null,
        active_lease: null,
        attempt_history: [],
        lease_history: [],
      },
    },
  };
}

function claimedJob(workerId = "Worker-A", attemptId = "attempt-a") {
  const queued = queuedJob();
  const transition = machine.claimJob(queued, {
    worker_id: workerId,
    attempt_id: attemptId,
    lease_id: `lease:${attemptId}`,
    now: CLAIMED_AT,
    expires_at: EXPIRES_AT,
  });
  return { ...queued, ...transition.patch };
}

function createSupabaseStore(initialJob, options = {}) {
  let job = structuredClone(initialJob);
  let writeTail = Promise.resolve();
  const api = {
    get job() {
      return structuredClone(job);
    },
    set job(value) {
      job = structuredClone(value);
    },
    from() {
      const query = {
        operation: "select",
        patch: null,
        filters: [],
        select() {
          return this;
        },
        update(patch) {
          this.operation = "update";
          this.patch = structuredClone(patch);
          return this;
        },
        eq(field, value) {
          this.filters.push([field, value]);
          return this;
        },
        async maybeSingle() {
          if (this.operation !== "update") {
            return { data: structuredClone(job), error: null };
          }
          const runWrite = async () => {
            if (options.onUpdate) {
              const handled = await options.onUpdate({ api, query: this, job: structuredClone(job) });
              if (handled) return handled;
            }
            const matches = this.filters.every(([field, value]) => job[field] === value);
            if (!matches) return { data: null, error: null };
            job = { ...job, ...structuredClone(this.patch) };
            return { data: structuredClone(job), error: null };
          };
          const result = writeTail.then(runWrite);
          writeTail = result.then(() => undefined, () => undefined);
          return result;
        },
      };
      return query;
    },
  };
  return api;
}

function request(body) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer,
  };
}

function reportBody(status, overrides = {}) {
  const failed = status === "failed";
  return {
    job_id: "job-report-cas",
    worker_id: "Worker-A",
    attempt_id: "attempt-a",
    status,
    worker_execution_status: failed ? "failed" : "succeeded",
    task_goal_status: failed ? "failed" : status,
    effective_final_status: status,
    failure_code: failed ? "FIRST_FAILURE" : null,
    failure_stage: failed ? "first_failure_stage" : null,
    final_report_source: `report-${status}`,
    ...overrides,
  };
}

function loadReportRoute(store) {
  return loadTypeScriptModule(path.join(root, "src", "app", "api", "worker", "report", "route.ts"), {
    "next/server": nextServer,
    "@/lib/feishu-worker-sync": { syncWorkerStatusToFeishu: async () => ({ ok: true }) },
    "@/lib/worker-jobs": {
      ...workerJobs,
      assertWorkerAuthorized: () => null,
      getWorkerSupabase: async () => store,
    },
  });
}

function terminalInput(status, overrides = {}) {
  const failed = status === "failed" || status === "terminal_failed";
  return {
    job_id: "job-report-cas",
    worker_id: "Worker-A",
    attempt_id: "attempt-a",
    report_identity: `report:${status}`,
    worker_execution_status: failed ? "failed" : "succeeded",
    task_goal_status: failed ? "failed" : status,
    effective_final_status: status,
    report_fields: {
      result: {
        worker_id: "Worker-A",
        failure_code: failed ? "FIRST_FAILURE" : null,
        failure_stage: failed ? "first_failure_stage" : null,
        final_report_source: `report-${status}`,
      },
    },
    now: TERMINAL_AT,
    ...overrides,
  };
}

test("two simultaneous success reports produce one canonical terminal truth", async () => {
  const store = createSupabaseStore(claimedJob());
  const route = loadReportRoute(store);
  const responses = await Promise.all([
    route.POST(request(reportBody("succeeded"))),
    route.POST(request(reportBody("succeeded"))),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200]);
  assert.equal(machine.normalizeJobState(store.job), "terminal_success");
  assert.equal(responses.some((response) => response.body.duplicate_report_idempotent === true), true);
});

test("simultaneous success and failure preserve the first success", async () => {
  const store = createSupabaseStore(claimedJob());
  const route = loadReportRoute(store);
  const [success, failure] = await Promise.all([
    route.POST(request(reportBody("succeeded"))),
    route.POST(request(reportBody("failed"))),
  ]);
  assert.equal(success.status, 200);
  assert.equal(failure.status, 409);
  assert.equal(machine.normalizeJobState(store.job), "terminal_success");
});

test("simultaneous failure and success preserve failure fields from the first report", async () => {
  const store = createSupabaseStore(claimedJob());
  const route = loadReportRoute(store);
  const [failure, success] = await Promise.all([
    route.POST(request(reportBody("failed"))),
    route.POST(request(reportBody("succeeded"))),
  ]);
  assert.equal(failure.status, 200);
  assert.equal(success.status, 409);
  assert.equal(machine.normalizeJobState(store.job), "terminal_failed");
  assert.equal(store.job.result.failure_code, "FIRST_FAILURE");
  assert.equal(store.job.result.failure_stage, "first_failure_stage");
  assert.equal(store.job.result.final_report_source, "report-failed");
});

test("simultaneous cancellation and success preserve the first cancellation", async () => {
  const store = createSupabaseStore(claimedJob());
  const route = loadReportRoute(store);
  const [cancelled, success] = await Promise.all([
    route.POST(request(reportBody("cancelled"))),
    route.POST(request(reportBody("succeeded"))),
  ]);
  assert.equal(cancelled.status, 200);
  assert.equal(success.status, 409);
  assert.equal(machine.normalizeJobState(store.job), "terminal_cancelled");
});

test("a stale attempt report cannot overwrite the current attempt", async () => {
  const store = createSupabaseStore(claimedJob("Worker-A", "attempt-b"));
  const route = loadReportRoute(store);
  const [stale, current] = await Promise.all([
    route.POST(request(reportBody("failed", { attempt_id: "attempt-a" }))),
    route.POST(request(reportBody("succeeded", { attempt_id: "attempt-b" }))),
  ]);
  assert.equal(stale.status, 409);
  assert.equal(current.status, 200);
  assert.equal(machine.normalizeJobState(store.job), "terminal_success");
});

test("terminal report wins over failed-claim rollback", async () => {
  const claimed = claimedJob();
  const store = createSupabaseStore(claimed);
  const terminal = await workerJobs.finalizeCanonicalJobReportSafely(store, terminalInput("succeeded"));
  const rollback = await workerJobs.rollbackFailedClaimSafely(store, {
    job_id: claimed.id,
    worker_id: "Worker-A",
    attempt_id: "attempt-a",
    now: TERMINAL_AT,
  });
  assert.equal(terminal.terminal_applied, true);
  assert.equal(rollback.terminal_report_won, true);
  assert.equal(machine.normalizeJobState(store.job), "terminal_success");
});

test("terminal report wins over a stale heartbeat CAS", async () => {
  const claimed = claimedJob();
  const heartbeat = workerJobs.buildCanonicalHeartbeatTransition(claimed, {
    worker_id: "Worker-A",
    attempt_id: "attempt-a",
    now: TERMINAL_AT,
    expires_at: EXPIRES_AT,
  });
  const store = createSupabaseStore(claimed);
  await workerJobs.finalizeCanonicalJobReportSafely(store, terminalInput("succeeded"));
  const stale = await workerJobs.updateCanonicalHermesJob(store, claimed.id, heartbeat.patch, claimed.updated_at);
  assert.equal(stale.data, null);
  assert.equal(machine.normalizeJobState(store.job), "terminal_success");
});

test("terminal report wins over a stale progress CAS", async () => {
  const claimed = claimedJob();
  const progress = workerJobs.buildCanonicalProgressTransition(claimed, {
    worker_id: "Worker-A",
    attempt_id: "attempt-a",
    now: TERMINAL_AT,
    progress_percent: 90,
    current_step: "almost done",
  });
  const store = createSupabaseStore(claimed);
  await workerJobs.finalizeCanonicalJobReportSafely(store, terminalInput("failed"));
  const stale = await workerJobs.updateCanonicalHermesJob(store, claimed.id, progress.patch, claimed.updated_at);
  assert.equal(stale.data, null);
  assert.equal(machine.normalizeJobState(store.job), "terminal_failed");
});

test("terminal report wins over stale recovery persistence", async () => {
  const claimed = claimedJob();
  const recovery = machine.recoverStaleAttempt(claimed, {
    now: "3000-08-02T12:00:00.000Z",
    expected_attempt_id: "attempt-a",
    expected_worker_id: "Worker-A",
    retry_allowed: true,
  });
  assert.equal(recovery.ok, true);
  const store = createSupabaseStore(claimed);
  await workerJobs.finalizeCanonicalJobReportSafely(store, terminalInput("succeeded"));
  const stale = await workerJobs.updateCanonicalHermesJob(store, claimed.id, recovery.patch, claimed.updated_at);
  assert.equal(stale.data, null);
  assert.equal(machine.normalizeJobState(store.job), "terminal_success");
});

test("zero-row terminal CAS recheck fails closed after ownership changes", async () => {
  const store = createSupabaseStore(claimedJob(), {
    onUpdate({ api }) {
      api.job = claimedJob("Worker-B", "attempt-b");
      return { data: null, error: null };
    },
  });
  const result = await workerJobs.finalizeCanonicalJobReportSafely(store, terminalInput("succeeded"));
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "TERMINAL_REPORT_OWNERSHIP_CHANGED");
});

test("zero-row terminal CAS recheck fails closed after attempt changes", async () => {
  const store = createSupabaseStore(claimedJob(), {
    onUpdate({ api }) {
      api.job = claimedJob("Worker-A", "attempt-b");
      return { data: null, error: null };
    },
  });
  const result = await workerJobs.finalizeCanonicalJobReportSafely(store, terminalInput("succeeded"));
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "TERMINAL_REPORT_ATTEMPT_CHANGED");
});

test("zero-row terminal CAS recheck rejects an invalid state without retry", async () => {
  const invalid = claimedJob();
  invalid.status = "queued";
  invalid.result.job_state_machine.job_state = "queued";
  const store = createSupabaseStore(claimedJob(), {
    onUpdate({ api }) {
      api.job = invalid;
      return { data: null, error: null };
    },
  });
  const result = await workerJobs.finalizeCanonicalJobReportSafely(store, terminalInput("succeeded"));
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "JOB_STATE_INVARIANT_VIOLATION");
  assert.equal(machine.normalizeJobState(store.job), "queued");
});

test("report route has one terminal authority and no generic terminal update", () => {
  const route = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "report", "route.ts"), "utf8");
  assert.equal((route.match(/finalizeCanonicalJobReportSafely\(supabase/g) || []).length, 1);
  assert.match(route, /terminal\s*\?\s*\{[\s\S]*terminalFinalization\?\.job/);
  assert.match(route, /:\s*await updateHermesJob\(supabase, jobId, reportFields\)/);
  assert.doesNotMatch(route, /updateHermesJob\(supabase,\s*jobId,\s*\{[\s\S]*status:\s*terminal/);
});
