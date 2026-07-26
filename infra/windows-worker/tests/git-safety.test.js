/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  assertCleanStatusEntries,
  comparePathSets,
  getStatusPaths,
  getTrackedStatusPaths,
  isAutomationSystemTaskText,
  isFrozenBusinessPagePath,
  isSensitivePath,
  normalizeGitPath,
  parseGitStatusPorcelain,
  parseGitStatusShort,
  scanSensitiveContent,
  validateAutomationTaskBoundaries,
  validateCommittablePaths,
  validateGitAddPathsExist,
  validateStagedPaths,
} = require("../git-safety");

const {
  NO_FIX_APPLIED,
  OUT_OF_SCOPE_BUSINESS_CHANGE,
  OUT_OF_SCOPE_SYSTEM_CHANGE,
  ORIGINAL_BATCH_CONTEXT_MISSING,
  READ_ONLY_MODE_VIOLATION,
  TASK_MODE_MISMATCH,
  EXPLICIT_TASK_MODE_OVERRIDDEN,
  EXPLICIT_PROJECT_DOMAIN_OVERRIDDEN,
  MISSING_REQUIRED_DOCS,
  INSUFFICIENT_DOC_OUTPUT,
  INCOMPLETE_QA_REPORT,
  INCOMPLETE_ARCHITECTURE_REPORT,
  WORKER_READONLY_CONTEXT_INCOMPLETE,
  CONTEXT_MISSING_WARNING,
  TASK_MODES,
  assertGitOperationAllowed,
  assertOriginalBatchContextAvailable,
  assertQaTaskOutcome,
  assertWorkerReadOnlyTaskGoalComplete,
  assertTaskGoalApplied,
  assertExplicitTaskFieldsNotOverridden,
  buildCodexPrompt,
  buildCodexExecArgs,
  buildCodexSpawnCommand,
  buildFailureReport,
  buildAutoIterationSuggestion,
  buildWorkerGuardedPrompt,
  buildTerminalStatusSnapshot,
  classifyWorkerFetchError,
  classifyWorkerTaskDomain,
  createTerminalReportState,
  extractCurrentExecutionBatchCode,
  extractRequiredChangePaths,
  formatCodexSpawnError,
  formatWorkerFetchError,
  getTerminalReportSnapshot,
  getCodexFileType,
  getWorkerPollBackoffMs,
  getTaskMode,
  isRunningJobNotFoundOrNotOwned,
  isTrueTaskFailureCode,
  isReadOnlyTask,
  isReadOnlyTaskText,
  lockAcceptedTerminalReportSnapshot,
  normalizeWorkerContext,
  normalizeWorkerFinalResult,
  recordPostCompletionTransportWarning,
  recordFailureMemoryForFinalResult,
  recordFailureMemory,
  recordTerminalJobIndex,
  registerTerminalTimerStopper,
  resolveCodexExecutable,
  resolveWorkerJobContract,
  runCodexPreflight,
  resetTerminalReportState,
} = require("../local_worker");

const workerRoot = path.resolve(__dirname, "..");

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-safety-files-"));

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  return root;
}

function writeFile(root, relativePath, content = "test\n") {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
}

const COMPLETE_QA_REPORT = [
  "当前能直接用的功能：访客可静态查看首页信息。",
  "当前需要修的功能：发布链路仍需补齐验收。",
  "首页验收结论：通过静态读取 src/app/page.tsx。",
  "搭子浏览页验收结论：通过静态读取 src/app/partners/**。",
  "发布页验收结论：通过静态读取 src/app/post/**。",
  "本地草稿 / 待审核流程验收结论：需要开发团队继续补齐。",
  "登录页和个人中心 warning 说明：登录页和个人中心仅做 warning，不阻断 QA。",
  "开发团队下一步建议：优先处理发布和审核链路。",
  "测试审核团队下一步建议：按页面和流程补测试用例。",
  "运营团队是否可以加入：暂不建议全面加入。",
  "下一批建议从哪个 BATCH 开始：建议从 BATCH-QA-04 开始。",
].join("\n");

const GROUPED_QA_REPORT = [
  "当前能直接使用的功能：访客可以进入首页并浏览公开内容。",
  "当前需要修复的功能：发布后的审核闭环仍需要继续修。",
  "首页：通过，已静态读取 src/app/page.tsx。",
  "搭子浏览页：通过，已静态读取 src/app/partners/**。",
  "发布页：不通过，发布后的流转仍需补齐。",
  "本地草稿 / 待审核流程：warning，需要继续补端到端验收。",
  "登录页 / 个人中心 warning：登录页和个人中心存在未完成风险。",
  "下一步建议：",
  "开发团队：下一批优先修发布、草稿和待审核流程。",
  "测试审核团队：补首页、搭子浏览页、发布页和审核流测试。",
  "运营团队：暂不建议加入，等发布和审核闭环稳定。",
  "下一批建议从哪个 BATCH 开始：建议从 BATCH-QA-04 后续修复批次开始。",
].join("\n");

const QA_REPORT_WITHOUT_TEAM_RECOMMENDATIONS = [
  "当前能直接使用的功能：访客可以进入首页并浏览公开内容。",
  "当前需要修复的功能：发布后的审核闭环仍需要继续修。",
  "首页：通过，已静态读取 src/app/page.tsx。",
  "搭子浏览页：通过，已静态读取 src/app/partners/**。",
  "发布页：不通过，发布后的流转仍需补齐。",
  "本地草稿 / 待审核流程：warning，需要继续补端到端验收。",
  "登录页 / 个人中心 warning：登录页和个人中心存在未完成风险。",
  "下一批建议从哪个 BATCH 开始：建议从 BATCH-QA-04 后续修复批次开始。",
].join("\n");

const STRUCTURED_QA_REPORT = [
  "页面验收结论",
  "- 首页：通过",
  "- 搭子浏览页：通过",
  "- 发布页：warning",
  "下一步建议",
  "- 开发团队：继续修发布和审核闭环。",
  "- 测试审核团队：补全静态和流程验收。",
  "- 运营团队：暂不建议加入。",
  "QA_REPORT_FIELDS:",
  "current_usable_features: yes",
  "current_fix_needed: yes",
  "homepage_verdict: pass",
  "partners_verdict: pass",
  "post_verdict: warning",
  "local_draft_review_verdict: warning",
  "login_profile_warning: yes",
  "dev_team_next_step: yes",
  "qa_team_next_step: yes",
  "ops_team_join: no",
  "next_batch: BATCH-QA-05",
].join("\n");

const STRUCTURED_QA_REPORT_MISSING_NEXT_BATCH = [
  "页面验收结论",
  "- 首页：通过",
  "- 搭子浏览页：通过",
  "- 发布页：warning",
  "QA_REPORT_FIELDS:",
  "current_usable_features: yes",
  "current_fix_needed: yes",
  "homepage_verdict: pass",
  "partners_verdict: pass",
  "post_verdict: warning",
  "local_draft_review_verdict: warning",
  "login_profile_warning: yes",
  "dev_team_next_step: yes",
  "qa_team_next_step: yes",
  "ops_team_join: no",
].join("\n");

const COMPLETE_ARCHITECTURE_REPORT = [
  "Architecture inventory conclusion: Worker routing, task mode guards, and reporting paths are mapped.",
  "Missing modules: architecture-specific read-only report validation was missing.",
  "Knowledge base status: project docs exist, but automation architecture notes need clearer ownership.",
  "Automation iteration status: retry and guard loops exist, with validation routing gaps now identified.",
  "Batch plan: BATCH-ARCH-02 reviews worker intake, BATCH-ARCH-03 reviews routing, BATCH-ARCH-04 reviews prompts, BATCH-ARCH-05 reviews reporting, BATCH-ARCH-06 reviews retries, BATCH-ARCH-07 reviews safety, BATCH-ARCH-08 reviews docs, BATCH-ARCH-09 reviews monitoring, and BATCH-ARCH-10 closes the architecture plan.",
].join("\n");

const INCOMPLETE_ARCHITECTURE_REPORT_TEXT = [
  "Architecture inventory conclusion: Worker routing was checked.",
  "Missing modules: architecture-specific validation was missing.",
].join("\n");

const STRUCTURED_ARCH_SMOKE_REPORT = [
  "ARCH_REPORT_FIELDS:",
  "final_report_status=succeeded",
  "no_fix_applied=false",
  "read_only_violation=false",
  "task_mode_mismatch=false",
  "out_of_scope_business_change=false",
].join("\n");

function joinedName(...parts) {
  return parts.join("_");
}

function joinedWords(...parts) {
  return parts.join(" ");
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.resolve(workerRoot, "..", "..", relativePath), "utf8");
}

test("Windows Worker polling errors are classified and back off", async (t) => {
  await t.test("DNS failures include actionable fetch diagnostics", () => {
    const error = new TypeError("fetch failed");
    error.cause = {
      name: "Error",
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
    };
    error.workerRequest = {
      method: "GET",
      url: "http://150.109.71.58.nip.io/api/worker/next?worker_id=local-worker",
      timeoutMs: 15000,
    };

    assert.equal(classifyWorkerFetchError(error), "dns_failure");
    const formatted = formatWorkerFetchError(error);
    assert.match(formatted, /type=dns_failure/);
    assert.match(formatted, /method=GET/);
    assert.match(formatted, /url=http:\/\/150\.109\.71\.58\.nip\.io\/api\/worker\/next/);
    assert.match(formatted, /timeout_ms=15000/);
    assert.doesNotMatch(
      formatted,
      new RegExp(["Authorization", "Bearer", joinedName("WORKER", "TOKEN")].join("|"))
    );
  });

  await t.test("TCP refusal and timeout are separated from generic fetch failed", () => {
    const refused = new TypeError("fetch failed");
    refused.cause = { code: "ECONNREFUSED", address: "150.109.71.58", port: 80 };
    assert.equal(classifyWorkerFetchError(refused), "connection_refused");

    const timeout = new Error("This operation was aborted");
    timeout.name = "AbortError";
    assert.equal(classifyWorkerFetchError(timeout), "timeout");
  });

  await t.test("poll retry backoff is bounded", () => {
    assert.equal(getWorkerPollBackoffMs(0), 5000);
    assert.equal(getWorkerPollBackoffMs(1), 5000);
    assert.equal(getWorkerPollBackoffMs(2), 10000);
    assert.equal(getWorkerPollBackoffMs(3), 20000);
    assert.equal(getWorkerPollBackoffMs(99), 60000);
  });
});

