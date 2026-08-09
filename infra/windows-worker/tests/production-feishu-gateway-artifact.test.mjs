import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(join(root, "infra/tencent-worker/production-artifacts/feishu-gateway.json"), "utf8"));
const reconciliation = JSON.parse(readFileSync(join(root, "docs/architecture/production-feishu-gateway-behavior-reconciliation.json"), "utf8"));
const gatewayPath = join(root, "infra/tencent-worker/feishu_gateway_canonical.js");
const routerPath = join(root, "infra/tencent-worker/feishu_gateway_canonical_router.js");
const contextPath = join(root, "infra/tencent-worker/feishu-canonical-context-core.js");
const routePath = join(root, "src/app/api/feishu/event/route.ts");
const acceptancePath = join(root, "src/lib/feishu-callback-application.ts");
const featurePath = join(root, "src/lib/feishu-application-boundary.ts");
const gatewaySource = readFileSync(gatewayPath, "utf8");
const routerSource = readFileSync(routerPath, "utf8");
const contextSource = readFileSync(contextPath, "utf8");
const routeSource = readFileSync(routePath, "utf8");
const acceptanceSource = readFileSync(acceptancePath, "utf8");
const featureSource = readFileSync(featurePath, "utf8");
const gatewayModule = require(gatewayPath);
const routerModule = require(routerPath);

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
  assert.equal(manifest.files.length, 2);
});

test("production PM2 target mapping is explicit", () => {
  assert.equal(manifest.pm2_process, "feishu-gateway");
  assert.equal(manifest.files[0].target_path, "/home/ubuntu/city-partner-agent/feishu_gateway_canonical.js");
});

test("restart and rollback mapping remain scoped to feishu-gateway", () => {
  assert.equal(manifest.restart_command, "pm2 restart feishu-gateway");
  assert.match(manifest.rollback_source, /same target paths/);
  assert.doesNotMatch(manifest.restart_command, /worker-api|nginx|restart all/i);
});

