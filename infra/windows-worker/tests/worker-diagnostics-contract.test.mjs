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

test("worker reports build versioned diagnostics", () => {
  assert.match(workerJobs, /DIAGNOSTICS_SCHEMA_VERSION\s*=\s*1/);
  assert.match(workerJobs, /DIAGNOSTICS_STORAGE_FIELD\s*=\s*"result\.diagnostics"/);
  assert.match(workerJobs, /function buildWorkerFailureDiagnostics/);
  assert.match(workerJobs, /diagnostics_schema_version:\s*DIAGNOSTICS_SCHEMA_VERSION/);
});

test("failed diagnostics require stable fallback code and stage", () => {
  assert.match(workerJobs, /UNKNOWN_FAILURE/);
  assert.match(workerJobs, /function normalizeDiagnosticsFailureCode/);
  assert.match(workerJobs, /function normalizeDiagnosticsFailureStage/);
  assert.match(workerJobs, /normalizeTerminalStatus\(effectiveFinalStatus\) === "failed" \? "UNKNOWN_FAILURE"/);
  assert.match(workerJobs, /normalizeTerminalStatus\(effectiveFinalStatus\) === "failed"\) return "unknown"/);
});

test("Codex usage-limit reports preserve machine-readable code stage and detail", () => {
  assert.match(workerJobs, /"CODEX_USAGE_LIMIT"/);
  assert.match(workerJobs, /failureCode === "CODEX_USAGE_LIMIT" \? "codex_execution"/);
  assert.match(workerJobs, /failure_detail: failureDetail/);
  assert.match(workerJobs, /failureCode === "CODEX_USAGE_LIMIT"[\s\S]{0,120}sanitizeDiagnosticsErrorSummary/);
  assert.match(reportRoute, /failureCode: falsePositiveGuard\?\.failureCode \?\? body\.failure_code/);
  assert.match(reportRoute, /failureStage: falsePositiveGuard\?\.failureStage \?\? body\.failure_stage/);
});

test("diagnostics separates worker, goal, and effective statuses", () => {
  assert.match(workerJobs, /worker_execution_status:\s*input\.workerExecutionStatus/);
  assert.match(workerJobs, /task_goal_status:\s*input\.taskGoalStatus/);
  assert.match(workerJobs, /effective_final_status:\s*effectiveStatus/);
});

test("worker contract carries verification-only no-change success flags", () => {
  assert.match(workerJobs, /"verification_only"/);
  assert.match(workerJobs, /"allow_no_change_success"/);
  assert.match(workerJobs, /verification_only:\s*verificationOnly/);
  assert.match(workerJobs, /allow_no_change_success:\s*allowNoChangeSuccess/);
  assert.match(reportRoute, /verification_only:\s*body\.verification_only \?\? null/);
  assert.match(reportRoute, /allow_no_change_success:\s*body\.allow_no_change_success \?\? null/);
});

test("diagnostics preserves context without original request text", () => {
  assert.match(workerJobs, /project_domain:/);
  assert.match(workerJobs, /requested_mode:/);
  assert.match(workerJobs, /task_mode:/);
  assert.match(workerJobs, /batch:/);
  const fnStart = workerJobs.indexOf("function buildWorkerFailureDiagnostics");
  const fnEnd = workerJobs.indexOf("function readDiagnosticLine", fnStart);
  assert.ok(fnStart >= 0, "buildWorkerFailureDiagnostics should exist");
  assert.ok(fnEnd > fnStart, "buildWorkerFailureDiagnostics should end before readDiagnosticLine");
  const fn = workerJobs.slice(fnStart, fnEnd);
  assert.doesNotMatch(fn, /original_request_text_base64:/);
});

test("diagnostics redacts sensitive summaries and caps length", () => {
  assert.match(workerJobs, /function sanitizeDiagnosticsErrorSummary/);
  assert.match(workerJobs, /Authorization:\s*Bearer \[redacted\]/);
  assert.match(workerJobs, /A-Z0-9_]\*\(\?:TOKEN\|SECRET\|KEY\|PASSWORD\)/);
  assert.match(workerJobs, /\[redacted private key\]/);
  assert.match(workerJobs, /text\.length > 1000 \? text\.slice\(0, 1000\)/);
});

test("worker report route persists diagnostics in hermes_jobs result json", () => {
  assert.match(reportRoute, /diagnostics\?: Record<string, unknown> \| null/);
  assert.match(reportRoute, /diagnostics: projectDirectorReport\.data\.diagnostics \?\? null/);
  assert.match(reportRoute, /terminal && isTerminalWorkerStatus\(effectiveFinalStatus\) \? effectiveFinalStatus : workerStatus/);
  assert.match(reportRoute, /status: storedStatus/);
});

test("missing diagnostics storage fails closed before notification side effects", () => {
  assert.match(workerJobs, /DIAGNOSTICS_STORAGE_UNAVAILABLE/);
  assert.match(reportRoute, /buildDiagnosticsStorageUnavailablePayload/);
  assert.match(reportRoute, /skippedColumns\.includes\("result"\)/);
  const unavailableIndex = reportRoute.indexOf('skippedColumns.includes("result")');
  const syncIndex = reportRoute.indexOf("await syncWorkerStatusToFeishu", unavailableIndex);
  assert.ok(unavailableIndex >= 0, "route should inspect result schema fallback");
  assert.ok(syncIndex > unavailableIndex, "route should check result storage before final sync");
});

test("duplicate terminal report is idempotent and skips non-diagnostic side effects", () => {
  const duplicateStart = reportRoute.indexOf("if (isTerminalWorkerStatus(existingJob.status))");
  const duplicateEnd = reportRoute.indexOf("const { data, error, skippedColumns }", duplicateStart);
  assert.ok(duplicateStart >= 0 && duplicateEnd > duplicateStart, "duplicate branch should be detectable");
  const duplicateBranch = reportRoute.slice(duplicateStart, duplicateEnd);
  assert.doesNotMatch(duplicateBranch, /syncWorkerStatusToFeishu/);
  assert.match(duplicateBranch, /duplicate_report_detected:\s*true/);
  assert.match(duplicateBranch, /duplicate_report_idempotent:\s*true/);
  assert.match(duplicateBranch, /second_side_effect_triggered:\s*false/);
});

test("diagnostics migration draft uses nullable result jsonb without backfill", () => {
  assert.match(migrationDraft, /ALTER TABLE public\.hermes_jobs\s+ADD COLUMN IF NOT EXISTS result jsonb NULL;/);
  assert.match(migrationDraft, /BEGIN;/);
  assert.match(migrationDraft, /COMMIT;/);
  assert.doesNotMatch(migrationDraft, /\bUPDATE\s+public\.hermes_jobs\b/i);
  assert.doesNotMatch(migrationDraft, /CREATE\s+INDEX/i);
  assert.doesNotMatch(migrationDraft, /ALTER\s+TABLE\s+public\.hermes_jobs\s+DROP\s+CONSTRAINT/i);
});
