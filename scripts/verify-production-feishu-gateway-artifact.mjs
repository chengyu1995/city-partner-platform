import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Script } from "node:vm";

const root = process.cwd();
const require = createRequire(import.meta.url);
const manifestPath = resolve(root, "infra/tencent-worker/production-artifacts/feishu-gateway.json");
const reconciliationPath = resolve(root, "docs/architecture/production-feishu-gateway-behavior-reconciliation.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const reconciliation = JSON.parse(readFileSync(reconciliationPath, "utf8"));

function fail(message) {
  throw new Error(`FEISHU_GATEWAY_ARTIFACT_INVALID: ${message}`);
}

if (manifest.artifact_type !== "direct" || manifest.build_required !== false) fail("artifact must be direct");
if (manifest.source_of_truth !== "infra/tencent-worker/feishu_gateway_canonical.js") fail("source of truth mismatch");
if (manifest.pm2_process !== "feishu-gateway") fail("PM2 process mismatch");
if (manifest.files.length !== 2) fail("unexpected artifact file count");
if (reconciliation.unknown_runtime_behaviors.length !== 0) fail("unknown runtime behavior remains");
if (manifest.transport !== "NGINX_HTTP_CALLBACK") fail("transport contract mismatch");
if (manifest.feishu_callback_external_deadline_ms !== 3000) fail("external callback deadline mismatch");
if (manifest.application_accept_timeout_ms > 1500) fail("application acceptance timeout exceeds safety budget");
if (manifest.gateway_internal_response_budget_ms > 2000) fail("Gateway response budget exceeds safety budget");
if (manifest.raw_body_preservation !== true) fail("raw body preservation is required");
if (manifest.challenge_handled_locally !== true) fail("challenge must be handled locally");
const responseContract = manifest.application_response_contract;
if (responseContract?.schema !== "feishu_application_acceptance_v1") fail("explicit acceptance schema missing");
if (responseContract?.allowed_http_status !== "2xx") fail("acceptance status contract mismatch");
if (responseContract?.content_type !== "application/json") fail("acceptance content type mismatch");
if (responseContract?.required_fields?.code !== 0) fail("acceptance code contract mismatch");
if (responseContract?.required_fields?.accepted !== true) fail("explicit acceptance field missing");
if (responseContract?.required_fields?.transport_acceptance !== true) fail("transport acceptance field missing");
if (responseContract?.required_fields?.event_id !== "non_empty_string") fail("acceptance event identity missing");
if (responseContract?.malformed_response_policy !== "FAIL_CLOSED") fail("malformed response policy must fail closed");
if (responseContract?.default_response_policy !== "REJECT") fail("default response policy must reject");
if (responseContract?.transport_acceptance_is_not_business_success !== true) fail("acceptance/business result boundary missing");
const requiredForwardHeaders = ["x-lark-request-timestamp", "x-lark-request-nonce", "x-lark-signature", "content-type"];
for (const header of requiredForwardHeaders) {
  if (!manifest.required_forward_headers.includes(header)) fail(`required forward header missing: ${header}`);
}

for (const file of manifest.files) {
  const source = resolve(root, file.source_path);
  const sourceText = readFileSync(source, "utf8");
  execFileSync("git", ["ls-files", "--error-unmatch", file.source_path], { cwd: root, stdio: "ignore" });
  try { new Script(sourceText, { filename: file.source_path }); }
  catch (error) { fail(`${file.source_path} failed JavaScript parsing: ${error.message}`); }
}

const gateway = readFileSync(resolve(root, manifest.source_of_truth), "utf8");
const routerPath = resolve(root, "infra/tencent-worker/feishu_gateway_canonical_router.js");
const router = readFileSync(routerPath, "utf8");
const routerModule = require(routerPath);
const applicationRoute = readFileSync(resolve(root, "src/app/api/feishu/event/route.ts"), "utf8");
const featureContract = readFileSync(resolve(root, "src/lib/feishu-application-boundary.ts"), "utf8");

const forbiddenAuthorityPatterns = [
  ["hermes_jobs", /hermes_jobs/i],
  ["job_creator", /(?:create|insert|enqueue)[A-Za-z0-9_]*Job|canonicalCreateJob/i],
  ["database_write", /supabase|\/rest\/v1|\/rpc\//i],
  ["gm_routing", /project[_ -]?(?:director|general_manager)|GM_ROUTING|agent[_ -]?mapping/i],
  ["worker_execution", /local_worker|worker-api|codex|claim[_ -]?job/i],
  ["execution_state", /attempt_id|lease_id|terminal_at|effective_final_status/i],
];
const productionGatewayArtifact = `${gateway}\n${router}`;
const authorityHits = forbiddenAuthorityPatterns.filter(([, pattern]) => pattern.test(productionGatewayArtifact)).map(([name]) => name);
if (authorityHits.length > 0) fail(`PM2 Gateway artifact authority detected: ${authorityHits.join(",")}`);
if (!gateway.includes("createFeishuApplicationBoundaryClient")) fail("shared application boundary delegation missing");
if (!gateway.includes("runWithinResponseBudget")) fail("Gateway internal response budget enforcement missing");
if (!gateway.includes('app.post("/feishu/event"')) fail("HTTP callback route missing");
if (!gateway.includes("url_verification")) fail("URL verification challenge missing");
if (!gateway.includes("createTransportDedupe")) fail("transport dedupe missing");
if (!router.includes("/api/feishu/event")) fail("shared application endpoint contract missing");
if (!router.includes("APPLICATION_ACCEPT_TIMEOUT_MS = 1_500")) fail("safe Application acceptance timeout missing");
if (!router.includes("REQUIRED_FEISHU_FORWARD_HEADERS")) fail("signature forwarding whitelist missing");
if (!router.includes("body: bodyBytes(input.rawBody)")) fail("raw body forwarding contract missing");
if (/JSON\.stringify\([^)]*(?:rawBody|input\.body)/.test(router)) fail("Gateway router reserializes callback body");
if (router.includes("feishu application boundary returned non-json")) fail("malformed response fallback success remains");
if (!router.includes("parseFeishuApplicationAcceptanceResponse")) fail("strict acceptance parser missing");
if (!router.includes("FEISHU_APPLICATION_INVALID_ACCEPTANCE_SCHEMA")) fail("default reject schema policy missing");
if (!router.includes("FEISHU_APPLICATION_INVALID_CONTENT_TYPE")) fail("content type rejection missing");
if (!router.includes("FEISHU_APPLICATION_INVALID_JSON")) fail("invalid JSON rejection missing");
if (!applicationRoute.includes("new Uint8Array(await req.arrayBuffer())")) fail("Application route does not read the raw callback body");
if (!applicationRoute.includes("after(async () =>")) fail("platform-supported background execution missing");
if (!applicationRoute.includes("buildFeishuApplicationAcceptanceResponse(accepted.event_id)")) fail("explicit Application acceptance response missing");
if (applicationRoute.indexOf("buildFeishuApplicationAcceptanceResponse(accepted.event_id)") > applicationRoute.indexOf("after(async () =>")) {
  fail("background work is registered before acceptance schema validation");
}
if (!applicationRoute.includes("resolveFeishuApplicationFeatureRoute")) fail("Next.js route does not use shared feature contract");
if (!featureContract.includes("resolveHermesCanonicalCutoverConfig")) fail("feature contract is not canonical cutover backed");

const rejectedResponses = [
  { status: 200, headers: { "content-type": "text/plain" }, responseText: "OK" },
  { status: 200, headers: { "content-type": "application/json" }, responseText: "{invalid" },
  { status: 200, headers: { "content-type": "application/json" }, responseText: "{}" },
  { status: 200, headers: { "content-type": "application/json" }, responseText: '{"accepted":false}' },
];
for (const response of rejectedResponses) {
  try {
    routerModule.parseFeishuApplicationAcceptanceResponse(response);
    fail("malformed Application response was accepted");
  } catch (error) {
    if (String(error?.message || "").startsWith("FEISHU_GATEWAY_ARTIFACT_INVALID")) throw error;
  }
}
const verifiedAcceptance = routerModule.parseFeishuApplicationAcceptanceResponse({
  status: 200,
  headers: { "content-type": "application/json" },
  responseText: JSON.stringify(routerModule.buildFeishuApplicationAcceptanceResponse("artifact-verifier")),
});
if (verifiedAcceptance.accepted !== true || verifiedAcceptance.event_id !== "artifact-verifier") {
  fail("valid explicit Application acceptance was not verified");
}

process.stdout.write(JSON.stringify({
  artifact_manifest_verified: true,
  artifact_authority_boundary_verified: true,
  artifact_callback_contract_verified: true,
  artifact_acceptance_response_contract_verified: true,
  entrypoint_direct_authority_scan_passed: true,
  gateway_authoritative_code_hits: authorityHits,
  artifact_type: manifest.artifact_type,
  artifact_count: manifest.files.length,
  source_of_truth: manifest.source_of_truth,
  target: manifest.files[0].target_path,
  unknown_runtime_behaviors: reconciliation.unknown_runtime_behaviors,
}) + "\n");
