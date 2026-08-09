import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);
const manifestPath = join(root, "infra/tencent-worker/production-artifacts/feishu-gateway.json");
const reconciliationPath = join(root, "docs/architecture/production-feishu-gateway-behavior-reconciliation.json");
const gatewayPath = join(root, "infra/tencent-worker/feishu_gateway_canonical.js");
const routerPath = join(root, "infra/tencent-worker/feishu_gateway_canonical_router.js");
const contextPath = join(root, "infra/tencent-worker/feishu-canonical-context-core.js");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const reconciliation = JSON.parse(readFileSync(reconciliationPath, "utf8"));
const gatewaySource = readFileSync(gatewayPath, "utf8");
const routerSource = readFileSync(routerPath, "utf8");
const contextSource = readFileSync(contextPath, "utf8");
const routerModule = require(routerPath);
const contextModule = require(contextPath);

function approvalInput(overrides = {}) {
  const original = [
    "BATCH-ARCH-COMPLETE-03C-3B-LIVE-VALIDATION-01",
    "requested_mode=worker_read_only",
    "execution_intent=verification_only",
  ].join("\n");
  return {
    is_approval: true,
    approval_text: "approve BATCH-ARCH-COMPLETE-03C-3B-LIVE-VALIDATION-01 requested_mode=worker_read_only",
    batch_code: "BATCH-ARCH-COMPLETE-03C-3B-LIVE-VALIDATION-01",
    body: { type: "event_callback", event: { message: { message_id: "m-1" } } },
    request_id: "m-1",
    approved_by: "boss",
    approved_at: "2026-08-09T00:00:00.000Z",
    feishu_chat_id: "chat-1",
    feishu_event_id: "event-1",
    load_saved_context: async () => ({
      batch_code: "BATCH-ARCH-COMPLETE-03C-3B-LIVE-VALIDATION-01",
      requested_mode: "worker_read_only",
      project_domain: "automation_system",
      execution_intent: "verification_only",
      original_request_text: original,
      exact_allowed_scope: [],
      acceptance_conditions: ["no writes"],
      plan_id: "plan-1",
      subtask_id: "subtask-1",
    }),
    ...overrides,
  };
}

test("production Gateway source and dependencies are tracked by Git", () => {
  for (const file of manifest.files) {
    const tracked = execFileSync("git", ["ls-files", "--error-unmatch", file.source_path], { cwd: root, encoding: "utf8" });
    assert.equal(tracked.trim(), file.source_path);
  }
});

test("artifact mapping is direct and deterministic", () => {
  assert.equal(manifest.artifact_type, "direct");
  assert.equal(manifest.build_required, false);
  assert.equal(manifest.build_command, null);
  assert.equal(manifest.files.length, 3);
});

test("production PM2 target mapping is explicit", () => {
  assert.equal(manifest.pm2_process, "feishu-gateway");
  assert.equal(manifest.runtime_cwd, "/home/ubuntu/city-partner-agent");
  assert.equal(manifest.files[0].target_path, "/home/ubuntu/city-partner-agent/feishu_gateway_canonical.js");
});

test("restart and rollback mapping are scoped to feishu-gateway", () => {
  assert.equal(manifest.restart_required, true);
  assert.equal(manifest.restart_command, "pm2 restart feishu-gateway");
  assert.match(manifest.rollback_source, /same target paths/);
  assert.doesNotMatch(JSON.stringify(manifest), /restart all|worker-api|nginx/i);
});

test("Gateway imports the canonical transport router before legacy runtime", () => {
  assert.match(gatewaySource.slice(0, 500), /feishu_gateway_canonical_router\.js/);
  const routeStart = gatewaySource.indexOf('app.post("/feishu/event"');
  const routeSource = gatewaySource.slice(routeStart);
  assert.ok(routeSource.indexOf("canonicalGatewayResult.handled") < routeSource.indexOf("PROJECT_DIRECTOR_APPROVAL_BATCH_ROUTER_GATE"));
});

