import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  SSH_ERROR_CODES,
  buildSshArgs,
  classifySshFailure,
  failureStageForCode,
  getActiveSshProcessCount,
  resolveSshExecutable,
  runSshCommand,
  shutdownActiveSshProcesses,
} = require("../ssh-execution.js");

let nextPid = 4000;

function fakeSpawn(behavior, calls = []) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = nextPid++;
    child.kill = () => true;
    calls.push({ command, args, options, child });
    queueMicrotask(() => behavior(child));
    return child;
  };
}

function completeSuccessfully(child, stdout = "SSH_OK\n", stderr = "") {
  child.stdout.end(stdout);
  child.stderr.end(stderr);
  setImmediate(() => {
    child.emit("exit", 0, null);
    setImmediate(() => child.emit("close", 0, null));
  });
}

function baseOptions(overrides = {}) {
  return {
    host: "example.test",
    user: "ubuntu",
    remoteCommand: "printf SSH_OK",
    sshExecutable: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    timeoutMs: 200,
    closeTimeoutMs: 50,
    ...overrides,
  };
}

test("stdin is isolated from the console and ended immediately", async () => {
  const calls = [];
  const result = await runSshCommand(
    baseOptions({ spawnImpl: fakeSpawn(completeSuccessfully, calls) })
  );
  assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(calls[0].child.stdin.writableEnded, true);
  assert.equal(result.telemetry.stdin_mode, "pipe_then_end");
  assert.equal(result.telemetry.stdin_end_called, true);
});

test("canonical resolver prefers configured then modern Git SSH", () => {
  assert.equal(
    resolveSshExecutable({ env: { WORKER_SSH_EXE: "D:\\ssh\\ssh.exe" } }),
    "D:\\ssh\\ssh.exe"
  );
  const resolved = resolveSshExecutable({
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files", WINDIR: "C:\\Windows" },
    fileExists: (candidate) => candidate.includes("Git"),
  });
  assert.equal(resolved, "C:\\Program Files\\Git\\usr\\bin\\ssh.exe");
});

test("pseudo-terminal allocation is disabled", () => {
  const args = buildSshArgs(baseOptions());
  assert.ok(args.includes("RequestTTY=no"));
});

test("SSH arguments contain -n", () => {
  assert.ok(buildSshArgs(baseOptions()).includes("-n"));
});

test("SSH arguments contain -T", () => {
  assert.ok(buildSshArgs(baseOptions()).includes("-T"));
});

test("SSH is spawned without a shell", async () => {
  const calls = [];
  await runSshCommand(baseOptions({ spawnImpl: fakeSpawn(completeSuccessfully, calls) }));
  assert.equal(calls[0].options.shell, false);
});

test("SSH child window is hidden", async () => {
  const calls = [];
  await runSshCommand(baseOptions({ spawnImpl: fakeSpawn(completeSuccessfully, calls) }));
  assert.equal(calls[0].options.windowsHide, true);
});

test("successful remote output is captured", async () => {
  const result = await runSshCommand(
    baseOptions({ spawnImpl: fakeSpawn((child) => completeSuccessfully(child, "REMOTE_OK\n")) })
  );
  assert.equal(result.stdout, "REMOTE_OK\n");
});

test("successful execution records the exit event", async () => {
  const result = await runSshCommand(
    baseOptions({ spawnImpl: fakeSpawn(completeSuccessfully) })
  );
  assert.ok(result.telemetry.exit_event_time);
  assert.equal(result.telemetry.exit_code, 0);
});

test("successful execution records the close event", async () => {
  const result = await runSshCommand(
    baseOptions({ spawnImpl: fakeSpawn(completeSuccessfully) })
  );
  assert.ok(result.telemetry.close_event_time);
  assert.equal(result.telemetry.close_code, 0);
});

test("stdout is drained before success", async () => {
  const result = await runSshCommand(
    baseOptions({ spawnImpl: fakeSpawn(completeSuccessfully) })
  );
  assert.equal(result.telemetry.stdout_drained, true);
});

test("stderr is drained before success", async () => {
  const result = await runSshCommand(
    baseOptions({ spawnImpl: fakeSpawn(completeSuccessfully) })
  );
  assert.equal(result.telemetry.stderr_drained, true);
});

test("normal success does not trigger timeout or taskkill", async () => {
  let terminateCalls = 0;
  const result = await runSshCommand(
    baseOptions({
      spawnImpl: fakeSpawn(completeSuccessfully),
      terminateProcessTree: async () => {
        terminateCalls += 1;
      },
    })
  );
  assert.equal(result.telemetry.timeout_triggered, false);
  assert.equal(result.telemetry.forced_termination, false);
  assert.equal(terminateCalls, 0);
});

