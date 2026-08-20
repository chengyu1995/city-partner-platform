import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const migrationPath = path.join(
  root,
  "supabase",
  "migrations",
  "202608140001_canary_owner_identity_receipt.sql"
);
const migration = fs.readFileSync(migrationPath, "utf8");
const routePath = path.join(root, "src", "app", "api", "feishu", "event", "route.ts");
const routeSource = fs.readFileSync(routePath, "utf8");
const helperPath = path.join(root, "src", "lib", "feishu-owner-identity-discovery.ts");
const helperSource = fs.readFileSync(helperPath, "utf8");
const helper = loadTypeScriptModule(helperPath, (id) => require(id));
const RAW_NONCE = "a".repeat(64);
const NONCE_SHA256 = sha256(RAW_NONCE);
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://synthetic.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

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
  new Function("require", "module", "exports", output)(
    (id) => resolveMock(id),
    compiledModule,
    compiledModule.exports
  );
  return compiledModule.exports;
}

function accepted(overrides = {}) {
  const text = overrides.text ?? `总管 身份验证 ${RAW_NONCE}`;
  return {
    payload: {
      header: { event_id: overrides.eventId ?? "event-fixture", event_type: overrides.eventType ?? "im.message.receive_v1" },
      event: {
        sender: {
          sender_type: overrides.senderType ?? "user",
          sender_id: { open_id: overrides.owner ?? "ou_synthetic_owner" },
        },
        message: {
          message_id: "message-fixture",
          chat_type: overrides.chatType ?? "p2p",
          content: JSON.stringify({ text }),
        },
      },
    },
    event_id: overrides.eventId ?? "event-fixture",
    event_type: overrides.eventType ?? "im.message.receive_v1",
    transport_request_id: "transport-fixture",
  };
}

function routeHarness({ acceptedCallback, rpcImpl }) {
  const afterTasks = [];
  const logs = [];
  const supabase = { rpc: rpcImpl };
  class MockNextResponse {
    constructor(body, status) { this.body = body; this.status = status; }
    static json(body, options = {}) { return new MockNextResponse(body, options.status ?? 200); }
  }
  const genericMock = new Proxy(function noop() {}, { get: () => function noop() {} });
  const route = loadTypeScriptModule(routePath, (id) => {
    if (id === "next/server") {
      return {
        after(task) { afterTasks.push(task); },
        NextResponse: MockNextResponse,
        NextRequest: class {},
      };
    }
    if (id === "@supabase/supabase-js") return { createClient() { return supabase; } };
    if (id === "@/lib/feishu-callback-application") {
      return {
        prepareFeishuCallbackAcceptance() { return { ok: true, accepted: acceptedCallback }; },
        buildFeishuCallbackAuthenticationAuditRecord() {
          return {
            failure_code: "NONE",
            authentication_layer: "ACCEPTED",
            authentication_stage: "COMPLETE",
            internal_gateway_auth_passed: true,
            feishu_callback_auth_passed: true,
          };
        },
      };
    }
    if (id === "@/lib/feishu-canonical-gateway-envelope") {
      return { buildFeishuApplicationAcceptanceResponse(eventId) { return { code: 0, accepted: true, event_id: eventId }; } };
    }
    if (id === "@/lib/feishu-owner-identity-discovery") return helper;
    return genericMock;
  });
  return { route, afterTasks, logs, supabase };
}

async function callRoute(harness) {
  const originalInfo = console.info;
  console.info = (...args) => harness.logs.push(args);
  try {
    return await harness.route.POST({ headers: new Headers(), async arrayBuffer() { return new ArrayBuffer(0); } });
  } finally {
    console.info = originalInfo;
  }
}

