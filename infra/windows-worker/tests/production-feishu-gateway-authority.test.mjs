import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);
const gatewayPath = join(root, "infra/tencent-worker/feishu_gateway_canonical.js");
const routerPath = join(root, "infra/tencent-worker/feishu_gateway_canonical_router.js");
const routePath = join(root, "src/app/api/feishu/event/route.ts");
const gatewaySource = readFileSync(gatewayPath, "utf8");
const routerSource = readFileSync(routerPath, "utf8");
const routeSource = readFileSync(routePath, "utf8");
const gateway = require(gatewayPath);
const router = require(routerPath);

async function withServer(app, operation) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address();
    return await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("real PM2 entrypoint is transport only", () => {
  assert.match(gatewaySource, /role: "feishu_transport_adapter"/);
  assert.doesNotMatch(gatewaySource, /classify|planner|orchestrat/i);
});

test("real PM2 entrypoint has one HTTP callback", () => {
  assert.equal((gatewaySource.match(/app\.post\("\/feishu\/event"/g) || []).length, 1);
});

test("real PM2 entrypoint has no authoritative HTTP database target", () => {
  assert.doesNotMatch(gatewaySource, /\/rest\/v1|\/rpc\/|postgres|database/i);
});

test("real PM2 entrypoint has no job lifecycle vocabulary", () => {
  assert.doesNotMatch(gatewaySource, /job_state|claimed_by|canonical_revision|retry_state/i);
});

test("real PM2 entrypoint has no attempt mutation", () => {
  assert.doesNotMatch(gatewaySource, /attempt_id|createAttempt|closeAttempt/i);
});

test("real PM2 entrypoint has no lease mutation", () => {
  assert.doesNotMatch(gatewaySource, /lease_id|acquireLease|heartbeat_at/i);
});

test("real PM2 entrypoint has no terminal mutation", () => {
  assert.doesNotMatch(gatewaySource, /terminal|effective_final_status|failure_stage/i);
});

test("real PM2 entrypoint cannot start Worker or Codex", () => {
  assert.doesNotMatch(gatewaySource, /child_process|spawn\(|exec\(|local_worker|codex/i);
});

test("URL verification challenge remains local and deterministic", async () => {
  const app = gateway.createGatewayApp({ client: { dispatch: async () => { throw new Error("unexpected"); } }, logger: { error() {} } });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/feishu/event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "url_verification", challenge: "c-1" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { challenge: "c-1" });
  });
});

test("non-challenge callback ACK comes from shared application boundary", async () => {
  const app = gateway.createGatewayApp({ client: { dispatch: async () => ({ status: 202, body: { code: 0, owner: "application" } }) }, logger: { error() {} } });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/feishu/event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ header: { event_id: "e-1" } }) });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).owner, "application");
  });
});

test("duplicate callback does not invoke application twice", async () => {
  let calls = 0;
  const app = gateway.createGatewayApp({ client: { dispatch: async () => { calls += 1; return { status: 200, body: { code: 0 } }; } }, logger: { error() {} } });
  await withServer(app, async (base) => {
    const options = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ header: { event_id: "e-2" } }) };
    await fetch(`${base}/feishu/event`, options);
    const duplicate = await fetch(`${base}/feishu/event`, options);
    assert.equal(duplicate.headers.get("x-city-partner-transport-deduplicated"), "true");
  });
  assert.equal(calls, 1);
});

test("different event IDs dispatch independently", async () => {
  let calls = 0;
  const dedupe = gateway.createTransportDedupe();
  await dedupe.run("event:1", async () => { calls += 1; });
  await dedupe.run("event:2", async () => { calls += 1; });
  assert.equal(calls, 2);
});

test("event identity takes precedence over message identity", () => {
  assert.equal(gateway.eventDedupeKey({ header: { event_id: "e" }, event: { message: { message_id: "m" } } }), "event:e");
});

test("payload without transport identity is delegated without invented job identity", async () => {
  const dedupe = gateway.createTransportDedupe();
  let calls = 0;
  await dedupe.run(gateway.eventDedupeKey({ type: "event_callback" }), async () => { calls += 1; });
  assert.equal(calls, 1);
});

test("application endpoint requires the shared Next.js path", () => {
  assert.equal(router.resolveApplicationEndpoint({ FEISHU_APPLICATION_EVENT_URL: "http://127.0.0.1:3000/api/feishu/event" }), "http://127.0.0.1:3000/api/feishu/event");
  assert.equal(router.resolveApplicationEndpoint({ FEISHU_APPLICATION_EVENT_URL: "http://remote.test/api/feishu/event" }), null);
});

test("legacy endpoint variable is only an endpoint compatibility alias", () => {
  assert.equal(router.resolveApplicationEndpoint({ HERMES_CANONICAL_EVENT_URL: "https://example.test/api/feishu/event" }), "https://example.test/api/feishu/event");
  assert.doesNotMatch(routerSource, /HERMES_CANONICAL_ORCHESTRATION_ENABLED/);
});

test("Gateway has no feature routing switch", () => {
  assert.doesNotMatch(gatewaySource + routerSource, /SHADOW_ENABLED|ORCHESTRATION_ENABLED|ROLLBACK_TO_LEGACY/);
});

test("Next.js route uses one shared feature decision for legacy and canonical guards", () => {
  assert.match(routeSource, /const feishuFeatureRoute = resolveFeishuApplicationFeatureRoute\(process\.env\)/);
  assert.ok((routeSource.match(/feishuFeatureRoute\.canonical_enabled/g) || []).length >= 3);
});

test("canonical creation remains inside the application boundary", () => {
  assert.match(routeSource, /canonicalCreateJob\(supabase/);
  assert.doesNotMatch(gatewaySource + routerSource, /canonicalCreateJob/);
});

test("legacy creation remains inside the application boundary", () => {
  assert.match(routeSource, /createHermesJob/);
  assert.doesNotMatch(gatewaySource + routerSource, /createHermesJob|hermes_jobs/);
});

test("application dispatch fails closed without endpoint", async () => {
  const client = router.createFeishuApplicationBoundaryClient({ env: { FEISHU_APP_SECRET: "secret" } });
  await assert.rejects(client.dispatch({ rawBody: "{}", body: {} }), /FEISHU_APPLICATION_ENDPOINT_INVALID/);
});

test("application dispatch fails closed without signing secret", async () => {
  const client = router.createFeishuApplicationBoundaryClient({ env: { FEISHU_APPLICATION_EVENT_URL: "https://example.test/api/feishu/event" } });
  await assert.rejects(client.dispatch({ rawBody: "{}", body: {} }), /FEISHU_APPLICATION_SIGNING_SECRET_MISSING/);
});
