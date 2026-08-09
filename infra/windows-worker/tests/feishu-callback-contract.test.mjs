import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const gateway = require(path.join(root, "infra", "tencent-worker", "feishu_gateway_canonical.js"));
const router = require(path.join(root, "infra", "tencent-worker", "feishu_gateway_canonical_router.js"));
const gatewaySource = fs.readFileSync(path.join(root, "infra", "tencent-worker", "feishu_gateway_canonical.js"), "utf8");
const routerSource = fs.readFileSync(path.join(root, "infra", "tencent-worker", "feishu_gateway_canonical_router.js"), "utf8");
const routeSource = fs.readFileSync(path.join(root, "src", "app", "api", "feishu", "event", "route.ts"), "utf8");
const acceptanceSource = fs.readFileSync(path.join(root, "src", "lib", "feishu-callback-application.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "infra", "tencent-worker", "production-artifacts", "feishu-gateway.json"), "utf8"));

const TEST_APPLICATION_SECRET = "synthetic-application-secret";
const TEST_ENCRYPT_KEY = "synthetic-feishu-encrypt-key";
const TEST_TIMESTAMP = "1786200000";
const TEST_NONCE = "synthetic-nonce";
const CALLBACK_BODY = Buffer.from('{\n  "header":{"event_id":"event-fixture","event_type":"im.message.receive_v1"},\n  "event":{"message":{"message_id":"message-fixture"}}\n}\n');

function loadTypeScriptModule(file, resolveMock) {
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
  const compiledModule = { exports: {} };
  const localRequire = (id) => resolveMock(id);
  new Function("require", "module", "exports", output)(localRequire, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}

const envelopeMock = {
  FEISHU_APPLICATION_BOUNDARY_SIGNATURE_HEADER: router.SIGNATURE_HEADER,
  FEISHU_APPLICATION_BOUNDARY_SOURCE_HEADER: router.SOURCE_HEADER,
  FEISHU_TRANSPORT_REQUEST_ID_HEADER: router.TRANSPORT_REQUEST_ID_HEADER,
  FEISHU_TIMESTAMP_HEADER: router.FEISHU_TIMESTAMP_HEADER,
  FEISHU_NONCE_HEADER: router.FEISHU_NONCE_HEADER,
  FEISHU_SIGNATURE_HEADER: router.FEISHU_SIGNATURE_HEADER,
  buildFeishuApplicationAcceptanceResponse: router.buildFeishuApplicationAcceptanceResponse,
  verifyFeishuApplicationBoundaryRequest(input) {
    return input.source === router.SOURCE_ID && router.verifyApplicationPayloadSignature(input.rawBody, input.signature, input.secret);
  },
  verifyFeishuCallbackRequestSignature(input) {
    return router.verifyFeishuCallbackSignature(input.rawBody, input.headers, input.encryptKey);
  },
};

const acceptance = loadTypeScriptModule(
  path.join(root, "src", "lib", "feishu-callback-application.ts"),
  (id) => {
    if (id === "@/lib/feishu-canonical-gateway-envelope") return envelopeMock;
    if (id === "@/lib/feishu-crypto") return { decryptFeishuEvent() { throw new Error("not used by plain fixture"); } };
    return require(id);
  }
);

function callbackHeaders(rawBody = CALLBACK_BODY, overrides = {}) {
  const signature = router.calculateFeishuCallbackSignature(rawBody, TEST_TIMESTAMP, TEST_NONCE, TEST_ENCRYPT_KEY);
  return new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "X-Lark-Request-Timestamp": TEST_TIMESTAMP,
    "X-Lark-Request-Nonce": TEST_NONCE,
    "X-Lark-Signature": signature,
    [router.SIGNATURE_HEADER]: router.signApplicationPayload(rawBody, TEST_APPLICATION_SECRET),
    [router.SOURCE_HEADER]: router.SOURCE_ID,
    [router.TRANSPORT_REQUEST_ID_HEADER]: "transport-fixture",
    ...overrides,
  });
}

function accept(rawBody = CALLBACK_BODY, overrides = {}) {
  return acceptance.prepareFeishuCallbackAcceptance({
    rawBody: new Uint8Array(rawBody),
    headers: callbackHeaders(rawBody, overrides),
    env: {
      FEISHU_APP_SECRET: TEST_APPLICATION_SECRET,
      FEISHU_ENCRYPT_KEY: TEST_ENCRYPT_KEY,
    },
  });
}

function validApplicationResponse(status = 200, eventId = "event-fixture") {
  return new Response(JSON.stringify(router.buildFeishuApplicationAcceptanceResponse(eventId)), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function applicationClient(fetchImpl) {
  return router.createFeishuApplicationBoundaryClient({
    env: {
      FEISHU_APPLICATION_EVENT_URL: "https://example.test/api/feishu/event",
      FEISHU_APP_SECRET: TEST_APPLICATION_SECRET,
    },
    fetchImpl,
  });
}

test("external callback deadline is fixed at 3000ms", () => {
  assert.equal(router.FEISHU_CALLBACK_EXTERNAL_DEADLINE_MS, 3000);
  assert.equal(manifest.feishu_callback_external_deadline_ms, 3000);
});

test("Application acceptance timeout reserves transport margin", () => {
  assert.equal(router.APPLICATION_ACCEPT_TIMEOUT_MS, 1500);
  assert.ok(router.APPLICATION_ACCEPT_TIMEOUT_MS < router.FEISHU_CALLBACK_EXTERNAL_DEADLINE_MS);
  assert.equal(manifest.application_accept_timeout_ms, 1500);
});

test("Gateway internal response budget is at most 2000ms", () => {
  assert.equal(router.GATEWAY_INTERNAL_RESPONSE_BUDGET_MS, 2000);
  assert.equal(manifest.gateway_internal_response_budget_ms, 2000);
});

test("signature forward header lookup is case insensitive", () => {
  const selected = router.selectFeishuForwardHeaders({
    "X-LARK-REQUEST-TIMESTAMP": TEST_TIMESTAMP,
    "x-Lark-request-NONCE": TEST_NONCE,
    "X-Lark-Signature": "fixture-signature",
    "CONTENT-TYPE": "application/json",
  });
  assert.equal(selected[router.FEISHU_TIMESTAMP_HEADER], TEST_TIMESTAMP);
  assert.equal(selected[router.FEISHU_NONCE_HEADER], TEST_NONCE);
  assert.equal(selected[router.FEISHU_SIGNATURE_HEADER], "fixture-signature");
  assert.equal(selected[router.CONTENT_TYPE_HEADER], "application/json");
});

test("Gateway header whitelist excludes credentials and cookies", () => {
  const selected = router.selectFeishuForwardHeaders({
    authorization: "Bearer never-forward",
    cookie: "secret=never-forward",
    "x-lark-signature": "allowed",
  });
  assert.equal(selected.authorization, undefined);
  assert.equal(selected.cookie, undefined);
  assert.equal(selected[router.FEISHU_SIGNATURE_HEADER], "allowed");
});

test("synthetic raw-body signature fixture validates", () => {
  assert.equal(router.verifyFeishuCallbackSignature(CALLBACK_BODY, callbackHeaders(), TEST_ENCRYPT_KEY), true);
});

test("one-byte raw-body mutation invalidates the signature", () => {
  const mutated = Buffer.from(CALLBACK_BODY);
  mutated[mutated.length - 2] ^= 1;
  assert.equal(router.verifyFeishuCallbackSignature(mutated, callbackHeaders(), TEST_ENCRYPT_KEY), false);
});

test("timestamp mutation invalidates the signature", () => {
  assert.equal(router.verifyFeishuCallbackSignature(CALLBACK_BODY, callbackHeaders(CALLBACK_BODY, { "X-Lark-Request-Timestamp": "1786200001" }), TEST_ENCRYPT_KEY), false);
});

test("nonce mutation invalidates the signature", () => {
  assert.equal(router.verifyFeishuCallbackSignature(CALLBACK_BODY, callbackHeaders(CALLBACK_BODY, { "X-Lark-Request-Nonce": "other-nonce" }), TEST_ENCRYPT_KEY), false);
});

test("signature mutation is rejected", () => {
  assert.equal(router.verifyFeishuCallbackSignature(CALLBACK_BODY, callbackHeaders(CALLBACK_BODY, { "X-Lark-Signature": "0".repeat(64) }), TEST_ENCRYPT_KEY), false);
});

test("semantically equal JSON is not reserialized in the signature channel", () => {
  const compact = Buffer.from(JSON.stringify(JSON.parse(CALLBACK_BODY.toString("utf8"))));
  assert.notDeepEqual(compact, CALLBACK_BODY);
  assert.equal(router.verifyFeishuCallbackSignature(compact, callbackHeaders(), TEST_ENCRYPT_KEY), false);
  assert.doesNotMatch(routerSource, /JSON\.stringify\([^)]*(?:rawBody|input\.body)/);
});

test("Application accepts a valid doubly authenticated callback", () => {
  const result = accept();
  assert.equal(result.ok, true);
  assert.equal(result.accepted.event_id, "event-fixture");
  assert.equal(result.accepted.transport_request_id, "transport-fixture");
});

test("Application fails closed when a Feishu signature header is missing", () => {
  const result = accept(CALLBACK_BODY, { "X-Lark-Request-Nonce": "" });
  assert.deepEqual(result, { ok: false, status: 401, failure_code: "FEISHU_CALLBACK_SIGNATURE_CONTEXT_MISSING" });
});

test("Application fails closed for an invalid Feishu signature", () => {
  const result = accept(CALLBACK_BODY, { "X-Lark-Signature": "f".repeat(64) });
  assert.deepEqual(result, { ok: false, status: 401, failure_code: "FEISHU_CALLBACK_SIGNATURE_INVALID" });
});

test("Application fails closed before parsing when the Gateway envelope is invalid", () => {
  const result = accept(CALLBACK_BODY, { [router.SIGNATURE_HEADER]: "0".repeat(64) });
  assert.deepEqual(result, { ok: false, status: 401, failure_code: "FEISHU_APPLICATION_BOUNDARY_SIGNATURE_INVALID" });
});

test("Application acceptance has no business persistence imports", () => {
  assert.doesNotMatch(acceptanceSource, /supabase|canonicalCreateJob|createHermesJob|feishu_event_receipts/i);
  assert.ok(acceptanceSource.indexOf("verifyFeishuCallbackRequestSignature") < acceptanceSource.indexOf("JSON.parse"));
});

test("Gateway forwards exact bytes and original signature values", async () => {
  let captured;
  const client = router.createFeishuApplicationBoundaryClient({
    env: { FEISHU_APPLICATION_EVENT_URL: "https://example.test/api/feishu/event", FEISHU_APP_SECRET: TEST_APPLICATION_SECRET },
    fetchImpl: async (_url, options) => {
      captured = options;
      return validApplicationResponse();
    },
  });
  const headers = callbackHeaders();
  await client.dispatch({ rawBody: CALLBACK_BODY, headers, transportRequestId: "transport-fixture" });
  assert.deepEqual(captured.body, CALLBACK_BODY);
  assert.equal(captured.headers[router.FEISHU_TIMESTAMP_HEADER], TEST_TIMESTAMP);
  assert.equal(captured.headers[router.FEISHU_NONCE_HEADER], TEST_NONCE);
  assert.equal(captured.headers[router.FEISHU_SIGNATURE_HEADER], headers.get(router.FEISHU_SIGNATURE_HEADER));
  assert.equal(captured.headers[router.CONTENT_TYPE_HEADER], headers.get(router.CONTENT_TYPE_HEADER));
});

test("shared Application acceptance schema is explicit", () => {
  assert.deepEqual(router.buildFeishuApplicationAcceptanceResponse(" event-1 "), {
    code: 0,
    accepted: true,
    transport_acceptance: true,
    event_id: "event-1",
  });
});

test("real Router rejects HTTP 200 text/plain fallback success", async () => {
  const client = applicationClient(async () => new Response("OK", {
    status: 200,
    headers: { "content-type": "text/plain" },
  }));
  await assert.rejects(
    client.dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }),
    (error) => error.code === "FEISHU_APPLICATION_INVALID_CONTENT_TYPE" && error.status === 502
  );
});

test("real Router rejects JSON text served as text/html", async () => {
  const client = applicationClient(async () => new Response('{"accepted":true}', {
    status: 200,
    headers: { "content-type": "text/html" },
  }));
  await assert.rejects(
    client.dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }),
    (error) => error.code === "FEISHU_APPLICATION_INVALID_CONTENT_TYPE"
  );
});