test("canonical transport router imports the shared context builder", () => {
  assert.match(routerSource, /require\("\.\/feishu-canonical-context-core\.js"\)/);
  assert.match(routerSource, /buildCanonicalApprovalContext\(\{/);
});

test("there is one canonical approval context implementation", () => {
  const definitions = contextSource.match(/function buildCanonicalApprovalContext\s*\(/g) || [];
  assert.equal(definitions.length, 1);
  assert.doesNotMatch(gatewaySource, /function buildCanonicalApprovalContext\s*\(/);
  assert.doesNotMatch(routerSource, /function buildCanonicalApprovalContext\s*\(/);
});

test("flag OFF leaves the complete legacy path untouched", async () => {
  let loaded = false;
  const router = routerModule.createCanonicalGatewayRouter({ env: {}, fetchImpl: async () => { throw new Error("unexpected fetch"); } });
  const result = await router.route(approvalInput({ load_saved_context: async () => { loaded = true; return {}; } }));
  assert.deepEqual(result, { handled: false, reason: "canonical_flag_off" });
  assert.equal(loaded, false);
});

test("flag ON approval dispatches to the shared canonical application handler", async () => {
  let request;
  const env = {
    HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true",
    HERMES_CANONICAL_SHADOW_ENABLED: "false",
    HERMES_CANONICAL_EVENT_URL: "https://example.test/api/feishu/event",
    FEISHU_APP_SECRET: "test-secret",
  };
  const router = routerModule.createCanonicalGatewayRouter({
    env,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ code: 0, state: "hermes_canonical_dispatched" }), { status: 200 });
    },
  });
  const result = await router.route(approvalInput());
  assert.equal(result.handled, true);
  assert.equal(result.ok, true);
  assert.equal(request.url, env.HERMES_CANONICAL_EVENT_URL);
  const body = JSON.parse(request.options.body);
  assert.equal(body._canonical_gateway_context.canonical_context_builder_used, true);
  assert.equal(body._canonical_gateway_context.legacy_context_builder_used, false);
  assert.equal(routerModule.verifyCanonicalGatewayContextSignature(body._canonical_gateway_context, request.options.headers[routerModule.SIGNATURE_HEADER], env.FEISHU_APP_SECRET), true);
});

test("canonical approval never enters the legacy readonly gate", () => {
  const routeStart = gatewaySource.indexOf('app.post("/feishu/event"');
  const routeSource = gatewaySource.slice(routeStart);
  const canonicalReturn = routeSource.indexOf("return res.status(canonicalGatewayResult.status");
  const legacyApproval = routeSource.indexOf("PROJECT_DIRECTOR_APPROVAL_BATCH_ROUTER_GATE");
  assert.ok(canonicalReturn > 0 && canonicalReturn < legacyApproval);
});

test("true missing canonical context fails closed without downstream dispatch", async () => {
  let fetched = false;
  const router = routerModule.createCanonicalGatewayRouter({
    env: {
      HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true",
      HERMES_CANONICAL_EVENT_URL: "https://example.test/api/feishu/event",
      FEISHU_APP_SECRET: "test-secret",
    },
    fetchImpl: async () => { fetched = true; throw new Error("unexpected fetch"); },
  });
  const result = await router.route(approvalInput({ load_saved_context: async () => null }));
  assert.equal(result.handled, true);
  assert.equal(result.ok, false);
  assert.equal(result.response.failure_code, "CANONICAL_APPROVAL_CONTEXT_INCOMPLETE");
  assert.equal(fetched, false);
});

test("complete worker_read_only context is accepted without writable scope", () => {
  const context = contextModule.buildCanonicalApprovalContext({
    approval_text: "approve BATCH-ARCH-COMPLETE-03C-3B-LIVE-VALIDATION-01 requested_mode=worker_read_only",
    saved_context_record: {
      batch_code: "BATCH-ARCH-COMPLETE-03C-3B-LIVE-VALIDATION-01",
      requested_mode: "worker_read_only",
      original_request_text: "read only audit",
      exact_allowed_scope: [],
    },
    request_id: "m-1",
    approved_by: "boss",
    approved_at: "2026-08-09T00:00:00.000Z",
    feishu_chat_id: "chat-1",
    feishu_event_id: "event-1",
  });
  assert.equal(context.ok, true);
  assert.equal(context.failure_code, null);
});

test("canonical worker context never invents job attempt or lease identity", () => {
  const payload = contextModule.buildCanonicalWorkerContextPayload({
    plan_id: "plan-1",
    subtask_id: "subtask-1",
    requested_mode: "worker_read_only",
    batch_code: "BATCH-1",
  });
  for (const key of ["job_id", "attempt_id", "lease_id", "worker_identity", "lease_identity"]) {
    assert.equal(key in payload, false);
  }
});

test("canonical router has no database authoritative write surface", () => {
  assert.doesNotMatch(routerSource, /supabase|hermes_jobs|canonicalCreateJob|canonical_acquire_attempt_lease/i);
  assert.doesNotMatch(routerSource, /\/rest\/v1|\/rpc\//i);
});

test("canonical router has no Worker or Codex execution surface", () => {
  assert.doesNotMatch(routerSource, /local_worker|worker-api|codex|attempt_id|lease_id/i);
});

test("signed context rejects tampering", () => {
  const context = { ok: true, batch_code: "BATCH-1" };
  const signature = routerModule.signCanonicalGatewayContext(context, "secret");
  assert.equal(routerModule.verifyCanonicalGatewayContextSignature(context, signature, "secret"), true);
  assert.equal(routerModule.verifyCanonicalGatewayContextSignature({ ...context, batch_code: "BATCH-2" }, signature, "secret"), false);
});

test("canonical endpoint cannot loop back into the production Gateway route", async () => {
  const router = routerModule.createCanonicalGatewayRouter({
    env: {
      HERMES_CANONICAL_ORCHESTRATION_ENABLED: "true",
      HERMES_CANONICAL_EVENT_URL: "https://example.test/feishu/event",
      FEISHU_APP_SECRET: "secret",
    },
  });
  const result = await router.route(approvalInput());
  assert.equal(result.response.failure_code, "CANONICAL_GATEWAY_ENDPOINT_INVALID");
});

test("production behavior reconciliation has no UNKNOWN entries", () => {
  assert.deepEqual(reconciliation.unknown_runtime_behaviors, []);
  assert.equal(reconciliation.authoritative_routing.parallel_authoritative_writes, false);
  assert.equal(reconciliation.behaviors.some((item) => item.classification === "UNKNOWN"), false);
});

test("historical production transport and safety behavior is preserved", () => {
  for (const marker of ['app.get("/health"', 'app.post("/feishu/event"', "url_verification", "shouldSkipDuplicateFeishuEvent", "replyFeishu", "runtimePatchHandleGatewayControlCommand"]) {
    assert.match(gatewaySource, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("canonical event envelope is verified before Next.js uses it", () => {
  const route = readFileSync(join(root, "src/app/api/feishu/event/route.ts"), "utf8");
  assert.match(route, /readVerifiedCanonicalGatewayContext\(\{/);
  assert.match(route, /gatewayContextProvided && !verifiedGatewayContext/);
  assert.match(route, /saved_context_record: savedContextRecord/);
});

test("artifact verifier covers tracked files syntax and mapping", () => {
  const verifier = readFileSync(join(root, "scripts/verify-production-feishu-gateway-artifact.mjs"), "utf8");
  assert.match(verifier, /git["'], \["ls-files", "--error-unmatch"/);
  assert.match(verifier, /new Script\(sourceText/);
  assert.match(verifier, /unknown_runtime_behaviors/);
});
