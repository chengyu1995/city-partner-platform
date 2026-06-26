const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  assertCleanStatusEntries,
  comparePathSets,
  getStatusPaths,
  isSensitivePath,
  normalizeGitPath,
  parseGitStatusPorcelain,
  scanSensitiveContent,
  validateCommittablePaths,
  validateStagedPaths,
} = require("../git-safety");

const workerRoot = path.resolve(__dirname, "..");
let gitSpawnAvailable;

function canSpawnGit() {
  if (gitSpawnAvailable !== undefined) {
    return gitSpawnAvailable;
  }

  try {
    execFileSync("git", ["--version"], { encoding: "utf8" });
    gitSpawnAvailable = true;
  } catch (error) {
    gitSpawnAvailable = false;
  }

  return gitSpawnAvailable;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

function writeFile(root, relativePath, content = "test\n") {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
}

function removeFile(root, relativePath) {
  fs.rmSync(path.join(root, relativePath), { force: true });
}

function createRepo(t) {
  if (!canSpawnGit()) {
    t.skip("Node child_process cannot spawn git in this environment");
    return null;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-safety-"));

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  git(root, ["init"]);
  git(root, ["config", "user.email", "worker-test@example.invalid"]);
  git(root, ["config", "user.name", "Worker Test"]);
  writeFile(root, "tracked.txt", "initial\n");
  git(root, ["add", "--", "tracked.txt"]);
  git(root, ["commit", "-m", "init"]);

  return root;
}

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-safety-files-"));

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  return root;
}

function statusEntries(root) {
  return parseGitStatusPorcelain(git(root, ["status", "--porcelain=v1", "-z"]));
}

function cachedNames(root) {
  return git(root, ["diff", "--cached", "--name-only"])
    .split(/\r?\n/)
    .filter(Boolean);
}

test("Git porcelain v1 -z status parsing", async (t) => {
  await t.test("ordinary modified file", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "tracked.txt", "changed\n");

    assert.deepEqual(statusEntries(root), [
      {
        status: " M",
        path: "tracked.txt",
        originalPath: null,
        paths: ["tracked.txt"],
      },
    ]);
  });

  await t.test("new untracked file", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "new.txt", "new\n");

    assert.equal(statusEntries(root)[0].status, "??");
    assert.deepEqual(getStatusPaths(statusEntries(root)), ["new.txt"]);
  });

  await t.test("staged file", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "tracked.txt", "staged\n");
    git(root, ["add", "--", "tracked.txt"]);

    assert.equal(statusEntries(root)[0].status, "M ");
  });

  await t.test("deleted file", (t) => {
    const root = createRepo(t);
    if (!root) return;
    removeFile(root, "tracked.txt");

    assert.equal(statusEntries(root)[0].status, " D");
    assert.deepEqual(getStatusPaths(statusEntries(root)), ["tracked.txt"]);
  });

  await t.test("renamed file", (t) => {
    const root = createRepo(t);
    if (!root) return;
    git(root, ["mv", "tracked.txt", "renamed.txt"]);

    const entry = statusEntries(root)[0];
    assert.equal(entry.status, "R ");
    assert.equal(entry.path, "renamed.txt");
    assert.equal(entry.originalPath, "tracked.txt");
  });

  await t.test("file name with spaces", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "file with spaces.txt", "space\n");

    assert.deepEqual(getStatusPaths(statusEntries(root)), ["file with spaces.txt"]);
  });

  await t.test("Chinese file name", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "中文文件.txt", "cn\n");

    assert.deepEqual(getStatusPaths(statusEntries(root)), ["中文文件.txt"]);
  });

  await t.test("simultaneous worktree and staged modifications", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "tracked.txt", "staged\n");
    git(root, ["add", "--", "tracked.txt"]);
    writeFile(root, "tracked.txt", "worktree\n");

    assert.equal(statusEntries(root)[0].status, "MM");
  });

  await t.test("rename double path in porcelain -z output", () => {
    const entries = parseGitStatusPorcelain("R  new name.txt\0old name.txt\0");

    assert.deepEqual(entries, [
      {
        status: "R ",
        path: "new name.txt",
        originalPath: "old name.txt",
        paths: ["new name.txt", "old name.txt"],
      },
    ]);
  });
});

