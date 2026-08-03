import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const migrationPath = join(
  root,
  "supabase/migrations/202608030001_canonical_attempt_lease_foundation.sql"
);
const migration = readFileSync(migrationPath, "utf8");
const contractPath = join(root, "src/lib/worker-job-persistence-contract.ts");
const contractSource = readFileSync(contractPath, "utf8");
const workerJobsSource = readFileSync(join(root, "src/lib/worker-jobs.ts"), "utf8");
const hermesSource = [
  "src/lib/hermes/execution-plan.ts",
  "src/lib/hermes/orchestration-adapter.ts",
  "src/lib/hermes/result-aggregator.ts",
  "src/lib/project-director-hermes-delegation.ts",
].map((file) => readFileSync(join(root, file), "utf8")).join("\n");
const openClawSource = readFileSync(join(root, "src/lib/openclaw/capability-gateway.ts"), "utf8");
const packageJson = readFileSync(join(root, "package.json"), "utf8");
const auditRequirements = readFileSync(
  join(root, "docs/database/canonical-migration-audit-requirements.md"),
  "utf8"
);
const contract = await import(pathToFileURL(contractPath).href);

const NOW = "2026-08-03T10:00:00.000Z";
const ACTIVE = "2026-08-03T10:05:00.000Z";
const EXPIRED = "2026-08-03T09:55:00.000Z";

function snapshot(overrides = {}) {
  const job = {
    job_id: "11111111-1111-4111-8111-111111111111",
    job_state: "running",
    revision: 7,
    requested_mode: "worker_read_only",
    plan_id: "plan-1",
    subtask_id: "subtask-1",
    created_at: "2026-08-03T09:00:00.000Z",
    updated_at: "2026-08-03T09:59:00.000Z",
    terminal_at: null,
    ...(overrides.job ?? {}),
  };
  const attempt = overrides.active_attempt === undefined ? {
    attempt_id: "attempt-1",
    job_id: job.job_id,
    attempt_number: 1,
    worker_id: "worker-1",
    attempt_state: "running",
    started_at: "2026-08-03T09:50:00.000Z",
    last_activity_at: "2026-08-03T09:59:00.000Z",
    finished_at: null,
    created_at: "2026-08-03T09:50:00.000Z",
    updated_at: "2026-08-03T09:59:00.000Z",
  } : overrides.active_attempt;
  const lease = overrides.active_lease === undefined ? {
    lease_id: "lease-1",
    job_id: job.job_id,
    attempt_id: attempt?.attempt_id ?? "attempt-1",
    worker_id: "worker-1",
    lease_state: "active",
    acquired_at: "2026-08-03T09:50:00.000Z",
    heartbeat_at: "2026-08-03T09:59:00.000Z",
    expires_at: ACTIVE,
    released_at: null,
    created_at: "2026-08-03T09:50:00.000Z",
    updated_at: "2026-08-03T09:59:00.000Z",
  } : overrides.active_lease;
  return { job, active_attempt: attempt, active_lease: lease, terminal: overrides.terminal ?? null };
}

function ownership(overrides = {}) {
  return {
    job_id: "11111111-1111-4111-8111-111111111111",
    attempt_id: "attempt-1",
    worker_id: "worker-1",
    expected_revision: 7,
    now: NOW,
    ...overrides,
  };
}

function terminalRecord() {
  return {
    terminal_id: "22222222-2222-4222-8222-222222222222",
    job_id: "11111111-1111-4111-8111-111111111111",
    attempt_id: "attempt-1",
    worker_id: "worker-1",
    report_identity: "report-1",
    worker_execution_status: "succeeded",
    task_goal_status: "succeeded",
    effective_final_status: "succeeded",
    failure_code: null,
    failure_stage: null,
    terminal_at: NOW,
    canonical_report: {},
    created_at: NOW,
  };
}

test("canonical job, attempt, lease, and terminal contracts exist", () => {
  assert.match(contractSource, /interface CanonicalJobRecord/);
  assert.match(contractSource, /interface CanonicalAttemptRecord/);
  assert.match(contractSource, /interface CanonicalLeaseRecord/);
  assert.match(contractSource, /interface CanonicalTerminalRecord/);
});