test("real Router rejects an empty JSON response", async () => {
  const client = applicationClient(async () => new Response("", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(
    client.dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }),
    (error) => error.code === "FEISHU_APPLICATION_INVALID_JSON"
  );
});

test("real Router rejects invalid JSON", async () => {
  const client = applicationClient(async () => new Response("{invalid-json", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(
    client.dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }),
    (error) => error.code === "FEISHU_APPLICATION_INVALID_JSON"
  );
});

test("real Router rejects an empty acceptance schema", async () => {
  const client = applicationClient(async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(
    client.dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }),
    (error) => error.code === "FEISHU_APPLICATION_INVALID_ACCEPTANCE_SCHEMA"
  );
});

test("real Router does not infer acceptance from code or ok fields", async () => {
  const client = applicationClient(async () => new Response('{"code":0,"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(
    client.dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }),
    (error) => error.code === "FEISHU_APPLICATION_INVALID_ACCEPTANCE_SCHEMA"
  );
});

test("real Router preserves explicit Application rejection", async () => {
  const client = applicationClient(async () => new Response('{"code":0,"accepted":false}', {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(
    client.dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }),
    (error) => error.code === "FEISHU_APPLICATION_EXPLICIT_REJECTION"
  );
});

test("real Router accepts a valid 201 schema and normalizes the Feishu ACK to 200", async () => {
  const result = await applicationClient(async () => validApplicationResponse(201)).dispatch({
    rawBody: CALLBACK_BODY,
    headers: callbackHeaders(),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.accepted, true);
});

test("real Router rejects a 204 empty response", async () => {
  const client = applicationClient(async () => new Response(null, { status: 204 }));
  await assert.rejects(
    client.dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }),
    (error) => error.code === "FEISHU_APPLICATION_INVALID_CONTENT_TYPE"
  );
});

