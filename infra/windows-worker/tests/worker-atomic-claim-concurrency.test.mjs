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
const CONCURRENCY_ROUNDS = 20;
const CLAIMED_AT = "2026-08-02T12:00:00.000Z";
const EXPIRES_AT = "2999-08-02T12:05:00.000Z";

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

const workerJobs = loadTypeScriptModule(path.join(root, "src", "lib", "worker-jobs.ts"), {
  "next/server": { NextRequest: class NextRequest {}, NextResponse: class NextResponse {} },
  "@/lib/env": { getSupabaseService: async () => null },
  "../../infra/tencent-worker/worker_job_state_machine": machine,
  "../../infra/tencent-worker/worker_terminal_finalizer": terminalFinalizer,
  "./worker-job-persistence-contract": { isCanonicalDatabasePersistenceEnabled: () => false },
  "./hermes/result-aggregator": {},
  "./hermes/execution-plan": {},
  "./hermes/shadow-runtime": { getCompletedHermesShadowObservation: () => null },
  "./project-director-final-report": {},
});

function createQueuedJob(round) {
  return {
    id: `atomic-claim-${round}`,
    status: "queued",
    claimed_by: null,
    attempt_id: null,
    active_attempt_id: null,
    lease_id: null,
    active_lease_id: null,
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

function createStartBarrier(participants) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    async arrive() {
      arrived += 1;
      if (arrived === participants) release();
      await gate;
    },
    get arrived() {
      return arrived;
    },
  };
}

function parsePostgrestAlternative(expression) {
  const [field, operator, ...rawValue] = expression.split(".");
  const value = rawValue.join(".");
  if (operator === "is" && value === "null") return (row) => row[field] === null;
  if (operator === "eq") return (row) => String(row[field]) === value;
  throw new Error(`unsupported PostgREST predicate: ${expression}`);
}

function createAtomicPostgrestStore(initialRow) {
  let row = structuredClone(initialRow);
  let writeTail = Promise.resolve();
  let updateCalls = 0;
  const startBarrier = createStartBarrier(2);

  return {
    get row() {
      return structuredClone(row);
    },
    get updateCalls() {
      return updateCalls;
    },
    get concurrentArrivals() {
      return startBarrier.arrived;
    },
    from(table) {
      assert.equal(table, "hermes_jobs");
      const filters = [];
      let patch = null;
      return {
        update(value) {
          patch = structuredClone(value);
          updateCalls += 1;
          return this;
        },
        eq(field, value) {
          filters.push((candidate) => candidate[field] === value);
          return this;
        },
        in(field, values) {
          filters.push((candidate) => values.includes(candidate[field]));
          return this;
        },
        is(field, value) {
          filters.push((candidate) => candidate[field] === value);
          return this;
        },
        or(expression) {
          const alternatives = expression.split(",").map(parsePostgrestAlternative);
          filters.push((candidate) => alternatives.some((matches) => matches(candidate)));
          return this;
        },
        select() {
          return this;
        },
        async maybeSingle() {
          assert.ok(patch, "production claim helper must issue an update");
          await startBarrier.arrive();
          const applyAtomicUpdate = async () => {
            if (!filters.every((matches) => matches(row))) return { data: null, error: null };
            row = { ...row, ...structuredClone(patch) };
            return { data: structuredClone(row), error: null };
          };
          const result = writeTail.then(applyAtomicUpdate);
          writeTail = result.then(() => undefined, () => undefined);
          return result;
        },
      };
    },
  };
}

function buildProductionClaim(job, workerId, attemptId) {
  const transition = machine.claimJob(job, {
    worker_id: workerId,
    attempt_id: attemptId,
    lease_id: `lease:${attemptId}`,
    now: CLAIMED_AT,
    expires_at: EXPIRES_AT,
  });
  assert.equal(transition.ok, true);
  assert.ok(transition.patch);
  return transition.patch;
}

test("real production atomic claim gives two workers one winner", async () => {
  for (let round = 1; round <= CONCURRENCY_ROUNDS; round += 1) {
    const initialJob = createQueuedJob(round);
    const store = createAtomicPostgrestStore(initialJob);
    const workers = ["worker-a", "worker-b"];
    const attempts = [`attempt-${round}-a`, `attempt-${round}-b`];
    const claims = workers.map((workerId, index) => workerJobs.claimHermesJob(
      store,
      initialJob.id,
      workerId,
      buildProductionClaim(initialJob, workerId, attempts[index]),
      { updated_at: initialJob.updated_at }
    ));

    const settled = await Promise.allSettled(claims);
    assert.equal(store.concurrentArrivals, 2);
    assert.equal(store.updateCalls, 2);
    assert.equal(settled.every((entry) => entry.status === "fulfilled"), true);

    const results = settled.map((entry) => entry.value);
    const winners = results.filter((result) => result.data !== null && result.error === null);
    const losers = results.filter((result) => result.data === null && result.error === null);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);

    const finalJob = store.row;
    const invariant = machine.validateJobStateInvariant(finalJob, { now: CLAIMED_AT });
    const snapshot = invariant.snapshot;
    assert.equal(invariant.ok, true);
    assert.equal(snapshot.state, "claimed");
    assert.equal(workers.includes(snapshot.claimed_by), true);
    assert.equal(snapshot.active_attempt ? 1 : 0, 1);
    assert.equal(snapshot.active_lease ? 1 : 0, 1);
    assert.equal(snapshot.active_attempt.worker_id, snapshot.claimed_by);
    assert.equal(snapshot.active_lease.worker_id, snapshot.claimed_by);
    assert.equal(snapshot.active_lease.attempt_id, snapshot.active_attempt.id);
    assert.equal(machine.isCanonicalClaimPersisted(finalJob, snapshot.active_attempt.id), true);

    const winningIndex = workers.indexOf(snapshot.claimed_by);
    assert.equal(snapshot.active_attempt.id, attempts[winningIndex]);
    assert.equal(snapshot.active_lease.id, `lease:${attempts[winningIndex]}`);
  }
});
