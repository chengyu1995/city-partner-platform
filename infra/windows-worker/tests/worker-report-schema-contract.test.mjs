import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..", "..", "..");
const workerJobs = fs.readFileSync(path.join(root, "src", "lib", "worker-jobs.ts"), "utf8");
const reportRoute = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "report", "route.ts"), "utf8");
const migrationDraft = fs.readFileSync(path.join(root, "docs", "setup-hermes-jobs-diagnostics.sql"), "utf8");

test("selected diagnostics persistence strategy is result.diagnostics only", () => {
  assert.match(workerJobs, /DIAGNOSTICS_STORAGE_FIELD\s*=\s*"result\.diagnostics"/);
  assert.match(reportRoute, /diagnostics:\s*projectDirectorReport\.data\.diagnostics \?\? null/);
  assert.doesNotMatch(reportRoute, /diagnostics:\s*body\.diagnostics\s*,\s*status:/);
});

test("missing result storage returns diagnostics storage unavailable", () => {
  assert.match(workerJobs, /DIAGNOSTICS_STORAGE_UNAVAILABLE/);
  assert.match(reportRoute, /failure_code:\s*DIAGNOSTICS_STORAGE_UNAVAILABLE/);
  assert.match(reportRoute, /failure_stage:\s*"report"/);
  assert.match(reportRoute, /terminal_status_persisted:\s*input\.terminalStatusPersisted/);
  assert.match(reportRoute, /diagnostics_persisted:\s*false/);
});

test("schema fallback guard does not leak skipped columns in HTTP response", () => {
  const responseStart = reportRoute.indexOf("function buildDiagnosticsStorageUnavailablePayload");
  const responseEnd = reportRoute.indexOf("export async function POST", responseStart);
  const responseBuilder = reportRoute.slice(responseStart, responseEnd);
  assert.doesNotMatch(responseBuilder, /skipped_columns/);
  assert.match(reportRoute, /console\.error\("\[worker\/report\] diagnostics storage unavailable"/);
});

test("migration draft adds nullable result jsonb without data rewrite", () => {
  assert.match(migrationDraft, /ADD COLUMN IF NOT EXISTS result jsonb NULL/);
  assert.match(migrationDraft, /failed_rows_with_result_after_migration/);
  assert.doesNotMatch(migrationDraft, /\bUPDATE\s+public\.hermes_jobs\b/i);
  assert.doesNotMatch(migrationDraft, /CREATE\s+INDEX/i);
});

test("migration draft does not alter status, RLS, triggers, functions, or policies", () => {
  assert.doesNotMatch(migrationDraft, /ALTER\s+TYPE|ALTER\s+TABLE\s+public\.hermes_jobs\s+ALTER\s+COLUMN\s+status/i);
  assert.doesNotMatch(migrationDraft, /\bCREATE\s+POLICY\b|\bALTER\s+POLICY\b|\bDROP\s+POLICY\b/i);
  assert.doesNotMatch(migrationDraft, /\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b|\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);
  assert.doesNotMatch(migrationDraft, /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b|\bCREATE\s+TRIGGER\b/i);
});

test("schema unavailable response separates terminal status from diagnostics persistence", () => {
  assert.match(reportRoute, /terminal_status_persisted:\s*input\.terminalStatusPersisted/);
  assert.match(reportRoute, /diagnostics_persisted:\s*false/);
  assert.match(reportRoute, /terminal_report_idempotent:\s*false/);
  assert.match(reportRoute, /diagnostics_storage_field:\s*DIAGNOSTICS_STORAGE_FIELD/);
});

test("selected strategy does not use risk_reasons or diagnostics top-level fallback", () => {
  assert.doesNotMatch(reportRoute, /risk_reasons:\s*{[\s\S]*diagnostics/);
  assert.doesNotMatch(reportRoute, /status:\s*storedStatus,[\s\S]{0,240}diagnostics:\s*projectDirectorReport\.data\.diagnostics/);
  assert.match(reportRoute, /result:\s*{[\s\S]*diagnostics:\s*projectDirectorReport\.data\.diagnostics \?\? null/);
});