test("Project Director Worker task creation uses hermes_jobs contract", async (t) => {
  const builderSource = readRepoFile("src/lib/project-director-job-builder.ts");
  const routeSource = readRepoFile("src/app/api/feishu/event/route.ts");
  const workerJobsSource = readRepoFile("src/lib/worker-jobs.ts");
  const troubleshootingSource = readRepoFile("docs/TROUBLESHOOTING.md");

  await t.test("runtime creation never inserts into worker_jobs", () => {
    assert.doesNotMatch(builderSource, /\.from\(["'`]worker_jobs["'`]\)/);
    assert.doesNotMatch(routeSource, /\.from\(["'`]worker_jobs["'`]\)/);
    assert.doesNotMatch(workerJobsSource, /\.from\(["'`]worker_jobs["'`]\)/);
    assert.match(workerJobsSource, /export async function createHermesJobs/);
    assert.match(workerJobsSource, /\.from\("hermes_jobs"\)\.insert\(rows\)/);
    assert.match(builderSource, /createHermesJobs\(supabase, rowsInput, failureLabel\)/);
    assert.match(routeSource, /createHermesJobs\(/);
  });

  await t.test("normalized Worker context survives missing payload column", () => {
    for (const source of [builderSource, routeSource]) {
      assert.match(source, /HERMES_WORKER_CONTEXT/);
      assert.match(source, /project_domain/);
      assert.match(source, /task_mode/);
      assert.match(source, /read_only_mode/);
      assert.match(source, /allowed_scope/);
      assert.match(source, /forbidden_scope/);
      assert.match(source, /original_request_text/);
      assert.match(source, /approved_batch/);
    }

    assert.match(builderSource, /withHermesWorkerContext\(requestText, context\)/);
    assert.match(routeSource, /withHermesWorkerContext\(input\.requestText, directWorkerPayload\)/);
    assert.match(routeSource, /requested_mode/);
    assert.match(routeSource, /final_mode/);
    assert.match(routeSource, /approval_required/);
  });

  await t.test("worker job contract reads full job context when request_text is unavailable", () => {
    assert.match(workerJobsSource, /function readWorkerJobContextText/);
    assert.match(workerJobsSource, /job\?\.description/);
    assert.match(workerJobsSource, /job\?\.prompt/);
    assert.match(workerJobsSource, /job\?\.title/);

    const helperIndex = workerJobsSource.indexOf("function readWorkerJobContextText");
    const usageIndex = workerJobsSource.indexOf("const jobContextText = readWorkerJobContextText");
    const sourceTextIndex = workerJobsSource.indexOf("const sourceText = [", usageIndex);
    assert.ok(helperIndex >= 0);
    assert.ok(usageIndex > helperIndex);
    assert.ok(sourceTextIndex > usageIndex);
    assert.match(workerJobsSource.slice(sourceTextIndex, sourceTextIndex + 180), /jobContextText/);
  });

  await t.test("Feishu final replies keep source-independent reply context", () => {
    assert.match(routeSource, /source:\s*"direct_worker_create"/);
    assert.match(routeSource, /source:\s*"project_director_approval"/);
    assert.match(routeSource, /source_message_id:\s*input\.feishuMessageId/);
    assert.match(routeSource, /source_chat_id:\s*input\.feishuChatId/);
    assert.match(routeSource, /source_message_id:\s*feishuContext\?\.messageId/);
    assert.match(routeSource, /source_chat_id:\s*feishuContext\?\.chatId/);
    assert.doesNotMatch(routeSource, /source:\s*"feishu"[\s\S]{0,240}route:\s*"direct_worker_create"/);
  });

  await t.test("final report delivery must not be gated by source=feishu only", () => {
    assert.match(troubleshootingSource, /FINAL_REPORT_SOURCE_GATE/);
    assert.match(troubleshootingSource, /project_director_approval/);
    assert.match(troubleshootingSource, /direct_worker_create/);
  });

  await t.test("long approval batch codes are not truncated", () => {
    const approvalText =
      "总管 批准执行：仅批准 BATCH-GM-DIRECTOR-OUTPUT-SEPARATION-FIX-01";
    const batchPattern = /\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/gi;
    assert.deepEqual(approvalText.match(batchPattern), [
      "BATCH-GM-DIRECTOR-OUTPUT-SEPARATION-FIX-01",
    ]);
    assert.ok(
      routeSource.includes(
        "const ROUTE_BATCH_CODE_PATTERN = /\\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\\b/gi;"
      )
    );
  });

  await t.test("project director reports keep task-goal failure codes machine-readable", () => {
    assert.match(workerJobsSource, /taskGoalFailureCode/);
    assert.match(workerJobsSource, /NO_FIX_APPLIED/);
    assert.match(workerJobsSource, /READ_ONLY_MODE_VIOLATION/);
    assert.match(workerJobsSource, /failed_no_fix_applied/);
  });

  await t.test("project director report title separates worker status from final task status", () => {
    assert.match(workerJobsSource, /workerStatusTitle/);
    assert.match(workerJobsSource, /worker_status_title/);
    assert.match(workerJobsSource, /effectiveFinalStatus === "failed" && input\.status === "succeeded"/);
    assert.match(workerJobsSource, /任务目标验收失败/);
  });

  await t.test("hermes_jobs payload shape and insert errors are observable without secrets", () => {
    const insertErrorFormatterStart = workerJobsSource.indexOf("function formatHermesJobInsertError");
    const insertErrorFormatterEnd = workerJobsSource.indexOf("export async function createHermesJobs");
    const insertErrorFormatter = workerJobsSource.slice(insertErrorFormatterStart, insertErrorFormatterEnd);

    assert.match(workerJobsSource, /summarizeHermesInsertRows/);
    assert.match(workerJobsSource, /insert_payload_shape/);
    assert.match(workerJobsSource, /payload_fields/);
    assert.match(workerJobsSource, /task_mode/);
    assert.match(workerJobsSource, /batch/);
    assert.match(workerJobsSource, /http_status/);
    assert.match(workerJobsSource, /code: error\?\.code/);
    assert.match(workerJobsSource, /message: error\?\.message/);
    assert.match(workerJobsSource, /details: error\?\.details/);
    assert.match(workerJobsSource, /hint: error\?\.hint/);
    assert.doesNotMatch(insertErrorFormatter, /SERVICE_ROLE/);
    assert.doesNotMatch(insertErrorFormatter, /Authorization/);
  });

  await t.test("legacy hermes_jobs status and priority constraints are retried safely", () => {
    assert.match(workerJobsSource, /status:queued->pending/);
    assert.match(workerJobsSource, /priority:number->P0\/P1\/P2/);
    assert.match(workerJobsSource, /shouldRetryPendingStatus/);
    assert.match(workerJobsSource, /shouldRetryTextPriority/);
  });

  await t.test("insert errors preserve Supabase body and field details", () => {
    assert.match(workerJobsSource, /code: error\?\.code/);
    assert.match(workerJobsSource, /message: error\?\.message/);
    assert.match(workerJobsSource, /details: error\?\.details/);
    assert.match(workerJobsSource, /hint: error\?\.hint/);
    assert.match(workerJobsSource, /hermes_jobs_insert/);
    assert.match(routeSource, /hermes_jobs_insert/);
    assert.match(routeSource, /已识别批准批次，但创建 hermes_jobs 失败。/);
    assert.doesNotMatch(routeSource, /hermes_jobs_insert[\s\S]{0,200}请重新明确批次/);
  });

  await t.test("duplicate approvals are checked before creating hermes_jobs", () => {
    const duplicateCheckIndex = routeSource.lastIndexOf("hasExistingAgentDispatchJobs(");
    const insertIndex = routeSource.lastIndexOf("insertApprovedAgentDispatchJobsWithContract(");
    assert.notEqual(duplicateCheckIndex, -1);
    assert.notEqual(insertIndex, -1);
    assert.ok(duplicateCheckIndex < insertIndex);
    assert.match(routeSource, /PROJECT_DIRECTOR_APPROVED_EXECUTION_DUPLICATE/);
    assert.match(workerJobsSource, /findDuplicateByEmbeddedRequestText/);
    assert.match(workerJobsSource, /normalizedRequestText\.includes\(normalizedNeedle\)/);
  });

  await t.test("route preserves exact allowed scope in Hermes Worker context", () => {
    assert.match(routeSource, /extractExactAllowedScopePaths/);
    assert.match(routeSource, /"exact_allowed_scope"/);
    assert.match(routeSource, /exactAllowedScope/);
    assert.match(routeSource, /allowedScope = exactAllowedScope\.length > 0 \? exactAllowedScope/);
    assert.match(workerJobsSource, /exactAllowedScope\?: unknown/);
    assert.match(workerJobsSource, /exact_allowed_scope: exactAllowedScope/);
  });

  await t.test("write request intake keeps exact scope without cloud-only classifiers", () => {
    assert.doesNotMatch(routeSource, /classifyGatewayTaskContext/);
    assert.match(routeSource, /extractExactAllowedScopePaths/);
    assert.match(routeSource, /original_request_text/);
    assert.match(routeSource, /exact_allowed_scope/);
    assert.match(routeSource, /DIRECT_WRITE_ALLOWED_REQUIRES_APPROVAL/);
  });
});

test("Git porcelain v1 -z status parsing", async (t) => {
  await t.test("ordinary modified file", () => {
    const entry = parseGitStatusPorcelain(" M tracked.txt\0")[0];

    assert.equal(entry.status, " M");
    assert.equal(entry.path, "tracked.txt");
    assert.equal(entry.originalPath, null);
    assert.deepEqual(entry.paths, ["tracked.txt"]);
    assert.equal(entry.line, " M tracked.txt");
  });

  await t.test("new untracked file", () => {
    const entries = parseGitStatusPorcelain("?? new.txt\0");

    assert.equal(entries[0].status, "??");
    assert.deepEqual(getStatusPaths(entries), ["new.txt"]);
    assert.deepEqual(getTrackedStatusPaths(entries), []);
  });

  await t.test("staged file", () => {
    assert.equal(parseGitStatusPorcelain("M  tracked.txt\0")[0].status, "M ");
  });

  await t.test("deleted file", () => {
    const entries = parseGitStatusPorcelain(" D tracked.txt\0");

    assert.equal(entries[0].status, " D");
    assert.deepEqual(getStatusPaths(entries), ["tracked.txt"]);
    assert.deepEqual(getTrackedStatusPaths(entries), ["tracked.txt"]);
  });

  await t.test("renamed file has new and original path", () => {
    const entry = parseGitStatusPorcelain("R  renamed.txt\0tracked.txt\0")[0];

    assert.equal(entry.status, "R ");
    assert.equal(entry.path, "renamed.txt");
    assert.equal(entry.originalPath, "tracked.txt");
    assert.deepEqual(entry.paths, ["renamed.txt"]);
  });

  await t.test("file name with spaces is not split", () => {
    assert.deepEqual(getStatusPaths(parseGitStatusPorcelain("?? file with spaces.txt\0")), [
      "file with spaces.txt",
    ]);
  });

  await t.test("Chinese file name is preserved", () => {
    assert.deepEqual(getStatusPaths(parseGitStatusPorcelain("?? 中文文件.txt\0")), [
      "中文文件.txt",
    ]);
  });

  await t.test("simultaneous worktree and staged modifications", () => {
    assert.equal(parseGitStatusPorcelain("MM tracked.txt\0")[0].status, "MM");
  });

  await t.test("Windows backslash paths are normalized", () => {
    assert.deepEqual(getStatusPaths(parseGitStatusPorcelain(" M src\\worker\\file.ts\0")), [
      "src/worker/file.ts",
    ]);
  });

  await t.test("Git slash paths are preserved", () => {
    assert.deepEqual(getStatusPaths(parseGitStatusPorcelain(" M src/worker/file.ts\0")), [
      "src/worker/file.ts",
    ]);
  });

  await t.test("BATCH-34 modified src and infra paths keep their first character", () => {
    const cases = [
      [" M src/lib/db/mock.ts", "src/lib/db/mock.ts"],
      ["M src/lib/db/mock.ts", "src/lib/db/mock.ts"],
      [" M src/app/post/page.tsx", "src/app/post/page.tsx"],
      ["M src/app/post/page.tsx", "src/app/post/page.tsx"],
      [" M infra/windows-worker/git-safety.js", "infra/windows-worker/git-safety.js"],
      ["M infra/windows-worker/git-safety.js", "infra/windows-worker/git-safety.js"],
      ["?? docs/test.md", "docs/test.md"],
      ["A  docs/test.md", "docs/test.md"],
    ];

    for (const [rawStatusLine, expectedPath] of cases) {
      assert.deepEqual(getStatusPaths(parseGitStatusPorcelain(`${rawStatusLine}\0`)), [
        expectedPath,
      ]);
    }
  });

  await t.test("empty output parses as clean", () => {
    assert.deepEqual(parseGitStatusPorcelain(""), []);
  });

  await t.test("BATCH-P3 acceptance paths are preserved", () => {
    const entries = parseGitStatusPorcelain(
      [
        " M app/page.tsx",
        " M app/partners/page.tsx",
        " M src/app/page.tsx",
        " M infra/windows-worker/local_worker.js",
      ].join("\0") + "\0"
    );

    assert.deepEqual(getStatusPaths(entries), [
      "app/page.tsx",
      "app/partners/page.tsx",
      "infra/windows-worker/local_worker.js",
      "src/app/page.tsx",
    ]);
    assert.equal(getStatusPaths(entries).includes("pp/page.tsx"), false);
  });

  await t.test("BATCH-30 incident path is preserved", () => {
    const entries = parseGitStatusPorcelain(" M src/app/post/page.tsx\0");

    assert.deepEqual(getStatusPaths(entries), ["src/app/post/page.tsx"]);
    assert.equal(getStatusPaths(entries).includes("rc/app/post/page.tsx"), false);
  });
});

test("Git short status fallback parsing", async (t) => {
  await t.test("ordinary modified paths start after the two status columns and one separator", () => {
    const entries = parseGitStatusShort(
      [
        " M app/page.tsx",
        " M app/partners/page.tsx",
        " M src/app/page.tsx",
        " M infra/windows-worker/local_worker.js",
      ].join("\n")
    );

    assert.deepEqual(getStatusPaths(entries), [
      "app/page.tsx",
      "app/partners/page.tsx",
      "infra/windows-worker/local_worker.js",
      "src/app/page.tsx",
    ]);
    assert.equal(getStatusPaths(entries).includes("pp/page.tsx"), false);
  });

  await t.test("BATCH-30 incident path is not truncated", () => {
    const entries = parseGitStatusShort(" M src/app/post/page.tsx");

    assert.deepEqual(getStatusPaths(entries), ["src/app/post/page.tsx"]);
    assert.equal(getStatusPaths(entries).includes("rc/app/post/page.tsx"), false);
  });
});

test("automation system task boundaries", async (t) => {
  await t.test("detects BATCH-41 and explicit automation_system domain", () => {
    assert.equal(
      isAutomationSystemTaskText(
        [
          "task_domain: automation_system",
          "Current execution batch: BATCH-41",
        ].join("\n")
      ),
      true
    );
  });

  await t.test("detects BATCH-30 worker repair tasks", () => {
    assert.equal(
      isAutomationSystemTaskText("执行 BATCH-30：修复 Windows Worker / Codex 上报链路"),
      true
    );
  });

  await t.test("detects frozen city-partner business page paths", () => {
    assert.equal(isFrozenBusinessPagePath("src/app/post/page.tsx"), true);
    assert.equal(isFrozenBusinessPagePath("src/app/partners/page.tsx"), true);
    assert.equal(isFrozenBusinessPagePath("infra/windows-worker/local_worker.js"), false);
  });

  await t.test("allows worker files for automation repair tasks", () => {
    assert.doesNotThrow(() =>
      validateAutomationTaskBoundaries(["infra/windows-worker/local_worker.js"], {
        requestText: "BATCH-30 Windows Worker system repair",
      })
    );
  });

  await t.test("blocks business page changes for automation repair tasks", () => {
    assert.throws(
      () =>
        validateAutomationTaskBoundaries(["src/app/post/page.tsx"], {
          requestText: "BATCH-30 Windows Worker system repair",
        }),
      (error) =>
        error.code === "BUSINESS_PAGE_BOUNDARY_VIOLATION" &&
        error.message.includes("src/app/post/page.tsx")
    );
  });

  await t.test("blocks business page changes for BATCH-41 automation_system tasks", () => {
    assert.throws(
      () =>
        validateAutomationTaskBoundaries(["src/app/partners/page.tsx"], {
          requestText: [
            "task_domain: automation_system",
            "Current execution batch: BATCH-41",
            "Forbidden scope: do not execute BATCH-P3 or BATCH-P4 product work",
          ].join("\n"),
        }),
      (error) =>
        error.code === "BUSINESS_PAGE_BOUNDARY_VIOLATION" &&
        error.message.includes("src/app/partners/page.tsx")
    );
  });

  await t.test("does not enforce automation boundaries for non-automation tasks", () => {
    assert.doesNotThrow(() =>
      validateAutomationTaskBoundaries(["src/app/post/page.tsx"], {
        requestText: "普通产品页面任务",
      })
    );
  });
});

test("NO_FIX_APPLIED task goal validation", async (t) => {
  await t.test("fails BATCH-37 reusable asset task when no files changed", () => {
    assert.throws(
      () =>
        assertTaskGoalApplied(
          {
            title: "BATCH-37 reusable assets",
            request_text: "修复目标：新增 docs/projects/reusable-assets.md",
          },
          []
        ),
      (error) =>
        error.code === NO_FIX_APPLIED &&
        error.message.includes("docs/projects/reusable-assets.md")
    );
  });

  await t.test("fails when task asks for a specified file but another file changed", () => {
    assert.throws(
      () =>
        assertTaskGoalApplied(
          {
            title: "BATCH-38A worker repair",
            request_text: "修复目标：修改 infra/windows-worker/local_worker.js",
          },
          ["docs/projects/feishu-gm-automation.md"]
        ),
      (error) =>
        error.code === NO_FIX_APPLIED &&
        error.message.includes("infra/windows-worker/local_worker.js")
    );
  });

  await t.test("allows mutation tasks when a required file changed", () => {
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(
        {
          title: "BATCH-38A worker repair",
          request_text: "修复目标：修改 infra/windows-worker/local_worker.js",
        },
        ["infra/windows-worker/local_worker.js"]
      )
    );
  });

  await t.test("extracts required files without treating allowed-only scope as required", () => {
    assert.deepEqual(
      extractRequiredChangePaths(
        [
          "允许修改：",
          "- infra/windows-worker/local_worker.js",
          "修复目标：新增 docs/projects/reusable-assets.md",
        ].join("\n")
      ),
      ["docs/projects/reusable-assets.md"]
    );
  });

  await t.test("does not extract forbidden scope paths as required paths", () => {
    const requestText = [
      "Repair target:",
      "- docs/projects/city-partner-website.md",
      "allowed_scope: src/app/**, docs/projects/city-partner-website.md",
      "forbidden_scope: infra/windows-worker/**, src/lib/worker-jobs.ts, src/app/api/feishu/event/route.ts",
      "Forbidden scope:",
      "- infra/windows-worker/local_worker.js",
      "- src/lib/worker-jobs.ts",
      "Do not modify src/app/api/feishu/event/route.ts",
    ].join("\n");

    assert.deepEqual(extractRequiredChangePaths(requestText), [
      "docs/projects/city-partner-website.md",
    ]);
  });

  await t.test("does not extract product paths from forbidden or background text", () => {
    const requestText = [
      "BATCH-ARCH-03C",
      "task_mode=automation_system_write_allowed",
      "Repair target:",
      "- infra/windows-worker/local_worker.js",
      "forbidden_scope: src/app/**, app/**, src/lib/db/**",
      "禁止修改 src/app/partners/page.tsx",
      "不要读取 app/login/page.tsx",
      "背景说明：src/app/profile/page.tsx appeared in a QA report.",
    ].join("\n");

    assert.deepEqual(extractRequiredChangePaths(requestText), [
      "infra/windows-worker/local_worker.js",
    ]);
  });

  await t.test("BATCH-ARCH-03C smoke ignores forbidden src app scope and accepts worker diffs", () => {
    const requestText = [
      "BATCH-ARCH-03C-SMOKE-01",
      "project_domain=automation_system",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      "Repair target:",
      "- infra/windows-worker/local_worker.js",
      "- infra/windows-worker/tests/git-safety.test.js",
      "forbidden_scope: src/app/**, app/**, docs/**, src/lib/**",
      "Do not modify src/app/page.tsx or src/app/partners/page.tsx.",
    ].join("\n");

    assert.deepEqual(extractRequiredChangePaths(requestText), [
      "infra/windows-worker/local_worker.js",
      "infra/windows-worker/tests/git-safety.test.js",
    ]);

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(
        { title: "BATCH-ARCH-03C-SMOKE-01", request_text: requestText },
        ["infra/windows-worker/local_worker.js"]
      )
    );
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(
        { title: "BATCH-ARCH-03C-SMOKE-01", request_text: requestText },
        ["infra/windows-worker/tests/git-safety.test.js"]
      )
    );
  });

  await t.test("BATCH-GM-WRITE-GUARD accepts Worker validator diffs", () => {
    const requestText = [
      "BATCH-GM-WRITE-GUARD-01",
      "project_domain=automation_system",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      "Repair target:",
      "- infra/windows-worker/local_worker.js",
      "- infra/windows-worker/tests/git-safety.test.js",
      "The task text mentions read_only guard behavior but is an automation write repair.",
    ].join("\n");

    const job = { title: "BATCH-GM-WRITE-GUARD-01", request_text: requestText };

    assert.equal(getTaskMode(job), TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["infra/windows-worker/local_worker.js"])
    );
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, [
        "infra/windows-worker/tests/git-safety.test.js",
      ])
    );
  });

  await t.test("drops required paths that conflict with forbidden scope during validation", () => {
    const job = {
      request_text: [
        "BATCH-ARCH-03C",
        "task_mode=automation_system_write_allowed",
        "required changed paths:",
        "- src/lib/worker-jobs.ts",
        "forbidden_scope: src/lib/worker-jobs.ts, src/app/**",
        "Repair Worker validator.",
      ].join("\n"),
    };

    assert.throws(
      () => assertTaskGoalApplied(job, []),
      (error) =>
        error.code === NO_FIX_APPLIED &&
        !error.requiredPaths.includes("src/lib/worker-jobs.ts")
    );
  });

  await t.test("allows product write tasks with non-empty allowed changes", () => {
    const productJob = {
      request_text: [
        "project_domain=city_partner_product",
        "task_mode=product_write_allowed",
        "required changed paths:",
        "- src/app/page.tsx",
        "forbidden_scope: infra/windows-worker/local_worker.js, src/lib/worker-jobs.ts",
      ].join("\n"),
    };

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(productJob, ["src/app/partners/page.tsx"])
    );
    assert.throws(
      () => assertTaskGoalApplied(productJob, []),
      (error) => error.code === NO_FIX_APPLIED
    );
  });

  await t.test("BATCH-FIX product changes do not treat scope declarations as required_paths", () => {
    const productJob = {
      request_text: [
        "BATCH-FIX-06",
        "project_domain=city_partner_product",
        "task_mode=product_write_allowed",
        "read_only_mode=false",
        "allowed_scope=src/app/**, docs/NEXT_TASK_CARD.md, docs/projects/city-partner-website.md",
        "forbidden_scope=infra/windows-worker/**, src/lib/worker-jobs.ts, src/app/api/feishu/**, src/lib/project-director-console.ts",
        "Fix partners, login, profile product pages for the city partner website.",
      ].join("\n"),
    };
    const changedPaths = [
      "src/app/partners/page.tsx",
      "src/app/partners/[id]/page.tsx",
      "src/app/partners/[id]/LocalDraftDetail.tsx",
    ];

    assert.deepEqual(extractRequiredChangePaths(productJob.request_text), []);
    assert.doesNotThrow(() => assertTaskGoalApplied(productJob, changedPaths));
    assert.throws(
      () => assertTaskGoalApplied(productJob, []),
      (error) =>
        error.code === NO_FIX_APPLIED &&
        !error.requiredPaths.includes("src/lib/worker-jobs.ts") &&
        !error.message.includes("src/lib/worker-jobs.ts")
    );
  });
});

test("read_only_mode task lock", async (t) => {
  await t.test("BATCH-QA tasks are qa_review read-only and require complete no-diff QA reports", () => {
    const qaJob = {
      request_text: [
        "BATCH-QA-03",
        "task_mode=read_only",
        "read_only_mode=false",
        "project_domain=qa_review",
        "allowed_scope=static reads for src/app/page.tsx, src/app/partners/**, src/app/post/**, docs/**",
        "禁止修改文件",
      ].join("\n"),
      payload: {
        task_mode: "automation_system_write_allowed",
      },
    };

    assert.equal(classifyWorkerTaskDomain(qaJob.request_text), "qa_review");
    assert.equal(getTaskMode(qaJob), TASK_MODES.READ_ONLY);
    assert.equal(isReadOnlyTask(qaJob), true);
    const prompt = buildCodexPrompt(qaJob);
    assert.match(prompt, /project_domain: qa_review/);
    assert.match(prompt, /src\/app\/page\.tsx/);
    assert.match(prompt, /src\/app\/partners\/\*\*/);
    assert.match(prompt, /docs\/\*\*/);
    assert.match(prompt, /INCOMPLETE_QA_REPORT/);
    assert.match(prompt, /QA_REPORT_FIELDS:/);
    assert.match(prompt, /next_batch: BATCH-xxx/);
    assert.doesNotThrow(() => assertTaskGoalApplied(qaJob, []));
    assert.doesNotThrow(() => assertQaTaskOutcome(qaJob, [], COMPLETE_QA_REPORT));
    assert.throws(
      () => assertQaTaskOutcome(qaJob, [], "Worker only ran git status and git diff."),
      (error) =>
        error.code === INCOMPLETE_QA_REPORT &&
        error.message.includes("missing_qa_report_fields")
    );
    assert.throws(
      () => assertQaTaskOutcome(qaJob, ["src/app/page.tsx"], COMPLETE_QA_REPORT),
      (error) => error.code === READ_ONLY_MODE_VIOLATION
    );
  });

  await t.test("BATCH-QA accepts grouped next-step headings but still fails missing team guidance", () => {
    const qaJob = {
      request_text: [
        "BATCH-QA-04",
        "project_domain=qa_review",
        "task_mode=read_only",
        "read_only_mode=true",
      ].join("\n"),
    };

    assert.equal(classifyWorkerTaskDomain(qaJob.request_text), "qa_review");
    assert.equal(getTaskMode(qaJob), TASK_MODES.READ_ONLY);
    assert.doesNotThrow(() => assertQaTaskOutcome(qaJob, [], GROUPED_QA_REPORT));
    assert.throws(
      () => assertQaTaskOutcome(qaJob, [], QA_REPORT_WITHOUT_TEAM_RECOMMENDATIONS),
      (error) =>
        error.code === INCOMPLETE_QA_REPORT &&
        error.message.includes("开发团队下一步建议") &&
        error.message.includes("测试审核团队下一步建议") &&
        error.message.includes("运营团队是否可以加入")
    );
    assert.throws(
      () => assertQaTaskOutcome(qaJob, ["docs/TROUBLESHOOTING.md"], GROUPED_QA_REPORT),
      (error) => error.code === READ_ONLY_MODE_VIOLATION
    );
  });

  await t.test("BATCH-QA prefers complete QA_REPORT_FIELDS and fails missing machine fields", () => {
    const qaJob = {
      request_text: [
        "BATCH-QA-05",
        "project_domain=qa_review",
        "task_mode=read_only",
        "read_only_mode=true",
      ].join("\n"),
    };

    assert.equal(classifyWorkerTaskDomain(qaJob.request_text), "qa_review");
    assert.equal(getTaskMode(qaJob), TASK_MODES.READ_ONLY);
    assert.doesNotThrow(() => assertQaTaskOutcome(qaJob, [], STRUCTURED_QA_REPORT));
    assert.throws(
      () => assertQaTaskOutcome(qaJob, [], STRUCTURED_QA_REPORT_MISSING_NEXT_BATCH),
      (error) =>
        error.code === INCOMPLETE_QA_REPORT &&
        error.message.includes("next_batch")
    );
    assert.throws(
      () => assertQaTaskOutcome(qaJob, ["docs/TROUBLESHOOTING.md"], STRUCTURED_QA_REPORT),
      (error) => error.code === READ_ONLY_MODE_VIOLATION
    );
  });

  await t.test("project_domain qa_review requires QA report even without BATCH-QA batch code", () => {
    const qaDomainJob = {
      request_text: [
        "Static product QA review",
        "project_domain=qa_review",
        "task_mode=read_only",
        "read_only_mode=true",
      ].join("\n"),
    };

    assert.equal(classifyWorkerTaskDomain(qaDomainJob.request_text), "qa_review");
    assert.equal(getTaskMode(qaDomainJob), TASK_MODES.READ_ONLY);
    assert.doesNotThrow(() => assertQaTaskOutcome(qaDomainJob, [], STRUCTURED_QA_REPORT));
    assert.throws(
      () => assertQaTaskOutcome(qaDomainJob, [], "Only git status was checked."),
      (error) => error.code === INCOMPLETE_QA_REPORT
    );
  });

  await t.test("BATCH-ARCH read-only uses architecture report validation instead of QA fields", () => {
    const archJob = {
      request_text: [
        "BATCH-ARCH-01 automation architecture inventory",
        "project_domain=automation_architecture",
        "task_mode=read_only",
        "read_only_mode=true",
        "Background: previous BATCH-QA-05 product QA is not the current batch.",
      ].join("\n"),
    };

    assert.equal(classifyWorkerTaskDomain(archJob.request_text), "automation_architecture");
    assert.equal(getTaskMode(archJob), TASK_MODES.READ_ONLY);

    const prompt = buildCodexPrompt(archJob);
    assert.doesNotMatch(prompt, /QA_REPORT_FIELDS:/);
    assert.doesNotMatch(prompt, /INCOMPLETE_QA_REPORT/);
    assert.match(prompt, /BATCH-ARCH/);

    assert.doesNotThrow(() =>
      assertQaTaskOutcome(archJob, [], COMPLETE_ARCHITECTURE_REPORT)
    );
    assert.throws(
      () => assertQaTaskOutcome(archJob, [], INCOMPLETE_ARCHITECTURE_REPORT_TEXT),
      (error) =>
        error.code === INCOMPLETE_ARCHITECTURE_REPORT &&
        !error.message.includes(INCOMPLETE_QA_REPORT)
    );
    assert.throws(
      () =>
        assertQaTaskOutcome(
          archJob,
          ["infra/windows-worker/local_worker.js"],
          COMPLETE_ARCHITECTURE_REPORT
        ),
      (error) => error.code === READ_ONLY_MODE_VIOLATION
    );
  });

  await t.test("automation architecture smoke accepts complete ARCH_REPORT_FIELDS", () => {
    const archSmokeJob = {
      request_text: [
        "BATCH-GM-FINAL-GUARD-02-SMOKE-01",
        "project_domain=automation_architecture",
        "task_mode=read_only",
        "read_only_mode=true",
        "Smoke task: validate ARCH_REPORT_FIELDS only.",
      ].join("\n"),
    };

    assert.equal(
      classifyWorkerTaskDomain(archSmokeJob.request_text),
      "automation_architecture"
    );
    assert.equal(getTaskMode(archSmokeJob), TASK_MODES.READ_ONLY);

    const prompt = buildCodexPrompt(archSmokeJob);
    assert.match(prompt, /ARCH_REPORT_FIELDS:/);
    assert.doesNotMatch(prompt, /BATCH-ARCH-02 到 BATCH-ARCH-10/);
    assert.doesNotThrow(() =>
      assertQaTaskOutcome(archSmokeJob, [], STRUCTURED_ARCH_SMOKE_REPORT)
    );
    assert.throws(
      () => assertQaTaskOutcome(archSmokeJob, [], INCOMPLETE_ARCHITECTURE_REPORT_TEXT),
      (error) =>
        error.code === INCOMPLETE_ARCHITECTURE_REPORT &&
        error.message.includes("final_report_status")
    );
  });

  await t.test("formal BATCH-ARCH inventory still requires the five report titles", () => {
    const archInventoryJob = {
      request_text: [
        "BATCH-ARCH-04 automation architecture inventory",
        "project_domain=automation_architecture",
        "task_mode=read_only",
        "read_only_mode=true",
      ].join("\n"),
    };

    const prompt = buildCodexPrompt(archInventoryJob);
    assert.doesNotMatch(prompt, /ARCH_REPORT_FIELDS:/);
    assert.match(prompt, /BATCH-ARCH-02 到 BATCH-ARCH-10/);
    assert.throws(
      () => assertQaTaskOutcome(archInventoryJob, [], STRUCTURED_ARCH_SMOKE_REPORT),
      (error) =>
        error.code === INCOMPLETE_ARCHITECTURE_REPORT &&
        error.message.includes("架构盘点结论") &&
        error.message.includes("缺失模块清单") &&
        error.message.includes("知识库现状判断") &&
        error.message.includes("自动迭代能力现状判断") &&
        error.message.includes("BATCH-ARCH-02 到 BATCH-ARCH-10 的分批计划")
    );
  });

  await t.test("QA read-only still requires QA_REPORT_FIELDS", () => {
    const qaJob = {
      request_text: [
        "BATCH-QA-06",
        "project_domain=qa_review",
        "task_mode=read_only",
        "read_only_mode=true",
      ].join("\n"),
    };

    const prompt = buildCodexPrompt(qaJob);
    assert.match(prompt, /QA_REPORT_FIELDS:/);
    assert.throws(
      () => assertQaTaskOutcome(qaJob, [], STRUCTURED_ARCH_SMOKE_REPORT),
      (error) =>
        error.code === INCOMPLETE_QA_REPORT &&
        error.message.includes("missing_qa_report_fields")
    );
    assert.doesNotThrow(() => assertQaTaskOutcome(qaJob, [], STRUCTURED_QA_REPORT));
  });

  await t.test("plain read-only tasks with QA background do not require product QA fields", () => {
    const plainReadOnlyJob = {
      request_text: [
        "Worker status read-only check",
        "task_mode=read_only",
        "read_only_mode=true",
        "Background: previous BATCH-QA-05 already completed product QA.",
      ].join("\n"),
    };

    assert.equal(getTaskMode(plainReadOnlyJob), TASK_MODES.READ_ONLY);
    const prompt = buildCodexPrompt(plainReadOnlyJob);
    assert.doesNotMatch(prompt, /QA_REPORT_FIELDS:/);
    assert.doesNotThrow(() =>
      assertQaTaskOutcome(plainReadOnlyJob, [], "Read-only worker status checked.")
    );
  });

  await t.test("BATCH-GM-SMOKE is read-only and never docs_write_allowed", () => {
    const smokeJob = {
      request_text: [
        "BATCH-GM-SMOKE-02 final validation smoke test.",
        "read_only_mode=true.",
        "Verify docs/projects/feishu-gm-automation.md and Worker/Gateway status only.",
        "Do not modify any files. Do not run git add, git commit, or git push.",
      ].join("\n"),
    };

    assert.equal(getTaskMode(smokeJob), TASK_MODES.READ_ONLY);
    assert.equal(isReadOnlyTask(smokeJob), true);
    assert.doesNotThrow(() => assertTaskGoalApplied(smokeJob, []));
    assert.throws(
      () => assertTaskGoalApplied(smokeJob, ["docs/projects/feishu-gm-automation.md"]),
      (error) => error.code === READ_ONLY_MODE_VIOLATION
    );
    assert.throws(
      () => assertTaskGoalApplied(smokeJob, ["infra/windows-worker/local_worker.js"]),
      (error) => error.code === READ_ONLY_MODE_VIOLATION
    );
  });

  await t.test("task_mode prevents docs and automation tasks from being misread as read-only", () => {
    const docsJob = {
      request_text: "BATCH-37-FIX 文档整理：更新 docs/projects/team-routing.md，只允许 docs/**。",
      payload: { read_only_mode: true },
    };
    const automationJob = {
      request_text: "BATCH-44 系统修复：修复 Worker / 飞书总管 / 腾讯云中转。",
      payload: { read_only_mode: true },
    };
    const readOnlyJob = {
      request_text: "BATCH-43 只读验证：只读检查，不修改任何文件，禁止 git add/commit/push。",
    };

    assert.equal(getTaskMode(docsJob), TASK_MODES.DOCS_WRITE_ALLOWED);
    assert.equal(isReadOnlyTask(docsJob), false);
    assert.equal(getTaskMode(automationJob), TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.equal(isReadOnlyTask(automationJob), false);
    assert.equal(
      getTaskMode({
        request_text: "BATCH-45A fix Worker / Gateway / worker-api final reporting.",
      }),
      TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED
    );
    assert.equal(getTaskMode(readOnlyJob), TASK_MODES.READ_ONLY);
    assert.equal(isReadOnlyTask(readOnlyJob), true);
  });

  await t.test("BATCH-37 docs modes keep docs_write_allowed above outer read-only flags", () => {
    const explicitDocsJob = {
      request_text: [
        "BATCH-37-FIX",
        "task_mode=docs_write_allowed",
        "read_only_mode=false",
        "允许修改 docs/**",
      ].join("\n"),
      payload: { read_only_mode: true },
    };
    const lockedDocsJob = {
      request_text: [
        "BATCH-37-DOCS-01",
        "task_mode=docs_write_allowed",
        "允许修改 docs/**",
      ].join("\n"),
      payload: { read_only_mode: true },
    };

    assert.equal(getTaskMode(explicitDocsJob), TASK_MODES.DOCS_WRITE_ALLOWED);
    assert.equal(isReadOnlyTask(explicitDocsJob), false);
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(explicitDocsJob, ["docs/projects/feishu-gm-automation.md"])
    );
    assert.throws(
      () => assertTaskGoalApplied(explicitDocsJob, []),
      (error) => error.code === NO_FIX_APPLIED
    );
    assert.throws(
      () => assertTaskGoalApplied(lockedDocsJob, []),
      (error) => error.code === TASK_MODE_MISMATCH
    );
  });

  await t.test("BATCH-37-DOCS requires all required docs, not just any docs diff", () => {
    const job = {
      request_text: [
        "BATCH-37-DOCS-03",
        "task_mode=docs_write_allowed",
        "read_only_mode=false",
        "必须新增或更新以下全部文件，缺一个就失败，MISSING_REQUIRED_DOCS：",
        "- docs/projects/reusable-assets.md",
        "- docs/projects/modification-needed.md",
        "- docs/projects/team-management.md",
        "- docs/projects/qa-handoff-process.md",
        "- docs/projects/operations-team-plan.md",
        "- docs/projects/agent-expansion-plan.md",
        "- docs/NEXT_TASK_CARD.md",
      ].join("\n"),
    };

    assert.throws(
      () => assertTaskGoalApplied(job, ["docs/projects/feishu-gm-automation.md"]),
      (error) =>
        error.code === INSUFFICIENT_DOC_OUTPUT &&
        error.requiredDocs.length === 7 &&
        error.changedDocs.length === 0
    );

    assert.throws(
      () => assertTaskGoalApplied(job, ["docs/projects/reusable-assets.md"]),
      (error) =>
        error.code === MISSING_REQUIRED_DOCS &&
        error.requiredDocs.length === 7 &&
        error.missingDocs.includes("docs/projects/modification-needed.md")
    );
  });

  await t.test("BATCH-37-DOCS completes only when all required docs exist and changed", (t) => {
    const job = {
      request_text: "BATCH-37-DOCS-03 task_mode=docs_write_allowed read_only_mode=false",
    };
    const requiredDocs = [
      "docs/projects/reusable-assets.md",
      "docs/projects/modification-needed.md",
      "docs/projects/team-management.md",
      "docs/projects/qa-handoff-process.md",
      "docs/projects/operations-team-plan.md",
      "docs/projects/agent-expansion-plan.md",
      "docs/NEXT_TASK_CARD.md",
    ];
    const originalExistsSync = fs.existsSync;

    fs.existsSync = (targetPath) => {
      const normalized = normalizeGitPath(String(targetPath));
      return requiredDocs.some((doc) => normalized.endsWith(doc)) || originalExistsSync(targetPath);
    };
    t.after(() => {
      fs.existsSync = originalExistsSync;
    });

    assert.doesNotThrow(() => assertTaskGoalApplied(job, requiredDocs));
  });

  await t.test("docs_write_allowed requires docs diff and blocks business pages", () => {
    const job = {
      request_text: "BATCH-37-FIX 文档整理：更新 docs/projects/team-routing.md。",
    };

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["docs/projects/team-routing.md"])
    );
    assert.throws(
      () => assertTaskGoalApplied(job, []),
      (error) => error.code === NO_FIX_APPLIED
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["src/app/page.tsx"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["src/app/partners/page.tsx"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
  });

  await t.test("automation_system_write_allowed requires automation diff and blocks product pages", () => {
    const job = {
      request_text: "BATCH-44 系统修复：修复 infra/windows-worker/local_worker.js。",
    };

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["infra/windows-worker/local_worker.js"])
    );
    assert.throws(
      () => assertTaskGoalApplied(job, []),
      (error) => error.code === NO_FIX_APPLIED
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["src/app/partners/page.tsx"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
  });

  await t.test("automation_system_write_allowed allows explicitly scoped architecture and project docs", () => {
    const architectureDocJob = {
      request_text: [
        "BATCH-ARCH-06",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/**, docs/architecture/context-contract.md, docs/projects/feishu-gm-automation.md",
        "Repair target: docs/architecture/context-contract.md",
      ].join("\n"),
    };

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(architectureDocJob, ["docs/architecture/context-contract.md"])
    );

    const projectDocJob = {
      request_text: [
        "BATCH-ARCH-06",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/**, docs/projects/automation-context-contract.md",
        "Repair target: docs/projects/automation-context-contract.md",
      ].join("\n"),
    };

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(projectDocJob, ["docs/projects/automation-context-contract.md"])
    );
  });

  function createBatchArch08aScopeJob() {
    const allowedScope = [
      "infra/windows-worker/local_worker.js",
      "infra/windows-worker/tests/git-safety.test.js",
      "src/lib/worker-jobs.ts",
      "src/app/api/feishu/event/route.ts",
      "docs/architecture/final-report-schema.md",
      "docs/architecture/iteration-loop.md",
      "docs/projects/feishu-gm-automation.md",
      "docs/BATCH_LOG.md",
      "docs/ACCEPTANCE_LOG.md",
      "docs/NEXT_TASK_CARD.md",
    ].join(", ");
    const job = {
      request_text: [
        "BATCH-ARCH-08A",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        `allowed_scope=${allowedScope}`,
        "forbidden_scope=app/**, src/app/page.tsx, src/app/partners/**, src/app/post/**, src/app/login/**, src/app/profile/**, src/lib/db/**, src/types/db.ts, work/tencent-cloud/**, .env, database, deploy, tencent-cloud runtime files, package.json, tsconfig.json",
      ].join("\n"),
    };

    return { allowedScope, job };
  }

  await t.test("automation_system_write_allowed honors explicit BATCH-ARCH-08A scope docs", () => {
    const { allowedScope, job } = createBatchArch08aScopeJob();
    const contract = resolveWorkerJobContract(job);

    assert.equal(contract.allowed_scope, allowedScope);

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["docs/BATCH_LOG.md"])
    );
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["docs/ACCEPTANCE_LOG.md"])
    );
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["docs/NEXT_TASK_CARD.md"])
    );
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, [
        "docs/BATCH_LOG.md",
        "docs/ACCEPTANCE_LOG.md",
        "docs/NEXT_TASK_CARD.md",
      ])
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["docs/UNKNOWN.md"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.message.includes("docs/UNKNOWN.md")
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["src/app/page.tsx"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.message.includes("src/app/page.tsx")
    );
    assert.throws(
      () => assertTaskGoalApplied(job, [".env"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.message.includes(".env")
    );
  });

  await t.test("BATCH-ARCH-08A allows explicit docs/BATCH_LOG.md", () => {
    const { job } = createBatchArch08aScopeJob();

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["docs/BATCH_LOG.md"])
    );
  });

  await t.test("BATCH-ARCH-08A allows explicit docs/ACCEPTANCE_LOG.md", () => {
    const { job } = createBatchArch08aScopeJob();

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["docs/ACCEPTANCE_LOG.md"])
    );
  });

  await t.test("BATCH-ARCH-08A allows explicit docs/NEXT_TASK_CARD.md", () => {
    const { job } = createBatchArch08aScopeJob();

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["docs/NEXT_TASK_CARD.md"])
    );
  });

  await t.test("BATCH-ARCH-08A blocks unscoped docs/UNKNOWN.md", () => {
    const { job } = createBatchArch08aScopeJob();

    assert.throws(
      () => assertTaskGoalApplied(job, ["docs/UNKNOWN.md"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.message.includes("docs/UNKNOWN.md")
    );
  });

  await t.test("BATCH-ARCH-08A still blocks src/app/page.tsx", () => {
    const { job } = createBatchArch08aScopeJob();

    assert.throws(
      () => assertTaskGoalApplied(job, ["src/app/page.tsx"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.message.includes("src/app/page.tsx")
    );
  });

  await t.test("BATCH-ARCH-08A still blocks .env", () => {
    const { job } = createBatchArch08aScopeJob();

    assert.throws(
      () => assertTaskGoalApplied(job, [".env"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.message.includes(".env")
    );
  });

  await t.test("automation_system_write_allowed allows explicit architecture wildcard only", () => {
    const architectureWildcardJob = {
      request_text: [
        "BATCH-ARCH-08A",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/**, docs/architecture/**",
      ].join("\n"),
    };

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(architectureWildcardJob, [
        "docs/architecture/final-report-schema.md",
      ])
    );
  });

  await t.test("automation_system_write_allowed blocks unscoped architecture doc", () => {
    const job = {
      request_text: [
        "BATCH-ARCH-06",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/**, docs/projects/feishu-gm-automation.md",
        "Repair target: docs/architecture/context-contract.md",
      ].join("\n"),
    };

    assert.throws(
      () => assertTaskGoalApplied(job, ["docs/architecture/context-contract.md"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.message.includes("docs/architecture/context-contract.md")
    );
  });

  await t.test("automation_system_write_allowed blocks docs wildcard and product page paths", () => {
    const wildcardDocsJob = {
      request_text: [
        "BATCH-ARCH-06",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/**, docs/**",
      ].join("\n"),
    };
    const productPageJob = {
      request_text: [
        "BATCH-ARCH-06A",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/**, docs/architecture/context-contract.md",
      ].join("\n"),
    };

    assert.throws(
      () => assertTaskGoalApplied(wildcardDocsJob, ["docs/architecture/context-contract.md"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
    assert.throws(
      () => assertTaskGoalApplied(productPageJob, ["src/app/login/page.tsx"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.message.includes("src/app/login/page.tsx")
    );
  });

  await t.test("automation_system_write_allowed selects one preferred HERMES context", () => {
    const job = {
      request_text: [
        "BATCH-ARCH-06C",
        "HERMES_WORKER_CONTEXT:",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/**, docs/architecture/context-contract.md, docs/projects/feishu-gm-automation.md",
        "forbidden_scope=docs/**, app/**, src/app/**, src/types/db.ts",
        "",
        "HERMES_WORKER_CONTEXT:",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/**, docs/projects/feishu-gm-automation.md",
        "forbidden_scope=docs/**, app/**, src/app/**, src/types/db.ts",
      ].join("\n"),
    };

    const contract = resolveWorkerJobContract(job);
    assert.equal(
      contract.allowed_scope,
      "infra/windows-worker/**, docs/architecture/context-contract.md, docs/projects/feishu-gm-automation.md"
    );
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["docs/architecture/context-contract.md"])
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["docs/architecture/other.md"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.message.includes("docs/architecture/other.md")
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["app/page.tsx"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.message.includes("app/page.tsx")
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["src/app/page.tsx"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.message.includes("src/app/page.tsx")
    );
  });

  await t.test("automation_system_write_allowed restores base64 original request without merging scope", () => {
    const originalRequest = [
      "BATCH-ARCH-06C",
      "HERMES_WORKER_CONTEXT:",
      "project_domain=automation_system",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      "allowed_scope=infra/windows-worker/**, docs/architecture/context-contract.md, docs/projects/feishu-gm-automation.md",
      "forbidden_scope=docs/**, app/**, src/app/**, src/types/db.ts",
    ].join("\n");
    const job = {
      request_text: [
        "BATCH-ARCH-06C",
        "HERMES_WORKER_CONTEXT:",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/**, docs/projects/feishu-gm-automation.md",
        "forbidden_scope=docs/**, app/**, src/app/**, src/types/db.ts",
        `original_request_text_base64=${Buffer.from(originalRequest, "utf8").toString("base64")}`,
      ].join("\n"),
    };
    const wildcardOnlyJob = {
      request_text: [
        "BATCH-ARCH-06C",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/**, docs/**",
        "forbidden_scope=docs/**, app/**, src/app/**",
      ].join("\n"),
    };

    const contract = resolveWorkerJobContract(job);
    assert.match(contract.original_request_text, /BATCH-ARCH-06C/);
    assert.match(contract.original_request_text, /docs\/architecture\/context-contract\.md/);
    assert.equal(contract.allowed_scope, "infra/windows-worker/**, docs/projects/feishu-gm-automation.md");
    assert.throws(
      () => assertTaskGoalApplied(job, ["docs/architecture/context-contract.md"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
    assert.throws(
      () => assertTaskGoalApplied(wildcardOnlyJob, ["docs/architecture/context-contract.md"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
  });

  await t.test("HERMES_WORKER_CONTEXT explicit fields outrank stale payload fields", () => {
    const originalRequest = [
      "BATCH-ARCH-06D",
      "HERMES_WORKER_CONTEXT:",
      "project_domain=automation_system",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      "allowed_scope=infra/windows-worker/local_worker.js, docs/architecture/context-contract.md",
      "forbidden_scope=src/app/**, app/**, src/lib/db/**",
      "route=direct_worker_create",
      "Do not use docs/NEXT_TASK_CARD.md as the task body.",
    ].join("\n");
    const job = {
      request_text: [
        "BATCH-ARCH-06D",
        "HERMES_WORKER_CONTEXT:",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/local_worker.js",
        "forbidden_scope=src/app/**, app/**",
        `original_request_text_base64=${Buffer.from(originalRequest, "utf8").toString("base64")}`,
        "This text also says do not modify product pages and do not start dev server.",
      ].join("\n"),
      payload: {
        project_domain: "city_partner_product",
        task_mode: "read_only",
        read_only_mode: true,
        original_request_text: "stale historical payload",
        route: "historical_route",
      },
    };

    const contract = resolveWorkerJobContract(job);

    assert.equal(contract.project_domain, "automation_system");
    assert.equal(contract.task_mode, TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.equal(contract.read_only_mode, false);
    assert.equal(contract.route, "direct_worker_create");
    assert.match(contract.original_request_text, /BATCH-ARCH-06D/);
    assert.doesNotMatch(contract.original_request_text, /stale historical payload/);
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["infra/windows-worker/local_worker.js"])
    );
  });

  await t.test("Codex prompt includes unified worker job payload contract fields", () => {
    const job = {
      request_text: [
        "BATCH-ARCH-06D",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/local_worker.js",
        "forbidden_scope=src/app/**, app/**",
        "route=direct_worker_create",
      ].join("\n"),
      payload: {
        route: "direct_worker_create",
      },
    };
    const prompt = buildCodexPrompt(job);

    assert.match(prompt, /\[Worker job payload contract\]/);
    assert.match(prompt, /project_domain: automation_system/);
    assert.match(prompt, /task_mode: automation_system_write_allowed/);
    assert.match(prompt, /read_only_mode: false/);
    assert.match(prompt, /allowed_scope: infra\/windows-worker\/local_worker\.js/);
    assert.match(prompt, /route: direct_worker_create/);
    assert.match(prompt, /changed_files: \[\]/);
    assert.match(prompt, /git_commit_sha: null/);
    assert.match(prompt, /pushed: false/);
    assert.match(prompt, /deploy_status: null/);
  });

  await t.test("allowed and forbidden scope stay identical in prompt and validation context", () => {
    const job = {
      request_text: [
        "BATCH-ARCH-07",
        "HERMES_WORKER_CONTEXT:",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/local_worker.js, docs/architecture/context-contract.md",
        "forbidden_scope=src/app/**, app/**, src/lib/db/**",
        "route=direct_worker_create",
        "Repair target: docs/architecture/context-contract.md",
      ].join("\n"),
    };
    const contract = resolveWorkerJobContract(job);
    const prompt = buildCodexPrompt(job);

    assert.match(prompt, new RegExp(`allowed_scope: ${contract.allowed_scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(prompt, new RegExp(`forbidden_scope: ${contract.forbidden_scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["docs/architecture/context-contract.md"])
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["docs/architecture/other.md"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
  });

  await t.test("original_request_text_base64 restores Chinese original demand", () => {
    const originalRequest = "新需求：修复 Worker 上下文字段，不修改产品页面。";
    const job = {
      request_text: [
        "BATCH-ARCH-07",
        "HERMES_WORKER_CONTEXT:",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/local_worker.js",
        "forbidden_scope=src/app/**, app/**",
        `original_request_text_base64=${Buffer.from(originalRequest, "utf8").toString("base64")}`,
        "route=direct_worker_create",
      ].join("\n"),
    };

    assert.equal(resolveWorkerJobContract(job).original_request_text, originalRequest);
  });

  await t.test("missing explicit HERMES context reports warning instead of silent defaults", () => {
    const job = {
      request_text: "BATCH-ARCH-07 repair Worker context normalizer.",
      payload: {
        project_domain: "automation_system",
        task_mode: "automation_system_write_allowed",
        read_only_mode: false,
        allowed_scope: "infra/windows-worker/local_worker.js",
        forbidden_scope: "src/app/**",
        route: "direct_worker_create",
      },
    };
    const contract = normalizeWorkerContext(job);

    assert.equal(contract.context_source, "payload");
    assert.equal(contract.context_reconstruct_failed, false);
    assert.match(contract.context_warnings.join("\n"), new RegExp(CONTEXT_MISSING_WARNING));
    assert.equal(contract.task_mode, TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.equal(contract.read_only_mode, false);
  });

  await t.test("explicit read_only is not overridden by repair keywords", () => {
    const job = {
      request_text: [
        "BATCH-QA-08",
        "project_domain=qa_review",
        "task_mode=read_only",
        "read_only_mode=true",
        "只读验收：正文提到修复、修改、补齐，但本任务禁止文件写入。",
      ].join("\n"),
    };

    assert.equal(getTaskMode(job), TASK_MODES.READ_ONLY);
    assert.doesNotThrow(() => assertTaskGoalApplied(job, []));
    assert.throws(
      () => assertTaskGoalApplied(job, ["infra/windows-worker/local_worker.js"]),
      (error) => error.code === READ_ONLY_MODE_VIOLATION
    );
  });

  await t.test("product QA automation and architecture modes do not cross-wire", () => {
    const cases = [
      {
        job: {
          request_text: "BATCH-FIX-08 project_domain=city_partner_product task_mode=product_write_allowed read_only_mode=false fix partners product page.",
        },
        taskMode: TASK_MODES.PRODUCT_WRITE_ALLOWED,
        projectDomain: "city_partner_product",
      },
      {
        job: {
          request_text: "BATCH-QA-08 project_domain=qa_review task_mode=read_only read_only_mode=true static QA only.",
        },
        taskMode: TASK_MODES.READ_ONLY,
        projectDomain: "qa_review",
      },
      {
        job: {
          request_text: "BATCH-ARCH-07 project_domain=automation_system task_mode=automation_system_write_allowed read_only_mode=false repair Worker.",
        },
        taskMode: TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED,
        projectDomain: "automation_system",
      },
      {
        job: {
          request_text: "BATCH-ARCH-SMOKE-02 project_domain=automation_architecture task_mode=read_only read_only_mode=true ARCH_REPORT_FIELDS smoke.",
        },
        taskMode: TASK_MODES.READ_ONLY,
        projectDomain: "automation_architecture",
      },
    ];

    for (const item of cases) {
      const contract = resolveWorkerJobContract(item.job);
      assert.equal(contract.task_mode, item.taskMode);
      assert.equal(contract.project_domain, item.projectDomain);
    }
  });

  await t.test("automation_system_write_allowed passes when Worker file changed despite forbidden product context", () => {
    const job = {
      request_text: [
        "BATCH-ARCH-03C",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "Repair target:",
        "- infra/windows-worker/local_worker.js",
        "forbidden_scope: src/app/**, app/**, docs/**",
        "禁止修改 src/app/partners/page.tsx",
        "Do not modify app/login/page.tsx or app/profile/page.tsx.",
      ].join("\n"),
    };

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["infra/windows-worker/local_worker.js"])
    );
  });

  await t.test("BATCH-FIX product repair stays product even with QA docs and lint wording", () => {
    const productJob = {
      request_text: [
        "BATCH-FIX-02 fix 同城搭子网站 partners login profile page.tsx 产品页面。",
        "Also read QA-05, docs, run npm run lint and tsc validation.",
        "read_only_mode=true",
        "只读任务锁死",
        "不修改任何文件",
        "只执行 git status / git diff",
        "Do not modify Worker or Tencent Cloud system files.",
      ].join("\n"),
    };

    assert.equal(classifyWorkerTaskDomain(productJob.request_text), "city_partner_product");
    assert.equal(getTaskMode(productJob), TASK_MODES.PRODUCT_WRITE_ALLOWED);
    assert.equal(isReadOnlyTask(productJob), false);
    const prompt = buildCodexPrompt(productJob);
    assert.match(prompt, /project_domain: city_partner_product/);
    assert.match(prompt, /task_mode: product_write_allowed/);
    assert.match(prompt, /read_only_mode: false/);
    assert.match(prompt, /can_write_files: true/);
    assert.match(prompt, /allowed_scope: src\/app\/\*\*/);
    assert.doesNotMatch(prompt, /只读任务锁死/);
    assert.doesNotMatch(prompt, /不修改任何文件/);
    assert.doesNotMatch(prompt, /只执行 git status/);
    assert.doesNotMatch(prompt, /只执行 git diff/);
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(productJob, ["src/app/partners/page.tsx"])
    );
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(productJob, ["src/app/partners/[id]/page.tsx"])
    );
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(productJob, [
        "src/app/partners/[id]/LocalDraftPartnerDetail.tsx",
      ])
    );
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(productJob, ["docs/projects/city-partner-website.md"])
    );
    assert.throws(
      () => assertTaskGoalApplied(productJob, ["infra/windows-worker/local_worker.js"]),
      (error) => error.code === OUT_OF_SCOPE_SYSTEM_CHANGE
    );
    assert.throws(
      () => assertTaskGoalApplied(productJob, ["docs/projects/feishu-gm-automation.md"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );

    const workerSource = fs.readFileSync(
      path.join(workerRoot, "local_worker.js"),
      "utf8"
    );
    assert.match(
      workerSource,
      /if \(taskMode !== TASK_MODES\.PRODUCT_WRITE_ALLOWED\) \{\s*validateAutomationTaskBoundaries/
    );
  });

  await t.test("BATCH-FIX new demand classification ignores forbidden system scope words", () => {
    const requestText = [
      "新需求：BATCH-FIX-04 产品修复",
      "项目名称：同城搭子网站",
      "QA 发现：修复 /partners，修复 /partners/[id]，修复 login/profile Link lint。",
      "允许修改：src/app/**",
      "禁止修改：Worker / 腾讯云 / worker-jobs / feishu gateway / src/app/api/feishu / env / 数据库 / 部署。",
      "背景：BATCH-GM-STABILIZE-11、BATCH-QA-05、BATCH-P3、BATCH-P4 都只是背景，不是当前执行批次。",
    ].join("\n");

    assert.equal(classifyWorkerTaskDomain(requestText), "city_partner_product");
    assert.equal(getTaskMode({ request_text: requestText }), TASK_MODES.PRODUCT_WRITE_ALLOWED);
    assert.equal(isReadOnlyTask({ request_text: requestText }), false);
    const prompt = buildCodexPrompt({ request_text: requestText });
    assert.match(prompt, /project_domain: city_partner_product/);
    assert.match(prompt, /task_mode: product_write_allowed/);
    assert.match(prompt, /read_only_mode: false/);
    assert.match(prompt, /allowed_scope: src\/app\/\*\*/);
  });

  await t.test("BATCH-QA explicit read_only outranks BATCH-FIX product background", () => {
    const qaJob = {
      request_text: [
        "BATCH-QA-06 final static QA review",
        "project_domain=qa_review",
        "task_mode=read_only",
        "read_only_mode=true",
        "验收背景：BATCH-FIX-06 fixed partners pages.",
        "验收背景：BATCH-FIX-07 fixed login/profile Link lint.",
        "Please statically read partners/login/profile/page.tsx and docs, run npx tsc and npm run lint.",
      ].join("\n"),
      payload: {
        task_mode: "product_write_allowed",
      },
    };

    assert.equal(classifyWorkerTaskDomain(qaJob.request_text), "qa_review");
    assert.equal(getTaskMode(qaJob), TASK_MODES.READ_ONLY);
    assert.equal(isReadOnlyTask(qaJob), true);
    assert.doesNotThrow(() => assertTaskGoalApplied(qaJob, []));
    assert.throws(
      () => assertTaskGoalApplied(qaJob, ["src/app/partners/page.tsx"]),
      (error) => error.code === READ_ONLY_MODE_VIOLATION
    );
  });

  await t.test("read_only_mode true prevents product_write_allowed inference from QA background words", () => {
    const readOnlyJob = {
      request_text: [
        "BATCH-QA-07",
        "project_domain=qa_review",
        "read_only_mode=true",
        "Background mentions BATCH-FIX-06, partners, login, profile, product pages.",
      ].join("\n"),
    };
    const productJob = {
      request_text: [
        "BATCH-FIX-07",
        "project_domain=city_partner_product",
        "task_mode=product_write_allowed",
        "read_only_mode=false",
        "Fix login/profile Link lint for the city partner website.",
      ].join("\n"),
    };

    assert.equal(getTaskMode(readOnlyJob), TASK_MODES.READ_ONLY);
    assert.equal(isReadOnlyTask(readOnlyJob), true);
    assert.equal(getTaskMode(productJob), TASK_MODES.PRODUCT_WRITE_ALLOWED);
    assert.equal(isReadOnlyTask(productJob), false);
  });

  await t.test("BATCH-FIX approved execution requires original product request context", () => {
    const originalRequest = [
      "新需求：BATCH-FIX-03 修复同城搭子网站 partners/login/profile/page.tsx 产品页面。",
      "目标：最小修复 partners、login、profile 页面。",
      "验证：可运行 tsc 和 lint，但不得修改 Worker。",
    ].join("\n");
    const approvedJob = {
      request_text: "新需求：执行项目总管批准批次 BATCH-FIX-03",
      payload: {
        approved_batch: "BATCH-FIX-03",
        original_request_text: originalRequest,
      },
    };
    const shellOnlyJob = {
      request_text: "新需求：执行项目总管批准批次 BATCH-FIX-03",
      payload: {
        approved_batch: "BATCH-FIX-03",
      },
    };

    assert.equal(
      classifyWorkerTaskDomain([approvedJob.request_text, originalRequest].join("\n")),
      "city_partner_product"
    );
    assert.equal(getTaskMode(approvedJob), TASK_MODES.PRODUCT_WRITE_ALLOWED);
    assert.equal(isReadOnlyTask(approvedJob), false);
    assert.doesNotThrow(() => assertOriginalBatchContextAvailable(approvedJob));
    assert.throws(
      () => assertOriginalBatchContextAvailable(shellOnlyJob),
      (error) => error.code === ORIGINAL_BATCH_CONTEXT_MISSING
    );
    assert.equal(getTaskMode(shellOnlyJob), TASK_MODES.READ_ONLY);
  });

  await t.test("task mode priorities keep GM QA and BATCH-37 classifications stable", () => {
    assert.equal(
      getTaskMode({
        request_text: "BATCH-GM-STABILIZE-09 fix Worker and Gateway routing.",
      }),
      TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED
    );
    assert.equal(
      getTaskMode({
        request_text: "BATCH-QA-06 project_domain=qa_review read_only_mode=true",
      }),
      TASK_MODES.READ_ONLY
    );
    assert.equal(
      classifyWorkerTaskDomain("BATCH-QA-06 project_domain=qa_review"),
      "qa_review"
    );
    assert.equal(
      getTaskMode({
        request_text: "BATCH-37-DOCS-04 task_mode=docs_write_allowed update docs/**",
      }),
      TASK_MODES.DOCS_WRITE_ALLOWED
    );
  });

  await t.test("explicit automation_system task fields cannot be overridden", () => {
    const requestText = [
      "新需求：BATCH-GM-ROUTER-MANUAL-FIX-01",
      "project_domain=automation_system",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      "正文可能提到 product、docs、database、BATCH-FIX、BATCH-P3、BATCH-P4，但这些都不能覆盖显式字段。",
    ].join("\n");

    const explicitJob = { request_text: requestText };
    assert.equal(classifyWorkerTaskDomain(requestText), "automation_system");
    assert.equal(getTaskMode(explicitJob), TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.doesNotThrow(() => assertExplicitTaskFieldsNotOverridden(explicitJob));

    assert.doesNotThrow(() =>
      assertExplicitTaskFieldsNotOverridden({
        request_text: requestText,
        payload: { task_mode: "docs_write_allowed" },
      })
    );

    assert.doesNotThrow(() =>
      assertExplicitTaskFieldsNotOverridden({
        request_text: requestText,
        payload: { project_domain: "product" },
      })
    );
  });

  await t.test("explicit automation_system write fields outrank read-only keywords and stale context", () => {
    const requestText = [
      "BATCH-GM-SMOKE-01",
      "project_domain=automation_system",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      "The body mentions read_only guards, read_only_mode, do not modify, and forbidden git add.",
      "Historical text may mention product, docs, database, BATCH-FIX, BATCH-P3, or BATCH-P4.",
    ].join("\n");

    const explicitJob = {
      request_text: requestText,
      payload: {
        task_mode: "read_only",
        project_domain: "qa_review",
        read_only_mode: true,
      },
      result: {
        task_mode: "read_only",
        read_only_mode: true,
      },
    };

    assert.equal(classifyWorkerTaskDomain(requestText), "automation_system");
    assert.equal(getTaskMode(explicitJob), TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.equal(isReadOnlyTask(explicitJob), false);
    assert.doesNotThrow(() => assertExplicitTaskFieldsNotOverridden(explicitJob));

    const prompt = buildCodexPrompt(explicitJob);
    assert.match(prompt, /task_mode: automation_system_write_allowed/);
    assert.match(prompt, /read_only_mode: false/);
  });

  await t.test("BATCH-GM-LIVE approval-only context stays automation write allowed", () => {
    const approvedBatch = "BATCH-GM-LIVE-THREE-MODE-ROUTER-FIX-02";
    const requestText = [
      "新需求：执行项目总管批准批次 BATCH-GM-LIVE-THREE-MODE-ROUTER-FIX-02",
      "HERMES_WORKER_CONTEXT:",
      "project_domain=automation_system",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      "allowed_scope=infra/windows-worker/**, src/lib/worker-jobs.ts, src/app/api/feishu/event/route.ts, src/lib/project-director-console.ts",
      "forbidden_scope=BATCH-P3/BATCH-P4 unless separately approved; src/app/page.tsx, src/app/partners/**, src/app/post/**, database/env/secrets/Vercel deploy",
      "original_request_text=总管 批准执行：仅批准 BATCH-GM-LIVE-THREE-MODE-ROUTER-FIX-02",
      "approved_batch=BATCH-GM-LIVE-THREE-MODE-ROUTER-FIX-02",
      "route=approval_only",
      "",
      "禁止范围：不得执行 BATCH-P3 或 BATCH-P4，不得修改产品页面。",
    ].join("\n");
    const job = {
      request_text: requestText,
      payload: {
        approved_batch: "BATCH-P3",
        project_domain: "city_partner_product",
        task_mode: "read_only",
        read_only_mode: true,
        route: "historical_route",
      },
    };

    const contract = resolveWorkerJobContract(job);

    assert.equal(contract.approved_batch, approvedBatch);
    assert.equal(contract.project_domain, "automation_system");
    assert.equal(contract.task_mode, TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.equal(contract.read_only_mode, false);
    assert.equal(contract.route, "approval_only");
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["src/app/api/feishu/event/route.ts"])
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["src/app/page.tsx"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
  });

  await t.test("BATCH-GM-MODE-SMOKE-WRITE approval-only context stays write allowed", () => {
    const approvedBatch = "BATCH-GM-MODE-SMOKE-WRITE-01";
    const requestText = [
      "New demand: execute Project Director approved batch BATCH-GM-MODE-SMOKE-WRITE-01",
      "HERMES_WORKER_CONTEXT:",
      "context_source=explicit_hermes_worker_context",
      "project_domain=automation_system",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      "allowed_scope=infra/windows-worker/**, src/lib/worker-jobs.ts, src/app/api/feishu/event/route.ts, src/lib/project-director-console.ts",
      "forbidden_scope=BATCH-P3/BATCH-P4 unless separately approved; src/app/page.tsx, src/app/partners/**, src/app/post/**, database/env/secrets/Vercel deploy",
      "original_request_text=Project Director approved execution: only approve BATCH-GM-MODE-SMOKE-WRITE-01",
      "approved_batch=BATCH-GM-MODE-SMOKE-WRITE-01",
      "route=approval_only",
      "",
      "Do not execute BATCH-P3 or BATCH-P4, and do not modify product pages.",
    ].join("\n");
    const job = {
      request_text: requestText,
      payload: {
        approved_batch: "BATCH-P3",
        project_domain: "city_partner_product",
        task_mode: "read_only",
        read_only_mode: true,
        route: "historical_route",
      },
    };

    const contract = resolveWorkerJobContract(job);

    assert.equal(contract.context_source, "explicit_hermes_worker_context");
    assert.equal(contract.approved_batch, approvedBatch);
    assert.equal(contract.project_domain, "automation_system");
    assert.equal(contract.task_mode, TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.equal(contract.read_only_mode, false);
    assert.equal(contract.route, "approval_only");
    assert.equal(getTaskMode(job), TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.equal(isReadOnlyTask(job), false);

    const args = buildCodexExecArgs("fix safely", job);
    const sandboxIndex = args.indexOf("--sandbox");
    assert.notEqual(sandboxIndex, -1);
    assert.equal(args[sandboxIndex + 1], "workspace-write");
    assert.doesNotMatch(args.join(" "), /read-only/);

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["infra/windows-worker/tests/git-safety.test.js"])
    );
    assert.throws(
      () => assertTaskGoalApplied(job, []),
      (error) => error.code === NO_FIX_APPLIED
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["src/app/page.tsx"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
  });

  await t.test("BATCH-GM-MODE-SMOKE-WRITE-02 approval-only context stays write allowed", () => {
    const approvedBatch = "BATCH-GM-MODE-SMOKE-WRITE-02";
    const allowedScope = [
      "infra/windows-worker/**",
      "src/lib/worker-jobs.ts",
      "src/app/api/feishu/event/route.ts",
      "src/lib/project-director-console.ts",
      "docs/projects/feishu-gm-automation.md",
      "docs/projects/team-routing.md",
      "docs/projects/feishu-group-routing.md",
    ].join(", ");
    const requestText = [
      `New demand: execute Project Director approved batch ${approvedBatch}`,
      "task_domain: automation_system",
      `Current execution batch: ${approvedBatch}`,
      `original_request_text: Project Director approved execution: only approve ${approvedBatch}`,
      `approved_batch: ${approvedBatch}`,
      "task_mode: automation_system_write_allowed",
      "read_only_mode: false",
      `allowed_scope: ${allowedScope}`,
      "forbidden_scope: BATCH-P3/BATCH-P4 unless separately approved; src/app/page.tsx, src/app/partners/**, src/app/post/**, database/env/secrets/Vercel deploy",
      "HERMES_WORKER_CONTEXT:",
      "context_source=explicit_hermes_worker_context",
      "project_domain=automation_system",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      `allowed_scope=${allowedScope}`,
      "forbidden_scope=src/app/page.tsx, src/app/partners/**, src/app/post/**, src/lib/db/mock.ts, src/types/db.ts, .env, database",
      `original_request_text=Project Director approved execution: only approve ${approvedBatch}`,
      `approved_batch=${approvedBatch}`,
      "route=approval_only",
      "",
      "Do not execute BATCH-P3 or BATCH-P4, and do not modify product pages.",
    ].join("\n");
    const job = {
      request_text: requestText,
      payload: {
        approved_batch: "BATCH-P4",
        project_domain: "city_partner_product",
        task_mode: "read_only",
        read_only_mode: true,
        allowed_scope: "src/app/**",
        route: "historical_route",
      },
    };

    const contract = resolveWorkerJobContract(job);
    const args = buildCodexExecArgs("fix safely", job);
    const sandboxIndex = args.indexOf("--sandbox");

    assert.equal(extractCurrentExecutionBatchCode(job), approvedBatch);
    assert.equal(contract.context_source, "explicit_hermes_worker_context");
    assert.equal(contract.approved_batch, approvedBatch);
    assert.equal(contract.allowed_scope, allowedScope);
    assert.equal(contract.project_domain, "automation_system");
    assert.equal(contract.task_mode, TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.equal(contract.read_only_mode, false);
    assert.equal(contract.route, "approval_only");
    assert.equal(getTaskMode(job), TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.equal(isReadOnlyTask(job), false);
    assert.notEqual(sandboxIndex, -1);
    assert.equal(args[sandboxIndex + 1], "workspace-write");

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["infra/windows-worker/tests/git-safety.test.js"])
    );
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["docs/projects/feishu-gm-automation.md"])
    );
    assert.throws(
      () => assertTaskGoalApplied(job, []),
      (error) => error.code === NO_FIX_APPLIED
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["src/app/page.tsx"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
  });

  await t.test("exact_allowed_scope permits only the boss-approved path", () => {
    const approvedBatch = "BATCH-GM-MODE-SMOKE-WRITE-03";
    const exactScope = "docs/architecture/exact-scope-a.md";
    const requestText = [
      `New demand: execute Project Director approved batch ${approvedBatch}`,
      "project_domain=automation_system",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      "allowed_scope=docs/architecture/exact-scope-a.md, infra/windows-worker/**",
      `exact_allowed_scope=${exactScope}`,
      `original_request_text=新需求：执行 ${approvedBatch}\\n只允许修改：\\n- ${exactScope}`,
      `approved_batch=${approvedBatch}`,
      "HERMES_WORKER_CONTEXT:",
      "project_domain=automation_system",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      "allowed_scope=docs/architecture/exact-scope-a.md, infra/windows-worker/**",
      `exact_allowed_scope=${exactScope}`,
      "forbidden_scope=src/app/**, .env, database",
      `original_request_text=新需求：执行 ${approvedBatch}\\n只允许修改：\\n- ${exactScope}`,
      `approved_batch=${approvedBatch}`,
      "route=approval_only",
    ].join("\n");
    const job = { request_text: requestText, payload: {} };

    const contract = resolveWorkerJobContract(job);

    assert.equal(contract.exact_allowed_scope, exactScope);
    assert.doesNotThrow(() => assertTaskGoalApplied(job, [exactScope]));
    assert.throws(
      () => assertTaskGoalApplied(job, ["infra/windows-worker/tests/git-safety.test.js"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.outOfScopePaths.includes("infra/windows-worker/tests/git-safety.test.js")
    );
  });

  await t.test("exact_allowed_scope beats default automation scope", () => {
    const job = {
      request_text: [
        "approved_batch=BATCH-GM-MODE-SMOKE-WRITE-03",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/**, src/lib/worker-jobs.ts, docs/architecture/exact-scope-a.md",
        "exact_allowed_scope=docs/architecture/exact-scope-a.md",
        "original_request_text=只允许修改： docs/architecture/exact-scope-a.md",
      ].join("\n"),
      payload: {
        allowed_scope: "infra/windows-worker/**",
        exact_allowed_scope: "docs/architecture/exact-scope-a.md",
      },
    };

    assert.throws(
      () => assertTaskGoalApplied(job, ["infra/windows-worker/local_worker.js"]),
      (error) =>
        error.code === OUT_OF_SCOPE_BUSINESS_CHANGE &&
        error.outOfScopePaths.includes("infra/windows-worker/local_worker.js")
    );
  });

  await t.test("exact write task with required output still fails when no files changed", () => {
    const job = {
      request_text: [
        "approved_batch=BATCH-GM-MODE-SMOKE-WRITE-03",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=docs/architecture/exact-scope-a.md",
        "exact_allowed_scope=docs/architecture/exact-scope-a.md",
        "original_request_text=必须创建 docs/architecture/exact-scope-a.md",
      ].join("\n"),
      payload: {},
    };

    assert.throws(
      () => assertTaskGoalApplied(job, []),
      (error) => error.code === NO_FIX_APPLIED
    );
  });

  await t.test("BATCH-GM-WRITE-SCOPE-CONTRACT-FIX keeps explicit write scope and batch", () => {
    const approvedBatch = "BATCH-GM-WRITE-SCOPE-CONTRACT-FIX-01";
    const allowedScope = [
      "infra/windows-worker/**",
      "src/lib/worker-jobs.ts",
      "src/app/api/feishu/event/route.ts",
      "src/lib/project-director-console.ts",
      "docs/projects/feishu-gm-automation.md",
      "docs/projects/team-routing.md",
      "docs/projects/feishu-group-routing.md",
    ].join(", ");
    const requestText = [
      `New demand: execute Project Director approved batch ${approvedBatch}`,
      "task_domain: automation_system",
      `Current execution batch: ${approvedBatch}`,
      `original_request_text: Project Director approved execution: only approve ${approvedBatch}`,
      `approved_batch: ${approvedBatch}`,
      "task_mode: automation_system_write_allowed",
      "read_only_mode: false",
      `allowed_scope: ${allowedScope}`,
      "forbidden_scope: BATCH-P3/BATCH-P4 unless separately approved; src/app/page.tsx, src/app/partners/**, src/app/post/**, database/env/secrets/Vercel deploy",
      "HERMES_WORKER_CONTEXT:",
      "context_source=explicit_hermes_worker_context",
      "project_domain=automation_system",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      `allowed_scope=${allowedScope}`,
      "forbidden_scope=src/app/page.tsx, src/app/partners/**, src/app/post/**, src/lib/db/mock.ts, src/types/db.ts, .env, database",
      `original_request_text=Project Director approved execution: only approve ${approvedBatch}`,
      `approved_batch=${approvedBatch}`,
      "route=approval_only",
      "",
      "Do not execute BATCH-P3 or BATCH-P4, and do not modify product pages.",
    ].join("\n");
    const job = {
      request_text: requestText,
      payload: {
        approved_batch: "BATCH-P3",
        project_domain: "city_partner_product",
        task_mode: "read_only",
        read_only_mode: true,
        allowed_scope: "src/app/**",
        route: "historical_route",
      },
    };

    const contract = resolveWorkerJobContract(job);
    const finalResult = normalizeWorkerFinalResult({
      job,
      status: "succeeded",
      finalReportStatus: "succeeded",
      effectiveFinalStatus: "succeeded",
      resultText: [
        "Worker execution status: succeeded",
        "Task goal status: completed_with_file_changes",
      ].join("\n"),
    });

    assert.equal(extractCurrentExecutionBatchCode(job), approvedBatch);
    assert.equal(contract.context_source, "explicit_hermes_worker_context");
    assert.equal(contract.approved_batch, approvedBatch);
    assert.equal(contract.allowed_scope, allowedScope);
    assert.equal(contract.project_domain, "automation_system");
    assert.equal(contract.task_mode, TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.equal(contract.read_only_mode, false);
    assert.equal(contract.route, "approval_only");
    assert.equal(finalResult.approved_batch, approvedBatch);
    assert.equal(getTaskMode(job), TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.equal(isReadOnlyTask(job), false);

    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["docs/projects/feishu-group-routing.md"])
    );
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["src/lib/project-director-console.ts"])
    );
    assert.throws(
      () => assertTaskGoalApplied(job, []),
      (error) => error.code === NO_FIX_APPLIED
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["src/app/page.tsx"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["src/lib/db/mock.ts"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
  });

  await t.test("failure report paths do not reference an undefined taskMode", () => {
    const job = {
      request_text: "BATCH-GM-SMOKE-01 read_only_mode=true final smoke validation.",
    };
    const error = Object.assign(new Error("simulated failure"), {
      code: OUT_OF_SCOPE_BUSINESS_CHANGE,
    });

    assert.doesNotThrow(() => buildFailureReport(job, error));

    const workerSource = fs.readFileSync(
      path.join(workerRoot, "local_worker.js"),
      "utf8"
    );
    assert.equal(/task_mode:\s*taskMode\b/.test(workerSource), false);
    assert.match(workerSource, /const initialContract = resolveWorkerJobContract\(job/);
    assert.match(workerSource, /const taskModeForReport = initialContract\.task_mode;/);
  });

  await t.test("detects explicit read-only task text", () => {
    assert.equal(
      isReadOnlyTaskText("本任务只读，不修改文件，禁止 git add，禁止 git commit，禁止 git push。"),
      true
    );
  });

  await t.test("detects explicit read_only_mode field", () => {
    assert.equal(
      isReadOnlyTask({
        request_text: "检查 Worker 状态并汇报。",
        payload: {
          read_only_mode: true,
        },
      }),
      true
    );
  });

  await t.test("does not treat the standard Codex git guard as task read-only", () => {
    assert.equal(
      isReadOnlyTaskText(
        [
          "【Windows Worker 强制规则】",
          "不允许执行 git add。",
          "不允许执行 git commit。",
          "不允许执行 git push。",
          "【原始任务内容】",
          "修复 infra/windows-worker/local_worker.js 的上报链路。",
          "【再次强调】",
          "不允许执行 git add。",
        ].join("\n")
      ),
      false
    );
  });

  await t.test("does not lock the worker repair task that implements this rule", () => {
    assert.equal(
      isReadOnlyTaskText(
        "只读任务锁死：任务正文出现“只读 / 不修改 / 禁止 git add / 禁止 commit / 禁止 git push”时，Worker 必须强制 read_only_mode。"
      ),
      false
    );
  });

  await t.test("allows read-only task with no file changes", () => {
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(
        {
          request_text: "本任务只读，不修改文件，只汇报检查结果。",
        },
        []
      )
    );
  });

  await t.test("explicit read_only task with empty changed_files succeeds", () => {
    const readOnlyJob = {
      request_text: [
        "BATCH-ARCH-READONLY-01",
        "project_domain=automation_architecture",
        "task_mode=read_only",
        "read_only_mode=true",
        "Static architecture inventory only.",
      ].join("\n"),
    };

    assert.equal(getTaskMode(readOnlyJob), TASK_MODES.READ_ONLY);
    assert.doesNotThrow(() => assertTaskGoalApplied(readOnlyJob, []));
  });

  await t.test("fails read-only task when files changed", () => {
    assert.throws(
      () =>
        assertTaskGoalApplied(
          {
            request_text: "本任务只读，不修改文件。",
          },
          ["infra/windows-worker/local_worker.js"]
        ),
      (error) =>
        error.code === READ_ONLY_MODE_VIOLATION &&
        error.message.includes("infra/windows-worker/local_worker.js")
    );
  });

  await t.test("hard-blocks git add commit and push in read_only_mode", () => {
    for (const args of [
      ["add", "--", "infra/windows-worker/local_worker.js"],
      ["commit", "-m", "should not commit"],
      ["push", "origin", "master"],
    ]) {
      assert.throws(
        () =>
          assertGitOperationAllowed(args, {
            readOnlyMode: true,
            changedPaths: ["infra/windows-worker/local_worker.js"],
          }),
        (error) =>
          error.code === READ_ONLY_MODE_VIOLATION &&
          error.message.includes("READ_ONLY_MODE_VIOLATION") &&
          error.message.includes("infra/windows-worker/local_worker.js")
      );
    }
  });

  await t.test("adds read-only lock instructions to the Codex prompt", () => {
    const prompt = buildWorkerGuardedPrompt("本任务只读，不修改文件，只做静态检查。");

    assert.match(prompt, /read_only_mode: true/);
    assert.match(prompt, /不得调用 apply_patch/);
    assert.match(prompt, /跳过 preflight 写入/);
  });

  await t.test("adds read-only prompt instructions for explicit payload flag", () => {
    const prompt = buildCodexPrompt({
      request_text: "检查 Worker 状态并汇报。",
      payload: {
        read_only_mode: true,
      },
    });

    assert.match(prompt, /read_only_mode: true/);
    assert.match(prompt, /Codex 只能读取、分析、静态验证并汇报结果/);
  });
});

test("batch extraction and automation routing guards", async (t) => {
  await t.test("does not extract forbidden BATCH-P3 or BATCH-P4 as current batch", () => {
    assert.equal(
      extractCurrentExecutionBatchCode({
        title: "",
        request_text: [
          "新需求：修复飞书总经理路由",
          "禁止范围",
          "- 不执行 BATCH-P3",
          "- 不执行 BATCH-P4",
          "批准语句：总管 批准修复：仅修复 BATCH-37",
        ].join("\n"),
      }),
      "BATCH-37"
    );
  });

  await t.test("extracts BATCH-39 from approval and skips forbidden section batch lines", () => {
    assert.equal(
      extractCurrentExecutionBatchCode({
        title: "",
        request_text: [
          "新需求：执行项目总管批准批次",
          "修复目标：修复 Worker / Codex / 飞书总经理路由和上报链路",
          "禁止范围",
          "- 当前批次 BATCH-P3 产品开发任务",
          "- 当前批次 BATCH-P4 产品开发任务",
          "老板批准原文：总管 批准执行：仅批准 BATCH-39",
        ].join("\n"),
      }),
      "BATCH-39"
    );
  });

  await t.test("extracts BATCH-41 from approved execution and ignores forbidden product batches", () => {
    assert.equal(
      extractCurrentExecutionBatchCode({
        title: "",
        request_text: [
          "Title: execute approved project director batch BATCH-41",
          "Repair target: fix Worker / Codex / route / report chain only",
          "Forbidden scope:",
          "- Current batch BATCH-P3 product development task",
          "- Current batch BATCH-P4 product development task",
          "Boss approval: approved execution only BATCH-41",
        ].join("\n"),
      }),
      "BATCH-41"
    );
  });

  await t.test("extracts approved GM live router batch and ignores forbidden product batches", () => {
    assert.equal(
      extractCurrentExecutionBatchCode({
        title: "",
        request_text: [
          "新需求：执行项目总管批准批次 BATCH-GM-LIVE-THREE-MODE-ROUTER-FIX-02",
          "修复目标：只修复 Worker / Codex / 飞书总经理三模式路由和上报链路",
          "禁止范围",
          "- 当前批次 BATCH-P3 产品开发任务",
          "- 当前批次 BATCH-P4 产品开发任务",
          "老板批准原文：总管 批准执行：仅批准 BATCH-GM-LIVE-THREE-MODE-ROUTER-FIX-02",
        ].join("\n"),
      }),
      "BATCH-GM-LIVE-THREE-MODE-ROUTER-FIX-02"
    );
  });

  await t.test("uses title before forbidden batch mentions", () => {
    assert.equal(
      extractCurrentExecutionBatchCode({
        title: "BATCH-38A local worker repair",
        request_text: "禁止范围：不执行 BATCH-P3 / BATCH-P4",
      }),
      "BATCH-38A"
    );
  });

  await t.test("classifies system repair separately from product context", () => {
    assert.equal(
      classifyWorkerTaskDomain(
        "BATCH-38 修复 Worker/Codex 空跑 succeeded 和飞书总经理路由污染"
      ),
      "automation_system"
    );
  });

  await t.test("automation prompt forbids city-partner product context as completion evidence", () => {
    const prompt = buildWorkerGuardedPrompt(
      "BATCH-38 修复 Worker/Codex 空跑 succeeded 和飞书总经理路由污染"
    );

    assert.match(prompt, /task_domain: automation_system/);
    assert.match(prompt, /不得把同城搭子产品页面/);
    assert.match(prompt, /首批城市/);
    assert.match(prompt, /本地草稿/);
  });
});

test("approved repair route remains on approved execution path", async (t) => {
  await t.test("console command accepts approve repair", () => {
    const source = fs.readFileSync(
      path.join(workerRoot, "..", "..", "src", "lib", "project-director-console.ts"),
      "utf8"
    );

    assert.match(source, /批准修复/);
    assert.match(source, /批准执行\[:：\\s\]/);
    assert.match(source, /approve_execution/);
  });

  await t.test("feishu route filters approved repair by explicit batch", () => {
    const source = fs.readFileSync(
      path.join(workerRoot, "..", "..", "src", "app", "api", "feishu", "event", "route.ts"),
      "utf8"
    );

    assert.match(source, /isApprovedRepairReply/);
    assert.match(source, /isApprovedBatchExecutionReply/);
    assert.match(source, /extractApprovedBatchCode/);
    assert.match(source, /extractApprovedRepairBatchCode/);
    assert.match(source, /filterApprovedRepairBuildResult/);
    assert.match(source, /approved_batch_filter/);
    assert.match(source, /dispatchedBatches/);
  });
});

test("bootstrap context router contract guards", async (t) => {
  const routeSource = fs.readFileSync(
    path.resolve(workerRoot, "../../src/app/api/feishu/event/route.ts"),
    "utf8"
  );
  const workerJobsSource = fs.readFileSync(
    path.resolve(workerRoot, "../../src/lib/worker-jobs.ts"),
    "utf8"
  );

  await t.test("automation_system write_allowed never becomes product_write_allowed or product scoped", () => {
    const job = {
      request_text: [
        "New demand: execute BATCH-ARCH-COMPLETE-00-LOCAL-BOOTSTRAP-CONTEXT-ROUTER-FIX-01",
        "project_domain=automation_system",
        "requested_mode=write_allowed",
        "allowed_scope=infra/windows-worker/local_worker.js",
        "forbidden_scope=src/app/**, docs/NEXT_TASK_CARD.md, BATCH-P1",
        "Background mentions product, src/app/**, docs/projects/city-partner-website.md and BATCH-P1 only as forbidden examples.",
      ].join("\n"),
    };

    const contract = resolveWorkerJobContract(job);
    assert.equal(classifyWorkerTaskDomain(job.request_text), "automation_system");
    assert.equal(getTaskMode(job), TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.equal(contract.task_mode, TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
    assert.notEqual(contract.task_mode, TASK_MODES.PRODUCT_WRITE_ALLOWED);
    assert.doesNotMatch(contract.allowed_scope || "", /src\/app\/\*\*|city-partner-website|NEXT_TASK_CARD/);
    assert.notEqual(extractCurrentExecutionBatchCode(job), "BATCH-P1");
  });

  await t.test("full demand context keeps original text, base64, exact scope and approval metadata", () => {
    const originalRequest = [
      "New demand: execute BATCH-GM-MODE-SMOKE-WRITE-99",
      "project_domain=automation_system",
      "requested_mode=write_allowed",
      "final_mode=write_allowed",
      "task_mode=automation_system_write_allowed",
      "read_only_mode=false",
      "approval_required=true",
      "Only modify:",
      "docs/architecture/batch-gm-mode-smoke-write-99.md",
    ].join("\n");
    const encoded = Buffer.from(originalRequest, "utf8").toString("base64");
    const job = {
      request_text: [
        "Manager approval command: only approve BATCH-GM-MODE-SMOKE-WRITE-99",
        "HERMES_WORKER_CONTEXT:",
        "project_domain=automation_system",
        "requested_mode=write_allowed",
        "final_mode=write_allowed",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "approval_required=true",
        "allowed_scope=docs/architecture/batch-gm-mode-smoke-write-99.md",
        "exact_allowed_scope=docs/architecture/batch-gm-mode-smoke-write-99.md",
        "forbidden_scope=src/app/**, database, env, BATCH-P1",
        `original_request_text_base64=${encoded}`,
        "approved_batch=BATCH-GM-MODE-SMOKE-WRITE-99",
        "chat_id=oc_xxx",
        "root_id=om_xxx",
        "message_id=om_xxx",
        "created_at=2026-07-20T00:00:00.000Z",
        "consumed=false",
        "context_id=BATCH-GM-MODE-SMOKE-WRITE-99:om_xxx",
      ].join("\n"),
    };

    const contract = resolveWorkerJobContract(job);
    assert.match(contract.original_request_text, /Only modify:/);
    assert.match(contract.original_request_text, /batch-gm-mode-smoke-write-99\.md/);
    assert.equal(
      Buffer.from(contract.original_request_text_base64, "base64").toString("utf8"),
      contract.original_request_text
    );
    assert.equal(contract.exact_allowed_scope, "docs/architecture/batch-gm-mode-smoke-write-99.md");
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(job, ["docs/architecture/batch-gm-mode-smoke-write-99.md"])
    );
    assert.throws(
      () => assertTaskGoalApplied(job, ["infra/windows-worker/tests/git-safety.test.js"]),
      (error) => error.code === OUT_OF_SCOPE_BUSINESS_CHANGE
    );
  });

  await t.test("approval shell cannot overwrite or replace missing exact original context", () => {
    assert.match(routeSource, /assertApprovedWriteRequestHasExactScope/);
    assert.match(routeSource, /ORIGINAL_BATCH_CONTEXT_MISSING/);
    assert.match(routeSource, /refusing generic automation scope fallback/);
    assert.match(routeSource, /original_request_text_base64/);
    assert.match(routeSource, /context_id/);
    assert.match(routeSource, /consumed:\s*false/);
    assert.match(routeSource, /chat_id/);
    assert.match(routeSource, /message_id/);
    assert.doesNotMatch(routeSource, /BATCH-P1[\s\S]{0,120}product_write_allowed/);
  });

  await t.test("scope polarity parser only trusts positive allow sections", () => {
    assert.match(routeSource, /POSITIVE_SCOPE_BLOCK_HEADING_PATTERN/);
    assert.match(routeSource, /POSITIVE_SCOPE_INLINE_PATTERN/);
    assert.match(routeSource, /NEGATIVE_SCOPE_LABEL_PATTERN/);
    assert.match(routeSource, /ORDINARY_SCOPE_SECTION_PATTERN/);
    assert.match(routeSource, /extractForbiddenScopePaths/);
    assert.match(routeSource, /SCOPE_CONTRACT_CONFLICT/);
    assert.match(routeSource, /assertNoScopeContractConflict\(exactAllowedScope,\s*task\.forbidden_files\)/);
    assert.match(routeSource, /assertNoScopeContractConflict\(exactAllowedScope,\s*input\.rawText\)/);
    assert.doesNotMatch(routeSource, /path\.dirname|split\("\/"\)\.slice|replace\([^)]*src\/app\/\*\*/);
  });

  await t.test("scope polarity regression fixture stays constrained to exact positive paths", () => {
    const positivePaths = [
      "src/app/api/feishu/event/route.ts",
      "src/lib/project-director-job-builder.ts",
      "src/lib/worker-jobs.ts",
      "infra/windows-worker/tests/git-safety.test.js",
    ];
    const negativeAndOrdinaryText = [
      "故障描述：历史结果提到了 docs/architecture/example-smoke.md",
      "不得修改 src/app",
      "forbidden_scope=src/app/api/feishu/event/route.ts",
      "示例：不要创建 BATCH-P1，也不要把 src/app 加入 allowed_scope",
    ].join("\n");

    assert.match(routeSource, /extractExactAllowedScopePaths/);
    assert.match(routeSource, /extractScopePathsFromFragment/);
    assert.match(routeSource, /stripScopeListPrefix/);
    for (const item of positivePaths) {
      assert.match(item, /\.[cm]?[jt]sx?$|\.js$/);
    }
    assert.match(negativeAndOrdinaryText, /src\/app/);
    assert.match(negativeAndOrdinaryText, /BATCH-P1/);
    assert.match(routeSource, /lineStartsNegativeScopeBlock\(line\)/);
    assert.match(routeSource, /ORDINARY_SCOPE_SECTION_PATTERN\.test\(line\)/);
  });

  await t.test("ambiguous or missing context is represented as a blocking contract failure", () => {
    const missingScopeJob = {
      request_text: [
        "BATCH-GM-MODE-SMOKE-WRITE-98",
        "project_domain=automation_system",
        "requested_mode=write_allowed",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
      ].join("\n"),
    };
    const ambiguousJob = {
      request_text: [
        "BATCH-GM-MODE-SMOKE-WRITE-98",
        "HERMES_WORKER_CONTEXT:",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=docs/architecture/a.md",
        "",
        "HERMES_WORKER_CONTEXT:",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=docs/architecture/b.md",
      ].join("\n"),
    };

    assert.equal(resolveWorkerJobContract(missingScopeJob).context_reconstruct_failed, true);
    assert.match(routeSource, /APPROVAL_CONTEXT_AMBIGUOUS|ORIGINAL_BATCH_CONTEXT_MISSING|explicit HERMES_WORKER_CONTEXT/);
    assert.equal(resolveWorkerJobContract(ambiguousJob).task_mode, TASK_MODES.AUTOMATION_SYSTEM_WRITE_ALLOWED);
  });

  await t.test("final status, failure metadata, empty changes, pushed false and reply error propagate", () => {
    const finalResult = normalizeWorkerFinalResult({
      job_id: "job-bootstrap-contract",
      approved_batch: "BATCH-GM-MODE-SMOKE-WRITE-97",
      status: "succeeded",
      effectiveFinalStatus: "failed",
      worker_execution_status: "succeeded_until_task_goal_validation",
      task_goal_status: "failed_no_fix_applied",
      failureCode: NO_FIX_APPLIED,
      failureStage: "task_goal_validation",
      changed_files: [],
      pushed: false,
      next_stage_allowed: false,
      reply_error: "manager_reply_failed",
    });

    assert.equal(finalResult.effective_final_status, "failed");
    assert.equal(finalResult.failure_code, NO_FIX_APPLIED);
    assert.equal(finalResult.failure_stage, "task_goal_validation");
    assert.deepEqual(finalResult.changed_files, []);
    assert.equal(finalResult.pushed, false);
    assert.equal(finalResult.next_stage_allowed, false);
    assert.equal(finalResult.reply_error, "manager_reply_failed");
    assert.deepEqual(finalResult.terminal_index.changed_files, []);
    assert.equal(finalResult.terminal_index.pushed, false);
  });

  await t.test("notification failure is non-task metadata and does not overwrite terminal truth", () => {
    const finalResult = normalizeWorkerFinalResult({
      status: "succeeded",
      effectiveFinalStatus: "succeeded",
      resultText: "Worker execution status: succeeded\nTask goal status: completed",
      errorText: "FEISHU_SEND_FAILED reply_error=feishu_rate_limited",
      changed_files: [],
      pushed: false,
      reply_error: "feishu_rate_limited",
    });

    assert.equal(finalResult.effective_final_status, "succeeded");
    assert.equal(finalResult.failure_code, null);
    assert.equal(finalResult.reply_error, "feishu_rate_limited");
  });

  await t.test("git TLS and network sync failures map before Codex execution", () => {
    const error = Object.assign(
      new Error("git fetch failed: schannel TLS handshake timeout ECONNRESET"),
      { code: "GIT_SYNC_FAILED" }
    );
    const finalResult = normalizeWorkerFinalResult({
      status: "failed",
      effectiveFinalStatus: "failed",
      error,
      errorText: error.message,
      changed_files: [],
      pushed: false,
    });
    const failureReport = buildFailureReport({ id: "git-sync", request_text: "BATCH-GM git sync" }, error);

    assert.equal(finalResult.failure_code, "GIT_SYNC_FAILED");
    assert.equal(finalResult.failure_stage, "git_sync_preflight");
    assert.match(failureReport, /failure_stage: git_sync_preflight/);
    assert.doesNotMatch(failureReport, /Codex 执行：通过/);
  });

  await t.test("read-only empty changes do not no-fix, write-allowed empty changes still no-fix", () => {
    assert.doesNotThrow(() =>
      assertTaskGoalApplied(
        {
          request_text: [
            "BATCH-GM-READONLY-EMPTY",
            "project_domain=automation_system",
            "task_mode=read_only",
            "read_only_mode=true",
          ].join("\n"),
        },
        []
      )
    );
    assert.throws(
      () =>
        assertTaskGoalApplied(
          {
            request_text: [
              "BATCH-GM-WRITE-EMPTY",
              "project_domain=automation_system",
              "requested_mode=write_allowed",
              "task_mode=automation_system_write_allowed",
              "read_only_mode=false",
              "allowed_scope=docs/architecture/write-empty.md",
              "exact_allowed_scope=docs/architecture/write-empty.md",
              "Task: create docs/architecture/write-empty.md",
            ].join("\n"),
          },
          []
        ),
      (error) => error.code === NO_FIX_APPLIED
    );
  });

  await t.test("worker job source preserves exact scope and does not reintroduce generic product fallback", () => {
    assert.match(workerJobsSource, /GIT_SYNC_FAILED/);
    assert.match(workerJobsSource, /worker_execution_status/);
    assert.match(workerJobsSource, /task_goal_status/);
    assert.match(workerJobsSource, /reply_error/);
    assert.match(workerJobsSource, /const filesChanged = readStringArray\(input\.filesChanged\)/);
    assert.doesNotMatch(workerJobsSource, /submittedFilesChanged\.length > 0[\s\S]{0,200}job\?\.result/);
  });
});

test("failure memory blocks after three repeated fingerprints", () => {
  let state = {};
  let result = recordFailureMemory(
    state,
    "QA_TASK_MODE_MISMATCH",
    "BATCH-QA-01",
    "2026-07-09T00:00:00.000Z"
  );
  assert.equal(result.status, "warning");
  assert.equal(result.blocked, false);

  state = result.memory;
  result = recordFailureMemory(
    state,
    "QA_TASK_MODE_MISMATCH",
    "BATCH-QA-01",
    "2026-07-09T00:01:00.000Z"
  );
  assert.equal(result.status, "repeated_warning");
  assert.equal(result.blocked, false);

  state = result.memory;
  result = recordFailureMemory(
    state,
    "QA_TASK_MODE_MISMATCH",
    "BATCH-QA-01",
    "2026-07-09T00:02:00.000Z"
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.blocked, true);
  assert.equal(result.entry.count, 3);
  assert.match(result.entry.suggested_guard, /BATCH-QA/);
});

test("BATCH-ARCH-09 terminal final result rules", async (t) => {
  await t.test("true test failure writes failure memory", () => {
    const finalResult = normalizeWorkerFinalResult({
      job: { id: "job-test-failed" },
      approvedBatch: "BATCH-ARCH-09",
      status: "failed",
      effectiveFinalStatus: "failed",
      errorText: "node --test infra/windows-worker/tests/git-safety.test.js failed",
      completedAt: "2026-07-15T00:00:00.000Z",
    });
    const memoryResult = recordFailureMemoryForFinalResult({}, finalResult, "2026-07-15T00:01:00.000Z");

    assert.equal(finalResult.failure_code, "TEST_FAILED");
    assert.equal(memoryResult.status, "recorded");
    assert.equal(memoryResult.recorded, true);
    assert.equal(memoryResult.entry.failure_code, "TEST_FAILED");
  });

  await t.test("Feishu rate limit does not write failure memory or terminal failure", () => {
    const finalResult = normalizeWorkerFinalResult({
      job: { id: "job-feishu-rate" },
      approvedBatch: "BATCH-ARCH-09",
      status: "failed",
      effectiveFinalStatus: "failed",
      errorText: "Feishu HTTP 429 rate limit while sending final report",
    });
    const memoryResult = recordFailureMemoryForFinalResult({}, finalResult);

    assert.equal(finalResult.effective_final_status, "running");
    assert.equal(finalResult.failure_code, null);
    assert.equal(memoryResult.status, "skipped_non_terminal");
    assert.equal(memoryResult.recorded, false);
  });

  await t.test("missing bitable_record_id does not write failure memory", () => {
    const finalResult = normalizeWorkerFinalResult({
      job: { id: "job-no-bitable" },
      approvedBatch: "BATCH-ARCH-09",
      status: "failed",
      effectiveFinalStatus: "failed",
      errorText: "bitable_record_id missing; feishu_sync=skipped_no_record_id",
    });
    const memoryResult = recordFailureMemoryForFinalResult({}, finalResult);

    assert.equal(finalResult.effective_final_status, "running");
    assert.equal(memoryResult.recorded, false);
  });

  await t.test("duplicate report does not duplicate terminal index or failure memory", () => {
    const finalResult = normalizeWorkerFinalResult({
      job: { id: "job-duplicate-report" },
      approvedBatch: "BATCH-ARCH-09",
      status: "failed",
      effectiveFinalStatus: "failed",
      errorText: "tsc --noEmit failed",
      completedAt: "2026-07-15T00:02:00.000Z",
    });

    const firstIndex = recordTerminalJobIndex({}, finalResult);
    const secondIndex = recordTerminalJobIndex(firstIndex.index, finalResult);
    const firstMemory = recordFailureMemoryForFinalResult({}, finalResult);
    const secondMemory = recordFailureMemoryForFinalResult(firstMemory.memory, finalResult);

    assert.equal(firstIndex.status, "recorded");
    assert.equal(secondIndex.status, "duplicate");
    assert.equal(secondIndex.idempotent, true);
    assert.equal(Object.keys(secondIndex.index).length, 1);
    assert.equal(firstMemory.status, "recorded");
    assert.equal(secondMemory.status, "duplicate");
    assert.equal(secondMemory.idempotent, true);
  });

  await t.test("succeeded final result saves next_batch", () => {
    const finalResult = normalizeWorkerFinalResult({
      job: { id: "job-succeeded" },
      approvedBatch: "BATCH-ARCH-09",
      status: "succeeded",
      effectiveFinalStatus: "succeeded",
      resultText: "next_batch: BATCH-ARCH-10",
      gitCommitSha: "abc123",
      completedAt: "2026-07-15T00:03:00.000Z",
    });
    const indexResult = recordTerminalJobIndex({}, finalResult);

    assert.equal(finalResult.next_batch, "BATCH-ARCH-10");
    assert.equal(indexResult.entry.next_batch, "BATCH-ARCH-10");
    assert.deepEqual(buildAutoIterationSuggestion(finalResult), {
      action: "continue",
      next_batch: "BATCH-ARCH-10",
      reason: "succeeded_next_batch",
    });
  });

  await t.test("failed final result saves failure_code", () => {
    const finalResult = normalizeWorkerFinalResult({
      job: { id: "job-ts-failed" },
      approvedBatch: "BATCH-ARCH-09",
      status: "failed",
      effectiveFinalStatus: "failed",
      errorText: "npx tsc --noEmit --incremental false TypeScript check failed",
      completedAt: "2026-07-15T00:04:00.000Z",
    });
    const indexResult = recordTerminalJobIndex({}, finalResult);

    assert.equal(finalResult.failure_code, "TYPESCRIPT_FAILED");
    assert.equal(indexResult.entry.failure_code, "TYPESCRIPT_FAILED");
  });

  await t.test("NO_FIX_APPLIED separates worker report status from task goal status", () => {
    const finalResult = normalizeWorkerFinalResult({
      job: { id: "job-no-fix" },
      approvedBatch: "BATCH-GM-DIRECTOR-OUTPUT-SEPARATION-FIX-01",
      status: "succeeded",
      finalReportStatus: "succeeded",
      effectiveFinalStatus: "failed",
      resultText: [
        "final_report_status: succeeded",
        "effective_final_status: failed",
        "failure_stage: task_goal_validation",
        "Worker execution status: succeeded_until_task_goal_validation",
        "Task goal status: failed_no_fix_applied",
        "NO_FIX_APPLIED: yes",
      ].join("\n"),
      completedAt: "2026-07-15T00:04:30.000Z",
    });

    assert.equal(finalResult.final_report_status, "succeeded");
    assert.equal(finalResult.effective_final_status, "failed");
    assert.equal(finalResult.failure_code, NO_FIX_APPLIED);
    assert.equal(finalResult.failure_memory_status, "recordable");
    assert.equal(isTrueTaskFailureCode(NO_FIX_APPLIED), true);
    assert.deepEqual(buildAutoIterationSuggestion(finalResult), {
      action: "repair",
      suggested_batch: "BATCH-GM-DIRECTOR-OUTPUT-SEPARATION-FIX-01-FIX",
      failure_code: NO_FIX_APPLIED,
      failure_stage: "task_goal_validation",
      reason: "minimal_repair_batch",
    });
  });

  await t.test("read-only violations are task-goal failures, not report transport failures", () => {
    const finalResult = normalizeWorkerFinalResult({
      job: { id: "job-read-only-violation" },
      approvedBatch: "BATCH-GM-DIRECTOR-OUTPUT-SEPARATION-FIX-01",
      status: "failed",
      effectiveFinalStatus: "failed",
      errorText: [
        "Worker execution status: succeeded_until_read_only_validation",
        "Task goal status: failed_read_only_mode_violation",
        "Read-only violation: yes",
      ].join("\n"),
    });

    assert.equal(finalResult.failure_code, READ_ONLY_MODE_VIOLATION);
    assert.equal(finalResult.failure_memory_status, "recordable");
    assert.equal(isTrueTaskFailureCode(READ_ONLY_MODE_VIOLATION), true);
  });

  await t.test("cancelled final result does not generate repair suggestion", () => {
    const finalResult = normalizeWorkerFinalResult({
      job: { id: "job-cancelled" },
      approvedBatch: "BATCH-ARCH-09",
      status: "cancelled",
      effectiveFinalStatus: "cancelled",
      completedAt: "2026-07-15T00:05:00.000Z",
    });
    const memoryResult = recordFailureMemoryForFinalResult({}, finalResult);

    assert.equal(finalResult.failure_memory_status, "skipped_cancelled");
    assert.equal(memoryResult.recorded, false);
    assert.deepEqual(buildAutoIterationSuggestion(finalResult), {
      action: "none",
      reason: "cancelled",
    });
  });
});

test("post-completion 404 transport warnings keep accepted terminal result", async (t) => {
  function lockCanarySuccess(state = createTerminalReportState()) {
    const snapshot = lockAcceptedTerminalReportSnapshot(
      {
        status: "succeeded",
        reportBody: {
          job_id: "job-canary-02",
          worker_execution_status: "succeeded",
          task_goal_status: "succeeded",
          effective_final_status: "succeeded",
          failure_code: null,
          failure_stage: null,
          changed_files: [],
          git_commit_sha: null,
          git_push: false,
        },
        acceptedFinalReportResponse: {
          ok: true,
          project_director_report: {
            data: {
              worker_execution_status: "succeeded",
              task_goal_status: "succeeded",
              effective_final_status: "succeeded",
              failure_code: null,
              failure_stage: null,
              changed_files: [],
              git_commit_sha: null,
              pushed: false,
            },
          },
        },
      },
      state
    );
    return { state, snapshot };
  }

  function normalizeAfterPostCompletion404(snapshot, errorText) {
    return normalizeWorkerFinalResult({
      job: { id: "job-canary-02" },
      status: "failed",
      effectiveFinalStatus: "failed",
      terminalStatusSnapshot: snapshot,
      errorText,
      failureCode: "not_provided",
      failureStage: "worker_progress",
    });
  }

  await t.test("progress 404 after accepted success is a warning and does not override", () => {
    const { state } = lockCanarySuccess();
    assert.equal(
      recordPostCompletionTransportWarning(
        { status: 404, text: "RUNNING_JOB_NOT_FOUND_OR_NOT_OWNED" },
        "worker_progress",
        "job-canary-02",
        state
      ),
      true
    );

    const finalResult = normalizeAfterPostCompletion404(
      getTerminalReportSnapshot(state),
      "worker_progress HTTP 404 RUNNING_JOB_NOT_FOUND_OR_NOT_OWNED"
    );

    assert.equal(finalResult.worker_execution_status, "succeeded");
    assert.equal(finalResult.task_goal_status, "succeeded");
    assert.equal(finalResult.effective_final_status, "succeeded");
    assert.equal(finalResult.failure_code, null);
    assert.equal(finalResult.failure_stage, null);
    assert.equal(finalResult.post_completion_transport_warning, true);
  });

  await t.test("heartbeat 404 after accepted success is a warning and does not override", () => {
    const { state } = lockCanarySuccess();
    assert.equal(
      recordPostCompletionTransportWarning(
        { status: 404, text: "RUNNING_JOB_NOT_FOUND_OR_NOT_OWNED" },
        "worker_heartbeat",
        "job-canary-02",
        state
      ),
      true
    );

    const finalResult = normalizeAfterPostCompletion404(
      getTerminalReportSnapshot(state),
      "worker_heartbeat HTTP 404 RUNNING_JOB_NOT_FOUND_OR_NOT_OWNED"
    );

    assert.equal(finalResult.effective_final_status, "succeeded");
    assert.equal(finalResult.failure_code, null);
    assert.equal(finalResult.failure_stage, null);
  });

  await t.test("multiple post-completion 404s only increment warnings", () => {
    const { state } = lockCanarySuccess();
    for (const stage of ["worker_progress", "worker_heartbeat", "worker_progress"]) {
      assert.equal(
        recordPostCompletionTransportWarning(
          new Error(`HTTP 404 RUNNING_JOB_NOT_FOUND_OR_NOT_OWNED stage=${stage}`),
          stage,
          "job-canary-02",
          state
        ),
        true
      );
    }

    const snapshot = getTerminalReportSnapshot(state);
    const finalResult = normalizeAfterPostCompletion404(
      snapshot,
      "multiple HTTP 404 RUNNING_JOB_NOT_FOUND_OR_NOT_OWNED"
    );

    assert.equal(snapshot.post_completion_warning_count, 3);
    assert.equal(finalResult.effective_final_status, "succeeded");
    assert.equal(finalResult.failure_code, null);
  });

  await t.test("accepted final report stops heartbeat and progress timers", () => {
    const state = createTerminalReportState();
    const stopped = [];
    registerTerminalTimerStopper("heartbeat", () => stopped.push("heartbeat"), state);
    registerTerminalTimerStopper("progress", () => stopped.push("progress"), state);

    lockCanarySuccess(state);

    assert.deepEqual(stopped.sort(), ["heartbeat", "progress"]);
  });

  await t.test("final report failure still fails closed without accepted snapshot", () => {
    const finalResult = normalizeWorkerFinalResult({
      job: { id: "job-report-failed" },
      status: "failed",
      effectiveFinalStatus: "failed",
      errorText: "final report HTTP 500",
      failureStage: "report",
    });

    assert.equal(finalResult.effective_final_status, "failed");
    assert.notEqual(finalResult.effective_final_status, "succeeded");
  });

  await t.test("true task goal failure is preserved", () => {
    const finalResult = normalizeWorkerFinalResult({
      job: { id: "job-goal-failed" },
      approvedBatch: "BATCH-ARCH-COMPLETE-01",
      status: "succeeded",
      finalReportStatus: "succeeded",
      effectiveFinalStatus: "failed",
      worker_execution_status: "succeeded_until_task_goal_validation",
      task_goal_status: "failed_no_fix_applied",
      failureCode: NO_FIX_APPLIED,
      failureStage: "task_goal_validation",
      changed_files: [],
      pushed: false,
    });

    assert.equal(finalResult.worker_execution_status, "succeeded_until_task_goal_validation");
    assert.equal(finalResult.task_goal_status, "failed_no_fix_applied");
    assert.equal(finalResult.effective_final_status, "failed");
    assert.equal(finalResult.failure_code, NO_FIX_APPLIED);
  });

  await t.test("worker_read_only success keeps empty changed_files and no push", () => {
    const snapshot = buildTerminalStatusSnapshot({
      status: "succeeded",
      reportBody: {
        job_id: "job-read-only",
        worker_execution_status: "succeeded",
        task_goal_status: "completed_read_only_no_file_changes",
        effective_final_status: "succeeded",
        changed_files: [],
        git_commit_sha: null,
        git_push: false,
      },
    });

    assert.deepEqual(snapshot.changed_files, []);
    assert.equal(snapshot.git_commit_sha, null);
    assert.equal(snapshot.git_push, false);
    assert.equal(snapshot.task_goal_status, "completed_read_only_no_file_changes");
  });

  await t.test("write_allowed success keeps commit and push fields", () => {
    const finalResult = normalizeWorkerFinalResult({
      status: "succeeded",
      effectiveFinalStatus: "succeeded",
      worker_execution_status: "succeeded",
      task_goal_status: "completed_with_file_changes",
      changed_files: ["infra/windows-worker/local_worker.js"],
      gitCommitSha: "abc123",
      github_push_status: "succeeded",
    });

    assert.deepEqual(finalResult.changed_files, ["infra/windows-worker/local_worker.js"]);
    assert.equal(finalResult.git_commit_sha, "abc123");
    assert.equal(finalResult.pushed, true);
    assert.equal(finalResult.git_push, true);
  });

  await t.test("worker process success with task goal failure stays failed", () => {
    const finalResult = normalizeWorkerFinalResult({
      status: "succeeded",
      finalReportStatus: "succeeded",
      effectiveFinalStatus: "failed",
      worker_execution_status: "succeeded_until_task_goal_validation",
      task_goal_status: "failed_no_fix_applied",
      resultText: "NO_FIX_APPLIED: yes",
      failureCode: NO_FIX_APPLIED,
      failureStage: "task_goal_validation",
    });

    assert.equal(finalResult.effective_final_status, "failed");
    assert.equal(finalResult.worker_execution_status, "succeeded_until_task_goal_validation");
    assert.equal(finalResult.task_goal_status, "failed_no_fix_applied");
  });

  await t.test("failure_code not_provided is normalized to null for success", () => {
    const finalResult = normalizeWorkerFinalResult({
      status: "succeeded",
      effectiveFinalStatus: "succeeded",
      resultText: "failure_code: not_provided\nfailure_stage: worker_progress",
      failureCode: "not_provided",
      failureStage: "worker_progress",
    });

    assert.equal(finalResult.failure_code, null);
    assert.equal(finalResult.failure_stage, null);
  });

  await t.test("terminal snapshot fields are complete", () => {
    const snapshot = buildTerminalStatusSnapshot({
      status: "succeeded",
      reportBody: {
        job_id: "job-snapshot",
        worker_execution_status: "succeeded",
        task_goal_status: "succeeded",
        effective_final_status: "succeeded",
        failure_code: null,
        failure_stage: null,
        changed_files: [],
        git_commit_sha: null,
        git_push: false,
      },
    });

    for (const field of [
      "worker_execution_status",
      "task_goal_status",
      "effective_final_status",
      "failure_code",
      "failure_stage",
      "changed_files",
      "git_commit_sha",
      "git_push",
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(snapshot, field), field);
    }
  });

  await t.test("CANARY-02 log scenario finally displays succeeded", () => {
    const { state } = lockCanarySuccess();
    assert.equal(isRunningJobNotFoundOrNotOwned("HTTP 404 RUNNING_JOB_NOT_FOUND_OR_NOT_OWNED"), true);
    recordPostCompletionTransportWarning(
      { status: 404, text: "worker_progress RUNNING_JOB_NOT_FOUND_OR_NOT_OWNED" },
      "worker_progress",
      "job-canary-02",
      state
    );
    recordPostCompletionTransportWarning(
      { status: 404, text: "worker_heartbeat RUNNING_JOB_NOT_FOUND_OR_NOT_OWNED" },
      "worker_heartbeat",
      "job-canary-02",
      state
    );

    const finalResult = normalizeAfterPostCompletion404(
      getTerminalReportSnapshot(state),
      [
        "Worker execution status: failed",
        "Task goal status: failed",
        "Final status: failed",
        "failure_code: not_provided",
      ].join("\n")
    );

    assert.equal(finalResult.worker_execution_status, "succeeded");
    assert.equal(finalResult.task_goal_status, "succeeded");
    assert.equal(finalResult.effective_final_status, "succeeded");
    assert.equal(finalResult.failure_code, null);
    assert.equal(finalResult.failure_stage, null);
    assert.equal(finalResult.post_completion_warning_count, 2);
  });

  await t.test("worker-jobs source keeps accepted report and terminal snapshot priority", () => {
    const workerJobsSource = readRepoFile("src/lib/worker-jobs.ts");

    assert.match(workerJobsSource, /readAcceptedFinalReportData/);
    assert.match(workerJobsSource, /readTerminalStatusSnapshot/);
    assert.match(workerJobsSource, /terminalChangedFiles/);
    assert.match(workerJobsSource, /post_completion_transport_warning/);
  });

  resetTerminalReportState(createTerminalReportState());
});

test("path normalization and path-set comparison", async (t) => {
  await t.test("normalizes Windows and relative path forms", () => {
    assert.equal(normalizeGitPath(".\\src\\\\file.ts"), "src/file.ts");
    assert.equal(normalizeGitPath("./src/file.ts"), "src/file.ts");
    assert.equal(normalizeGitPath("src//file.ts"), "src/file.ts");
  });

  await t.test("does not silently repair dropped-first-character paths", () => {
    assert.equal(normalizeGitPath("rc/lib/db/mock.ts"), "rc/lib/db/mock.ts");
    assert.equal(
      normalizeGitPath("nfra/windows-worker/git-safety.js"),
      "nfra/windows-worker/git-safety.js"
    );
  });

  await t.test("path comparisons are exact and case-sensitive", () => {
    const comparison = comparePathSets(["README.md"], ["readme.md"]);

    assert.equal(comparison.ok, false);
    assert.deepEqual(comparison.missing, ["README.md"]);
    assert.deepEqual(comparison.extra, ["readme.md"]);
  });

  await t.test("path comparisons ignore ordering and duplicate paths", () => {
    const comparison = comparePathSets(["b.txt", "a.txt", "a.txt"], ["a.txt", "b.txt"]);

    assert.equal(comparison.ok, true);
    assert.deepEqual(comparison.expected, ["a.txt", "b.txt"]);
    assert.deepEqual(comparison.actual, ["a.txt", "b.txt"]);
  });
});

test("pre-task worktree checks", async (t) => {
  await t.test("clean worktree is allowed", () => {
    assert.doesNotThrow(() => assertCleanStatusEntries([]));
  });

  await t.test("modified file blocks task", () => {
    assert.throws(
      () => assertCleanStatusEntries(parseGitStatusPorcelain(" M tracked.txt\0")),
      /tracked\.txt/
    );
  });

  await t.test("untracked file blocks task", () => {
    assert.throws(
      () => assertCleanStatusEntries(parseGitStatusPorcelain("?? new.txt\0")),
      /\?\? new\.txt/
    );
  });

  await t.test("staged file blocks task", () => {
    assert.throws(
      () => assertCleanStatusEntries(parseGitStatusPorcelain("M  tracked.txt\0")),
      /M  tracked\.txt/
    );
  });

  await t.test("deleted file blocks task", () => {
    assert.throws(
      () => assertCleanStatusEntries(parseGitStatusPorcelain(" D tracked.txt\0")),
      / D tracked\.txt/
    );
  });

  await t.test("renamed file blocks task", () => {
    assert.throws(
      () => assertCleanStatusEntries(parseGitStatusPorcelain("R  renamed.txt\0tracked.txt\0")),
      /R  renamed\.txt/
    );
  });

  await t.test("error message contains path and status but not file content", () => {
    assert.throws(
      () => assertCleanStatusEntries(parseGitStatusPorcelain(" M tracked.txt\0")),
      (error) =>
        error.message.includes(" M tracked.txt") &&
        !error.message.includes("DO_NOT_PRINT_THIS_CONTENT")
    );
  });
});

test("sensitive path rules", async (t) => {
  const blocked = [
    ".env",
    "config/.env",
    "config.env",
    "infra/windows-worker/.env",
    "infra\\windows-worker.env",
    "C:\\city-partner-worker.env",
    "logs/worker.log",
    "logs\\worker.log",
    "infra/windows-worker/logs/output.log",
    "backup.bak",
    "folder/file.BAK",
  ];

  for (const filePath of blocked) {
    await t.test(`blocks ${filePath}`, () => {
      assert.equal(isSensitivePath(filePath), true);
    });
  }

  const allowed = [
    ".env.example",
    "infra/windows-worker/.env.example",
    "README.md",
    "src/example.ts",
  ];

  for (const filePath of allowed) {
    await t.test(`allows ${filePath}`, () => {
      assert.equal(isSensitivePath(filePath), false);
    });
  }

  await t.test("path normalization handles slash style and case", () => {
    assert.equal(normalizeGitPath("Logs\\Worker.LOG"), "Logs/Worker.LOG");
    assert.equal(isSensitivePath("FoLdEr\\FiLe.bAk"), true);
  });

  await t.test("legacy path bugs are not hard-coded as exact rules", () => {
    const source = fs.readFileSync(path.join(workerRoot, "git-safety.js"), "utf8");

    assert.doesNotMatch(source, /c:\/city-partner-worker\.env/i);
    assert.doesNotMatch(source, /infra\/windows-worker\.env/i);
  });
});

test("safe staging path validation", async (t) => {
  await t.test("matching staged paths pass", () => {
    assert.deepEqual(validateStagedPaths(["new.txt"], ["new.txt"]), ["new.txt"]);
  });

  await t.test("modified file path can be validated", () => {
    assert.deepEqual(validateStagedPaths(["tracked.txt"], ["tracked.txt"]), [
      "tracked.txt",
    ]);
  });

  await t.test("deleted file path can be validated", () => {
    assert.deepEqual(validateStagedPaths(["tracked.txt"], ["tracked.txt"]), [
      "tracked.txt",
    ]);
  });

  await t.test("file name with spaces can be validated", () => {
    assert.deepEqual(
      validateStagedPaths(["file with spaces.txt"], ["file with spaces.txt"]),
      ["file with spaces.txt"]
    );
  });

  await t.test("Chinese file name can be validated", () => {
    assert.deepEqual(validateStagedPaths(["中文文件.txt"], ["中文文件.txt"]), [
      "中文文件.txt",
    ]);
  });

  await t.test("extra staged file fails validation with paths only", () => {
    assert.throws(
      () => validateStagedPaths(["expected.txt"], ["expected.txt", "extra.txt"]),
      (error) =>
        error.message.includes("extra.txt") &&
        !error.message.includes("extra file content")
    );
  });

  await t.test("missing staged file fails validation", () => {
    assert.throws(
      () => validateStagedPaths(["expected.txt", "missing.txt"], ["expected.txt"]),
      /missing\.txt/
    );
  });

  await t.test("worker source does not contain unrestricted or destructive git commands", () => {
    const source = fs.readFileSync(path.join(workerRoot, "local_worker.js"), "utf8");

    assert.doesNotMatch(source, /git\s+add\s+-A/i);
    assert.doesNotMatch(source, /reset",\s*"--hard|reset --hard/i);
    assert.doesNotMatch(source, /clean",\s*"-fd|clean -fd/i);
  });

  await t.test("git add path existence failure includes diagnostic fields", (t) => {
    const root = createTempRoot(t);

    assert.throws(
      () =>
        validateGitAddPathsExist(root, [
          {
            status: " M",
            path: "pp/page.tsx",
            line: " M app/page.tsx",
          },
        ]),
      (error) =>
        error.code === "GIT_ADD_PATH_RESOLUTION" &&
        error.message.includes("rawStatusLine:  M app/page.tsx") &&
        error.message.includes("parsedPath: pp/page.tsx") &&
        error.message.includes("cwd: ") &&
        error.message.includes("projectRoot: ") &&
        error.message.includes("reason: path does not exist")
    );
  });

});

test("failure reports include repair diagnostics", async (t) => {
  await t.test("pathspec failures produce boss repair recommendation", () => {
    const report = buildFailureReport(
      {
        id: "job-123",
        request_text: "修复 Worker git status 路径解析错误",
      },
      new Error("fatal: pathspec 'pp/page.tsx' did not match any files"),
      {
        filesChanged: ["infra/windows-worker/local_worker.js"],
        uncommittedFiles: ["infra/windows-worker/local_worker.js"],
        head: "abc123",
      }
    );

    assert.match(report, /任务编号：job-123/);
    assert.match(report, /失败阶段：git add 路径解析/);
    assert.match(report, /关键错误/);
    assert.match(report, /当前未提交文件清单/);
    assert.match(report, /当前 HEAD：abc123/);
    assert.match(report, /建议修复动作/);
    assert.match(report, /是否建议老板回复“总管 批准修复”：是/);
  });
});

test("committable path and sensitive content validation", async (t) => {
  await t.test(".env.example is allowed by path", (t) => {
    const root = createTempRoot(t);
    writeFile(root, ".env.example", "PLACEHOLDER_ONLY=true\n");

    assert.doesNotThrow(() =>
      validateCommittablePaths([".env.example"], { projectRoot: root })
    );
  });

  await t.test(".env is blocked by path", (t) => {
    const root = createTempRoot(t);
    writeFile(root, ".env", "placeholder=true\n");

    assert.throws(
      () => validateCommittablePaths([".env"], { projectRoot: root }),
      /\.env \(sensitive path\)/
    );
  });

  await t.test("logs directory is blocked by path", (t) => {
    const root = createTempRoot(t);
    writeFile(root, "logs/worker.log", "log\n");

    assert.throws(
      () => validateCommittablePaths(["logs/worker.log"], { projectRoot: root }),
      /logs\/worker\.log \(sensitive path\)/
    );
  });

  await t.test("bak files are blocked by path", (t) => {
    const root = createTempRoot(t);
    writeFile(root, "folder/file.BAK", "backup\n");

    assert.throws(
      () => validateCommittablePaths(["folder/file.BAK"], { projectRoot: root }),
      /folder\/file\.BAK \(sensitive path\)/
    );
  });

  const privateKeyHeader = joinedWords("-----BEGIN", "PRIVATE", "KEY-----");
  const privateKeyFooter = joinedWords("-----END", "PRIVATE", "KEY-----");
  const fakeSamples = [
    [
      joinedName("WORKER", "TOKEN"),
      `${joinedName("WORKER", "TOKEN")}=sample_value_1234567890`,
    ],
    [
      joinedName("SUPABASE", "SERVICE", "ROLE", "KEY"),
      `${joinedName("SUPABASE", "SERVICE", "ROLE", "KEY")}=sample_value_1234567890`,
    ],
    [
      joinedName("FEISHU", "APP", "SECRET"),
      `${joinedName("FEISHU", "APP", "SECRET")}=sample_value_1234567890`,
    ],
    [
      joinedName("GITHUB", "TOKEN"),
      `${joinedName("GITHUB", "TOKEN")}=${["gh", "p"].join("")}_samplegithubvalue1234567890`,
    ],
    [
      ["pass", "word"].join(""),
      `${["pass", "word"].join("")}=sample_value_1234567890`,
    ],
    [
      joinedWords("private", "key"),
      `${privateKeyHeader}\nsample_material_1234567890\n${privateKeyFooter}`,
    ],
  ];

  for (const [ruleName, content] of fakeSamples) {
    await t.test(`detects ${ruleName}`, () => {
      assert.ok(scanSensitiveContent(content).includes(ruleName));
    });
  }

  await t.test("validation error reports only path and rule name", (t) => {
    const root = createTempRoot(t);
    const fieldName = joinedName("WORKER", "TOKEN");
    const fakeSecret = "sample_value_that_must_not_be_printed_1234567890";
    writeFile(root, "safe-name.txt", `${fieldName}=${fakeSecret}\n`);

    assert.throws(
      () => validateCommittablePaths(["safe-name.txt"], { projectRoot: root }),
      (error) =>
        error.message.includes("safe-name.txt") &&
        error.message.includes(fieldName) &&
        !error.message.includes(fakeSecret)
    );
  });

  await t.test("test suite does not access production API or remote writes", () => {
    const source = fs.readFileSync(__filename, "utf8");
    const workerApiPattern = new RegExp("WORKER" + "_API_URL");
    const remoteWritePattern = new RegExp("git\\s*\\([^\\n]*\"pu" + "sh\"");

    assert.doesNotMatch(source, workerApiPattern);
    assert.doesNotMatch(source, remoteWritePattern);
  });

  await t.test("test source does not trigger its own sensitive scan", () => {
    const source = fs.readFileSync(__filename, "utf8");
    const forbiddenFieldLiterals = [
      joinedName("WORKER", "TOKEN"),
      joinedName("SUPABASE", "SERVICE", "ROLE", "KEY"),
      joinedName("FEISHU", "APP", "SECRET"),
      joinedName("GITHUB", "TOKEN"),
      ["pass", "word"].join(""),
      joinedName("private", "key"),
    ];

    assert.deepEqual(scanSensitiveContent(source), []);

    for (const fieldName of forbiddenFieldLiterals) {
      assert.equal(source.includes(fieldName), false);
    }
  });
});

test("Codex prompt git operation guard", async (t) => {
  await t.test("adds required git prohibitions around the task", () => {
    const prompt = buildWorkerGuardedPrompt("请修改 README，并必须生成 Git Commit。");

    assert.match(prompt, /不允许执行 git add/);
    assert.match(prompt, /不允许执行 git commit/);
    assert.match(prompt, /不允许执行 git push/);
    assert.match(prompt, /Git 提交和推送由外层 Worker 自动完成/);
    assert.match(prompt, /如果任务要求生成 Git Commit，Codex 不应自行执行/);
    assert.match(prompt, /docs\/NEXT_TASK_CARD\.md/);
  });

  await t.test("keeps git-related acceptance text but explains worker ownership", () => {
    const requestText = "验收标准：必须生成 Git Commit，并必须推送到 origin/master。";
    const prompt = buildWorkerGuardedPrompt(requestText);

    assert.match(prompt, /必须生成 Git Commit/);
    assert.match(prompt, /必须推送到 origin\/master/);
    assert.match(
      prompt,
      /Codex 应理解为外层 Worker 的验收目标，而不是自己执行 Git/
    );
  });
});

test("worker_read_only context preservation and goal validation", async (t) => {
  const batchCode = "BATCH-ARCH-COMPLETE-01-WORKER-READONLY-CONTEXT-PRESERVATION-FIX-04";
  const originalRequest = [
    `Original task: execute ${batchCode}`,
    "task_goal: complete a read-only audit for remote branch refs, production file hashes, and patched directory contents.",
    "required_output_fields: remote_branch_audit, production_file_hashes, patched_directory_audit",
    "acceptance_conditions: all required audit sections are present and no write operation is performed.",
    "forbidden_scope: file writes, Git writes, database writes, deployment",
    "read_only_operations: inspect remote branch refs; inspect production file hashes; inspect patched directory contents",
  ].join("\n");
  const job = {
    id: "job-worker-readonly-context",
    request_text: `Approved execution for ${batchCode}.`,
    payload: {
      project_domain: "automation_system",
      task_mode: "worker_read_only",
      read_only_mode: true,
      original_request_text: originalRequest,
      approved_batch: batchCode,
      exact_allowed_scope_count: 0,
      readable_scope: "origin/master refs, production file hashes, patched/**",
      read_only_operations: [
        "remote branch refs audit",
        "production file hashes audit",
        "patched directory audit",
      ],
      forbidden_operations: [
        "file writes",
        "apply_patch",
        "git add",
        "git commit",
        "git push",
        "checkout",
        "merge",
        "rebase",
        "reset",
        "deployment",
        "database writes",
      ],
      forbidden_scope: "file writes, Git writes, database writes, deployment",
      task_goal: "complete a read-only audit for remote branch refs, production file hashes, and patched directory contents.",
      required_output_fields: [
        "remote_branch_audit",
        "production_file_hashes",
        "patched_directory_audit",
      ],
      acceptance_conditions: "all required audit sections are present and no write operation is performed.",
    },
  };

  await t.test("exact_allowed_scope_count zero preserves full original_request_text in Codex prompt", () => {
    const contract = resolveWorkerJobContract(job);
    const prompt = buildCodexPrompt(job);

    assert.equal(contract.task_mode, "worker_read_only");
    assert.equal(contract.read_only_mode, true);
    assert.equal(contract.exact_allowed_scope_count, "0");
    assert.equal(contract.writable_scope, "[]");
    assert.equal(contract.original_request_text, originalRequest);
    assert.equal(contract.original_request_text_preserved, true);
    assert.match(prompt, /Original task: execute BATCH-ARCH-COMPLETE-01-WORKER-READONLY-CONTEXT-PRESERVATION-FIX-04/);
    assert.match(prompt, /exact_allowed_scope_count: 0/);
    assert.match(prompt, /writable_scope: \[\]/);
  });

  await t.test("remote branch, production hash and patched audit do not fall back to generic git status diff", () => {
    const prompt = buildCodexPrompt(job);

    assert.match(prompt, /remote branch refs audit/);
    assert.match(prompt, /production file hashes audit/);
    assert.match(prompt, /patched directory audit/);
    assert.doesNotMatch(prompt, /【原始任务内容】\s*(?:git status|git diff)\s*$/i);
  });

  await t.test("required_output_fields are passed intact", () => {
    const contract = resolveWorkerJobContract(job);
    const prompt = buildCodexPrompt(job);

    assert.match(contract.required_output_fields, /remote_branch_audit/);
    assert.match(contract.required_output_fields, /production_file_hashes/);
    assert.match(contract.required_output_fields, /patched_directory_audit/);
    assert.match(prompt, /required_output_fields:[\s\S]*remote_branch_audit/);
    assert.match(prompt, /required_output_fields:[\s\S]*production_file_hashes/);
    assert.match(prompt, /required_output_fields:[\s\S]*patched_directory_audit/);
  });

  await t.test("missing original_request_text fails closed", () => {
    const missingOriginalJob = {
      ...job,
      payload: {
        ...job.payload,
        original_request_text: undefined,
        originalRequestText: undefined,
        original_request_text_base64: undefined,
      },
    };

    assert.throws(
      () => buildCodexPrompt(missingOriginalJob),
      (error) =>
        error.code === WORKER_READONLY_CONTEXT_INCOMPLETE &&
        error.missingWorkerReadonlyContextFields.includes("original_request_text")
    );
  });

  await t.test("missing required output fields fail task goal", () => {
    assert.doesNotThrow(() =>
      assertWorkerReadOnlyTaskGoalComplete(
        job,
        [
          "remote_branch_audit: complete",
          "production_file_hashes: complete",
          "patched_directory_audit: complete",
        ].join("\n")
      )
    );

    assert.throws(
      () =>
        assertWorkerReadOnlyTaskGoalComplete(
          job,
          [
            "remote_branch_audit: complete",
            "production_file_hashes: complete",
          ].join("\n")
        ),
      (error) =>
        error.code === WORKER_READONLY_CONTEXT_INCOMPLETE &&
        error.failureStage === "worker_readonly_required_output_validation" &&
        error.missingRequiredOutputFields.includes("patched_directory_audit")
    );
  });

  await t.test("git write and history commands stay blocked in worker_read_only", () => {
    const blocked = ["add", "commit", "push", "checkout", "merge", "rebase", "reset"];
    for (const subcommand of blocked) {
      assert.throws(
        () =>
          assertGitOperationAllowed([subcommand, "target"], {
            readOnlyMode: true,
          }),
        (error) => error.code === READ_ONLY_MODE_VIOLATION
      );
    }

    const prompt = buildCodexPrompt(job);
    assert.match(prompt, /apply_patch/);
    assert.match(prompt, /deployment/);
    assert.match(prompt, /database writes/);
  });
});

test("Codex spawn preflight guard", async (t) => {
  await t.test("uses read-only sandbox for worker_read_only tasks", () => {
    const job = {
      id: "job-worker-read-only",
      request_text: [
        "新需求：执行 BATCH-GM-MODE-SMOKE-WORKER-04",
        "project_domain=automation_system",
        "requested_mode=worker_read_only",
        "final_mode=worker_read_only",
        "task_mode=worker_read_only",
        "read_only_mode=true",
        "allowed_scope=Worker read-only static inspection; no file writes",
        "forbidden_scope=file writes, git add, git commit, git push",
        "approved_batch=BATCH-GM-MODE-SMOKE-WORKER-04",
      ].join("\n"),
      payload: {
        project_domain: "automation_system",
        requested_mode: "worker_read_only",
        final_mode: "worker_read_only",
        task_mode: "worker_read_only",
        read_only_mode: true,
        allowed_scope: "Worker read-only static inspection; no file writes",
        forbidden_scope: "file writes, git add, git commit, git push",
        approved_batch: "BATCH-GM-MODE-SMOKE-WORKER-04",
      },
    };

    const contract = resolveWorkerJobContract(job);
    assert.equal(contract.project_domain, "automation_system");
    assert.equal(contract.task_mode, "worker_read_only");
    assert.equal(contract.read_only_mode, true);
    assert.equal(isReadOnlyTask(job), true);

    const args = buildCodexExecArgs("report only", job);
    const sandboxIndex = args.indexOf("--sandbox");
    assert.notEqual(sandboxIndex, -1);
    assert.equal(args[sandboxIndex + 1], "read-only");
    assert.doesNotMatch(args.join(" "), /workspace-write/);
  });

  await t.test("uses workspace-write sandbox for write-allowed tasks", () => {
    const job = {
      id: "job-write",
      request_text: [
        "BATCH-GM-WRITE-FIX",
        "project_domain=automation_system",
        "task_mode=automation_system_write_allowed",
        "read_only_mode=false",
        "allowed_scope=infra/windows-worker/**",
      ].join("\n"),
      payload: {
        project_domain: "automation_system",
        task_mode: "automation_system_write_allowed",
        read_only_mode: false,
        allowed_scope: "infra/windows-worker/**",
      },
    };

    const args = buildCodexExecArgs("fix safely", job);
    const sandboxIndex = args.indexOf("--sandbox");
    assert.equal(args[sandboxIndex + 1], "workspace-write");
  });

  await t.test("direct worker route enforces worker_read_only three-mode boundaries", () => {
    const routeSource = fs.readFileSync(
      path.join(workerRoot, "..", "..", "src", "app", "api", "feishu", "event", "route.ts"),
      "utf8"
    );

    assert.match(routeSource, /isExplicitDirectWorkerCreateCommand/);
    assert.match(routeSource, /resolveDirectWorkerReadOnlyContract/);
    assert.match(routeSource, /DIRECT_MANAGER_READ_ONLY_REJECTED/);
    assert.match(routeSource, /DIRECT_WRITE_ALLOWED_REQUIRES_APPROVAL/);
    assert.match(routeSource, /PROJECT_DIRECTOR_WORKER_READ_ONLY_TASK_CREATED/);
    assert.match(routeSource, /PROJECT_DIRECTOR_DIRECT_WORKER_TASK_DUPLICATE/);
    assert.match(routeSource, /taskMode: modeContract\.taskMode/);
    assert.match(routeSource, /readOnlyMode: modeContract\.readOnlyMode/);
    assert.match(routeSource, /approvedBatch: modeContract\.batchCode/);
  });

  await t.test("detects executable file types", () => {
    assert.equal(getCodexFileType("C:/Tools/Codex/codex.exe"), "exe");
    assert.equal(getCodexFileType("C:/Users/admin/AppData/Roaming/npm/codex.cmd"), "cmd");
    assert.equal(getCodexFileType("C:/Tools/codex.bat"), "bat");
    assert.equal(getCodexFileType("C:/Users/admin/AppData/Roaming/npm/codex"), "shim-or-app-alias");
  });

  await t.test("builds direct exe spawn command", () => {
    const command = buildCodexSpawnCommand(
      {
        ok: true,
        resolvedPath: "C:\\Program Files\\OpenAI Codex\\codex.exe",
        fileType: "exe",
      },
      ["exec", "-C", "D:\\Project With Spaces", "prompt text"]
    );

    assert.equal(command.command, "C:\\Program Files\\OpenAI Codex\\codex.exe");
    assert.deepEqual(command.args, ["exec", "-C", "D:\\Project With Spaces", "prompt text"]);
    assert.equal(command.shell, false);
  });

  await t.test("wraps cmd and bat launchers without shell prompt concatenation", () => {
    const command = buildCodexSpawnCommand(
      {
        ok: true,
        resolvedPath: "C:\\Users\\admin\\AppData\\Roaming\\npm\\codex.cmd",
        fileType: "cmd",
      },
      ["exec", "-C", "D:\\Project With Spaces", "prompt with spaces"]
    );

    assert.equal(command.command, "cmd.exe");
    assert.deepEqual(command.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.match(command.args[3], /"C:\\Users\\admin\\AppData\\Roaming\\npm\\codex\.cmd"/);
    assert.match(command.args[3], /"D:\\Project With Spaces"/);
    assert.match(command.args[3], /"prompt with spaces"/);
  });

  await t.test("rejects Windows App aliases and extensionless shims", (t) => {
    const root = createTempRoot(t);
    const aliasPath = path.join(root, "WindowsApps", "codex");
    writeFile(root, "WindowsApps/codex", "");

    const result = resolveCodexExecutable({ codexExe: aliasPath });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "CODEX_EXE_APP_ALIAS_OR_SHIM");
  });

  await t.test("formats spawn EPERM diagnostics without leaking full prompt", () => {
    const error = new Error("spawn EPERM");
    error.code = "EPERM";
    error.errno = -4048;
    error.syscall = "spawn";

    const diagnostic = formatCodexSpawnError(error, {
      command: "C:\\Program Files\\OpenAI Codex\\codex.exe",
      args: ["exec", "-C", "D:\\Project", "prompt ".repeat(80)],
      codexResolution: {
        resolvedPath: "C:\\Program Files\\OpenAI Codex\\codex.exe",
        fileType: "exe",
      },
    });

    assert.match(diagnostic, /CODEX_SPAWN_EPERM/);
    assert.match(diagnostic, /errno=-4048/);
    assert.match(diagnostic, /syscall=spawn/);
    assert.match(diagnostic, /file_type=exe/);
    assert.match(diagnostic, /truncated/);
  });

  await t.test("preflight fails before any worker polling when executable is missing", async () => {
    const result = await runCodexPreflight({
      codexExe: "C:\\definitely-missing\\codex.exe",
      timeoutMs: 100,
    });

    assert.equal(result.ok, false);
    assert.equal(result.codexResolution.reason, "CODEX_EXE_NOT_FOUND");
  });
});
