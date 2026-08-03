import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function assertIncludes(path, needle) {
  const content = read(path);
  if (!content.includes(needle)) {
    throw new Error(`${path} is missing required text: ${needle}`);
  }
}

function assertExists(path) {
  if (!existsSync(join(root, path))) {
    throw new Error(`${path} does not exist`);
  }
}

const requiredDocs = [
  "docs/ops/cloud-feishu-gateway-boss-console-sync.md",
  "docs/ops/git-branch-alignment.md",
  "docs/ops/project-director-system-self-check.md",
  "docs/ops/agent-status-dashboard.md",
  "docs/ops/start-product-workflow.md",
  "docs/product/mvp-stage-1-planning-template.md",
  "docs/product/batch-20-production-hardening-notes.md",
];

for (const path of requiredDocs) {
  assertExists(path);
}

const consoleFile = "src/lib/project-director-console.ts";
for (const text of [
  "system_self_check",
  "agent_status",
  "系统自检",
  "Agent 状态",
  "Agent 看板",
  "formatGitBranchCheck",
  "formatSafetyChecks",
  "formatAgentDashboard",
]) {
  assertIncludes(consoleFile, text);
}

const routeFile = "src/app/api/feishu/event/route.ts";
for (const text of [
  "parseProjectDirectorConsoleCommand(text)",
  "consoleCommand && consoleCommand !== \"approve_execution\"",
  "consoleCommand === \"approve_execution\"",
  "classifyProjectDirectorDemand(text)",
  "state: \"waiting_execution_approval\"",
  "isApprovedExecutionReply(text)",
  "hasExistingAgentDispatchJobs",
]) {
  assertIncludes(routeFile, text);
}

for (const text of [
  "createWorkerAttemptId",
  "assertWorkerAttemptMatchesJob",
  "validateCanonicalJobStateInvariant",
  "worker_job_state_machine",
]) {
  assertIncludes("src/lib/worker-jobs.ts", text);
}

assertIncludes("src/app/api/worker/report/route.ts", "terminal_job_report_ignored");
assertIncludes("src/app/api/worker/next/route.ts", "attempt_contract");
assertIncludes("docs/ops/git-branch-alignment.md", "origin/HEAD");
assertIncludes("docs/ops/agent-status-dashboard.md", "project_director");
assertIncludes("docs/product/mvp-stage-1-planning-template.md", "先不要写代码");

console.log("BATCH-20 static verification passed.");