test("default Application response policy rejects unknown JSON values", () => {
  for (const responseText of ["null", "true", "[]", '"accepted"', '{"accepted":true}']) {
    assert.throws(
      () => router.parseFeishuApplicationAcceptanceResponse({
        status: 200,
        headers: { "content-type": "application/json" },
        responseText,
      }),
      (error) => error.code === "FEISHU_APPLICATION_INVALID_ACCEPTANCE_SCHEMA"
    );
  }
});

test("malformed response errors expose metadata but never the response body", async () => {
  const sensitiveBody = "secret-response-body-must-not-leak";
  const client = applicationClient(async () => new Response(sensitiveBody, {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(
    client.dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }),
    (error) => {
      assert.equal(error.code, "FEISHU_APPLICATION_INVALID_JSON");
      assert.equal(error.responseLength, Buffer.byteLength(sensitiveBody));
      assert.doesNotMatch(JSON.stringify(error), /secret-response-body-must-not-leak/);
      assert.doesNotMatch(error.message, /secret-response-body-must-not-leak/);
      return true;
    }
  );
});

test("malformed response failure is immediate within the Gateway budget", async () => {
  const startedAt = performance.now();
  await assert.rejects(
    applicationClient(async () => new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    })).dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }),
    (error) => error.code === "FEISHU_APPLICATION_INVALID_JSON"
  );
  assert.ok(performance.now() - startedAt < router.GATEWAY_INTERNAL_RESPONSE_BUDGET_MS);
});