test("pre-task worktree checks", async (t) => {
  await t.test("clean worktree is allowed", (t) => {
    const root = createRepo(t);
    if (!root) return;

    assert.doesNotThrow(() => assertCleanStatusEntries(statusEntries(root)));
  });

  await t.test("modified file blocks task", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "tracked.txt", "changed\n");

    assert.throws(() => assertCleanStatusEntries(statusEntries(root)), /tracked\.txt/);
  });

  await t.test("untracked file blocks task", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "new.txt", "new\n");

    assert.throws(() => assertCleanStatusEntries(statusEntries(root)), /\?\? new\.txt/);
  });

  await t.test("staged file blocks task", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "tracked.txt", "staged\n");
    git(root, ["add", "--", "tracked.txt"]);

    assert.throws(() => assertCleanStatusEntries(statusEntries(root)), /M  tracked\.txt/);
  });

  await t.test("deleted file blocks task", (t) => {
    const root = createRepo(t);
    if (!root) return;
    removeFile(root, "tracked.txt");

    assert.throws(() => assertCleanStatusEntries(statusEntries(root)), / D tracked\.txt/);
  });

  await t.test("renamed file blocks task", (t) => {
    const root = createRepo(t);
    if (!root) return;
    git(root, ["mv", "tracked.txt", "renamed.txt"]);

    assert.throws(() => assertCleanStatusEntries(statusEntries(root)), /R  renamed\.txt/);
  });

  await t.test("error message contains path and status but not file content", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "tracked.txt", "DO_NOT_PRINT_THIS_CONTENT\n");

    assert.throws(
      () => assertCleanStatusEntries(statusEntries(root)),
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

test("safe staging checks", async (t) => {
  await t.test("new file can be staged by explicit path", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "new.txt", "new\n");
    git(root, ["add", "--", "new.txt"]);

    assert.deepEqual(validateStagedPaths(["new.txt"], cachedNames(root)), ["new.txt"]);
  });

  await t.test("modified file can be staged by explicit path", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "tracked.txt", "modified\n");
    git(root, ["add", "--", "tracked.txt"]);

    assert.deepEqual(validateStagedPaths(["tracked.txt"], cachedNames(root)), ["tracked.txt"]);
  });

  await t.test("deleted file can be staged by explicit path", (t) => {
    const root = createRepo(t);
    if (!root) return;
    removeFile(root, "tracked.txt");
    git(root, ["add", "--", "tracked.txt"]);

    assert.deepEqual(validateStagedPaths(["tracked.txt"], cachedNames(root)), ["tracked.txt"]);
  });

  await t.test("file name with spaces can be staged", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "file with spaces.txt", "space\n");
    git(root, ["add", "--", "file with spaces.txt"]);

    assert.deepEqual(validateStagedPaths(["file with spaces.txt"], cachedNames(root)), [
      "file with spaces.txt",
    ]);
  });

  await t.test("Chinese file name can be staged", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "中文文件.txt", "cn\n");
    git(root, ["add", "--", "中文文件.txt"]);

    assert.deepEqual(validateStagedPaths(["中文文件.txt"], cachedNames(root)), ["中文文件.txt"]);
  });

  await t.test("unrestricted git add all is absent from worker implementation", () => {
    const source = fs.readFileSync(path.join(workerRoot, "local_worker.js"), "utf8");

    assert.doesNotMatch(source, /git\s+add\s+-A/i);
    assert.doesNotMatch(source, /reset",\s*"--hard|reset --hard/i);
    assert.doesNotMatch(source, /clean",\s*"-fd|clean -fd/i);
  });

  await t.test("cached diff names must exactly match expected paths", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "new.txt", "new\n");
    git(root, ["add", "--", "new.txt"]);

    const comparison = comparePathSets(["new.txt"], cachedNames(root));
    assert.equal(comparison.ok, true);
    assert.deepEqual(comparison.extra, []);
    assert.deepEqual(comparison.missing, []);
  });

  await t.test("extra staged file fails validation", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "expected.txt", "expected\n");
    writeFile(root, "extra.txt", "extra\n");
    git(root, ["add", "--", "expected.txt", "extra.txt"]);

    assert.throws(
      () => validateStagedPaths(["expected.txt"], cachedNames(root)),
      /extra\.txt/
    );
  });

  await t.test("failed validation can unstage without deleting worktree files", (t) => {
    const root = createRepo(t);
    if (!root) return;
    writeFile(root, "expected.txt", "expected\n");
    writeFile(root, "extra.txt", "extra\n");
    git(root, ["add", "--", "expected.txt", "extra.txt"]);

    assert.throws(() => validateStagedPaths(["expected.txt"], cachedNames(root)));
    git(root, ["restore", "--staged", "--", ...cachedNames(root)]);

    assert.equal(fs.existsSync(path.join(root, "expected.txt")), true);
    assert.equal(fs.existsSync(path.join(root, "extra.txt")), true);
    assert.deepEqual(cachedNames(root), []);
  });

  await t.test("worker source does not contain destructive cleanup commands", () => {
    const source = fs.readFileSync(path.join(workerRoot, "local_worker.js"), "utf8");

    assert.doesNotMatch(source, /reset\s+--hard/i);
    assert.doesNotMatch(source, /clean\s+-fd/i);
  });
});

test("sensitive content scanning", async (t) => {
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

  await t.test("test suite does not access production API or execute remote pushes", () => {
    const source = fs.readFileSync(__filename, "utf8");
    const workerApiPattern = new RegExp("WORKER" + "_API_URL");
    const gitPushPattern = new RegExp("git\\([^\\n]*\"pu" + "sh\"");

    assert.doesNotMatch(source, workerApiPattern);
    assert.doesNotMatch(source, gitPushPattern);
  });
});
