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
const terminalFinalizer = require(path.join(root, "infra", "tencent-worker", "worker_terminal_finalizer.js"));
const NOW = "2026-08-02T12:00:00.000Z";
const CLAIMED_AT = "2026-08-02T11:00:00.000Z";
const EXPIRES_AT = "2099-08-02T13:00:00.000Z";

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
  const localRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    return require(id);
  };
  new Function("require", "module", "exports", output)(
    localRequire,
    compiledModule,
    compiledModule.exports
  );
  return compiledModule.exports;
}

const nextServer = {
  NextRequest: class NextRequest {},
  NextResponse: {
    json(body, options = {}) {
      return { body, status: options.status ?? 200 };
    },
  },
};

const workerJobs = loadTypeScriptModule(path.join(root, "src", "lib", "worker-jobs.ts"), {
  "next/server": nextServer,
  "@/lib/env": { getSupabaseService: async () => null },
  "../../infra/tencent-worker/worker_job_state_machine": machine,
  "../../infra/tencent-worker/worker_terminal_finalizer": terminalFinalizer,
  "./worker-job-persistence-contract": { isCanonicalDatabasePersistenceEnabled: () => false },
  "./hermes/result-aggregator": {},
  "./hermes/execution-plan": {},
  "./project-director-final-report": {},
});

function queuedJob() {
  return {
    id: "job-a",
    status: "queued",
    claimed_by: null,
    updated_at: CLAIMED_AT,
    payload: { payload_marker: "current" },
    result: {
      audit_marker: "current",
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
  const claim = machine.claimJob(queued, {
    worker_id: workerId,
    attempt_id: attemptId,
    lease_id: `lease:${attemptId}`,
    now: CLAIMED_AT,
    expires_at: EXPIRES_AT,
  });
  return { ...queued, ...claim.patch };
}

function terminalJob(state) {
  const claimed = claimedJob();
  const finalization = machine.finalizeJob(claimed, {
    attempt_id: "attempt-a",
    worker_execution_status: state === "terminal_failed" ? "failed" : "succeeded",
    task_goal_status: state === "terminal_failed" ? "failed" : "succeeded",
    effective_final_status: state,
    now: NOW,
  });
  return { ...claimed, ...finalization.patch };
}

function rollback(job, overrides = {}) {
  return machine.rollbackFailedClaim(job, {
    job_id: "job-a",
    worker_id: "Worker-A",
    attempt_id: "attempt-a",
    expected_updated_at: job.updated_at,
    now: NOW,
    ...overrides,
  });
}

function createSupabaseStore(initialJob, options = {}) {
  let job = structuredClone(initialJob);
  let readCount = 0;
  const api = {
    get job() {
      return job;
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
          this.patch = patch;
          return this;
        },
        eq(field, value) {
          this.filters.push([field, value]);
          return this;
        },
        in() {
          return this;
        },
        is() {
          return this;
        },
        order() {
          return this;
        },
        async limit() {
          return { data: [structuredClone(job)], error: null };
        },
        async maybeSingle() {
          if (this.operation === "update") {
            if (options.onUpdate) {
              const handled = await options.onUpdate({ api, query: this, job: structuredClone(job) });
              if (handled) return handled;
            }
            const matches = this.filters.every(([field, value]) => job[field] === value);
            if (!matches) return { data: null, error: null };
            job = { ...job, ...structuredClone(this.patch) };
            return { data: structuredClone(job), error: null };
          }
          readCount += 1;
          if (options.onRead) await options.onRead({ api, readCount });
          return { data: structuredClone(job), error: null };
        },
      };
      return query;
    },
  };
  return api;
}

test("terminal success wins over failed claim rollback", () => {
  const job = terminalJob("terminal_success");
  const before = structuredClone(job);
  const result = rollback(job);
  assert.equal(result.terminal_report_won, true);
  assert.equal(result.patch, null);
  assert.deepEqual(job, before);
});

test("terminal failure wins over failed claim rollback", () => {
  const result = rollback(terminalJob("terminal_failed"));
  assert.equal(result.rollback_skipped_reason, "JOB_ALREADY_TERMINAL");
  assert.equal(result.patch, null);
});

test("terminal cancellation wins over failed claim rollback", () => {
  const result = rollback(terminalJob("terminal_cancelled"));
  assert.equal(result.terminal_immutable, true);
  assert.equal(result.patch, null);
});

