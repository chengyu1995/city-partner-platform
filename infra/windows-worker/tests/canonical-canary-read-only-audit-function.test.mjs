import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const migrationPath = join(
  root,
  "supabase/migrations/202608130001_canonical_canary_read_only_audit_function.sql"
);
const oldMigrationPath = join(
  root,
  "supabase/migrations/202608110001_canonical_canary_admission_control.sql"
);
const jobsFixturePath = join(
  root,
  "infra/windows-worker/tests/fixtures/production-hermes-jobs-schema.sql"
);
const migration = readFileSync(migrationPath, "utf8");
const functionBody = migration.split("as $function$")[1]?.split("$function$;")[0] ?? "";

test("audit migration uses the exact additive function signature", () => {
  assert.match(migration, /create or replace function public\.audit_canonical_canary_scope_state\(\s*p_policy_id text,\s*p_owner_open_id_sha256 text,\s*p_batch_code_sha256 text,\s*p_requested_mode text,\s*p_event_id_sha256 text\s*\)/i);
  assert.doesNotMatch(migration, /alter table public\./i);
});

test("audit function is SQL STABLE SECURITY DEFINER with a catalog-only search path", () => {
  assert.match(migration, /language sql\s+stable\s+security definer\s+set search_path = pg_catalog/i);
  assert.match(migration, /owner to postgres/i);
});

test("audit function fully qualifies tables and digest", () => {
  assert.doesNotMatch(functionBody, /(?<!public\.)\bhermes_(?:canonical_canary|jobs|job_)/i);
  assert.doesNotMatch(functionBody, /(?<!extensions\.)\bdigest\s*\(/i);
  assert.match(functionBody, /pg_catalog\.encode\(extensions\.digest\(/i);
});

test("audit function body is mutation-free", () => {
  assert.doesNotMatch(functionBody, /\b(insert|update|delete|merge|truncate|alter|drop|create|grant|copy|notify)\b/i);
});

test("audit function body contains no dynamic SQL", () => {
  assert.doesNotMatch(functionBody, /\bexecute\b/i);
  assert.doesNotMatch(functionBody, /pg_catalog\.format|format\s*\(/i);
});

test("audit migration grants no table privileges or role escalation", () => {
  assert.doesNotMatch(migration, /grant\s+select/i);
  assert.doesNotMatch(migration, /grant\s+all|alter\s+role|alter\s+default\s+privileges/i);
});

test("audit function ACL is reader-only", () => {
  for (const role of ["public", "anon", "authenticated", "authenticator", "service_role", "production_schema_audit_reader"]) {
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.audit_canonical_canary_scope_state\\(text, text, text, text, text\\)\\s+from ${role}`, "i")
    );
  }
  assert.match(migration, /grant execute on function public\.audit_canonical_canary_scope_state\(text, text, text, text, text\)\s+to production_schema_audit_reader/i);
});

test("audit scope validates every identity component", () => {
  assert.match(functionBody, /nullif\(pg_catalog\.btrim\(p_policy_id\), ''\) is not null/i);
  assert.equal((functionBody.match(/\^\[0-9a-f\]\{64\}\$/g) || []).length, 3);
  assert.match(functionBody, /p_requested_mode = 'worker_read_only'/i);
});

test("audit query binds policy owner batch mode and event", () => {
  for (const binding of [
    /p\.policy_id = i\.policy_id/i,
    /p\.requested_mode = i\.requested_mode/i,
    /digest\(p\.owner_open_id, 'sha256'\)[\s\S]*i\.owner_open_id_sha256/i,
    /digest\(p\.batch_code, 'sha256'\)[\s\S]*i\.batch_code_sha256/i,
    /a\.policy_id = i\.policy_id/i,
    /digest\(a\.event_id, 'sha256'\)[\s\S]*i\.event_id_sha256/i,
  ]) assert.match(functionBody, binding);
});

test("invalid scope returns a zero-state row instead of raising", () => {
  assert.match(functionBody, /case when i\.scope_input_valid then i\.policy_id else null end/i);
  assert.match(functionBody, /from input_scope i/i);
  assert.doesNotMatch(functionBody, /raise exception/i);
});

test("audit return contract excludes sensitive data", () => {
  const returnContract = migration.match(/\) returns table \(([\s\S]*?)\)\r?\n+language sql/i)?.[1] ?? "";
  for (const required of [
    "scope_input_valid", "policy_row_count", "scope_admission_count",
    "matching_event_admission_count", "scope_job_count", "event_job_count",
    "attempt_count", "lease_count", "terminal_count", "result_count",
    "duplicate_admission_detected", "duplicate_job_detected",
  ]) assert.match(returnContract, new RegExp(`\\b${required}\\b`));
  for (const forbidden of [
    "request_text", "result_text", "error_text", "canonical_report",
    "output", "files_changed", "owner_open_id", "event_id", "request_id",
  ]) assert.doesNotMatch(returnContract, new RegExp(`\\b${forbidden}\\b`));
});

test("audit identifiers use the actual Production column types", () => {
  assert.match(migration, /attempt_ids text\[\]/i);
  assert.match(migration, /lease_ids text\[\]/i);
  assert.match(migration, /terminal_ids uuid\[\]/i);
});

test("audit migration carries preconditions and transactional postconditions", () => {
  assert.match(migration, /^begin;/i);
  assert.match(migration, /AUDIT_FUNCTION_PRECHECK_FAILED/g);
  assert.match(migration, /AUDIT_FUNCTION_POSTCHECK_FAILED/g);
  assert.match(migration, /required columns missing/i);
  assert.match(migration, /target function already exists/i);
  assert.match(migration, /function ACL mismatch/i);
  assert.match(migration, /commit;\s*$/i);
});

test("audit rollback drops only the additive function", () => {
  assert.match(migration, /drop function if exists public\.audit_canonical_canary_scope_state\(text, text, text, text, text\)/i);
  assert.doesNotMatch(migration, /drop (table|policy)/i);
  assert.doesNotMatch(migration, /drop function if exists public\.canonical_admit_canary_job/i);
});

test("approved Production migration remains byte-identical", () => {
  assert.equal(
    createHash("sha256").update(readFileSync(oldMigrationPath)).digest("hex"),
    "d1f92f4f56bd1a83a301dff950c20965eacc4b4dbb9ab0fefdd02286d962eac9"
  );
});

test("audit migration targets the current Production hermes_jobs schema", () => {
  const fixture = readFileSync(jobsFixturePath, "utf8");
  assert.match(fixture, /request_text text not null/i);
  assert.doesNotMatch(fixture, /^\s*title\s+/im);
  assert.doesNotMatch(fixture, /^\s*payload\s+/im);
  assert.doesNotMatch(migration, /\btitle\b|\bpayload\b/i);
});
