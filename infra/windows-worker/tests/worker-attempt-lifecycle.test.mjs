import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
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
const productionWorkerApi = fs.readFileSync(
  path.join(root, "infra", "tencent-worker", "worker_api.js"),
  "utf8"
);
const terminalPolicySource = fs.readFileSync(
  path.join(root, "infra", "tencent-worker", "worker_terminal_policy.js"),
  "utf8"
);
const stateMachineSource = fs.readFileSync(
  path.join(root, "infra", "tencent-worker", "worker_job_state_machine.js"),
  "utf8"
);
const require = createRequire(import.meta.url);
const terminalPolicy = require(path.join(root, "infra", "tencent-worker", "worker_terminal_policy.js"));

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
  assert.doesNotMatch(nextRoute, /request_text:\s*\[/);
  assert.match(nextRoute, /isCanonicalClaimPersisted\(runnableClaimedJob, attemptId\)/);
  assert.match(nextRoute, /persistedAttemptId !== attemptId/);
  assert.match(nextRoute, /WORKER_ATTEMPT_PERSISTENCE_FAILED/);
  assert.match(nextRoute, /updateHermesJob\(supabase,\s*job\.id/);
  assert.match(nextRoute, /claimed_by:\s*null/);
  assert.match(nextRoute, /job:\s*runnableClaimedJob/);
});

