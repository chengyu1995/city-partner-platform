const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  assertCleanStatusEntries,
  classifyGitPath,
  comparePathSets,
  getStatusPaths,
  getTrackedStatusPaths,
  isAutomationSystemPath,
  isProtectedBusinessPath,
  isSensitivePath,
  isWorkerSystemPath,
  normalizeGitPath,
  pathMatchesGitPattern,
  parseGitStatusPorcelain,
  scanSensitiveContent,
  validateCommittablePaths,
  validateStagedPaths,
} = require("../git-safety");

const {
  assertChangedPathsAllowedForJob,
  assertGitWriteAllowedForJob,
  assertProductTaskCardAccessAllowed,
  buildTaskBoundaryPolicy,
  buildWorkerGuardedPrompt,
  classifyWorkerTask,
  getJobBatchCode,
  isReadOnlyJob,
  referencesProductTaskCardAsExecutionText,
  shouldAutoPushJob,
  validateJobBatchConsistency,
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

test("Git porcelain v1 -z status parsing", async (t) => {
  await t.test("ordinary modified file", () => {
    assert.deepEqual(parseGitStatusPorcelain(" M tracked.txt\0"), [
      {
        status: " M",
        path: "tracked.txt",
        originalPath: null,
        paths: ["tracked.txt"],
      },
    ]);
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

  await t.test("modified src and infra paths keep their first character", () => {
    const cases = [
      [" M src/lib/db/mock.ts", "src/lib/db/mock.ts"],
      ["M src/lib/db/mock.ts", "src/lib/db/mock.ts"],
      [" M src/app/post/page.tsx", "src/app/post/page.tsx"],
      ["M src/app/post/page.tsx", "src/app/post/page.tsx"],
      [" M infra/windows-worker/git-safety.js", "infra/windows-worker/git-safety.js"],
      ["M infra/windows-worker/git-safety.js", "infra/windows-worker/git-safety.js"],
    ];

    for (const [rawStatusLine, expectedPath] of cases) {
      assert.deepEqual(getStatusPaths(parseGitStatusPorcelain(`${rawStatusLine}\0`)), [
        expectedPath,
      ]);
    }
  });

  await t.test("supported status records parse without fixed-width path loss", () => {
    const cases = [
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

test("automation and worker system path classification", async (t) => {
  await t.test("classifies agents/project-director.md as automation system", () => {
    assert.equal(classifyGitPath("agents/project-director.md"), "automation_system");
    assert.equal(isAutomationSystemPath("agents/project-director.md"), true);
  });

  await t.test("classifies infra/windows-worker/local_worker.js as worker system", () => {
    assert.equal(classifyGitPath("infra/windows-worker/local_worker.js"), "worker_system");
    assert.equal(isWorkerSystemPath("infra/windows-worker/local_worker.js"), true);
  });

  await t.test("classifies src/lib/worker-jobs.ts as worker system", () => {
    assert.equal(classifyGitPath("src/lib/worker-jobs.ts"), "worker_system");
    assert.equal(isWorkerSystemPath("src/lib/worker-jobs.ts"), true);
  });

  await t.test("classifies protected application pages as protected business", () => {
    assert.equal(classifyGitPath("src/app/page.tsx"), "protected_business");
    assert.equal(isProtectedBusinessPath("src/app/page.tsx"), true);
    assert.equal(isProtectedBusinessPath("src/app/partners/123/page.tsx"), true);
    assert.equal(pathMatchesGitPattern("src/app/post/layout.tsx", "src/app/post/**"), true);
    assert.equal(isWorkerSystemPath("src/app/page.tsx"), false);
    assert.equal(isAutomationSystemPath("src/app/page.tsx"), false);
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

  const fakeSamples = [
    ["WORKER_TOKEN", "WORKER_TOKEN=fake_worker_token_1234567890"],
    [
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_SERVICE_ROLE_KEY=fake_supabase_service_role_key_1234567890",
    ],
    ["FEISHU_APP_SECRET", "FEISHU_APP_SECRET=fake_feishu_secret_1234567890"],
    ["GITHUB_TOKEN", "GITHUB_TOKEN=ghp_fakegithubtoken1234567890"],
    ["password", "password=fake_password_1234567890"],
    [
      "private key",
      "-----BEGIN PRIVATE KEY-----\nfake_private_key_material\n-----END PRIVATE KEY-----",
    ],
  ];

  for (const [ruleName, content] of fakeSamples) {
    await t.test(`detects ${ruleName}`, () => {
      assert.ok(scanSensitiveContent(content).includes(ruleName));
    });
  }

  await t.test("validation error reports only path and rule name", (t) => {
    const root = createTempRoot(t);
    const fakeSecret = "fake_worker_token_value_that_must_not_be_printed";
    writeFile(root, "safe-name.txt", `WORKER_TOKEN=${fakeSecret}\n`);

    assert.throws(
      () => validateCommittablePaths(["safe-name.txt"], { projectRoot: root }),
      (error) =>
        error.message.includes("safe-name.txt") &&
        error.message.includes("WORKER_TOKEN") &&
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
});

test("Codex prompt git operation guard", async (t) => {
  await t.test("adds required git prohibitions around the task", () => {
    const prompt = buildWorkerGuardedPrompt("请修改 README，并必须生成 Git Commit。");

    assert.match(prompt, /不允许执行 git add/);
    assert.match(prompt, /不允许执行 git commit/);
    assert.match(prompt, /不允许执行 git push/);
    assert.match(prompt, /Git 提交和推送由外层 Worker 自动完成/);
    assert.match(prompt, /如果任务要求生成 Git Commit，Codex 不应自行执行/);
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

test("Worker read-only and batch mismatch guards", async (t) => {
  await t.test("BATCH-22A read-only inventory is recognized without write flow", () => {
    const job = {
      id: "job-batch-22a",
      title: "BATCH-22A read-only workspace inventory",
      request_text: [
        "仅批准 BATCH-22A。",
        "只读工作区盘点：运行 git status --short 和 git diff --name-only。",
        "禁止修改文件、stash、reset、commit、push。",
      ].join("\n"),
      payload: {
        batch_code: "BATCH-22A",
        boss_original_text: "仅批准 BATCH-22A 只读工作区盘点",
      },
    };

    assert.equal(isReadOnlyJob(job), true);
    assert.equal(getJobBatchCode(job), "BATCH-22A");
    assert.equal(validateJobBatchConsistency(job).ok, true);
  });

  await t.test("worker repair task is not treated as read-only", () => {
    const job = {
      id: "job-batch-23",
      title: "BATCH-23 修复 Windows Worker 安全自检和任务串队问题",
      request_text: [
        "修复 git-safety 分类规则。",
        "只读任务包括 git status --short 和 git diff --name-only。",
        "允许修改 infra/windows-worker/local_worker.js。",
      ].join("\n"),
      payload: {
        batch_code: "BATCH-23",
      },
    };

    assert.equal(isReadOnlyJob(job), false);
  });

  await t.test("BATCH-22A read-only task tolerates automation and worker system changes", () => {
    const changedPaths = [
      "agents/project-director.md",
      "infra/windows-worker/local_worker.js",
      "src/lib/worker-jobs.ts",
    ];
    const classifications = changedPaths.map(classifyGitPath);
    const job = {
      id: "job-batch-22a-system-dirty",
      title: "BATCH-22A read-only project classification inventory",
      request_text: "仅批准 BATCH-22A。只读项目分类盘点，包含 git status --short 与 git diff --name-only。",
      payload: {
        batch_code: "BATCH-22A",
        boss_original_text: "仅批准 BATCH-22A",
      },
    };

    assert.equal(isReadOnlyJob(job), true);
    assert.deepEqual(classifications, [
      "automation_system",
      "worker_system",
      "worker_system",
    ]);
  });

  await t.test("BATCH-22A approval rejects stale BATCH-P1 job before execution", () => {
    const staleJob = {
      id: "job-old-batch-p1",
      title: "同城搭子网站 MVP 第一阶段 BATCH-P1：产品范围和页面结构定稿",
      request_text: "同城搭子网站 MVP 第一阶段 BATCH-P1：产品范围和页面结构定稿",
      payload: {
        batch_code: "BATCH-P1",
        boss_original_text: "仅批准 BATCH-22A 只读工作区盘点，不执行旧 BATCH-P1。",
      },
    };
    const result = validateJobBatchConsistency(staleJob);

    assert.equal(getJobBatchCode(staleJob), "BATCH-P1");
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "TASK_BATCH_MISMATCH");
    assert.equal(result.approvedBatch, "BATCH-22A");
    assert.equal(result.jobBatch, "BATCH-P1");
    assert.match(result.message, /TASK_BATCH_MISMATCH/);
  });
});

test("BATCH-35 task boundary guards", async (t) => {
  const batch31ReadOnlyJob = {
    id: "simulate-batch-31",
    title: "BATCH-31 Worker path parsing read-only validation",
    request_text: [
      "Only approve BATCH-31.",
      "Read-only validation task: run git status --short and git diff --name-only.",
      "Do not modify files. No commit. No push.",
    ].join("\n"),
    payload: {
      batch_code: "BATCH-31",
      boss_original_text:
        "Only approve BATCH-31 read-only validation. Do not modify files. No commit. No push.",
    },
  };

  const batch35SystemJob = {
    id: "simulate-batch-35",
    title: "BATCH-35 fix Worker system task boundaries",
    request_text: [
      "BATCH-35 fix Worker system task boundaries.",
      "Allowed files:",
      "- infra/windows-worker/local_worker.js",
      "- infra/windows-worker/git-safety.js",
      "- infra/windows-worker/worker-recovery.js",
      "- infra/windows-worker/tests/git-safety.test.js",
      "- src/lib/worker-jobs.ts",
    ].join("\n"),
    payload: {
      batch_code: "BATCH-35",
      boss_original_text:
        "Only approve BATCH-35 Worker system fix. Allowed files: infra/windows-worker/** and src/lib/worker-jobs.ts.",
    },
  };

  const batchP3ProductJob = {
    id: "simulate-batch-p3",
    title: "BATCH-P3 product development",
    request_text: "BATCH-P3 product development task for city partner pages.",
    payload: {
      batch_code: "BATCH-P3",
      boss_original_text: "Approve BATCH-P3 product development.",
    },
  };

  function assertOutOfScope(job, filePath) {
    assert.throws(
      () => assertChangedPathsAllowedForJob(job, [filePath]),
      (error) =>
        error.code === "OUT_OF_SCOPE_BUSINESS_CHANGE" &&
        error.message.includes("OUT_OF_SCOPE_BUSINESS_CHANGE") &&
        error.message.includes(filePath) &&
        error.message.includes("allowed_scope") &&
        error.message.includes("next_step")
    );
  }

  await t.test("BATCH-31 read-only validation rejects src/app/layout.tsx", () => {
    assert.equal(isReadOnlyJob(batch31ReadOnlyJob), true);
    assert.equal(classifyWorkerTask(batch31ReadOnlyJob), "read_only_validation");
    assertOutOfScope(batch31ReadOnlyJob, "src/app/layout.tsx");
  });

  await t.test("BATCH-31 read-only validation rejects partners detail page", () => {
    assertOutOfScope(batch31ReadOnlyJob, "src/app/partners/[id]/page.tsx");
  });

  await t.test("BATCH-35 system task rejects post layout business page", () => {
    const policy = buildTaskBoundaryPolicy(batch35SystemJob);

    assert.equal(policy.systemGuarded, true);
    assert.ok(policy.allowedPathPatterns.includes("src/lib/worker-jobs.ts"));
    assert.equal(policy.allowedPathPatterns.includes("src/lib/worker-jobs.ts."), false);
    assertOutOfScope(batch35SystemJob, "src/app/post/layout.tsx");
  });

  await t.test("BATCH-P3 product task is not blocked by system business-path guard", () => {
    const policy = assertChangedPathsAllowedForJob(batchP3ProductJob, [
      "src/app/post/layout.tsx",
    ]);

    assert.equal(policy.productDevelopment, true);
    assert.equal(policy.allowedPathPatterns, null);
  });

  await t.test("read-only task blocks git add, git commit, and git push", () => {
    for (const operation of ["git add", "git commit", "git push"]) {
      assert.throws(
        () => assertGitWriteAllowedForJob(batch31ReadOnlyJob, operation),
        (error) =>
          error.code === "READ_ONLY_GIT_OPERATION_BLOCKED" &&
          error.message.includes(operation)
      );
    }
  });

  await t.test("system repair task skips auto push without explicit boss approval", () => {
    const decision = shouldAutoPushJob(batch35SystemJob, true);

    assert.equal(decision.allowed, false);
    assert.match(decision.message, /no explicit boss approval/i);
  });

  await t.test("system task stops when changed files exceed allowed scope", () => {
    assertOutOfScope(batch35SystemJob, "src/lib/env.ts");
  });

  await t.test("non-product task may not read product task card as execution text", () => {
    const systemCardJob = {
      ...batch35SystemJob,
      request_text:
        "BATCH-35 system fix. Please read docs/NEXT_TASK_CARD.md and execute that product task.",
    };

    assert.equal(referencesProductTaskCardAsExecutionText(systemCardJob), true);
    assert.throws(
      () => assertProductTaskCardAccessAllowed(systemCardJob),
      (error) => error.code === "OUT_OF_SCOPE_PRODUCT_TASK_CARD"
    );
  });

  await t.test("product task may read product task card", () => {
    const productCardJob = {
      ...batchP3ProductJob,
      request_text:
        "BATCH-P3 product task. Please read docs/NEXT_TASK_CARD.md before editing product pages.",
    };

    assert.doesNotThrow(() => assertProductTaskCardAccessAllowed(productCardJob));
  });
});
