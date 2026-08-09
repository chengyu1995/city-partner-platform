import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const routeSource = readFileSync(join(root, "src/app/api/feishu/event/route.ts"), "utf8");
const contextSource = readFileSync(join(root, "src/lib/feishu-canonical-context.ts"), "utf8");
const context = await import("../../../src/lib/feishu-canonical-context.ts");

test("canonical approval context restores worker_read_only request without legacy exact scope", () => {
  const original = [
    "new requirement: execute BATCH-ARCH-COMPLETE-03C-3B-LIVE-VALIDATION-01",
    "requested_mode=worker_read_only",
    "exact_allowed_scope_count=0",
    "task_goal=read-only live validation",
    "required_output_fields=canonical_job_created",
    "acceptance_conditions=no writes",
  ].join("\n");
  const saved = [
    "approval_context_saved=true",
    "approved_batch=BATCH-ARCH-COMPLETE-03C-3B-LIVE-VALIDATION-01",
    "requested_mode=worker_read_only",
    "project_domain=automation_system",
    `original_request_text_base64=${Buffer.from(original, "utf8").toString("base64")}`,
  ].join("\n");
  const result = context.buildCanonicalApprovalContext({
    approval_text: "approve BATCH-ARCH-COMPLETE-03C-3B-LIVE-VALIDATION-01 requested_mode=worker_read_only",
    saved_context_text: saved,
    request_id: "message-1",
    approved_by: "boss",
    approved_at: "2026-08-06T00:00:00.000Z",
    feishu_chat_id: "chat",
    feishu_event_id: "event",
  });

  assert.equal(result.ok, true);
  assert.equal(result.canonical_context_builder_used, true);
  assert.equal(result.legacy_context_builder_used, false);
  assert.equal(result.requested_mode, "worker_read_only");
  assert.equal(result.original_request_text, original);
  assert.equal(result.failure_code, null);
});

test("canonical approval context fails closed when original request is missing", () => {
  const result = context.buildCanonicalApprovalContext({
    approval_text: "approve BATCH-ARCH-COMPLETE-03C-3B-LIVE-VALIDATION-01 requested_mode=worker_read_only",
    saved_context_text: "approval_context_saved=true",
    request_id: "message-2",
    approved_by: "boss",
    approved_at: "2026-08-06T00:00:00.000Z",
    feishu_chat_id: "chat",
    feishu_event_id: "event",
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure_code, "CANONICAL_APPROVAL_CONTEXT_INCOMPLETE");
  assert.equal(result.failure_stage, "canonical_approval_context_validation");
});

test("canonical worker context carries planning context without invented execution identities", () => {
  const payload = context.buildCanonicalWorkerContextPayload({
    plan_id: "plan-1",
    subtask_id: "subtask-1",
    requested_mode: "worker_read_only",
    batch_code: "BATCH-ARCH-COMPLETE-03C-3B-LIVE-VALIDATION-01",
    project_domain: "automation_system",
    execution_intent: "verification_only",
    scope: ["infra/tencent-worker/**"],
    acceptance: ["tests pass"],
    original_request_text: "audit request",
    approval_context: { approved_by: "boss" },
  });

  assert.equal(payload.plan_id, "plan-1");
  assert.equal(payload.subtask_id, "subtask-1");
  assert.equal(payload.requested_mode, "worker_read_only");
  assert.equal(payload.canonical_revision, 0);
  assert.equal(payload.execution_intent, "verification_only");
  assert.deepEqual(payload.scope, ["infra/tencent-worker/**"]);
  assert.deepEqual(payload.acceptance, ["tests pass"]);
  assert.equal("job_id" in payload, false);
  assert.equal("attempt_id" in payload, false);
  assert.equal("lease_id" in payload, false);
  assert.equal("worker_identity" in payload, false);
  assert.equal("lease_identity" in payload, false);
});

test("Feishu gateway routes missing legacy draft approvals through canonical context when enabled", () => {
  assert.match(routeSource, /findRecentCanonicalApprovalContext\(supabase,\s*convId,\s*text\)/);
  assert.match(routeSource, /buildCanonicalApprovalContext\(\{/);
  assert.match(routeSource, /feishuFeatureRoute\.canonical_enabled/);
  assert.match(routeSource, /runApprovedRequestThroughCanonicalHermes\(/);
  assert.match(routeSource, /buildCanonicalWorkerContextPayload\(\{/);
  assert.match(routeSource, /canonical_context_builder_used:\s*true/);
  assert.match(routeSource, /legacy_context_builder_used:\s*false/);
});

test("canonical context path does not use legacy readonly incomplete failure", () => {
  const canonicalBlock = routeSource.slice(
    routeSource.indexOf("findRecentCanonicalApprovalContext"),
    routeSource.indexOf("const canonicalCutover = await attemptHermesCanonicalCutover", routeSource.indexOf("if (!recentDraft)"))
  );
  assert.doesNotMatch(canonicalBlock, /WORKER_READONLY_CONTEXT_INCOMPLETE/);
  assert.doesNotMatch(contextSource, /WORKER_READONLY_CONTEXT_INCOMPLETE/);
});

test("legacy task tree missing path is preserved when canonical flag is off", () => {
  const missingDraftBlock = routeSource.slice(
    routeSource.indexOf("if (!recentDraft)"),
    routeSource.indexOf("const canonicalCutover = await attemptHermesCanonicalCutover", routeSource.indexOf("if (!recentDraft)") + 1)
  );
  assert.match(missingDraftBlock, /feishuFeatureRoute\.canonical_enabled/);
  assert.match(routeSource, /state:\s*"waiting_task_tree_missing"/);
});

test("canonical path records authoritative writes only after canonicalCreateJob", () => {
  const canonicalBlock = routeSource.slice(
    routeSource.indexOf("if (!recentDraft)"),
    routeSource.indexOf("const reply = \"", routeSource.indexOf("if (!recentDraft)"))
  );
  assert.match(canonicalBlock, /canonicalCreateJob\(supabase/);
  assert.match(canonicalBlock, /writeGuard\.recordAuthoritativeWrite\(created\.insertedCount\)/);
});

test("canonical context keeps legacy repair readback isolated", () => {
  assert.match(routeSource, /assertSystemRepairApprovalContextReadback/);
  assert.doesNotMatch(contextSource, /assertSystemRepairApprovalContextReadback|SYSTEM_REPAIR_TASK_TYPE/);
});