test("canonical job contract includes state, revision, plan, mode, and terminal time", () => {
  for (const field of ["job_state", "revision", "requested_mode", "plan_id", "subtask_id", "terminal_at"]) {
    assert.match(contractSource, new RegExp(`\\b${field}:`));
  }
});

test("canonical job database column mapping is explicit and complete", () => {
  assert.deepEqual(contract.CANONICAL_JOB_DATABASE_COLUMN_MAP, {
    job_id: "id",
    job_state: "canonical_job_state",
    revision: "canonical_revision",
    requested_mode: "requested_mode",
    plan_id: "plan_id",
    subtask_id: "subtask_id",
    created_at: "created_at",
    updated_at: "updated_at",
    terminal_at: "terminal_at",
  });
  const mapped = contract.mapCanonicalJobDatabaseRow({
    id: "11111111-1111-4111-8111-111111111111",
    canonical_job_state: "queued",
    canonical_revision: 0,
    requested_mode: "worker_read_only",
    plan_id: "plan-1",
    subtask_id: "subtask-1",
    created_at: NOW,
    updated_at: NOW,
    terminal_at: null,
  });
  assert.equal(mapped.job_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(mapped.job_state, "queued");
  assert.equal(mapped.revision, 0);
});

test("terminal persistence uses worker execution status consistently", () => {
  assert.match(contractSource, /worker_execution_status: string/);
  assert.doesNotMatch(contractSource, /\bworker_status\b/);
  assert.match(migration, /worker_execution_status text not null/i);
  assert.match(migration, /p_worker_execution_status text/i);
  assert.doesNotMatch(migration, /\bworker_status\b/i);
});

test("migration indexes preserve history without redundant attempt indexes", () => {
  assert.doesNotMatch(migration, /create index if not exists hermes_job_attempts_history/i);
  assert.doesNotMatch(migration, /unique \(job_id, report_identity\)/i);
  assert.match(
    migration,
    /create index if not exists hermes_job_leases_attempt_history\s+on public\.hermes_job_leases\(attempt_id, created_at\)/i
  );
});

test("all security definer functions use the fixed safe search path", () => {
  assert.equal((migration.match(/security definer/gi) ?? []).length, 4);
  assert.equal((migration.match(/set search_path = public, pg_temp/gi) ?? []).length, 4);
  assert.doesNotMatch(migration, /set search_path = public\s*\n/i);
});

test("first terminal truth has one named constraint and idempotent duplicate handling", () => {
  assert.match(migration, /constraint hermes_job_terminals_first_truth_per_job unique \(job_id\)/i);
  assert.equal((migration.match(/hermes_job_terminals_first_truth_per_job/gi) ?? []).length, 1);
  assert.doesNotMatch(migration, /unique \(job_id, report_identity\)/i);
  assert.match(migration, /where job_id = p_job_id;[\s\S]*if found then[\s\S]*'idempotent', true/i);
  assert.match(auditRequirements, /pg_catalog\.pg_constraint/);
  assert.match(auditRequirements, /function and schema ACL metadata/i);
});

test("attempt ids are unique database identities", () => {
  assert.match(migration, /attempt_id text primary key/i);
  assert.match(migration, /unique \(job_id, attempt_id\)/i);
});

test("only one active attempt is allowed per job", () => {
  assert.match(migration, /hermes_job_attempts_one_active_per_job[\s\S]*where attempt_state in \('claimed', 'running'\)/i);
});

test("attempt history is preserved instead of replaced", () => {
  assert.match(migration, /attempt_number bigint not null/);
  assert.match(migration, /unique \(job_id, attempt_number\)/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.hermes_job_attempts/i);
});

test("lease ids are unique database identities", () => {
  assert.match(migration, /lease_id text primary key/i);
});

test("only one active lease is allowed per attempt", () => {
  assert.match(migration, /hermes_job_leases_one_active_per_attempt[\s\S]*where lease_state = 'active'/i);
});

test("only one active lease is allowed per job", () => {
  assert.match(migration, /hermes_job_leases_one_active_per_job[\s\S]*where lease_state = 'active'/i);
});

test("attempt and lease foreign keys preserve ownership topology", () => {
  assert.match(migration, /references public\.hermes_jobs\(id\) on delete restrict/i);
  assert.match(migration, /references public\.hermes_job_attempts\(job_id, attempt_id\) on delete restrict/i);
});

test("runtime signal rejects worker ownership mismatch", () => {
  const result = contract.validateRuntimeSignalContract(snapshot(), ownership({ worker_id: "worker-2", signal: "heartbeat" }));
  assert.equal(result.ok, false);
  assert.match(result.failure_code, /WORKER|LEASE/);
});

test("runtime signal rejects attempt mismatch", () => {
  const result = contract.validateRuntimeSignalContract(snapshot(), ownership({ attempt_id: "attempt-2", signal: "progress" }));
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "ATTEMPT_IDENTITY_MISMATCH");
});

