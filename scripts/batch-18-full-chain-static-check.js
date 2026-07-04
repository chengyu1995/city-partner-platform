/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");

const requiredDocs = [
  "docs/upgrade/batch-18-full-chain-test.md",
  "docs/upgrade/batch-18-test-cases.md",
  "docs/upgrade/batch-18-acceptance-report.md",
];

const forbiddenBusinessPages = [
  "app/page.tsx",
  "app/post/page.tsx",
  "app/partners/page.tsx",
  "src/app/page.tsx",
  "src/app/post/page.tsx",
  "src/app/partners/page.tsx",
];

const checks = [];
const warnings = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function addCheck(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

function addWarning(name, detail) {
  warnings.push({ name, detail });
}

function includesAll(content, values) {
  return values.every((value) => content.includes(value));
}

const consoleSource = read("src/lib/project-director-console.ts");
const intakeSource = read("src/lib/project-director-intake.ts");
const feishuRoute = read("src/app/api/feishu/event/route.ts");
const workerJobs = read("src/lib/worker-jobs.ts");
const workerNext = read("src/app/api/worker/next/route.ts");
const workerReport = read("src/app/api/worker/report/route.ts");
const workerProgress = read("src/app/api/worker/progress/route.ts");
const workerHeartbeat = read("src/app/api/worker/heartbeat/route.ts");
const localWorker = read("infra/windows-worker/local_worker.js");

for (const doc of requiredDocs) {
  addCheck(`doc exists: ${doc}`, exists(doc), doc);
}

addCheck(
  "console commands are recognized",
  includesAll(consoleSource, [
    '"help"',
    '"status"',
    '"pause_agents"',
    '"resume_agents"',
    '"approve_execution"',
    "parseProjectDirectorConsoleCommand",
  ]),
  "help/status/pause/resume/approve parser"
);

addCheck(
  "plain new demand remains planning before approval",
  includesAll(feishuRoute, [
    "savePlanningTaskTreeReply",
    "planning_job: not_inserted_before_boss_approval",
    "project_director_task_tree_draft",
  ]),
  "task tree is saved to hermes_messages before execution approval"
);

addCheck(
  "approval is required before agent dispatch jobs are inserted",
  includesAll(feishuRoute, [
    "isApprovedExecutionReply",
    "insertApprovedAgentDispatchJobs",
    "PROJECT_DIRECTOR_APPROVED_EXECUTION_DISPATCHED",
  ]),
  "approved execution path owns agent_dispatch insertion"
);

addCheck(
  "pause blocks approved dispatch",
  includesAll(feishuRoute, [
    "isProjectDirectorDispatchPaused",
    "approved_execution_blocked_paused",
    "PROJECT_DIRECTOR_APPROVED_EXECUTION_BLOCKED",
  ]),
  "paused state is checked before approved dispatch"
);

addCheck(
  "worker claim returns worker and attempt contract",
  includesAll(workerNext, [
    "getWorkerIdFromRequest",
    "createWorkerAttemptId",
    "attempt_id",
    "attempt_contract",
  ]),
  "/api/worker/next assigns attempt_id on claim"
);

addCheck(
  "heartbeat/progress/report validate attempt_id",
  includesAll(workerHeartbeat + workerProgress + workerReport, [
    "assertWorkerAttemptMatchesJob",
    "assertWorkerOwnsJob",
  ]),
  "all update endpoints validate owner and attempt"
);

addCheck(
  "missing or mismatched attempt_id is rejected",
  includesAll(workerJobs, [
    "attempt_id is required for active job attempt",
    "attempt_id does not match active job attempt",
    "active_attempt_id",
  ]),
  "active attempt cannot be overwritten without matching attempt_id"
);

addCheck(
  "terminal report idempotency prevents status overwrite",
  includesAll(workerReport, [
    "isTerminalWorkerStatus(existingJob.status)",
    "terminal_job_report_ignored",
    "idempotent",
  ]),
  "succeeded/failed terminal jobs ignore later reports"
);

addCheck(
  "worker claim avoids duplicate execution",
  includesAll(workerJobs + workerNext, [
    "claimHermesJob",
    '.in("status", ["queued", "pending"])',
    "already_claimed_or_not_runnable",
  ]),
  "only queued/pending and unclaimed compatible jobs can be claimed"
);

addCheck(
  "local worker carries attempt_id through lifecycle",
  includesAll(localWorker, [
    "currentAttemptId",
    "attempt_id: attemptId",
    "startHeartbeat(job.id, attemptId)",
  ]),
  "worker sends attempt_id in heartbeat/progress/report"
);

addCheck(
  "acceptance feedback has freeze path documented in intake/job builder",
  includesAll(intakeSource + feishuRoute, [
    "isAcceptanceFeedbackMessage",
    "getAcceptanceFeedbackBody",
  ]),
  "feedback is routed explicitly instead of being treated as generic Codex work"
);

let changedFiles = [];
try {
  changedFiles = execFileSync("git", ["diff", "--name-only"], {
    cwd: root,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((item) => item.replace(/\\/g, "/"));
} catch (error) {
  addWarning("git diff --name-only unavailable inside Node static script", error.message);
}

const changedForbiddenPages = changedFiles.filter((file) =>
  forbiddenBusinessPages.includes(file)
);
addCheck(
  "no frozen business pages changed",
  changedForbiddenPages.length === 0,
  changedForbiddenPages.length ? changedForbiddenPages.join(", ") : "none"
);

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  const prefix = check.ok ? "PASS" : "FAIL";
  console.log(`${prefix} ${check.name} - ${check.detail}`);
}

for (const warning of warnings) {
  console.log(`WARN ${warning.name} - ${warning.detail}`);
}

console.log("");
console.log("BATCH-18 static message matrix:");
console.log("- New demand: status/help/pause/resume -> console reply only; no Worker queue.");
console.log("- New demand: fake test demand -> task tree planning record only; no executable Worker queue.");
console.log("- Project Director approve execution -> creates Worker jobs only when not paused and a plan exists.");
console.log("- Acceptance feedback during upgrade freeze -> record or queue diagnosis only; business pages stay frozen.");
console.log("- Worker report without matching attempt_id -> rejected before task overwrite.");

if (failed.length > 0) {
  console.error("");
  console.error(`BATCH-18 static check failed: ${failed.length} issue(s).`);
  process.exit(1);
}

console.log("");
console.log("BATCH-18 static check passed.");
