import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..", "..", "..");
const reportRoute = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "report", "route.ts"), "utf8");

function duplicateBranch() {
  const start = reportRoute.indexOf("if (isTerminalWorkerStatus(existingJob.status))");
  const end = reportRoute.indexOf("const { data, error, skippedColumns }", start);
  assert.ok(start >= 0 && end > start, "duplicate terminal branch should exist");
  return reportRoute.slice(start, end);
}

test("duplicate terminal report does not retry Feishu sync", () => {
  const branch = duplicateBranch();
  assert.doesNotMatch(branch, /syncWorkerStatusToFeishu/);
  assert.match(branch, /duplicate_report_detected:\s*true/);
  assert.match(branch, /duplicate_report_idempotent:\s*true/);
  assert.match(branch, /second_side_effect_triggered:\s*false/);
  assert.match(branch, /feishu_sync:\s*"skipped_duplicate_terminal"/);
});

test("duplicate terminal report allows diagnostics enrichment only", () => {
  assert.match(reportRoute, /async function enrichTerminalDiagnosticsIfMissing/);
  const branch = duplicateBranch();
  assert.match(branch, /diagnostics_enrichment_only:\s*diagnosticsEnrichment\.enriched/);
  assert.match(branch, /non_diagnostic_side_effects:\s*0/);
});

test("diagnostics enrichment does not update terminal status fields", () => {
  const start = reportRoute.indexOf("async function enrichTerminalDiagnosticsIfMissing");
  const end = reportRoute.indexOf("function buildDiagnosticsStorageUnavailablePayload", start);
  assert.ok(start >= 0 && end > start, "diagnostics enrichment helper should be detectable");
  const helper = reportRoute.slice(start, end);
  assert.match(helper, /result:\s*{[\s\S]*diagnostics/);
  assert.doesNotMatch(helper, /status:\s*/);
  assert.doesNotMatch(helper, /completed_at:\s*/);
  assert.doesNotMatch(helper, /retry_count:\s*/);
});

test("duplicate terminal report preserves stored terminal truth", () => {
  const branch = duplicateBranch();
  assert.match(branch, /storedTerminalStatus/);
  assert.match(branch, /status:\s*storedTerminalStatus/);
  assert.doesNotMatch(branch, /status:\s*workerStatus/);
  assert.doesNotMatch(branch, /status:\s*storedStatus/);
});
