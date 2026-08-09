import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";

const root = process.cwd();
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

for (const file of manifest.files) {
  const source = resolve(root, file.source_path);
  const sourceText = readFileSync(source, "utf8");
  execFileSync("git", ["ls-files", "--error-unmatch", file.source_path], { cwd: root, stdio: "ignore" });
  try { new Script(sourceText, { filename: file.source_path }); }
  catch (error) { fail(`${file.source_path} failed JavaScript parsing: ${error.message}`); }
}

const gateway = readFileSync(resolve(root, manifest.source_of_truth), "utf8");
const router = readFileSync(resolve(root, "infra/tencent-worker/feishu_gateway_canonical_router.js"), "utf8");
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
if (!gateway.includes('app.post("/feishu/event"')) fail("HTTP callback route missing");
if (!gateway.includes("url_verification")) fail("URL verification challenge missing");
if (!gateway.includes("createTransportDedupe")) fail("transport dedupe missing");
if (!router.includes("/api/feishu/event")) fail("shared application endpoint contract missing");
if (!applicationRoute.includes("resolveFeishuApplicationFeatureRoute")) fail("Next.js route does not use shared feature contract");
if (!featureContract.includes("resolveHermesCanonicalCutoverConfig")) fail("feature contract is not canonical cutover backed");

process.stdout.write(JSON.stringify({
  artifact_manifest_verified: true,
  artifact_authority_boundary_verified: true,
  entrypoint_direct_authority_scan_passed: true,
  gateway_authoritative_code_hits: authorityHits,
  artifact_type: manifest.artifact_type,
  artifact_count: manifest.files.length,
  source_of_truth: manifest.source_of_truth,
  target: manifest.files[0].target_path,
  unknown_runtime_behaviors: reconciliation.unknown_runtime_behaviors,
}) + "\n");
