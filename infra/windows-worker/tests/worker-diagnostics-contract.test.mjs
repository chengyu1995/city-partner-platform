import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..", "..", "..");
const workerJobs = fs.readFileSync(path.join(root, "src", "lib", "worker-jobs.ts"), "utf8");
const reportRoute = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "report", "route.ts"), "utf8");
const localWorker = fs.readFileSync(path.join(root, "infra", "windows-worker", "local_worker.js"), "utf8");
const migrationDraft = fs.readFileSync(path.join(root, "docs", "setup-hermes-jobs-diagnostics.sql"), "utf8");

const canonicalReportFields = [
  "report_schema_version",
  "worker_execution_status",
  "task_goal_status",
  "effective_final_status",
  "failure_code",
  "failure_stage",
  "failure_detail",
  "changed_files",
  "git_commit_sha",
  "git_push",
  "pushed_branch",
  "job_id",
  "attempt_id",
  "worker_instance_id",
  "terminal_report_acknowledged",
  "terminal_state_persisted",
  "duplicate_terminal_report_idempotent",
  "final_report_source",
  "post_completion_state_applied",
];

function functionBlock(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found`);
  const end = nextSignature ? source.indexOf(nextSignature, start) : -1;
  return source.slice(start, end === -1 ? source.length : end);
}

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

test("worker reports carry Codex executable resolution diagnostics", () => {
  for (const field of [
    "codex_resolution_source",
    "codex_requested_path",
    "codex_executable_resolved",
    "codex_executable_exists",
    "codex_executable_file_type",
    "codex_executable_version",
    "codex_executable_is_app_alias",
    "codex_preflight_status",
    "stdin_transport_verified",
    "prompt_in_spawnargs",
  ]) {
    assert.match(workerJobs, new RegExp(`${field}:`));
  }
  assert.match(workerJobs, /readDiagnosticLine\(combinedReportText,\s*"codex_resolution_source"\)/);
  assert.match(workerJobs, /readDiagnosticLine\(reportText,\s*"codex_preflight_status"\)/);
});

test("worker contract carries verification-only no-change success flags", () => {
  assert.match(workerJobs, /"verification_only"/);
  assert.match(workerJobs, /"allow_no_change_success"/);
  assert.match(workerJobs, /"code_changes_required"/);
  assert.match(workerJobs, /"codex_required"/);
  assert.match(workerJobs, /"git_commit_required"/);
  assert.match(workerJobs, /"git_push_required"/);
  assert.match(workerJobs, /"execution_policy_source"/);
  assert.match(workerJobs, /verification_only:\s*verificationOnly/);
  assert.match(workerJobs, /allow_no_change_success:\s*allowNoChangeSuccess/);
  assert.match(workerJobs, /code_changes_required:\s*codeChangesRequired/);
  assert.match(workerJobs, /codex_required:\s*codexRequired/);
  assert.match(reportRoute, /verification_only:\s*body\.verification_only \?\? null/);
  assert.match(reportRoute, /allow_no_change_success:\s*body\.allow_no_change_success \?\? null/);
  assert.match(reportRoute, /code_changes_required:\s*body\.code_changes_required \?\? null/);
  assert.match(reportRoute, /codex_required:\s*body\.codex_required \?\? null/);
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

test("canonical worker report schema v2 is accepted without blind fallback exhaustion", () => {
  assert.match(workerJobs, /CANONICAL_WORKER_REPORT_SCHEMA_VERSION\s*=\s*2/);
  assert.match(workerJobs, /function validateCanonicalWorkerReportSchema/);
  assert.match(workerJobs, /function buildCanonicalWorkerReportSchema/);
  assert.match(reportRoute, /buildCanonicalWorkerReportSchema/);
  assert.match(reportRoute, /validateCanonicalWorkerReportSchema/);
  assert.match(reportRoute, /canonical_worker_report:\s*canonicalReport/);
  assert.match(reportRoute, /report_schema_version:\s*CANONICAL_WORKER_REPORT_SCHEMA_VERSION/);
  assert.match(reportRoute, /WORKER_REPORT_SCHEMA_INVALID/);
  assert.match(reportRoute, /missing_fields/);
  assert.match(reportRoute, /invalid_fields/);
  assert.match(reportRoute, /supported_schema_versions/);
  assert.doesNotMatch(reportRoute, /worker_report_schema_fallback_exhausted[^:]/);
  assert.match(reportRoute, /worker_report_schema_fallback_exhausted:\s*false/);
});

test("canonical worker report schema v2 stores one complete terminal object", () => {
  const builder = functionBlock(
    workerJobs,
    "export function buildCanonicalWorkerReportSchema",
    "export function normalizeWorkerFinalResult"
  );

  for (const field of canonicalReportFields) {
    assert.match(builder, new RegExp(`${field}:`), field);
  }

  assert.match(builder, /codex_git_push:/);
  assert.equal((reportRoute.match(/canonical_worker_report:\s*canonicalReport/g) || []).length, 1);
  assert.match(reportRoute, /const canonicalReport = buildCanonicalWorkerReportSchema/);
});

test("canonical report preserves failure detail and terminal idempotency metadata", () => {
  const builder = functionBlock(
    workerJobs,
    "export function buildCanonicalWorkerReportSchema",
    "export function normalizeWorkerFinalResult"
  );

  assert.match(builder, /failure_detail:[\s\S]*body\.failure_detail[\s\S]*finalResult\.failure_detail/);
  assert.match(builder, /terminal_report_acknowledged:[\s\S]*body\.terminal_report_acknowledged[\s\S]*finalResult\.terminal_report_acknowledged[\s\S]*true/);
  assert.match(builder, /duplicate_terminal_report_idempotent:[\s\S]*body\.duplicate_terminal_report_idempotent[\s\S]*finalResult\.duplicate_terminal_report_idempotent[\s\S]*false/);
  assert.match(builder, /final_report_source:[\s\S]*body\.final_report_source[\s\S]*finalResult\.final_report_source/);
});

test("effective final status has a single priority source", () => {
  const normalizer = functionBlock(
    workerJobs,
    "export function normalizeWorkerFinalResult",
    "function terminalIndexKey"
  );
  const statusRead = normalizer.slice(
    normalizer.indexOf("const requestedStatus"),
    normalizer.indexOf("const nonTaskFailureCode")
  );

  assert.match(statusRead, /readPriorityReportField\(terminalSources,\s*"effective_final_status"/);
  assert.match(statusRead, /input\.effectiveFinalStatus/);
  assert.match(statusRead, /input\.effective_final_status/);
  assert.doesNotMatch(statusRead, /codex_result|git_push|changed_files|worker_execution_status/);
});

test("local Worker submits canonical report schema and received policy diagnostics", () => {
  assert.match(localWorker, /CANONICAL_WORKER_REPORT_SCHEMA_VERSION\s*=\s*2/);
  assert.match(localWorker, /report_schema_version:\s*CANONICAL_WORKER_REPORT_SCHEMA_VERSION/);
  assert.match(localWorker, /worker_instance_id:\s*WORKER_NAME/);
  assert.match(localWorker, /received_verification_only=/);
  assert.match(localWorker, /received_code_changes_required=/);
  assert.match(localWorker, /received_codex_required=/);
  assert.match(localWorker, /received_execution_policy_source=/);
  assert.match(localWorker, /isVerificationOnlyNoopTask\(job, initialContract\)/);
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