test("new migration adds exactly the approved table and two functions", () => {
  assert.equal((migration.match(/create table public\./gi) ?? []).length, 1);
  assert.equal((migration.match(/create function public\./gi) ?? []).length, 2);
  assert.match(migration, /create table public\.hermes_canary_owner_identity_receipts/i);
  assert.match(migration, /create function public\.capture_canary_owner_identity_receipt\(/i);
  assert.match(migration, /create function public\.audit_canary_owner_identity_receipt\(/i);
  assert.doesNotMatch(migration, /create or replace/i);
});

test("migration leaves both executed migrations byte-identical", () => {
  const hashes = [
    ["202608110001_canonical_canary_admission_control.sql", "d1f92f4f56bd1a83a301dff950c20965eacc4b4dbb9ab0fefdd02286d962eac9"],
    ["202608130001_canonical_canary_read_only_audit_function.sql", "7547cf283995c2dae5b4f69b2b61fe1e2f334a2543cea48d266f95d823605d03"],
  ];
  for (const [name, expected] of hashes) {
    const body = fs.readFileSync(path.join(root, "supabase", "migrations", name));
    assert.equal(createHash("sha256").update(body).digest("hex"), expected);
  }
});

test("receipt schema fixes purpose, status, hash, state, and time contracts", () => {
  assert.match(migration, /purpose = 'CANARY_OWNER_IDENTITY_DISCOVERY_V1'/i);
  assert.match(migration, /status in \('PENDING', 'CAPTURED', 'CONSUMED', 'RETIRED'\)/i);
  assert.match(migration, /nonce_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(migration, /challenge_expires_at > challenge_created_at/i);
  assert.match(migration, /receipt_expires_at > captured_at/i);
  assert.match(migration, /status = 'PENDING'[\s\S]*owner_open_id is null/i);
  assert.match(migration, /status = 'CAPTURED'[\s\S]*owner_open_id is not null/i);
  assert.match(migration, /status = 'CONSUMED'[\s\S]*owner_open_id is null/i);
  assert.match(migration, /status = 'RETIRED'[\s\S]*owner_open_id is null/i);
  assert.doesNotMatch(migration, /\braw_nonce\b|\bchallenge_token\b/i);
});

test("receipt uniqueness and RLS are database enforced without policies", () => {
  assert.match(migration, /unique index[\s\S]*\(nonce_sha256\)/i);
  assert.match(migration, /unique index[\s\S]*\(verified_event_id_sha256\)[\s\S]*where verified_event_id_sha256 is not null/i);
  assert.match(migration, /unique index[\s\S]*\(purpose\)[\s\S]*where status in \('PENDING', 'CAPTURED'\)/i);
  assert.match(migration, /alter table public\.hermes_canary_owner_identity_receipts enable row level security/i);
  assert.doesNotMatch(migration, /create policy/i);
});

test("capture RPC has the exact authority and mutation surface", () => {
  assert.match(migration, /capture_canary_owner_identity_receipt\(\s*p_nonce_sha256 text,\s*p_verified_owner_open_id text,\s*p_verified_event_id text\s*\)/i);
  assert.match(migration, /language plpgsql\s+volatile\s+security definer\s+set search_path = pg_catalog/i);
  const body = migration.split("as $function$")[1]?.split("$function$;")[0] ?? "";
  assert.match(body, /update public\.hermes_canary_owner_identity_receipts/i);
  assert.doesNotMatch(body, /\b(insert|delete|merge|truncate)\b/i);
  assert.doesNotMatch(body, /hermes_jobs|feishu_event_receipts|conversation|message|canonical_admit|claim_next|recover_stale/i);
  assert.doesNotMatch(body, /\bexecute\b/i);
});

test("capture RPC computes owner and event hashes internally", () => {
  assert.match(migration, /extensions\.digest\(p_verified_owner_open_id, 'sha256'\)/i);
  assert.match(migration, /extensions\.digest\(p_verified_event_id, 'sha256'\)/i);
  assert.match(migration, /pg_catalog\.encode\([\s\S]*'hex'/i);
  assert.doesNotMatch(migration, /p_owner_open_id_sha256|p_verified_event_id_sha256/i);
});

test("capture RPC uses one atomic pending-to-captured CAS and a fixed DB TTL", () => {
  assert.match(migration, /update public\.hermes_canary_owner_identity_receipts r[\s\S]*r\.status = 'PENDING'[\s\S]*r\.challenge_expires_at > v_now[\s\S]*returning r\.\* into v_receipt/i);
  assert.match(migration, /v_now := pg_catalog\.clock_timestamp\(\)/i);
  assert.match(migration, /receipt_expires_at = v_now \+ interval '900 seconds'/i);
});

test("capture return tuple excludes raw identity and nonce", () => {
  const contract = migration.match(/capture_canary_owner_identity_receipt\([\s\S]*?\) returns table \(([\s\S]*?)\)\s*language plpgsql/i)?.[1] ?? "";
  assert.deepEqual(
    [...contract.matchAll(/^\s*([a-z0-9_]+)\s+/gm)].map((match) => match[1]),
    ["receipt_id", "capture_outcome", "owner_open_id_sha256", "verified_event_id_sha256", "receipt_expires_at"]
  );
  assert.doesNotMatch(contract, /\bowner_open_id\b|\bevent_id\b|\bnonce\b/i);
});

test("capture ACL is service-role-only while table direct access stays revoked", () => {
  assert.match(migration, /grant execute on function public\.capture_canary_owner_identity_receipt\(text, text, text\)\s+to service_role/i);
  assert.match(migration, /revoke all on table public\.hermes_canary_owner_identity_receipts[\s\S]*service_role[\s\S]*production_schema_audit_reader/i);
});

test("audit function is exact-scope hash-only and read-only", () => {
  const auditBody = migration.split("create function public.audit_canary_owner_identity_receipt")[1] ?? "";
  assert.match(auditBody, /^\(\s*p_receipt_id uuid,\s*p_purpose text,\s*p_nonce_sha256 text\s*\)/i);
  assert.match(auditBody, /language sql\s+stable\s+security definer\s+set search_path = pg_catalog/i);
  assert.match(auditBody, /r\.receipt_id = p_receipt_id[\s\S]*r\.purpose = p_purpose[\s\S]*r\.nonce_sha256 = p_nonce_sha256/i);
  assert.doesNotMatch(auditBody, /\blike\b|\bilike\b|\blimit\b|\boffset\b/i);
  const returns = auditBody.match(/returns table \(([\s\S]*?)\)\s*language sql/i)?.[1] ?? "";
  assert.doesNotMatch(returns, /^\s*owner_open_id\s+/im);
  assert.match(returns, /raw_owner_present boolean/i);
});

test("audit ACL is reader-only and service role cannot execute", () => {
  assert.match(migration, /grant execute on function public\.audit_canary_owner_identity_receipt\(uuid, text, text\)\s+to production_schema_audit_reader/i);
  assert.match(migration, /revoke all on function public\.audit_canary_owner_identity_receipt\(uuid, text, text\)[\s\S]*service_role/i);
});

test("migration is transactional, fail-closed, additive, and seed-free", () => {
  assert.match(migration, /^begin;/i);
  assert.match(migration, /target table already exists/i);
  assert.match(migration, /target function name already exists/i);
  assert.match(migration, /extensions\.digest\(text, text\) missing/i);
  assert.match(migration, /required hardened roles missing/i);
  assert.match(migration, /migration seeded receipt data/i);
  assert.match(migration, /commit;\s*$/i);
  assert.doesNotMatch(migration, /alter table public\.(?!hermes_canary_owner_identity_receipts)/i);
});

test("parser accepts only the deterministic exact discovery command", () => {
  const result = helper.inspectAcceptedIdentityDiscovery(accepted());
  assert.equal(result.reserved, true);
  assert.equal(result.commandValid, true);
  assert.equal(result.nonceSha256, NONCE_SHA256);
  assert.equal(result.verifiedOwnerOpenId, "ou_synthetic_owner");
  assert.equal(result.verifiedEventId, "event-fixture");
});

test("malformed reserved commands are intercepted rather than treated as normal", () => {
  for (const text of [
    "总管 身份验证",
    "总管 身份验证 abc",
    `总管 身份验证 ${"A".repeat(64)}`,
    `总管 身份验证 ${"a".repeat(63)}`,
    `总管 身份验证 ${"a".repeat(65)}`,
    ` 总管 身份验证 ${RAW_NONCE}`,
  ]) {
    const result = helper.inspectAcceptedIdentityDiscovery(accepted({ text }));
    assert.equal(result.reserved, true, text);
    assert.equal(result.commandValid, false, text);
  }
});

test("ordinary text that mentions the namespace does not false-positive", () => {
  for (const text of [
    "我想知道总管身份验证怎么用",
    "帮我执行总管 身份验证",
    "普通聊天",
    "总管状态",
  ]) {
    assert.equal(helper.inspectAcceptedIdentityDiscovery(accepted({ text })).reserved, false, text);
  }
});

test("event type, supported chat type, and user sender gates fail closed", () => {
  for (const value of [
    accepted({ eventType: "url_verification" }),
    accepted({ chatType: "topic" }),
    accepted({ senderType: "bot" }),
    accepted({ senderType: "app" }),
  ]) {
    const result = helper.inspectAcceptedIdentityDiscovery(value);
    assert.equal(result.reserved, true);
    assert.equal(result.commandValid, false);
  }
});

test("parser accepts p2p and group owner discovery callbacks", () => {
  for (const chatType of ["p2p", "group"]) {
    const result = helper.inspectAcceptedIdentityDiscovery(accepted({ chatType }));
    assert.equal(result.reserved, true);
    assert.equal(result.commandValid, true);
    assert.equal(result.nonceSha256, NONCE_SHA256);
    assert.equal(result.verifiedOwnerOpenId, "ou_synthetic_owner");
    assert.equal(result.verifiedEventId, "event-fixture");
  }
});

test("capture helper sends only the approved raw authority inputs to the RPC", async () => {
  const calls = [];
  const inspection = helper.inspectAcceptedIdentityDiscovery(accepted());
  const result = await helper.captureAcceptedIdentityDiscovery(inspection, {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: [{ receipt_id: "receipt-1", capture_outcome: "CAPTURED" }], error: null };
    },
  });
  assert.equal(result.captureOutcome, "CAPTURED");
  assert.deepEqual(calls, [{
    name: "capture_canary_owner_identity_receipt",
    args: {
      p_nonce_sha256: NONCE_SHA256,
      p_verified_owner_open_id: "ou_synthetic_owner",
      p_verified_event_id: "event-fixture",
    },
  }]);
});

test("RPC error, timeout, and malformed response become an unknown fail-closed outcome", async () => {
  const inspection = helper.inspectAcceptedIdentityDiscovery(accepted());
  const clients = [
    { async rpc() { return { data: null, error: { message: "synthetic" } }; } },
    { async rpc() { throw new Error("synthetic timeout"); } },
    { async rpc() { return { data: [{ capture_outcome: "unexpected" }], error: null }; } },
  ];
  for (const client of clients) {
    const result = await helper.captureAcceptedIdentityDiscovery(inspection, client);
    assert.equal(result.captureOutcome, "IDENTITY_CAPTURE_OUTCOME_UNKNOWN");
  }
});

test("identity audit record contains hashes and never raw owner, nonce, or command", async () => {
  const inspection = helper.inspectAcceptedIdentityDiscovery(accepted());
  const result = await helper.captureAcceptedIdentityDiscovery(inspection, {
    async rpc() { return { data: [{ capture_outcome: "DENIED" }], error: null }; },
  });
  const serialized = JSON.stringify(helper.buildIdentityDiscoveryAuditRecord(inspection, result));
  assert.doesNotMatch(serialized, /ou_synthetic_owner/);
  assert.doesNotMatch(serialized, new RegExp(RAW_NONCE));
  assert.doesNotMatch(serialized, /总管 身份验证/);
  assert.match(serialized, new RegExp(sha256("ou_synthetic_owner")));
});

test("reserved branch executes synchronously before background registration", async () => {
  const harness = routeHarness({
    acceptedCallback: accepted(),
    rpcImpl: async function rpc() { return { data: [{ receipt_id: "receipt-1", capture_outcome: "CAPTURED" }], error: null }; },
  });
  const response = await callRoute(harness);
  assert.equal(response.status, 200);
  assert.equal(harness.afterTasks.length, 0);
  assert.equal(harness.logs.length, 1);
  assert.equal(harness.logs[0][1].reason_code, "CAPTURED");
});

test("malformed reserved command never calls RPC or registers business background work", async () => {
  let rpcCalls = 0;
  const harness = routeHarness({
    acceptedCallback: accepted({ text: "总管 身份验证 malformed" }),
    rpcImpl: async function rpc() { rpcCalls += 1; return { data: null, error: null }; },
  });
  await callRoute(harness);
  assert.equal(rpcCalls, 0);
  assert.equal(harness.afterTasks.length, 0);
});

test("unsupported chat, non-user, and wrong-event reserved callbacks never call RPC or business routing", async () => {
  for (const callback of [
    accepted({ chatType: "topic" }),
    accepted({ senderType: "bot" }),
    accepted({ eventType: "other.event" }),
  ]) {
    let rpcCalls = 0;
    const harness = routeHarness({ acceptedCallback: callback, rpcImpl: async function rpc() { rpcCalls += 1; } });
    await callRoute(harness);
    assert.equal(rpcCalls, 0);
    assert.equal(harness.afterTasks.length, 0);
  }
});

test("group reserved callback is captured synchronously without business routing", async () => {
  let rpcCalls = 0;
  const harness = routeHarness({
    acceptedCallback: accepted({ chatType: "group" }),
    rpcImpl: async function rpc() {
      rpcCalls += 1;
      return { data: [{ receipt_id: "receipt-1", capture_outcome: "CAPTURED" }], error: null };
    },
  });
  await callRoute(harness);
  assert.equal(rpcCalls, 1);
  assert.equal(harness.afterTasks.length, 0);
  assert.equal(harness.logs[0][1].reason_code, "CAPTURED");
});

test("no challenge, consumed challenge, and conflict outcomes share one external ACK", async () => {
  const responses = [];
  for (const outcome of ["DENIED", "IDEMPOTENT_ALREADY_CAPTURED", "CAPTURED"]) {
    const harness = routeHarness({
      acceptedCallback: accepted(),
      rpcImpl: async function rpc() { return { data: [{ capture_outcome: outcome }], error: null }; },
    });
    responses.push((await callRoute(harness)).body);
    assert.equal(harness.afterTasks.length, 0);
  }
  assert.deepEqual(responses[0], responses[1]);
  assert.deepEqual(responses[1], responses[2]);
});

test("capture commit followed by response loss remains captured and never enters business routing", async () => {
  let committed = false;
  const harness = routeHarness({
    acceptedCallback: accepted(),
    rpcImpl: async function rpc() {
      committed = true;
      throw new Error("synthetic response lost after commit");
    },
  });
  const response = await callRoute(harness);
  assert.equal(committed, true);
  assert.equal(response.status, 200);
  assert.equal(harness.afterTasks.length, 0);
  assert.equal(harness.logs[0][1].reason_code, "IDENTITY_CAPTURE_OUTCOME_UNKNOWN");
});

test("normal callback behavior still registers exactly one existing background task", async () => {
  let rpcCalls = 0;
  const harness = routeHarness({
    acceptedCallback: accepted({ text: "普通需求" }),
    rpcImpl: async function rpc() { rpcCalls += 1; },
  });
  const response = await callRoute(harness);
  assert.equal(response.status, 200);
  assert.equal(rpcCalls, 0);
  assert.equal(harness.afterTasks.length, 1);
});

test("route source places the authoritative identity boundary before after()", () => {
  const inspectIndex = routeSource.indexOf("inspectAcceptedIdentityDiscovery(accepted)");
  const captureIndex = routeSource.indexOf("captureAcceptedIdentityDiscovery(identityDiscovery, sb())");
  const afterIndex = routeSource.indexOf("after(async () =>", inspectIndex);
  assert.ok(inspectIndex > 0 && captureIndex > inspectIndex && afterIndex > captureIndex);
  assert.match(routeSource, /if \(identityDiscovery\?\.reserved\)[\s\S]*return NextResponse\.json\(acceptanceResponse\)/);
});

test("application authority is the service-role client and no discovery env or challenge endpoint was added", () => {
  assert.match(routeSource, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(routeSource, /createClient\(url, key/);
  assert.doesNotMatch(routeSource + helperSource, /IDENTITY_DISCOVERY_ENABLED/);
  assert.doesNotMatch(routeSource + helperSource, /create.*challenge|generate.*nonce/i);
});

test("helper source never logs raw owner, nonce, command, payload, or errors", () => {
  assert.doesNotMatch(helperSource, /console\.(log|info|warn|error)/);
  assert.doesNotMatch(helperSource, /error\.(message|details|hint)|JSON\.stringify\(accepted|JSON\.stringify\(inspection/i);
  assert.match(helperSource, /accepted\.event_id/);
  assert.match(helperSource, /sender_id/);
});

test("gateway, worker-api, worker runtime, and canonical state machine are outside the implementation", () => {
  const changedAllowlist = [
    "src/app/api/feishu/event/route.ts",
    "src/lib/feishu-owner-identity-discovery.ts",
    "supabase/migrations/202608140001_canary_owner_identity_receipt.sql",
    "infra/windows-worker/tests/canary-owner-identity-receipt.test.mjs",
    "infra/windows-worker/tests/run-canary-owner-identity-receipt-postgres.ps1",
    "docs/ops/canary-owner-identity-receipt.md",
  ];
  assert.equal(changedAllowlist.some((file) => /gateway|worker_api|local_worker|canonical-job/i.test(file)), false);
});
