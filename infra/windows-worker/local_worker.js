require("dotenv").config();

const { spawn, execFile } = require("child_process");
const os = require("os");
const {
  assertCleanStatusEntries,
  getStatusPaths,
  getTrackedStatusPaths,
  parseGitStatusPorcelain,
  uniqueSortedPaths,
  validateCommittablePaths,
  validateStagedPaths,
} = require("./git-safety");

const WORKER_API_URL = String(process.env.WORKER_API_URL || "").replace(/\/+$/, "");
const WORKER_AUTH_ENV_KEY = "WORKER_" + "TOKEN";
const WORKER_AUTH = process.env[WORKER_AUTH_ENV_KEY];
const WORKER_NAME = process.env.WORKER_NAME || os.hostname();
const PROJECT_DIR = process.env.PROJECT_DIR;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 900000);
const CODEX_IDLE_TIMEOUT_MS = Number(process.env.CODEX_IDLE_TIMEOUT_MS || 60000);
const CODEX_PROGRESS_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const CODEX_EXE = process.env.CODEX_EXE || "C:/Users/admin/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe";

function repairKnownDroppedFirstCharPath(filePath) {
  const value = String(filePath || "").trim();

  const knownPrefixes = [
    ["ocs/", "docs/"],
    ["rc/", "src/"],
    ["nfra/", "infra/"],
    ["ackage.json", "package.json"],
    ["EADME.md", "README.md"],
  ];

  for (const [badPrefix, goodPrefix] of knownPrefixes) {
    if (value.startsWith(badPrefix)) {
      return goodPrefix + value.slice(badPrefix.length);
    }
  }

  return value;
}


const required = {
  WORKER_API_URL,
  [WORKER_AUTH_ENV_KEY]: WORKER_AUTH,
  PROJECT_DIR,
};

const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([key]) => key);

function assertRequiredEnv() {
  if (missing.length > 0) {
    console.error(`缺少环境变量: ${missing.join(", ")}`);
    process.exit(1);
  }
}

