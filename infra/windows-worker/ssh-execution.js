/* eslint-disable @typescript-eslint/no-require-imports */
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const SSH_ERROR_CODES = Object.freeze({
  TCP_CONNECT_FAILED: "SSH_TCP_CONNECT_FAILED",
  KEX_FAILED: "SSH_KEX_FAILED",
  HOSTKEY_FAILED: "SSH_HOSTKEY_FAILED",
  AUTH_FAILED: "SSH_AUTH_FAILED",
  SESSION_OPEN_FAILED: "SSH_SESSION_OPEN_FAILED",
  REMOTE_COMMAND_FAILED: "SSH_REMOTE_COMMAND_FAILED",
  CLIENT_TEARDOWN_TIMEOUT: "SSH_CLIENT_TEARDOWN_TIMEOUT",
  CLIENT_PROCESS_TIMEOUT: "SSH_CLIENT_PROCESS_TIMEOUT",
  CLIENT_PROCESS_SPAWN_FAILED: "SSH_CLIENT_PROCESS_SPAWN_FAILED",
  CLIENT_PROCESS_CLOSE_FAILED: "SSH_CLIENT_PROCESS_CLOSE_FAILED",
});

const activeExecutions = new Map();

class SshExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SshExecutionError";
    this.code = code;
    this.failureCode = code;
    this.failureStage = details.failureStage || "ssh_execution";
    this.details = details;
  }
}