test("terminal jobs are excluded before and after claim using persisted state", () => {
  const preClaimRead = nextRoute.indexOf("const { data: preClaimJob");
  const claim = nextRoute.indexOf("claimHermesJob(");
  const postClaimRead = nextRoute.indexOf("const { data: persistedClaimedJob");
  const returnJob = nextRoute.indexOf("job: runnableClaimedJob");

  assert.ok(preClaimRead >= 0 && preClaimRead < claim);
  assert.ok(postClaimRead > claim && postClaimRead < returnJob);
  assert.match(nextRoute, /getCanonicalTerminalWorkerJobStatus\(preClaimJob \?\? job\)/);
  assert.match(nextRoute, /getCanonicalTerminalWorkerJobStatus\(\s*persistedClaimedJob \?\? claimedJob/);
  assert.match(nextRoute, /terminal_job_excluded_before_claim/);
  assert.match(nextRoute, /terminal_job_detected_after_claim/);
  assert.match(nextRoute, /execution_aborted:\s*true/);
  assert.match(nextRoute, /codex_called:\s*false/);
  assert.match(nextRoute, /git_mutation_executed:\s*false/);
});

test("persisted terminal jobs stay disabled without historical job identity rules", () => {
  assert.doesNotMatch(terminalPolicySource, /eaaee4df-8ac7-4e5b-8267-080eb68f6b31/);
  assert.doesNotMatch(terminalPolicySource, /ef2453ed-2385-49f2-a618-34fcc037fb70/);
  assert.doesNotMatch(terminalPolicySource, /3ca92636-1b5a-4711-9c5d-5148c195e21b/);
  assert.equal(
    terminalPolicy.isTerminalWorkerJob({ id: "arbitrary-job", status: "failed" }),
    true
  );
  assert.equal(
    terminalPolicy.isTerminalWorkerJob({
      id: "another-job",
      status: "queued",
      result: { terminal_state: "superseded" },
    }),
    true
  );
  assert.match(nextRoute, /worker_next_returned:\s*false/);
});

test("canonical terminal predicate recognizes legacy semantic terminal records", () => {
  assert.equal(
    terminalPolicy.isTerminalWorkerJob({ status: "failed", result: { terminal_state: "superseded" } }),
    true
  );
  assert.equal(
    terminalPolicy.isTerminalWorkerJob({ status: "failed", result: { terminal_state: "cancelled" } }),
    true
  );
  assert.equal(
    terminalPolicy.isTerminalWorkerJob({
      status: "queued",
      retryable: true,
      result: { terminal_state: "superseded" },
    }),
    true
  );
  assert.equal(terminalPolicy.isTerminalWorkerJob({ status: "queued", result: {} }), false);
  assert.equal(
    terminalPolicy.getTerminalWorkerJobDescriptor({ status: "succeeded" }).storageStatus,
    "succeeded"
  );
});

test("production next filters terminal semantics before selecting and claiming", () => {
  const eligibility = productionWorkerApi.indexOf("for (const queuedJob of Array.isArray(data) ? data : [])");
  const invariant = productionWorkerApi.indexOf("canonicalValidateJobStateInvariant(queuedJob)", eligibility);
  const selectable = productionWorkerApi.indexOf("canonicalIsJobSelectable(queuedJob)", eligibility);
  const claim = productionWorkerApi.indexOf("runtimeClaimHermesJob(persistedJob || job, workerName)", eligibility);
  assert.ok(eligibility >= 0 && eligibility < invariant && invariant < selectable && selectable < claim);
  assert.match(productionWorkerApi, /runtimeGetTerminalJobDescriptor\(queuedJob\)/);
  assert.match(productionWorkerApi, /canonicalValidateJobStateInvariant\(persistedJob \|\| job\)/);
  assert.match(productionWorkerApi, /canonicalIsJobSelectable\(persistedJob \|\| job\)/);
  assert.match(productionWorkerApi, /runtimeFindHermesJob\(job\.id\)/);
  assert.match(productionWorkerApi, /post_claim_terminal_check_failed/);
});

test("production stale recovery cannot reactivate terminal jobs", () => {
  const recovery = functionBlock(productionWorkerApi, "recoverStaleJobs");
  assert.match(recovery, /runtimeExcludeTerminalJobsFromActiveQueue\("before_stale_recovery"\)/);
  assert.match(recovery, /canonicalInspectJobState\(job, \{ now \}\)/);
  assert.match(recovery, /canonicalRecoverStaleAttempt\(job/);
  assert.match(recovery, /\.eq\("status", job\.status\)\.eq\("updated_at", job\.updated_at\)/);
  assert.doesNotMatch(recovery, /recover_stale_hermes_jobs/);
  assert.match(recovery, /runtimeExcludeTerminalJobsFromActiveQueue\("after_stale_recovery"\)/);
  assert.match(productionWorkerApi, /terminal_jobs_excluded_from_active_queue/);
});

test("terminal cleanup is schema-aware and keeps terminal semantics persisted", () => {
  const productionCleanup = functionBlock(productionWorkerApi, "runtimeBuildTerminalCleanupFields");
  const canonicalCleanup = functionBlock(stateMachineSource, "cleanupTerminalJob");
  assert.match(productionCleanup, /canonicalCleanupTerminalJob/);
  assert.match(productionCleanup, /field in job/);
  assert.doesNotMatch(productionCleanup, /status:\s*["'](?:queued|pending|running)["']/);
  assert.match(canonicalCleanup, /claimed_by:\s*null/);
  assert.match(canonicalCleanup, /claimed_at:\s*null/);
  assert.match(canonicalCleanup, /heartbeat_at:\s*null/);
  assert.match(canonicalCleanup, /job_state:\s*state/);
  assert.match(canonicalCleanup, /selectable:\s*false/);
});

test("terminal approval identity replay is suppressed before insert", () => {
  const createJobs = functionBlock(workerJobs, "createHermesJobs");
  assert.match(createJobs, /replayedTerminalIdentities/);
  assert.match(createJobs, /isCanonicalTerminalWorkerJob\(existingJob\)/);
  assert.match(createJobs, /terminal_identity_replay_suppressed/);
  assert.match(createJobs, /insertedCount:\s*0/);
});

test("repository and production runtime share one terminal status registry", () => {
  assert.match(workerJobs, /infra\/tencent-worker\/worker_job_state_machine/);
  assert.match(productionWorkerApi, /require\("\.\/worker_job_state_machine"\)/);
  assert.match(stateMachineSource, /require\("\.\/worker_terminal_policy"\)/);
  assert.doesNotMatch(workerJobs, /const TERMINAL_WORKER_STATUSES/);
  assert.doesNotMatch(productionWorkerApi, /const RUNTIME_TERMINAL_JOB_STATUSES/);
});

test("terminal cleanup clears attempts, lease, running index, and retry flags", () => {
  const cleanup = functionBlock(stateMachineSource, "cleanupTerminalJob");
  assert.match(cleanup, /claimed_by:\s*null/);
  assert.match(cleanup, /active_attempt_id:\s*null/);
  assert.match(cleanup, /expires_at:\s*null/);
  assert.match(cleanup, /heartbeat_at:\s*null/);
  assert.match(cleanup, /running_job_id:\s*null/);
  assert.match(cleanup, /retry_requested:\s*false/);
  assert.match(cleanup, /retry_pending:\s*false/);
  assert.match(cleanup, /should_retry:\s*false/);
  assert.match(cleanup, /active_attempt:\s*null/);
  assert.match(cleanup, /active_lease:\s*null/);
  assert.match(reportRoute, /buildCanonicalFinalizeTransition\(existingJob/);
  assert.match(reportRoute, /terminalJobHasRuntimeState\(existingJob\)/);
  assert.match(reportRoute, /terminal_runtime_cleanup_applied:\s*terminalRuntimeCleanupApplied/);
});

test("duplicate terminal report stays terminal and idempotent after runtime cleanup", () => {
  const duplicateStart = reportRoute.indexOf("if (existingTerminalStatus)");
  const duplicateEnd = reportRoute.indexOf("const { data, error, skippedColumns }", duplicateStart);
  const duplicateBranch = reportRoute.slice(duplicateStart, duplicateEnd);

  assert.match(duplicateBranch, /duplicate_report_idempotent:\s*true/);
  assert.match(duplicateBranch, /second_side_effect_triggered:\s*false/);
  assert.doesNotMatch(duplicateBranch, /status:\s*["'](?:queued|pending|running)["']/);
});

test("deterministic Git reports bypass code-diff false-positive guard only after remote verification", () => {
  const guard = functionBlock(reportRoute, "buildFalsePositiveSuccessGuard");
  assert.match(guard, /deterministicGitOperation === true/);
  assert.match(guard, /codeChangesRequired === false/);
  assert.match(guard, /codexRequired === false/);
  assert.match(guard, /gitCommitRequired === false/);
  assert.match(guard, /gitPushRequired === true/);
  assert.match(guard, /codexCalled === false/);
  assert.match(guard, /body\.remote_contains_commit/);
  assert.match(guard, /body\.repository_clean_after_push/);
  assert.match(guard, /verificationOnlyNoChangeSuccess \|\| deterministicGitSuccess/);
});

test("explicit no-Codex policy is checked before Codex execution", () => {
  const pollBlock = functionBlock(localWorker, "pollOnce");
  const policyIndex = pollBlock.indexOf("shouldCallCodexForContract(initialContract)");
  const deterministicIndex = pollBlock.indexOf("runDeterministicGitOperation(job, initialContract)");
  const codexIndex = pollBlock.indexOf("runCodexWithRetries(job)");

  assert.ok(policyIndex >= 0 && policyIndex < codexIndex);
  assert.ok(deterministicIndex > policyIndex && deterministicIndex < codexIndex);
  assert.match(pollBlock, /execution_policy_conflict=/);
  assert.match(pollBlock, /codex_required=false; deterministic Worker Git operation used/);
});

test("attempt identity can survive schemas without attempt_id columns or payload", () => {
  const activeAttempt = functionBlock(stateMachineSource, "getActiveAttempt");
  assert.match(workerJobs, /getCanonicalActiveAttempt\(job\)/);
  assert.match(activeAttempt, /machine\.active_attempt/);
  assert.match(activeAttempt, /source:\s*"canonical_state_machine"/);
  assert.match(activeAttempt, /parseAttemptContext\(job\.request_text\)/);
  assert.match(stateMachineSource, /HERMES_WORKER_ATTEMPT_CONTEXT:/);
  assert.doesNotMatch(nextRoute, /HERMES_WORKER_ATTEMPT_CONTEXT:/);
});

test("heartbeat and progress reject wrong attempts with explicit failure code", () => {
  assert.match(heartbeatRoute, /buildCanonicalHeartbeatTransition\(existingJob/);
  assert.match(progressRoute, /buildCanonicalProgressTransition\(existingJob/);
  assert.match(stateMachineSource, /transitionFailure\("WORKER_ATTEMPT_MISMATCH"\)/);
  assert.match(heartbeatRoute, /failure_code:\s*transition\.failure_code/);
  assert.match(progressRoute, /failure_code:\s*transition\.failure_code/);
});

test("heartbeat and progress update the active attempt payload for the correct attempt", () => {
  assert.match(stateMachineSource, /function applyHeartbeat\(job, input = \{\}\)/);
  assert.match(stateMachineSource, /function applyProgress\(job, input = \{\}\)/);
  assert.match(heartbeatRoute, /updateCanonicalHermesJob\(/);
  assert.match(progressRoute, /updateCanonicalHermesJob\(/);
  assert.match(heartbeatRoute, /transition\.patch/);
  assert.match(progressRoute, /transition\.patch/);
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
  const bypassIndexes = [
    ...block.matchAll(/if \(verificationOnlyNoChangeSuccess \|\| deterministicGitSuccess\)/g),
  ].map((match) => match.index ?? -1);
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
  assert.match(pollBlock, /remote_contains_commit:\s*remoteContainsCommit/);
  assert.match(pollBlock, /deterministicResult\?\.remoteContainsCommit === true \|\| pushResult\.pushed/);
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