let stopping = false;
let working = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`${WORKER_API_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${WORKER_AUTH}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  return response;
}

async function sendHeartbeat(jobId) {
  const response = await request("/api/worker/heartbeat", {
    method: "POST",
    body: JSON.stringify({
      job_id: jobId,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `心跳上报失败 HTTP ${response.status}: ${text}`
    );
  }
}

function startHeartbeat(jobId) {
  let stopped = false;

  const send = async () => {
    if (stopped) {
      return;
    }

    try {
      await sendHeartbeat(jobId);
    } catch (error) {
      console.error(
        `任务 ${jobId} 心跳失败：`,
        error instanceof Error ? error.message : error
      );
    }
  };

  send();

  const timer = setInterval(send, 60 * 1000);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
const GIT_AUTO_COMMIT =
  String(process.env.GIT_AUTO_COMMIT || "true").toLowerCase() === "true";

const GIT_ROLLBACK_ON_FAILURE =
  String(process.env.GIT_ROLLBACK_ON_FAILURE || "true").toLowerCase() === "true";

const GIT_AUTO_PUSH =
  String(process.env.GIT_AUTO_PUSH || "false").toLowerCase() === "true";

const GIT_REMOTE_NAME =
  String(process.env.GIT_REMOTE_NAME || "origin").trim();

const GIT_PUSH_BRANCH =
  String(process.env.GIT_PUSH_BRANCH || "").trim();

function runCommand(command, args, cwd = PROJECT_DIR) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              [
                `命令执行失败：${command} ${args.join(" ")}`,
                String(stderr || "").trim(),
                String(stdout || "").trim(),
                error.message,
              ]
                .filter(Boolean)
                .join("\n")
            )
          );
          return;
        }

        resolve({
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
        });
      }
    );
  });
}

async function runGit(args) {
  return runCommand("git", args, PROJECT_DIR);
}

async function readGitStatusEntries() {
  const status = await runGit(["status", "--porcelain=v1", "-z"]);
  return parseGitStatusPorcelain(status.stdout);
}

async function assertCleanWorktreeBeforeCodex() {
  const entries = await readGitStatusEntries();

  assertCleanStatusEntries(entries);
}

async function getTaskChangedPaths() {
  const entries = await readGitStatusEntries();
  return getStatusPaths(entries);
}

async function unstagePaths(paths) {
  const uniquePaths = uniqueSortedPaths(paths);

  if (uniquePaths.length === 0) {
    return;
  }

  await runGit(["restore", "--staged", "--", ...uniquePaths]);
}

async function getCachedDiffPaths() {
  const diff = await runGit(["diff", "--cached", "--name-only"]);
  return uniqueSortedPaths(String(diff.stdout || "").split(/\r?\n/).filter(Boolean).map(repairKnownDroppedFirstCharPath));
}

async function stageTaskPaths(paths) {
  const taskPaths = uniqueSortedPaths(paths.map(repairKnownDroppedFirstCharPath));

  if (taskPaths.length === 0) {
    return [];
  }

  validateCommittablePaths(taskPaths, { projectRoot: PROJECT_DIR });

  await runGit(["add", "--", ...taskPaths]);

  const stagedPaths = await getCachedDiffPaths();

  try {
    validateStagedPaths(taskPaths, stagedPaths);
  } catch (error) {
    await unstagePaths(stagedPaths);
    throw error;
  }

  validateCommittablePaths(stagedPaths, { projectRoot: PROJECT_DIR });

  return stagedPaths;
}

async function prepareGitTask(job) {
  if (!GIT_AUTO_COMMIT) {
    return {
      enabled: false,
      baseCommit: null,
    };
  }

  await runGit(["rev-parse", "--is-inside-work-tree"]);

  await assertCleanWorktreeBeforeCodex();

  const syncBranch = GIT_PUSH_BRANCH || (
    await runGit(["branch", "--show-current"])
  ).stdout;

  if (!syncBranch) {
    throw new Error("无法确定 Git 同步分支");
  }

  console.log(`开始同步远程分支：${GIT_REMOTE_NAME}/${syncBranch}`);

  await runGit(["fetch", GIT_REMOTE_NAME, "--prune"]);
  await runGit(["switch", syncBranch]);
  await runGit(["pull", "--rebase", GIT_REMOTE_NAME, syncBranch]);

  console.log(`远程分支同步完成：${GIT_REMOTE_NAME}/${syncBranch}`);

  await assertCleanWorktreeBeforeCodex();

  const head = await runGit(["rev-parse", "HEAD"]);

  console.log(`Git 基准提交：${head.stdout}`);

  return {
    enabled: true,
    baseCommit: head.stdout,
  };
}

function createCommitMessage(job) {
  const summary = String(job.request_text || "Codex task")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return `worker: ${job.id} ${summary}`;
}

const CODEX_GIT_OPERATION_GUARD = [
  "【Windows Worker 强制规则】",
  "Codex 只负责修改文件和汇报结果，Git 提交和推送由外层 Worker 自动完成。",
  "只允许修改任务要求的文件。",
  "不允许执行 git add。",
  "不允许执行 git commit。",
  "不允许执行 git push。",
  "不允许创建分支。",
  "不允许修改 Git 配置。",
  "不允许创建 GitHub commit。",
  "不允许调用 GitHub 写入接口。",
  "不允许尝试临时 clone 仓库来提交。",
  "Codex 完成后只需要汇报修改文件和验证结果。",
  "如果任务描述中出现“必须生成 Git Commit”“必须推送到 origin/master”，Codex 应理解为外层 Worker 的验收目标，而不是自己执行 Git。",
  "如果任务要求生成 Git Commit，Codex 不应自行执行。",
].join("\n");

function buildWorkerGuardedPrompt(requestText) {
  const taskText = String(requestText || "").trim();

  return [
    CODEX_GIT_OPERATION_GUARD,
    "",
    "【原始任务内容】",
    taskText,
    "",
    "【再次强调】",
    CODEX_GIT_OPERATION_GUARD,
  ].join("\n");
}

function buildCodexPrompt(job) {
  return buildWorkerGuardedPrompt(job?.request_text || "");
}

async function commitGitTask(job) {
  if (!GIT_AUTO_COMMIT) {
    return {
      committed: false,
      message: "Git 自动提交已关闭",
    };
  }

  const taskChangedPaths = await getTaskChangedPaths();

  if (taskChangedPaths.length === 0) {
    return {
      committed: false,
      message: "Codex 没有产生文件变更",
    };
  }

  const stagedPaths = await stageTaskPaths(taskChangedPaths);

  if (stagedPaths.length === 0) {
    return {
      committed: false,
      message: "Codex 没有产生可提交的文件变更",
    };
  }

  await runGit(["commit", "-m", createCommitMessage(job)]);

  const commit = await runGit(["rev-parse", "HEAD"]);
  const summary = await runGit([
    "show",
    "--stat",
    "--oneline",
    "--summary",
    "HEAD",
  ]);

  console.log(`Git 自动提交成功：${commit.stdout}`);

  return {
    committed: true,
    commitSha: commit.stdout,
    summary: summary.stdout,
  };
}

async function pushGitTask(commitSha) {
  if (!GIT_AUTO_PUSH) {
    return {
      pushed: false,
      message: "Git 自动推送已关闭",
    };
  }

  const remoteResult = await runGit([
    "remote",
    "get-url",
    GIT_REMOTE_NAME,
  ]);

  if (!remoteResult.stdout) {
    throw new Error(
      `Git 远程仓库不存在：${GIT_REMOTE_NAME}`
    );
  }

  let branch = GIT_PUSH_BRANCH;

  if (!branch) {
    const branchResult = await runGit([
      "branch",
      "--show-current",
    ]);

    branch = branchResult.stdout;
  }

  if (!branch) {
    throw new Error("无法确定 Git 推送分支");
  }

  try {
    await runGit([
      "push",
      GIT_REMOTE_NAME,
      `HEAD:${branch}`,
    ]);
  } catch (firstPushError) {
    console.warn(
      `Git 首次推送失败，正在同步 ${GIT_REMOTE_NAME}/${branch} 后重试：`,
      firstPushError instanceof Error
        ? firstPushError.message
        : firstPushError
    );

    await runGit(["pull", "--rebase", GIT_REMOTE_NAME, branch]);

    await runGit([
      "push",
      GIT_REMOTE_NAME,
      `HEAD:${branch}`,
    ]);
  }

  console.log(
    `Git 推送成功：${GIT_REMOTE_NAME}/${branch}`
  );

  return {
    pushed: true,
    remote: GIT_REMOTE_NAME,
    branch,
    commitSha,
  };
}
async function rollbackGitTask(checkpoint) {
  if (
    !GIT_AUTO_COMMIT ||
    !GIT_ROLLBACK_ON_FAILURE ||
    !checkpoint?.enabled ||
    !checkpoint.baseCommit
  ) {
    return {
      rolledBack: false,
      message: "Git 回滚未启用",
    };
  }

  const entries = await readGitStatusEntries();
  const changedPaths = getStatusPaths(entries).map(repairKnownDroppedFirstCharPath);
  const trackedPaths = getTrackedStatusPaths(entries).map(repairKnownDroppedFirstCharPath);

  await unstagePaths(changedPaths);

  if (trackedPaths.length > 0) {
    await runGit([
      "restore",
      "--source",
      checkpoint.baseCommit,
      "--staged",
      "--worktree",
      "--",
      ...trackedPaths,
    ]);
  }

  console.log(`Git 已回滚到：${checkpoint.baseCommit}`);

  return {
    rolledBack: true,
    commitSha: checkpoint.baseCommit,
  };
}

function killProcessTree(pid, reason) {
  return new Promise((resolve) => {
    if (!pid) {
      resolve();
      return;
    }

    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const message = [
          reason,
          stdout ? String(stdout).trim() : "",
          stderr ? String(stderr).trim() : "",
          error ? error.message : "",
        ].filter(Boolean).join("\n");

        if (message) {
          console.warn(message);
        }

        resolve();
      }
    );
  });
}

function startCodexProgressHeartbeat(jobId) {
  if (!jobId) {
    return () => {};
  }

  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) {
      return;
    }

    try {
      await updateProgress(
        jobId,
        35,
        "执行 Codex",
        "Codex 仍在运行，Worker 心跳正常"
      );
    } catch (error) {
      console.warn(
        "Codex 执行期间心跳上报异常：",
        error instanceof Error ? error.message : String(error)
      );
    }
  }, CODEX_PROGRESS_HEARTBEAT_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function runCodex(prompt, jobId) {
  return new Promise((resolve, reject) => {
    console.log(`开始执行 Codex，项目目录：${PROJECT_DIR}`);

    const child = spawn(
      CODEX_EXE,
      [
        "exec",
        "-C",
        PROJECT_DIR,
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        prompt,
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CI: "1",
          NO_COLOR: "1",
        },
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    let lastOutputAt = Date.now();
    const stopCodexProgressHeartbeat = startCodexProgressHeartbeat(jobId);

    const cleanupTimers = () => {
      stopCodexProgressHeartbeat();
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
    };

    const appendOutput = (target, chunk) => {
      const text = chunk.toString();
      lastOutputAt = Date.now();

      if (target === "stdout") {
        stdout += text;
        if (stdout.length > 2 * 1024 * 1024) {
          stdout = stdout.slice(-2 * 1024 * 1024);
        }
        process.stdout.write(text);
      } else {
        stderr += text;
        if (stderr.length > 2 * 1024 * 1024) {
          stderr = stderr.slice(-2 * 1024 * 1024);
        }
        process.stderr.write(text);
      }

      resetIdleTimer();
    };

    const failAndKill = (message) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupTimers();

      killProcessTree(child.pid, message).finally(() => {
        reject(new Error(message));
      });
    };

    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const idleMs = Date.now() - lastOutputAt;
        failAndKill(`Codex 空闲超时：${idleMs}ms 无输出，已强制结束进程树`);
      }, CODEX_IDLE_TIMEOUT_MS);
    };

    let idleTimer = setTimeout(() => {
      const idleMs = Date.now() - lastOutputAt;
      failAndKill(`Codex 空闲超时：${idleMs}ms 无输出，已强制结束进程树`);
    }, CODEX_IDLE_TIMEOUT_MS);

    const hardTimer = setTimeout(() => {
      failAndKill(`Codex 执行总超时：${CODEX_TIMEOUT_MS}ms，已强制结束进程树`);
    }, CODEX_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => appendOutput("stderr", chunk));

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupTimers();
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupTimers();

      if (code === 0) {
        resolve(stdout.trim() || "Codex 执行完成");
        return;
      }

      reject(
        new Error(
          `Codex 退出码 ${code}\n${stderr || stdout || "没有输出"}`
        )
      );
    });
  });
}

async function updateProgress(
  jobId,
  progressPercent,
  currentStep,
  statusMessage = ""
) {
  try {
    const response = await request("/api/worker/progress", {
      method: "POST",
      body: JSON.stringify({
        job_id: jobId,
        worker_name: WORKER_NAME,
        progress_percent: progressPercent,
        current_step: currentStep,
        status_message: statusMessage,
      }),
    });

    const text = await response.text();

    if (!response.ok) {
      console.warn(
        `任务进度上报失败 HTTP ${response.status}: ${text}`
      );
      return false;
    }

    console.log(
      `任务进度：${progressPercent}% - ${currentStep}`
    );

    return true;
  } catch (error) {
    console.warn(
      "任务进度上报异常：",
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

async function report(jobId, status, payload, extra = {}) {
  const body =
    status === "succeeded"
      ? {
          job_id: jobId,
          status,
          result_text: payload,
          ...extra,
        }
      : {
          job_id: jobId,
          status,
          error_text: payload,
          ...extra,
        };

  const response = await request("/api/worker/report", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`上报失败 HTTP ${response.status}: ${text}`);
  }

  console.log(`任务 ${jobId} 已上报为 ${status}`);
}

async function pollOnce() {
  if (working || stopping) {
    return;
  }

  const response = await request(
    `/api/worker/next?worker_name=${encodeURIComponent(WORKER_NAME)}`
  );

  if (response.status === 204) {
    return;
  }

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`领取任务失败 HTTP ${response.status}: ${text}`);
  }

  const payload = JSON.parse(text);
  const job = payload.job;

  if (!job || !job.id) {
    return;
  }

  working = true;

  console.log(`领取任务： ${job.id}`);

  await updateProgress(
    job.id,
    5,
    "已领取任务",
    "任务已被 Worker 领取"
  );
  console.log(`任务内容：${job.request_text}`);

  const stopHeartbeat = startHeartbeat(job.id);
  let gitCheckpoint = null;

  try {
    await updateProgress(
      job.id,
      15,
      "同步 Git",
      "正在同步 Git 仓库"
    );

    gitCheckpoint = await prepareGitTask(job);

    await updateProgress(
      job.id,
      25,
      "Git 同步完成",
      "本地分支已与远程分支同步"
    );

    await updateProgress(
      job.id,
      35,
      "执行 Codex",
      "正在启动 Codex"
    );

    const result = await runCodex(buildCodexPrompt(job), job.id);

    await updateProgress(
      job.id,
      65,
      "Codex 执行完成",
      "Codex 已完成代码修改"
    );

    await updateProgress(
      job.id,
      75,
      "检查并提交代码",
      "正在检查 Git 修改并准备提交"
    );

    const gitResult = await commitGitTask(job);

    await updateProgress(
      job.id,
      85,
      "Git 提交完成",
      gitResult.committed
        ? `提交成功：${gitResult.commitSha}`
        : gitResult.message
    );

    let pushResult = {
      pushed: false,
      message: "没有新提交，无需推送",
    };

    if (gitResult.committed) {
      await updateProgress(
        job.id,
        90,
        "推送 GitHub",
        "正在推送代码到远程仓库"
      );

      pushResult = await pushGitTask(
        gitResult.commitSha
      );
    }

    await updateProgress(
      job.id,
      95,
      "Git 推送阶段完成",
      pushResult.pushed
        ? `已推送：${pushResult.remote}/${pushResult.branch}`
        : pushResult.message
    );

    const finalResult = [
      result,
      "",
      "Git 自动备份：",
      gitResult.committed
        ? `提交成功：${gitResult.commitSha}`
        : gitResult.message,
      gitResult.summary || "",
      "",
      "GitHub 自动推送：",
      pushResult.pushed
        ? `推送成功：${pushResult.remote}/${pushResult.branch}`
        : pushResult.message,
    ]
      .filter(Boolean)
      .join("\n");

    console.log(
      `准备上报：job=${job.id}, git_commit_sha=${gitResult.commitSha || "null"}, deploy_status=${pushResult.pushed ? "pending" : "null"}`
    );

    await updateProgress(
      job.id,
      100,
      "任务已完成",
      "任务执行完成并准备上报"
    );

    await report(
      job.id,
      "succeeded",
      finalResult,
      {
        git_commit_sha:
          gitResult.commitSha || null,
        deploy_status:
          pushResult.pushed
            ? "pending"
            : null,
      }
    );
  } catch (error) {
    console.error("任务执行失败：", error);

    let rollbackMessage = "";

    try {
      const rollbackResult = await rollbackGitTask(gitCheckpoint);

      rollbackMessage = rollbackResult.rolledBack
        ? `\nGit 已自动回滚到：${rollbackResult.commitSha}`
        : `\n${rollbackResult.message}`;
    } catch (rollbackError) {
      rollbackMessage =
        `\nGit 自动回滚失败：${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        }`;
    }

    await updateProgress(
      job.id,
      100,
      "任务执行失败",
      "任务执行失败，正在上报错误"
    );

    await report(
      job.id,
      "failed",
      `${
        error instanceof Error ? error.message : String(error)
      }${rollbackMessage}`
    );
  } finally {
    stopHeartbeat();
    working = false;
  }
}

async function main() {
  assertRequiredEnv();

  console.log("本地 Worker 已启动");
  console.log(`Worker 名称：${WORKER_NAME}`);
  console.log(`云端地址：${WORKER_API_URL}`);
  console.log(`项目目录：${PROJECT_DIR}`);

  while (!stopping) {
    try {
      await pollOnce();
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] 轮询失败：`,
        error instanceof Error ? error.message : error
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

process.on("SIGINT", () => {
  stopping = true;
  console.log("正在停止 Worker...");
});

process.on("SIGTERM", () => {
  stopping = true;
});

if (require.main === module) {
  main().catch((error) => {
    console.error("Worker 启动失败：", error);
    process.exit(1);
  });
}

module.exports = {
  assertCleanWorktreeBeforeCodex,
  buildCodexPrompt,
  buildWorkerGuardedPrompt,
  commitGitTask,
  getTaskChangedPaths,
  main,
  prepareGitTask,
  rollbackGitTask,
  stageTaskPaths,
};


















