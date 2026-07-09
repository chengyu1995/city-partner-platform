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
  assertTaskGoalApplied,
  buildFailureReport,
  buildWorkerGuardedPrompt,
  classifyWorkerTaskDomain,
  extractCurrentExecutionBatchCode,
  extractRequiredChangePaths,
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

function joinedName(...parts) {
  return parts.join("_");
}

function joinedWords(...parts) {
  return parts.join(" ");
}

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
    assert.match(source, /approve_execution/);
  });

  await t.test("feishu route filters approved repair by explicit batch", () => {
    const source = fs.readFileSync(
      path.join(workerRoot, "..", "..", "src", "app", "api", "feishu", "event", "route.ts"),
      "utf8"
    );

    assert.match(source, /isApprovedRepairReply/);
    assert.match(source, /extractApprovedRepairBatchCode/);
    assert.match(source, /filterApprovedRepairBuildResult/);
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