test("an actually hung child triggers the bounded timeout", async () => {
  let terminateCalls = 0;
  await assert.rejects(
    runSshCommand(
      baseOptions({
        timeoutMs: 20,
        spawnImpl: fakeSpawn(() => {}),
        terminateProcessTree: async () => {
          terminateCalls += 1;
        },
      })
    ),
    (error) => error.code === SSH_ERROR_CODES.CLIENT_PROCESS_TIMEOUT
  );
  assert.equal(terminateCalls, 1);
});

test("remote output followed by a hang gets teardown timeout code", async () => {
  await assert.rejects(
    runSshCommand(
      baseOptions({
        timeoutMs: 20,
        spawnImpl: fakeSpawn((child) => child.stdout.write("REMOTE_OK\n")),
        terminateProcessTree: async () => {},
      })
    ),
    (error) => error.code === SSH_ERROR_CODES.CLIENT_TEARDOWN_TIMEOUT
  );
});

test("exit without close gets process-close failure code", async () => {
  await assert.rejects(
    runSshCommand(
      baseOptions({
        closeTimeoutMs: 20,
        spawnImpl: fakeSpawn((child) => {
          child.stdout.end("OK\n");
          child.stderr.end();
          setImmediate(() => child.emit("exit", 0, null));
        }),
        terminateProcessTree: async () => {},
      })
    ),
    (error) => error.code === SSH_ERROR_CODES.CLIENT_PROCESS_CLOSE_FAILED
  );
});

test("multiple sequential executions do not leak active SSH children", async () => {
  for (let index = 0; index < 4; index += 1) {
    await runSshCommand(baseOptions({ spawnImpl: fakeSpawn(completeSuccessfully) }));
  }
  assert.equal(getActiveSshProcessCount(), 0);
});

test("Worker shutdown terminates active SSH children without orphans", async () => {
  const children = [];
  const terminateProcessTree = async (child) => {
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 1, "SIGKILL");
    child.emit("close", 1, "SIGKILL");
  };
  const pending = [1, 2].map(() =>
    runSshCommand(
      baseOptions({
        timeoutMs: 1_000,
        spawnImpl: fakeSpawn((child) => children.push(child)),
        terminateProcessTree,
      })
    )
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getActiveSshProcessCount(), 2);
  await shutdownActiveSshProcesses();
  await Promise.allSettled(pending);
  assert.equal(getActiveSshProcessCount(), 0);
});

test("Windows Worker exports the canonical helper and shuts it down on signals", () => {
  const workerSource = fs.readFileSync(new URL("../local_worker.js", import.meta.url), "utf8");
  assert.match(workerSource, /runSshCommand:\s*runCanonicalSshCommand/);
  assert.match(workerSource, /shutdownActiveSshProcesses/);
  assert.match(workerSource, /requestWorkerStop/);
});

test("error classification remains stage-specific", () => {
  assert.equal(classifySshFailure("Connection timed out"), SSH_ERROR_CODES.TCP_CONNECT_FAILED);
  assert.equal(classifySshFailure("kex_exchange_identification"), SSH_ERROR_CODES.KEX_FAILED);
  assert.equal(classifySshFailure("Host key verification failed"), SSH_ERROR_CODES.HOSTKEY_FAILED);
  assert.equal(classifySshFailure("Permission denied (publickey)"), SSH_ERROR_CODES.AUTH_FAILED);
  assert.equal(classifySshFailure("channel 0: open failed"), SSH_ERROR_CODES.SESSION_OPEN_FAILED);
  assert.equal(classifySshFailure("remote command exited 7"), SSH_ERROR_CODES.REMOTE_COMMAND_FAILED);
  assert.equal(failureStageForCode(SSH_ERROR_CODES.TCP_CONNECT_FAILED), "tcp_connect");
  assert.equal(failureStageForCode(SSH_ERROR_CODES.KEX_FAILED), "kex");
  assert.equal(failureStageForCode(SSH_ERROR_CODES.AUTH_FAILED), "publickey_auth");
  assert.equal(failureStageForCode(SSH_ERROR_CODES.SESSION_OPEN_FAILED), "session_open");
  assert.equal(failureStageForCode(SSH_ERROR_CODES.REMOTE_COMMAND_FAILED), "remote_command");
});