test("unchanged failed claim rolls back with a field-level canonical transition", async () => {
  const claimed = claimedJob();
  const result = rollback(claimed);
  const rolledBack = { ...claimed, ...result.patch };
  assert.equal(result.ok, true);
  assert.equal(result.patch.status, "queued");
  assert.equal(result.patch.result.job_state_machine.active_attempt, null);
  assert.equal(result.patch.result.job_state_machine.active_lease, null);
  assert.equal(machine.validateJobStateInvariant(rolledBack, { now: NOW }).ok, true);
  const store = createSupabaseStore(claimed);
  const persisted = await workerJobs.rollbackFailedClaimSafely(store, {
    job_id: "job-a",
    worker_id: "Worker-A",
    attempt_id: "attempt-a",
    now: NOW,
  });
  assert.equal(persisted.rollback_applied, true);
  assert.equal(machine.isJobSelectable(store.job, { now: NOW }), true);
});

test("rollback denies transferred worker ownership", () => {
  const job = claimedJob("Worker-B", "attempt-a");
  const result = rollback(job);
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "ROLLBACK_OWNERSHIP_CHANGED");
  assert.equal(result.patch, null);
});

test("rollback denies a changed active attempt", () => {
  const job = claimedJob("Worker-A", "attempt-b");
  const result = rollback(job);
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "ROLLBACK_ATTEMPT_CHANGED");
});

test("rollback denies an updated_at version change", () => {
  const job = claimedJob();
  const result = rollback(job, { expected_updated_at: "2026-08-02T10:00:00.000Z" });
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "ROLLBACK_VERSION_CHANGED");
});

test("zero-row rollback recheck treats terminal as a won race", async () => {
  const store = createSupabaseStore(claimedJob(), {
    onUpdate({ api }) {
      api.job = terminalJob("terminal_success");
      return { data: null, error: null };
    },
  });
  const result = await workerJobs.rollbackFailedClaimSafely(store, {
    job_id: "job-a",
    worker_id: "Worker-A",
    attempt_id: "attempt-a",
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.rollback_applied, false);
  assert.equal(result.terminal_report_won, true);
});

test("zero-row rollback recheck fails closed after ownership changes", async () => {
  const store = createSupabaseStore(claimedJob(), {
    onUpdate({ api }) {
      api.job = claimedJob("Worker-B", "attempt-b");
      return { data: null, error: null };
    },
  });
  const result = await workerJobs.rollbackFailedClaimSafely(store, {
    job_id: "job-a",
    worker_id: "Worker-A",
    attempt_id: "attempt-a",
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "ROLLBACK_OWNERSHIP_CHANGED");
});

test("rollback never restores terminal or result fields from an old snapshot", () => {
  const job = claimedJob();
  const result = rollback(job, {
    old_snapshot: {
      status: "failed",
      result: { terminal_state: "terminal_failed", stale_marker: true },
      payload: { stale_marker: true },
    },
  });
  assert.equal(result.patch.result.audit_marker, "current");
  assert.equal(result.patch.result.stale_marker, undefined);
  assert.equal(result.patch.payload.payload_marker, "current");
  assert.equal(result.patch.payload.stale_marker, undefined);
});

test("duplicate terminal report keeps first truth ahead of rollback", () => {
  const terminal = terminalJob("terminal_failed");
  const duplicate = machine.finalizeJob(terminal, {
    attempt_id: "attempt-a",
    worker_execution_status: "failed",
    task_goal_status: "failed",
    effective_final_status: "terminal_failed",
    now: NOW,
  });
  const persisted = { ...terminal, ...duplicate.patch };
  const result = rollback(persisted);
  assert.equal(machine.normalizeJobState(persisted), "terminal_failed");
  assert.equal(result.patch, null);
});

test("production next handler preserves a concurrent terminal report", async () => {
  const queued = queuedJob();
  const malformedClaim = claimedJob();
  malformedClaim.result.job_state_machine.active_attempt.id = "attempt-other";
  const terminal = terminalJob("terminal_success");
  const store = createSupabaseStore(queued, {
    onRead({ api, readCount }) {
      if (readCount === 3) api.job = terminal;
    },
  });
  const routeWorkerJobs = {
    ...workerJobs,
    assertWorkerAuthorized: () => null,
    getWorkerSupabase: async () => store,
    responseFromMaybe: () => null,
    getWorkerIdFromRequest: () => "Worker-A",
    createWorkerAttemptId: () => "attempt-a",
    claimHermesJob: async () => {
      store.job = malformedClaim;
      return { data: structuredClone(malformedClaim), error: null, skippedColumns: [] };
    },
  };
  const route = loadTypeScriptModule(
    path.join(root, "src", "app", "api", "worker", "next", "route.ts"),
    {
      "next/server": nextServer,
      "@/lib/feishu-worker-sync": { syncWorkerStatusToFeishu: async () => ({ ok: true }) },
      "@/lib/worker-jobs": routeWorkerJobs,
    }
  );
  const response = await route.POST({});
  assert.equal(response.body.terminal_report_won, true);
  assert.equal(response.body.rollback_applied, false);
  assert.equal(machine.normalizeJobState(store.job), "terminal_success");
});