test("Gateway delegates every business event to the shared application boundary", () => {
  assert.match(gatewaySource, /createFeishuApplicationBoundaryClient/);
  assert.match(gatewaySource, /client\.dispatch\(\{[\s\S]*rawBody,[\s\S]*headers: req\.headers/);
});

test("Gateway contains no direct hermes_jobs persistence", () => {
  assert.doesNotMatch(gatewaySource, /hermes_jobs|supabase|\/rest\/v1|\/rpc\//i);
});

test("Gateway contains no Worker job creator", () => {
  assert.doesNotMatch(gatewaySource, /(?:create|insert|enqueue)[A-Za-z0-9_]*Job|canonicalCreateJob/i);
});

test("Gateway contains no independent GM routing", () => {
  assert.doesNotMatch(gatewaySource, /project[_ -]?(?:director|general_manager)|GM_ROUTING|agent[_ -]?mapping/i);
});

test("Gateway contains no execution-state authority", () => {
  assert.doesNotMatch(gatewaySource, /attempt_id|lease_id|terminal_at|effective_final_status/i);
});

test("transport dedupe keys only use event or message identity", () => {
  assert.equal(gatewayModule.eventDedupeKey({ header: { event_id: "e-1" } }), "event:e-1");
  assert.equal(gatewayModule.eventDedupeKey({ event: { message: { message_id: "m-1" } } }), "message:m-1");
});

test("transport dedupe shares one in-flight dispatch", async () => {
  const dedupe = gatewayModule.createTransportDedupe();
  let calls = 0;
  const operation = async () => { calls += 1; return { ok: true }; };
  const [first, second] = await Promise.all([dedupe.run("event:e", operation), dedupe.run("event:e", operation)]);
  assert.equal(calls, 1);
  assert.equal(first.result.ok, true);
  assert.equal(second.duplicate, true);
});

test("failed transport dispatch is retryable", async () => {
  const dedupe = gatewayModule.createTransportDedupe();
  await assert.rejects(dedupe.run("event:e", async () => { throw new Error("offline"); }));
  const retried = await dedupe.run("event:e", async () => ({ ok: true }));
  assert.equal(retried.duplicate, false);
});

test("application client signs and forwards the original body", async () => {
  let captured;
  const env = { FEISHU_APPLICATION_EVENT_URL: "https://example.test/api/feishu/event", FEISHU_APP_SECRET: "secret" };
  const client = routerModule.createFeishuApplicationBoundaryClient({ env, fetchImpl: async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify(routerModule.buildFeishuApplicationAcceptanceResponse("event-artifact")), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } });
  const rawBody = Buffer.from('{"type":"event_callback"}');
  const result = await client.dispatch({ rawBody, headers: {} });
  assert.equal(captured.url, env.FEISHU_APPLICATION_EVENT_URL);
  assert.deepEqual(captured.options.body, rawBody);
  assert.equal(result.body.code, 0);
  assert.equal(result.body.accepted, true);
});

test("application boundary signature rejects tampering", () => {
  const signature = routerModule.signApplicationPayload("one", "secret");
  assert.equal(routerModule.verifyApplicationPayloadSignature("one", signature, "secret"), true);
  assert.equal(routerModule.verifyApplicationPayloadSignature("two", signature, "secret"), false);
});

test("application endpoint cannot point at the PM2 callback route", () => {
  assert.equal(routerModule.resolveApplicationEndpoint({ FEISHU_APPLICATION_EVENT_URL: "https://example.test/feishu/event" }), null);
  assert.equal(routerModule.resolveApplicationEndpoint({ FEISHU_APPLICATION_EVENT_URL: "https://example.test/api/feishu/event" }), "https://example.test/api/feishu/event");
});

test("Next.js route verifies the PM2 transport envelope", () => {
  assert.match(routeSource, /prepareFeishuCallbackAcceptance\(\{/);
  assert.match(acceptanceSource, /verifyFeishuApplicationBoundaryRequest\(\{/);
});

test("Next.js route owns the shared feature decision", () => {
  assert.match(routeSource, /resolveFeishuApplicationFeatureRoute\(process\.env\)/);
  assert.match(featureSource, /resolveHermesCanonicalCutoverConfig/);
  assert.doesNotMatch(gatewaySource + routerSource, /HERMES_CANONICAL_(?:ORCHESTRATION|SHADOW)_ENABLED/);
});

test("canonical approval context has one implementation", () => {
  assert.equal((contextSource.match(/function buildCanonicalApprovalContext\s*\(/g) || []).length, 1);
  assert.doesNotMatch(gatewaySource + routerSource, /function buildCanonicalApprovalContext\s*\(/);
});

test("production behavior reconciliation has no unknowns or parallel authority", () => {
  assert.deepEqual(reconciliation.unknown_runtime_behaviors, []);
  assert.deepEqual(reconciliation.gateway_authoritative_code_hits, []);
  assert.equal(reconciliation.target_architecture.parallel_business_implementations, 0);
  assert.equal(reconciliation.target_architecture.parallel_authoritative_job_creators, 0);
});

test("manifest declares thin entrypoint authority", () => {
  assert.ok(manifest.entrypoint_responsibilities.includes("shared_application_boundary_dispatch"));
  assert.ok(manifest.entrypoint_forbidden_authorities.includes("database_persistence"));
  assert.equal(manifest.shared_application_boundary.source_path, "src/app/api/feishu/event/route.ts");
});

test("shared application boundary covers every reconciled production business capability", () => {
  const requiredMarkers = [
    "FEISHU_VERIFICATION_TOKEN",
    "decryptFeishuEvent",
    "feishu_event_receipts",
    "sendFeishuMessage",
    "parseProjectDirectorConsoleCommand",
    "isBossApprovalReply",
    "runApprovedRequestThroughCanonicalHermes",
    "canonicalCreateJob",
    "createHermesJob",
    "markReceiptFailed",
  ];
  for (const marker of requiredMarkers) assert.match(routeSource + acceptanceSource, new RegExp(marker));
});

test("artifact verifier scans the real PM2 entrypoint authority", () => {
  const verifier = readFileSync(join(root, "scripts/verify-production-feishu-gateway-artifact.mjs"), "utf8");
  assert.match(verifier, /forbiddenAuthorityPatterns/);
  assert.match(verifier, /productionGatewayArtifact/);
  assert.match(verifier, /PM2 Gateway artifact authority detected/);
  assert.match(verifier, /entrypoint_direct_authority_scan_passed/);
});