function resolveSshExecutable(options = {}) {
  if (options.sshExecutable) {
    return options.sshExecutable;
  }

  const env = options.env || process.env;
  const fileExists = options.fileExists || fs.existsSync;

  if (env.WORKER_SSH_EXE) {
    return env.WORKER_SSH_EXE;
  }

  if ((options.platform || process.platform) === "win32") {
    const gitSsh = path.join(
      env.ProgramFiles || "C:\\Program Files",
      "Git",
      "usr",
      "bin",
      "ssh.exe"
    );
    const systemSsh = path.join(
      env.WINDIR || "C:\\Windows",
      "System32",
      "OpenSSH",
      "ssh.exe"
    );

    for (const candidate of [gitSsh, systemSsh]) {
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return "ssh";
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function buildSshArgs(options = {}) {
  const host = String(options.host || "").trim();
  const user = String(options.user || "").trim();
  const remoteCommand = String(options.remoteCommand || "").trim();

  if (!host || !user || !remoteCommand) {
    throw new SshExecutionError(
      SSH_ERROR_CODES.CLIENT_PROCESS_SPAWN_FAILED,
      "SSH host, user, and remoteCommand are required.",
      { failureStage: "ssh_configuration" }
    );
  }

  const args = [
    "-T",
    "-n",
    "-o",
    "BatchMode=yes",
    "-o",
    "RequestTTY=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    `ConnectTimeout=${positiveInteger(options.connectTimeoutSeconds, 15)}`,
    "-o",
    `ServerAliveInterval=${positiveInteger(options.serverAliveIntervalSeconds, 10)}`,
    "-o",
    `ServerAliveCountMax=${positiveInteger(options.serverAliveCountMax, 2)}`,
  ];

  if (options.ipv4 !== false) {
    args.push("-4");
  }
  if (options.identityFile) {
    args.push("-o", "IdentitiesOnly=yes", "-i", options.identityFile);
  }
  if (options.port) {
    args.push("-p", String(options.port));
  }

  args.push(`${user}@${host}`, remoteCommand);
  return args;
}

function classifySshFailure(stderr) {
  const message = String(stderr || "").toLowerCase();

  if (
    /connection refused|connection timed out|connect to host .* timed out|no route to host|could not resolve hostname/.test(
      message
    )
  ) {
    return SSH_ERROR_CODES.TCP_CONNECT_FAILED;
  }
  if (/kex_exchange_identification|key exchange|banner exchange/.test(message)) {
    return SSH_ERROR_CODES.KEX_FAILED;
  }
  if (/host key verification failed|remote host identification has changed/.test(message)) {
    return SSH_ERROR_CODES.HOSTKEY_FAILED;
  }
  if (/permission denied|authentication failed|no supported authentication methods/.test(message)) {
    return SSH_ERROR_CODES.AUTH_FAILED;
  }
  if (/channel .* open failed|session open failed|administratively prohibited/.test(message)) {
    return SSH_ERROR_CODES.SESSION_OPEN_FAILED;
  }
  return SSH_ERROR_CODES.REMOTE_COMMAND_FAILED;
}

function failureStageForCode(code) {
  const stages = {
    [SSH_ERROR_CODES.TCP_CONNECT_FAILED]: "tcp_connect",
    [SSH_ERROR_CODES.KEX_FAILED]: "kex",
    [SSH_ERROR_CODES.HOSTKEY_FAILED]: "hostkey",
    [SSH_ERROR_CODES.AUTH_FAILED]: "publickey_auth",
    [SSH_ERROR_CODES.SESSION_OPEN_FAILED]: "session_open",
    [SSH_ERROR_CODES.REMOTE_COMMAND_FAILED]: "remote_command",
  };
  return stages[code] || "ssh_execution";
}

function defaultTerminateProcessTree(child) {
  return new Promise((resolve) => {
    if (!child || !child.pid) {
      resolve();
      return;
    }

    if (process.platform !== "win32") {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have exited between the timeout and termination.
      }
      resolve();
      return;
    }

    execFile(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      () => resolve()
    );
  });
}

function createTelemetry(startedAt) {
  return {
    spawn_time: startedAt.toISOString(),
    pid: null,
    exit_event_time: null,
    exit_code: null,
    exit_signal: null,
    close_event_time: null,
    close_code: null,
    close_signal: null,
    stdout_closed: false,
    stderr_closed: false,
    stdout_drained: false,
    stderr_drained: false,
    stdin_mode: "pipe_then_end",
    stdin_end_called: false,
    timeout_triggered: false,
    taskkill_required: false,
    forced_termination: false,
    duration_ms: null,
  };
}

function runSshCommand(options = {}) {
  const startedAt = new Date();
  const telemetry = createTelemetry(startedAt);
  const timeoutMs = positiveInteger(options.timeoutMs, 60_000);
  const closeTimeoutMs = positiveInteger(options.closeTimeoutMs, 5_000);
  const maxBuffer = positiveInteger(options.maxBuffer, 20 * 1024 * 1024);
  const spawnImpl = options.spawnImpl || spawn;
  const terminateProcessTree = options.terminateProcessTree || defaultTerminateProcessTree;
  const executable = resolveSshExecutable(options);
  const args = buildSshArgs(options);
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let child;
  let timeoutTimer;
  let closeTimer;
  let settled = false;

  return new Promise((resolve, reject) => {
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(closeTimer);
      if (telemetry.pid !== null) {
        activeExecutions.delete(telemetry.pid);
      }
      telemetry.duration_ms = Date.now() - startedAt.getTime();
      if (value?.telemetry) {
        value.telemetry.duration_ms = telemetry.duration_ms;
      }
      if (value?.details?.telemetry) {
        value.details.telemetry.duration_ms = telemetry.duration_ms;
      }
      handler(value);
    };

    const output = () => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    });

    const failAfterTermination = async (code, message, failureStage) => {
      telemetry.timeout_triggered = true;
      telemetry.taskkill_required = true;
      telemetry.forced_termination = true;
      try {
        await terminateProcessTree(child);
      } finally {
        const captured = output();
        finish(
          reject,
          new SshExecutionError(code, message, {
            failureStage,
            executable,
            args,
            ...captured,
            telemetry: { ...telemetry },
          })
        );
      }
    };

    try {
      child = spawnImpl(executable, args, {
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish(
        reject,
        new SshExecutionError(
          SSH_ERROR_CODES.CLIENT_PROCESS_SPAWN_FAILED,
          `Unable to spawn SSH client: ${error instanceof Error ? error.message : error}`,
          { failureStage: "client_spawn", executable, args, telemetry: { ...telemetry } }
        )
      );
      return;
    }

    telemetry.pid = child.pid || null;
    if (child.stdin) {
      child.stdin.end();
      telemetry.stdin_end_called = true;
    }
    if (telemetry.pid !== null) {
      activeExecutions.set(telemetry.pid, { child, terminateProcessTree });
    }

    const capture = (chunks, byteCounter, streamName) => (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextBytes = byteCounter() + buffer.length;
      if (nextBytes > maxBuffer) {
        void failAfterTermination(
          SSH_ERROR_CODES.CLIENT_PROCESS_CLOSE_FAILED,
          `SSH ${streamName} exceeded the configured buffer limit.`,
          "client_stream_drain"
        );
        return;
      }
      chunks.push(buffer);
      if (streamName === "stdout") stdoutBytes = nextBytes;
      else stderrBytes = nextBytes;
    };

    child.stdout.on("data", capture(stdoutChunks, () => stdoutBytes, "stdout"));
    child.stderr.on("data", capture(stderrChunks, () => stderrBytes, "stderr"));
    child.stdout.on("end", () => {
      telemetry.stdout_drained = true;
    });
    child.stderr.on("end", () => {
      telemetry.stderr_drained = true;
    });
    child.stdout.on("close", () => {
      telemetry.stdout_closed = true;
    });
    child.stderr.on("close", () => {
      telemetry.stderr_closed = true;
    });

    child.once("error", (error) => {
      finish(
        reject,
        new SshExecutionError(
          SSH_ERROR_CODES.CLIENT_PROCESS_SPAWN_FAILED,
          `SSH client process error: ${error instanceof Error ? error.message : error}`,
          {
            failureStage: "client_spawn",
            executable,
            args,
            ...output(),
            telemetry: { ...telemetry },
          }
        )
      );
    });

    child.once("exit", (code, signal) => {
      telemetry.exit_event_time = new Date().toISOString();
      telemetry.exit_code = code;
      telemetry.exit_signal = signal;
      closeTimer = setTimeout(() => {
        void failAfterTermination(
          SSH_ERROR_CODES.CLIENT_PROCESS_CLOSE_FAILED,
          "SSH client emitted exit but did not close its process streams.",
          "client_close"
        );
      }, closeTimeoutMs);
    });

    child.once("close", (code, signal) => {
      telemetry.close_event_time = new Date().toISOString();
      telemetry.close_code = code;
      telemetry.close_signal = signal;
      clearTimeout(closeTimer);
      const captured = output();

      if (telemetry.timeout_triggered) return;
      if (!telemetry.exit_event_time) {
        finish(
          reject,
          new SshExecutionError(
            SSH_ERROR_CODES.CLIENT_PROCESS_CLOSE_FAILED,
            "SSH client closed without an exit event.",
            {
              failureStage: "client_close",
              executable,
              args,
              ...captured,
              telemetry: { ...telemetry },
            }
          )
        );
        return;
      }
      if (!telemetry.stdout_drained || !telemetry.stderr_drained) {
        finish(
          reject,
          new SshExecutionError(
            SSH_ERROR_CODES.CLIENT_PROCESS_CLOSE_FAILED,
            "SSH client closed before stdout and stderr were drained.",
            {
              failureStage: "client_stream_drain",
              executable,
              args,
              ...captured,
              telemetry: { ...telemetry },
            }
          )
        );
        return;
      }
      if (code !== 0 || telemetry.exit_code !== 0) {
        const failureCode = classifySshFailure(captured.stderr);
        finish(
          reject,
          new SshExecutionError(failureCode, "SSH remote command failed.", {
            failureStage: failureStageForCode(failureCode),
            executable,
            args,
            ...captured,
            telemetry: { ...telemetry },
          })
        );
        return;
      }

      finish(resolve, {
        executable,
        args,
        ...captured,
        telemetry: { ...telemetry },
      });
    });

    timeoutTimer = setTimeout(() => {
      const captured = output();
      const remoteActivityObserved =
        captured.stdout.length > 0 ||
        telemetry.stdout_drained ||
        telemetry.stderr_drained ||
        telemetry.exit_event_time !== null;
      void failAfterTermination(
        remoteActivityObserved
          ? SSH_ERROR_CODES.CLIENT_TEARDOWN_TIMEOUT
          : SSH_ERROR_CODES.CLIENT_PROCESS_TIMEOUT,
        remoteActivityObserved
          ? "SSH remote activity completed but the client process did not terminate."
          : "SSH client process exceeded its execution deadline.",
        remoteActivityObserved ? "client_teardown" : "client_process"
      );
    }, timeoutMs);
  });
}

function getActiveSshProcessCount() {
  return activeExecutions.size;
}

async function shutdownActiveSshProcesses() {
  const executions = [...activeExecutions.values()];
  await Promise.allSettled(
    executions.map(({ child, terminateProcessTree }) => terminateProcessTree(child))
  );
}

module.exports = {
  SSH_ERROR_CODES,
  SshExecutionError,
  buildSshArgs,
  classifySshFailure,
  failureStageForCode,
  getActiveSshProcessCount,
  resolveSshExecutable,
  runSshCommand,
  shutdownActiveSshProcesses,
};