test("expired lease cannot heartbeat", () => {
  const current = snapshot({ active_lease: { ...snapshot().active_lease, expires_at: EXPIRED } });
  const result = contract.validateRuntimeSignalContract(current, ownership({ signal: "heartbeat" }));
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "LEASE_EXPIRED");
});

test("finished attempt cannot emit runtime signals or recover", () => {
  const current = snapshot({
    active_attempt: { ...snapshot().active_attempt, attempt_state: "finished", finished_at: NOW },
  });
  const runtime = contract.validateRuntimeSignalContract(current, ownership({ signal: "progress" }));
  const recovery = contract.validateStaleRecoveryContract(current, { ...ownership(), lease_id: "lease-1" });
  assert.equal(runtime.failure_code, "ATTEMPT_NOT_ACTIVE");
  assert.equal(recovery.failure_code, "ATTEMPT_NOT_ACTIVE");
});

test("stale revision is rejected", () => {
  const result = contract.validateRuntimeSignalContract(snapshot(), ownership({ expected_revision: 6, signal: "progress" }));
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "STALE_REVISION");
});

test("updated_at alone cannot satisfy canonical CAS", () => {
  assert.match(contractSource, /expected_revision/);
  assert.doesNotMatch(contractSource, /expected_updated_at/);
  assert.match(migration, /canonical_revision = p_expected_revision/);
});

test("terminal heartbeat is an idempotent no-op", () => {
  const current = snapshot({
    job: { job_state: "terminal_success", terminal_at: NOW },
    active_attempt: null,
    active_lease: null,
    terminal: terminalRecord(),
  });
  const result = contract.validateRuntimeSignalContract(current, ownership({ signal: "heartbeat" }));
  assert.equal(result.ok, true);
  assert.equal(result.terminal_noop, true);
});

test("terminal progress is an idempotent no-op", () => {
  const current = snapshot({
    job: { job_state: "terminal_failed", terminal_at: NOW },
    active_attempt: null,
    active_lease: null,
    terminal: { ...terminalRecord(), effective_final_status: "failed" },
  });
  const result = contract.validateRuntimeSignalContract(current, ownership({ signal: "progress" }));
  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true);
});

test("terminal stale recovery is impossible", () => {
  const current = snapshot({
    job: { job_state: "terminal_cancelled", terminal_at: NOW },
    active_attempt: null,
    active_lease: null,
    terminal: { ...terminalRecord(), effective_final_status: "cancelled" },
  });
  const result = contract.validateStaleRecoveryContract(current, { ...ownership(), lease_id: "lease-1" });
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "TERMINAL_JOB_IMMUTABLE");
});

test("duplicate terminal report returns first truth idempotently", () => {
  assert.match(migration, /where job_id = p_job_id;[\s\S]*if found then[\s\S]*'idempotent', true/i);
  assert.match(migration, /'first_terminal_truth_preserved', true/i);
});

