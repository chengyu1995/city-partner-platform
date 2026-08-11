import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const fixture = readFileSync(join(root, "infra/windows-worker/tests/fixtures/production-hermes-jobs-schema.sql"), "utf8");
const migration = readFileSync(join(root, "supabase/migrations/202608110001_canonical_canary_admission_control.sql"), "utf8");
const contract = readFileSync(join(root, "src/lib/hermes/canonical-job-insert-contract.ts"), "utf8");
const nextPersistence = readFileSync(join(root, "src/lib/worker-jobs.ts"), "utf8");
const tencentPersistence = readFileSync(join(root, "infra/tencent-worker/worker_canonical_persistence.js"), "utf8");

const productionColumns = [...fixture.matchAll(/^\s{2}([a-z][a-z0-9_]*)\s+(?:uuid|text|timestamptz|integer|jsonb|bigint)\b/gm)]
  .map((match) => match[1]);

test("Production fixture records the complete 53-column catalog snapshot", () => {
  assert.equal(productionColumns.length, 53);
  assert.equal(new Set(productionColumns).size, 53);
  assert.deepEqual(productionColumns.slice(0, 4), ["id", "source", "request_text", "status"]);
  assert.deepEqual(productionColumns.slice(-6), ["canonical_job_state", "canonical_revision", "requested_mode", "plan_id", "subtask_id", "terminal_at"]);
});

test("Production fixture required insert contract is request_text only", () => {
  assert.match(fixture, /^\s{2}request_text text not null,/m);
  assert.doesNotMatch(fixture, /^\s{2}title\b/m);
  assert.doesNotMatch(fixture, /^\s{2}payload\b/m);
  assert.match(fixture, /^\s{2}result jsonb null,/m);
});

test("admission migration references only observed Production columns", () => {
  const insert = migration.match(/insert into public\.hermes_jobs \(([^)]+)\) values/s);
  assert.ok(insert);
  const insertColumns = insert[1].split(",").map((value) => value.trim()).filter(Boolean);
  assert.deepEqual(insertColumns, [
    "id", "source", "request_text", "status", "result", "source_event_id", "source_message_id",
    "requester_id", "feishu_event_id", "feishu_message_id", "canonical_job_state", "canonical_revision",
    "requested_mode", "plan_id", "subtask_id", "terminal_at",
  ]);
  assert.equal(insertColumns.every((column) => productionColumns.includes(column)), true);
});

test("reconciliation is schema-inert for hermes_jobs", () => {
  assert.doesNotMatch(migration, /alter table public\.hermes_jobs/i);
  assert.doesNotMatch(migration, /add column[^;]*(title|payload)/i);
  assert.doesNotMatch(migration, /jsonb_populate_record/i);
});

test("Canonical context uses existing result JSON storage", () => {
  assert.match(migration, /p_job->'state_snapshot'\s*\|\|\s*jsonb_build_object\('canonical_context', p_job->'canonical_context'\)/i);
  assert.match(contract, /canonical_context: Record<string, unknown>/);
  assert.doesNotMatch(contract, /^\s{2}title: string;/m);
  assert.doesNotMatch(contract, /^\s{2}payload: Record<string, unknown>;/m);
});

test("both Canonical persistence runtimes read result.canonical_context", () => {
  assert.match(nextPersistence, /readRecord\(result\?\.canonical_context\)/);
  assert.match(tencentPersistence, /result\.canonical_context/);
  assert.match(tencentPersistence, /job: \{ \.\.\.job, payload,/);
  assert.match(nextPersistence, /\.\.\.candidate,\s*payload,/s);
});

test("Production fixture preserves Canonical selection and terminal contracts", () => {
  assert.match(fixture, /hermes_jobs_canonical_selectable/);
  assert.match(fixture, /canonical_job_state = 'queued'/);
  assert.match(fixture, /terminal_at is null/);
  assert.match(fixture, /hermes_jobs_canonical_revision_check/);
});

test("migration remains admission-only and inert", () => {
  assert.doesNotMatch(migration, /canonical_acquire_attempt_lease|canonical_finalize_terminal/);
  assert.doesNotMatch(migration, /insert into public\.hermes_canonical_canary_policy_rules/i);
  assert.doesNotMatch(migration, /HERMES_CANONICAL_ORCHESTRATION_ENABLED|CANONICAL_DATABASE_PERSISTENCE_ENABLED/);
});
