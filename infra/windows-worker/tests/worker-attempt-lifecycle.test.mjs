import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..", "..", "..");

const nextRoute = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "next", "route.ts"), "utf8");
const heartbeatRoute = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "heartbeat", "route.ts"), "utf8");
const progressRoute = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "progress", "route.ts"), "utf8");
const reportRoute = fs.readFileSync(path.join(root, "src", "app", "api", "worker", "report", "route.ts"), "utf8");
const localWorker = fs.readFileSync(path.join(root, "infra", "windows-worker", "local_worker.js"), "utf8");
const workerJobs = fs.readFileSync(path.join(root, "src", "lib", "worker-jobs.ts"), "utf8");
const feishuRoute = fs.readFileSync(path.join(root, "src", "app", "api", "feishu", "event", "route.ts"), "utf8");
const jobBuilder = fs.readFileSync(path.join(root, "src", "lib", "project-director-job-builder.ts"), "utf8");

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("/next persists claim and attempt contract before returning a job", () => {
  assert.match(nextRoute, /claimHermesJob\(/);
  assert.match(nextRoute, /\.in\("status",\s*\["queued",\s*"pending"\]\)/);
  assert.match(nextRoute, /\.is\("claimed_by",\s*null\)/);
  assert.doesNotMatch(nextRoute, /\.order\("priority"/);
  assert.match(nextRoute, /\.order\("created_at",\s*\{\s*ascending:\s*true\s*\}\)/);
  assert.match(nextRoute, /status:\s*"running"/);
  assert.match(nextRoute, /claimed_by:\s*workerId/);
  assert.match(nextRoute, /claimed_at:\s*now/);
  assert.match(nextRoute, /attempt_id:\s*attemptId/);
  assert.match(nextRoute, /active_attempt_id:\s*attemptId/);
  assert.match(nextRoute, /expires_at:\s*expiresAt/);
  assert.match(nextRoute, /request_text:\s*\[/);
  assert.match(nextRoute, /HERMES_WORKER_ATTEMPT_CONTEXT:/);
  assert.match(nextRoute, /persistedAttemptId !== attemptId/);
  assert.match(nextRoute, /WORKER_ATTEMPT_PERSISTENCE_FAILED/);
  assert.match(nextRoute, /updateHermesJob\(supabase,\s*job\.id/);
  assert.match(nextRoute, /claimed_by:\s*null/);
  assert.match(nextRoute, /job:\s*claimedJob/);
});

test("attempt identity can survive schemas without attempt_id columns or payload", () => {
  assert.match(workerJobs, /function readAttemptContextFromRequestText/);
  assert.match(workerJobs, /HERMES_WORKER_ATTEMPT_CONTEXT:/);
  assert.match(workerJobs, /readString\(requestTextAttempt\?\.active_attempt_id\)/);
  assert.match(workerJobs, /readString\(requestTextAttempt\?\.attempt_id\)/);
  assert.match(workerJobs, /function buildAttemptRequestText/);
});

test("heartbeat and progress reject wrong attempts with explicit failure code", () => {
  assert.match(heartbeatRoute, /assertWorkerAttemptMatchesJob\(existingJob, attemptId\)/);
  assert.match(progressRoute, /assertWorkerAttemptMatchesJob\(existingJob, attemptId\)/);
  assert.match(workerJobs, /failure_code:\s*"WORKER_ATTEMPT_MISMATCH"/);
  assert.match(workerJobs, /failure_stage:\s*"worker_attempt_validation"/);
  assert.match(workerJobs, /stale_attempt:\s*true/);
});

test("heartbeat and progress update the active attempt payload for the correct attempt", () => {
  assert.match(heartbeatRoute, /payload:\s*buildAttemptPayload\(existingJob/);
  assert.match(progressRoute, /payload:\s*buildAttemptPayload\(existingJob/);
  assert.match(heartbeatRoute, /active_attempt_id:\s*attemptId/);
  assert.match(progressRoute, /active_attempt_id:\s*attemptId/);
});

test("terminal report blocks false positive success after lifecycle failure", () => {
  assert.match(reportRoute, /function buildFalsePositiveSuccessGuard/);
  assert.match(reportRoute, /WORKER_ATTEMPT_LIFECYCLE_FAILED/);
  assert.match(reportRoute, /running_job_not_found_or_not_owned/);
  assert.match(reportRoute, /status:\s*falsePositiveGuard \? "failed" : workerStatus/);
});

test("terminal report stops periodic heartbeat and progress before report request", () => {
  const block = functionBlock(localWorker, "report");
  const stopIndex = block.indexOf("stopTerminalReportTimers()");
  const requestIndex = block.indexOf('request("/api/worker/report"');
  assert.ok(stopIndex >= 0, "terminal report should stop periodic timers");
  assert.ok(requestIndex > stopIndex, "timer stop must happen before terminal report request");
});

test("Codex timeout waits for process cleanup before retry can continue", () => {
  const spawnBlock = functionBlock(localWorker, "spawnCodexWithStdin");
  assert.match(spawnBlock, /requestTermination\(\s*"CODEX_TIMEOUT"/);
  assert.match(spawnBlock, /child\.stdin\.end\(\)/);
  assert.match(spawnBlock, /killProcessTree\(child\.pid, message\)\.finally/);
  assert.match(spawnBlock, /child\.on\("close"/);
  assert.match(spawnBlock, /CODEX_PROCESS_CLOSE_TIMEOUT/);
  assert.match(spawnBlock, /pendingFailure/);
  const retriesBlock = functionBlock(localWorker, "runCodexWithRetries");
  assert.match(retriesBlock, /await runCodex\(/);
});

test("verification-only no-change success bypasses false positive guards only with explicit strict policy", () => {
  const block = functionBlock(reportRoute, "buildFalsePositiveSuccessGuard");
  assert.match(block, /verificationOnly === true/);
  assert.match(block, /allowNoChangeSuccess === true/);
  assert.match(block, /codeChangesRequired === false/);
  assert.match(block, /codexRequired === false/);
  assert.match(block, /gitCommitRequired === false/);
  assert.match(block, /gitPushRequired === false/);
  assert.doesNotMatch(block, /verification\[_ -\]\?only/);
  const noFixIndex = block.indexOf('failureCode: "NO_FIX_APPLIED"');
  const gitPublishIndex = block.indexOf('failureCode: "GIT_PUBLISH_REQUIRED"');
  const bypassIndexes = [...block.matchAll(/if \(verificationOnlyNoChangeSuccess\)/g)].map((match) => match.index ?? -1);
  assert.equal(bypassIndexes.length, 2);
  assert.ok(bypassIndexes[0] >= 0 && bypassIndexes[0] < noFixIndex);
  assert.ok(bypassIndexes[1] >= 0 && bypassIndexes[1] < gitPublishIndex);
});

test("verification-only dispatch returns before Codex and git publish phases", () => {
  const pollStart = localWorker.indexOf("async function pollOnce");
  const pollEnd = localWorker.indexOf("async function main", pollStart);
  assert.ok(pollStart >= 0 && pollEnd > pollStart, "pollOnce block should be detectable");
  const pollBlock = localWorker.slice(pollStart, pollEnd);
  const noopIndex = pollBlock.indexOf("isVerificationOnlyNoopTask(job, initialContract)");
  const codexIndex = pollBlock.indexOf('"执行 Codex"');
  const commitIndex = pollBlock.indexOf("commitGitTask(job)");
  const pushIndex = pollBlock.indexOf("pushGitTask(");

  assert.ok(noopIndex >= 0, "verification-only no-op branch should exist");
  assert.ok(codexIndex > noopIndex, "no-op branch must run before Codex progress");
  assert.ok(commitIndex > noopIndex, "no-op branch must run before git commit");
  assert.ok(pushIndex > noopIndex, "no-op branch must run before git push");

  const noopBlock = functionBlock(localWorker, "completeVerificationOnlyNoopJob");
  assert.match(noopBlock, /codex_called:\s*false/);
  assert.match(noopBlock, /git_commit_sha:\s*null/);
  assert.match(noopBlock, /git_push:\s*false/);
  assert.match(noopBlock, /next_stage_allowed:\s*false/);
});

test("worker startup runs Codex executable preflight before polling", () => {
  const mainStart = localWorker.indexOf("async function main");
  const mainEnd = localWorker.indexOf('process.on("SIGINT"', mainStart);
  assert.ok(mainStart >= 0 && mainEnd > mainStart, "main block should be detectable");
  const mainBlock = localWorker.slice(mainStart, mainEnd);

  const preflightIndex = mainBlock.indexOf("await runCodexStartupPreflight()");
  const pollIndex = mainBlock.indexOf("await pollOnce()");
  assert.ok(preflightIndex >= 0, "startup should run the Codex preflight");
  assert.ok(pollIndex > preflightIndex, "preflight must complete before polling starts");
  assert.match(localWorker, /mode:\s*"version"/);
  assert.match(localWorker, /mode:\s*"smoke"/);
  assert.match(localWorker, /CODEX_WORKER_PREFLIGHT_OK/);
});

test("write allowed read-only downgrade is blocked before success persistence", () => {
  assert.match(reportRoute, /APPROVAL_CONTEXT_MODE_MISMATCH/);
  assert.match(reportRoute, /write_allowed task was executed with read_only context/);
  assert.match(feishuRoute, /function assertApprovedWriteRequestModeMatches/);
  assert.match(feishuRoute, /APPROVAL_CONTEXT_MODE_MISMATCH/);
});

test("post-push report state is persisted without commit rollback semantics", () => {
  const pollBlock = functionBlock(localWorker, "pollOnce");
  assert.match(pollBlock, /remote_contains_commit:\s*pushResult\.pushed/);
  assert.match(pollBlock, /repository_clean_after_push:\s*repositoryCleanAfterPush/);
  assert.match(pollBlock, /worker_git_push:\s*pushResult\.pushed/);
  assert.match(pollBlock, /codex_git_push:\s*"not_run_by_codex"/);

  const rollbackBlock = functionBlock(localWorker, "rollbackGitTask");
  assert.doesNotMatch(rollbackBlock, /git\s+reset|runGit\(\["reset"|runGit\(\["revert"/);
  assert.doesNotMatch(rollbackBlock, /runGit\(\["push"/);
});

test("approved write contexts keep original request and approved execution route", () => {
  const block = functionBlock(jobBuilder, "buildAgentDispatchContext");
  assert.match(block, /requested_mode:\s*"write_allowed"/);
  assert.match(block, /final_mode:\s*"write_allowed"/);
  assert.match(block, /task_mode:\s*"automation_system_write_allowed"/);
  assert.match(block, /original_request_text_base64:\s*Buffer\.from\(requestText/);
  assert.match(block, /route:\s*"approved_execution"/);
  assert.doesNotMatch(block, /route:\s*"project_director_approved_execution"/);
});

test("approval command text is not used as the only exact write scope source", () => {
  assert.match(feishuRoute, /assertApprovedWriteRequestHasExactScope/);
  assert.match(feishuRoute, /ORIGINAL_BATCH_CONTEXT_MISSING/);
  assert.match(feishuRoute, /refusing generic automation scope fallback/);
  assert.match(jobBuilder, /exact_allowed_scope/);
});