test("failed claim rollback cannot reactivate terminal persistence", () => {
  assert.match(migration, /canonical_recover_stale_attempt[\s\S]*TERMINAL_JOB_IMMUTABLE/i);
  assert.doesNotMatch(migration, /terminal_%'[\s\S]{0,300}canonical_job_state = 'queued'/i);
});

test("stale recovery closes the old lease", () => {
  assert.match(migration, /set lease_state = 'expired',[\s\S]*released_at = p_now/i);
});

test("stale recovery preserves the old attempt as abandoned", () => {
  assert.match(migration, /set attempt_state = 'abandoned',[\s\S]*finished_at = p_now/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.hermes_job_attempts/i);
});

test("a recovery retry receives a caller-supplied new attempt identity", () => {
  const current = snapshot({ job: { job_state: "queued" }, active_attempt: null, active_lease: null });
  const first = contract.validateAtomicClaimContract(current, {
    ...ownership(), attempt_id: "attempt-2", lease_id: "lease-2", expires_at: ACTIVE,
  });
  const second = contract.validateAtomicClaimContract(current, {
    ...ownership(), attempt_id: "attempt-3", lease_id: "lease-3", expires_at: ACTIVE,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual("attempt-2", "attempt-3");
});

test("worker availability alone is not stale-recovery evidence", () => {
  assert.doesNotMatch(contractSource, /worker_available/i);
  const result = contract.validateStaleRecoveryContract(snapshot(), { ...ownership(), lease_id: "lease-1" });
  assert.equal(result.failure_code, "LEASE_NOT_EXPIRED");
});

test("legacy fields are a canonical projection only", () => {
  const projection = contract.buildLegacyJobProjection(snapshot());
  assert.equal(projection.projection_only, true);
  assert.equal(projection.source, "canonical_persistence");
});

test("legacy projection has no inverse canonical mutation API", () => {
  assert.doesNotMatch(contractSource, /canonicalFromLegacy|applyLegacy|legacyToCanonical/i);
});

test("Hermes cannot write attempts", () => {
  assert.doesNotMatch(hermesSource, /hermes_job_attempts|canonicalAcquireAttemptLease|canonical_acquire_attempt_lease/);
});

test("Hermes cannot write leases", () => {
  assert.doesNotMatch(hermesSource, /hermes_job_leases|canonicalPersistRuntimeSignal|canonical_record_runtime_signal/);
});

test("OpenClaw cannot access persistence or Worker API", () => {
  assert.doesNotMatch(openClawSource, /supabase|hermes_jobs|hermes_job_attempts|hermes_job_leases|\/api\/worker|canonicalAcquire/);
});

test("canonicalCreateJob remains the unique recommended job creation path", () => {
  assert.match(workerJobsSource, /export async function canonicalCreateJob/);
  assert.match(workerJobsSource, /canonical_job_state: "queued"/);
  assert.match(workerJobsSource, /canonical_revision: 0/);
  assert.doesNotMatch(contractSource, /\.from\(["']hermes_jobs["']\).*insert/s);
});

test("atomic claim validates then persists attempt, lease, and job under one row lock", () => {
  const claim = migration.match(/create or replace function public\.canonical_acquire_attempt_lease[\s\S]*?end;\n\$\$;/i)?.[0] ?? "";
  assert.match(claim, /for update/i);
  assert.match(claim, /insert into public\.hermes_job_attempts/i);
  assert.match(claim, /insert into public\.hermes_job_leases/i);
  assert.match(claim, /update public\.hermes_jobs/i);
  assert.match(claim, /canonical_revision = p_expected_revision \+ 1/i);
});

test("heartbeat persistence binds job, attempt, worker, lease, and revision", () => {
  const runtime = migration.match(/create or replace function public\.canonical_record_runtime_signal[\s\S]*?end;\n\$\$;/i)?.[0] ?? "";
  for (const evidence of ["p_job_id", "p_attempt_id", "p_worker_id", "p_expected_revision", "lease_state = 'active'", "LEASE_EXPIRED"]) {
    assert.match(runtime, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("progress persistence shares the canonical runtime CAS", () => {
  assert.match(migration, /p_signal not in \('heartbeat', 'progress'\)/i);
  assert.match(contractSource, /signal: "heartbeat" \| "progress"/);
});

test("terminal persistence is one immutable row per job", () => {
  assert.match(migration, /constraint hermes_job_terminals_first_truth_per_job unique \(job_id\)/i);
  assert.match(migration, /insert into public\.hermes_job_terminals/i);
});

test("Worker success cannot override task failure", () => {
  const result = contract.validateTerminalPersistenceContract(snapshot(), {
    ...ownership(),
    report_identity: "report-2",
    terminal_job_state: "terminal_success",
    final_attempt_state: "finished",
    worker_execution_status: "succeeded",
    task_goal_status: "failed",
    effective_final_status: "succeeded",
    failure_code: null,
    failure_stage: null,
    canonical_report: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "TASK_FAILURE_CANNOT_SUCCEED");
});

test("all persistence RPCs use a monotonic expected revision", () => {
  for (const name of [
    "canonical_acquire_attempt_lease",
    "canonical_record_runtime_signal",
    "canonical_finalize_terminal",
    "canonical_recover_stale_attempt",
  ]) {
    const block = migration.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?end;\\n\\$\\$;`, "i"))?.[0] ?? "";
    assert.match(block, /p_expected_revision bigint/i);
    assert.match(block, /canonical_revision = p_expected_revision/i);
    assert.match(block, /canonical_revision = p_expected_revision \+ 1/i);
  }
});

test("database migration creates persistence, not a trigger state machine", () => {
  assert.doesNotMatch(migration, /create\s+trigger/i);
  assert.doesNotMatch(migration, /execute\s+(?:function|procedure)/i);
});

test("canonical history tables and RPCs are service-role only", () => {
  for (const table of ["hermes_job_attempts", "hermes_job_leases", "hermes_job_terminals"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  assert.equal((migration.match(/from public, anon, authenticated/gi) ?? []).length, 4);
  assert.equal((migration.match(/to service_role/gi) ?? []).length, 4);
});

test("migration contains no destructive table or history operations", () => {
  assert.doesNotMatch(migration, /\bdrop\s+table\b/i);
  assert.doesNotMatch(migration, /\bdrop\s+column\b/i);
  assert.doesNotMatch(migration, /\btruncate\b/i);
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
});

test("migration contains no historical backfill", () => {
  const schemaPhase = migration.split("create or replace function public.canonical_acquire_attempt_lease")[0];
  assert.doesNotMatch(schemaPhase, /update\s+public\.hermes_jobs/i);
  assert.doesNotMatch(schemaPhase, /insert\s+into\s+public\.hermes_job_(?:attempts|leases|terminals)/i);
});

test("migration artifact is not wired to an execution script", () => {
  assert.doesNotMatch(packageJson, /202608030001_canonical_attempt_lease_foundation|supabase\s+db\s+push/i);
});

test("canonical persistence RPC adapter forwards expected revision", async () => {
  const calls = [];
  const client = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: { ok: true }, error: null };
    },
  };
  await contract.canonicalAcquireAttemptLease(client, {
    ...ownership(), attempt_id: "attempt-2", lease_id: "lease-2", expires_at: ACTIVE,
  });
  assert.equal(calls[0].name, "canonical_acquire_attempt_lease");
  assert.equal(calls[0].args.p_expected_revision, 7);
});

test("03A and database production feature flags remain off", async () => {
  const orchestration = await import(pathToFileURL(join(root, "src/lib/hermes/orchestration-adapter.ts")).href);
  const openClaw = await import(pathToFileURL(join(root, "src/lib/openclaw/capability-gateway.ts")).href);
  assert.equal(orchestration.HERMES_CANONICAL_ORCHESTRATION_ENABLED_DEFAULT, false);
  assert.equal(openClaw.OPENCLAW_CAPABILITY_GATEWAY_ENABLED_DEFAULT, false);
  assert.equal(contract.CANONICAL_DATABASE_PERSISTENCE_ENABLED_DEFAULT, false);
});