test("Application 500 is not converted into a successful ACK", async () => {
  const client = router.createFeishuApplicationBoundaryClient({
    env: { FEISHU_APPLICATION_EVENT_URL: "https://example.test/api/feishu/event", FEISHU_APP_SECRET: TEST_APPLICATION_SECRET },
    fetchImpl: async () => new Response('{"code":500}', {
      status: 500,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(client.dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }), (error) => error.code === "FEISHU_APPLICATION_HTTP_REJECTED" && error.status === 500);
});

test("Application network failure is not converted into a successful ACK", async () => {
  const client = router.createFeishuApplicationBoundaryClient({
    env: { FEISHU_APPLICATION_EVENT_URL: "https://example.test/api/feishu/event", FEISHU_APP_SECRET: TEST_APPLICATION_SECRET },
    fetchImpl: async () => { throw Object.assign(new Error("offline"), { code: "ENETUNREACH" }); },
  });
  await assert.rejects(client.dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }), (error) => error.code === "FEISHU_APPLICATION_NETWORK_FAILURE" && error.causeCode === "ENETUNREACH");
});

test("hung Application request is deterministically aborted at 1500ms", async () => {
  let scheduledMs = 0;
  const client = router.createFeishuApplicationBoundaryClient({
    env: { FEISHU_APPLICATION_EVENT_URL: "https://example.test/api/feishu/event", FEISHU_APP_SECRET: TEST_APPLICATION_SECRET },
    setTimeoutImpl(callback, milliseconds) { scheduledMs = milliseconds; queueMicrotask(callback); return 1; },
    clearTimeoutImpl() {},
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  await assert.rejects(client.dispatch({ rawBody: CALLBACK_BODY, headers: callbackHeaders() }), (error) => error.code === "FEISHU_APPLICATION_TIMEOUT" && error.status === 504);
  assert.equal(scheduledMs, 1500);
});

test("unsafe custom timeout is rejected", () => {
  assert.throws(() => router.createFeishuApplicationBoundaryClient({ timeoutMs: 1501 }), /FEISHU_APPLICATION_ACCEPT_TIMEOUT_UNSAFE/);
});

test("real Gateway response budget resolves a fast Application acceptance", async () => {
  const result = await gateway.runWithinResponseBudget(async () => ({ status: 200 }), { timeoutMs: 2000 });
  assert.equal(result.status, 200);
});

test("real Gateway response budget rejects a hung Application before 3000ms", async () => {
  let scheduledMs = 0;
  await assert.rejects(gateway.runWithinResponseBudget(
    async () => new Promise(() => {}),
    {
      timeoutMs: 2000,
      setTimeoutImpl(callback, milliseconds) { scheduledMs = milliseconds; queueMicrotask(callback); return 1; },
      clearTimeoutImpl() {},
    }
  ), (error) => error.code === "FEISHU_GATEWAY_RESPONSE_BUDGET_EXCEEDED" && error.status === 504);
  assert.equal(scheduledMs, 2000);
  assert.ok(scheduledMs < router.FEISHU_CALLBACK_EXTERNAL_DEADLINE_MS);
});

test("real Gateway response budget preserves Application failures", async () => {
  await assert.rejects(
    gateway.runWithinResponseBudget(async () => { throw Object.assign(new Error("application failed"), { status: 500 }); }),
    (error) => error.status === 500
  );
});

test("real Gateway response budget preserves network failures", async () => {
  await assert.rejects(
    gateway.runWithinResponseBudget(async () => { throw Object.assign(new Error("network failed"), { code: "ENETUNREACH" }); }),
    (error) => error.code === "ENETUNREACH"
  );
});

test("challenge remains local to the real PM2 entrypoint", () => {
  assert.match(gatewaySource, /body\.type === "url_verification"/);
  assert.ok(gatewaySource.indexOf('body.type === "url_verification"') < gatewaySource.indexOf("client.dispatch"));
});

test("Application route uses supported after lifecycle, not bare fire-and-forget", () => {
  assert.match(routeSource, /after\(async \(\) =>/);
  assert.doesNotMatch(routeSource, /void\s+processAcceptedFeishuEvent|setTimeout\(processAcceptedFeishuEvent/);
  assert.ok(routeSource.indexOf("prepareFeishuCallbackAcceptance") < routeSource.indexOf("after(async () =>"));
  assert.ok(routeSource.indexOf("buildFeishuApplicationAcceptanceResponse(accepted.event_id)") < routeSource.indexOf("after(async () =>"));
});

test("transport acceptance is explicitly separate from task success", () => {
  assert.match(routeSource, /buildFeishuApplicationAcceptanceResponse\(accepted\.event_id\)/);
  assert.doesNotMatch(routeSource.slice(routeSource.indexOf("export async function POST")), /task_goal_status\s*:\s*["']succeeded/);
});

test("background execution reuses the existing shared business function", () => {
  assert.match(routeSource, /await processAcceptedFeishuEvent\(accepted\.payload\)/);
  assert.equal((routeSource.match(/async function processAcceptedFeishuEvent/g) || []).length, 1);
});

test("durable Feishu receipt remains the retry idempotency boundary", () => {
  assert.match(routeSource, /from\("feishu_event_receipts"\)\.insert/);
  assert.match(routeSource, /isDuplicateReceiptError\(receiptError\)/);
  assert.doesNotMatch(gatewaySource, /feishu_event_receipts/);
});

test("callback observability excludes raw authentication data", () => {
  assert.match(gatewaySource + routeSource, /application_accept_latency_ms|background_started/);
  assert.doesNotMatch(gatewaySource, /console\.[a-z]+\([^\n]*(?:rawBody|x-lark-signature|FEISHU_APP_SECRET)/i);
});

test("manifest records the complete callback safety contract", () => {
  assert.equal(manifest.transport, "NGINX_HTTP_CALLBACK");
  assert.equal(manifest.raw_body_preservation, true);
  assert.equal(manifest.challenge_handled_locally, true);
  assert.deepEqual(manifest.required_forward_headers, [
    "x-lark-request-timestamp",
    "x-lark-request-nonce",
    "x-lark-signature",
    "content-type",
  ]);
  assert.equal(manifest.shared_application_boundary.background_execution_primitive, "next/server.after");
  assert.deepEqual(manifest.application_response_contract, {
    schema: "feishu_application_acceptance_v1",
    allowed_http_status: "2xx",
    content_type: "application/json",
    required_fields: {
      code: 0,
      accepted: true,
      transport_acceptance: true,
      event_id: "non_empty_string",
    },
    malformed_response_policy: "FAIL_CLOSED",
    default_response_policy: "REJECT",
    transport_acceptance_is_not_business_success: true,
  });
});

test("real Application route accepts a valid callback and registers background work", async () => {
  const afterTasks = [];
  class MockNextResponse {
    constructor(body, status) { this.body = body; this.status = status; }
    static json(body, options = {}) { return new MockNextResponse(body, options.status ?? 200); }
  }
  const genericMock = new Proxy(function noop() {}, { get: () => function noop() {} });
  const route = loadTypeScriptModule(
    path.join(root, "src", "app", "api", "feishu", "event", "route.ts"),
    (id) => {
      if (id === "next/server") return { after(task) { afterTasks.push(task); }, NextResponse: MockNextResponse, NextRequest: class {} };
      if (id === "@/lib/feishu-callback-application") return acceptance;
      if (id === "@/lib/feishu-canonical-gateway-envelope") return envelopeMock;
      return genericMock;
    }
  );
  const previous = { secret: process.env.FEISHU_APP_SECRET, key: process.env.FEISHU_ENCRYPT_KEY };
  process.env.FEISHU_APP_SECRET = TEST_APPLICATION_SECRET;
  process.env.FEISHU_ENCRYPT_KEY = TEST_ENCRYPT_KEY;
  try {
    const response = await route.POST({ headers: callbackHeaders(), async arrayBuffer() { return CALLBACK_BODY; } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, router.buildFeishuApplicationAcceptanceResponse("event-fixture"));
    assert.equal(afterTasks.length, 1);
  } finally {
    if (previous.secret === undefined) delete process.env.FEISHU_APP_SECRET; else process.env.FEISHU_APP_SECRET = previous.secret;
    if (previous.key === undefined) delete process.env.FEISHU_ENCRYPT_KEY; else process.env.FEISHU_ENCRYPT_KEY = previous.key;
  }
});

test("real Application route rejects missing signature before background registration", async () => {
  const afterTasks = [];
  class MockNextResponse {
    constructor(body, status) { this.body = body; this.status = status; }
    static json(body, options = {}) { return new MockNextResponse(body, options.status ?? 200); }
  }
  const genericMock = new Proxy(function noop() {}, { get: () => function noop() {} });
  const route = loadTypeScriptModule(
    path.join(root, "src", "app", "api", "feishu", "event", "route.ts"),
    (id) => {
      if (id === "next/server") return { after(task) { afterTasks.push(task); }, NextResponse: MockNextResponse, NextRequest: class {} };
      if (id === "@/lib/feishu-callback-application") return acceptance;
      if (id === "@/lib/feishu-canonical-gateway-envelope") return envelopeMock;
      return genericMock;
    }
  );
  const headers = callbackHeaders();
  headers.delete(router.FEISHU_SIGNATURE_HEADER);
  const oldSecret = process.env.FEISHU_APP_SECRET;
  const oldKey = process.env.FEISHU_ENCRYPT_KEY;
  process.env.FEISHU_APP_SECRET = TEST_APPLICATION_SECRET;
  process.env.FEISHU_ENCRYPT_KEY = TEST_ENCRYPT_KEY;
  try {
    const response = await route.POST({ headers, async arrayBuffer() { return CALLBACK_BODY; } });
    assert.equal(response.status, 401);
    assert.equal(afterTasks.length, 0);
  } finally {
    if (oldSecret === undefined) delete process.env.FEISHU_APP_SECRET; else process.env.FEISHU_APP_SECRET = oldSecret;
    if (oldKey === undefined) delete process.env.FEISHU_ENCRYPT_KEY; else process.env.FEISHU_ENCRYPT_KEY = oldKey;
  }
});

test("real Application route rejects a body mutation before background registration", async () => {
  const afterTasks = [];
  class MockNextResponse {
    constructor(body, status) { this.body = body; this.status = status; }
    static json(body, options = {}) { return new MockNextResponse(body, options.status ?? 200); }
  }
  const genericMock = new Proxy(function noop() {}, { get: () => function noop() {} });
  const route = loadTypeScriptModule(
    path.join(root, "src", "app", "api", "feishu", "event", "route.ts"),
    (id) => {
      if (id === "next/server") return { after(task) { afterTasks.push(task); }, NextResponse: MockNextResponse, NextRequest: class {} };
      if (id === "@/lib/feishu-callback-application") return acceptance;
      if (id === "@/lib/feishu-canonical-gateway-envelope") return envelopeMock;
      return genericMock;
    }
  );
  const mutated = Buffer.from(CALLBACK_BODY.toString("utf8").replace("event-fixture", "event-changed"));
  const oldSecret = process.env.FEISHU_APP_SECRET;
  const oldKey = process.env.FEISHU_ENCRYPT_KEY;
  process.env.FEISHU_APP_SECRET = TEST_APPLICATION_SECRET;
  process.env.FEISHU_ENCRYPT_KEY = TEST_ENCRYPT_KEY;
  try {
    const response = await route.POST({ headers: callbackHeaders(), async arrayBuffer() { return mutated; } });
    assert.equal(response.status, 401);
    assert.equal(afterTasks.length, 0);
  } finally {
    if (oldSecret === undefined) delete process.env.FEISHU_APP_SECRET; else process.env.FEISHU_APP_SECRET = oldSecret;
    if (oldKey === undefined) delete process.env.FEISHU_ENCRYPT_KEY; else process.env.FEISHU_ENCRYPT_KEY = oldKey;
  }
});

test("Gateway remains a thin transport adapter after callback hardening", () => {
  assert.doesNotMatch(gatewaySource + routerSource, /hermes_jobs|canonicalCreateJob|createHermesJob|attempt_id|lease_id|effective_final_status/i);
  assert.match(gatewaySource, /express\.raw\(/);
  assert.match(gatewaySource, /client\.dispatch/);
});
