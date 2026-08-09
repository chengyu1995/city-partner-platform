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
if (manifest.files.length !== 3) fail("unexpected artifact file count");
if (reconciliation.unknown_runtime_behaviors.length !== 0) fail("unknown runtime behavior remains");

for (const file of manifest.files) {
  const source = resolve(root, file.source_path);
  const sourceText = readFileSync(source, "utf8");
  execFileSync("git", ["ls-files", "--error-unmatch", file.source_path], { cwd: root, stdio: "ignore" });
  try {
    new Script(sourceText, { filename: file.source_path });
  } catch (error) {
    fail(`${file.source_path} failed JavaScript parsing: ${error.message}`);
  }
}

const gateway = readFileSync(resolve(root, manifest.source_of_truth), "utf8");
if (!gateway.includes('require("./feishu_gateway_canonical_router.js")')) fail("Gateway router import missing");
if (!gateway.includes("canonicalGatewayResult.handled")) fail("canonical early-return boundary missing");

process.stdout.write(JSON.stringify({
  artifact_manifest_verified: true,
  artifact_type: manifest.artifact_type,
  artifact_count: manifest.files.length,
  source_of_truth: manifest.source_of_truth,
  target: manifest.files[0].target_path,
  unknown_runtime_behaviors: reconciliation.unknown_runtime_behaviors,
}) + "\n");
