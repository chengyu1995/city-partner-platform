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
  isSensitivePath,
  normalizeGitPath,
  parseGitStatusPorcelain,
  scanSensitiveContent,
  validateCommittablePaths,
  validateStagedPaths,
} = require("../git-safety");

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
