import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..", "..", "..");
const workerJobs = fs.readFileSync(path.join(root, "src", "lib", "worker-jobs.ts"), "utf8");
const reportRoute = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "report", "route.ts"), "utf8");

test("worker reports build versioned diagnostics", () => {
  assert.match(workerJobs, /DIAGNOSTICS_SCHEMA_VERSION\s*=\s*1/);
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

test("diagnostics separates worker, goal, and effective statuses", () => {
  assert.match(workerJobs, /worker_execution_status:\s*input\.workerExecutionStatus/);
  assert.match(workerJobs, /task_goal_status:\s*input\.taskGoalStatus/);
  assert.match(workerJobs, /effective_final_status:\s*effectiveStatus/);
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
  assert.match(workerJobs, /\[redacted private key\]/);
  assert.match(workerJobs, /text\.length > 1000 \? text\.slice\(0, 1000\)/);
});

test("worker report route persists diagnostics in hermes_jobs result json", () => {
  assert.match(reportRoute, /diagnostics\?: Record<string, unknown> \| null/);
  assert.match(reportRoute, /diagnostics: projectDirectorReport\.data\.diagnostics \?\? null/);
  assert.match(reportRoute, /const storedStatus = terminal \? effectiveFinalStatus : workerStatus/);
  assert.match(reportRoute, /status: storedStatus/);
});
