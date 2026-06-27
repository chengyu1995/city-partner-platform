# Windows Codex Worker

本目录保存 Windows Worker 的可公开源码副本和部署说明，用于后续通过飞书需求链路升级 Worker。

当前生产运行目录仍为 `C:\city-partner-worker`。本仓库中的 `infra/windows-worker/` 暂时只是受版本控制的源码副本，不会自动替代生产运行目录。

## 用途和整体链路

Windows Codex Worker 运行在本地 Windows 主机上，定时向 Worker API 领取任务，调用 Codex CLI 在项目仓库中执行任务，并把心跳、进度和执行结果上报回服务端。

整体链路：

1. 飞书需求进入任务系统。
2. 服务端生成可执行 Worker 任务。
3. Windows Worker 轮询任务领取接口。
4. Worker 在本机项目目录中调用 Codex CLI 执行任务。
5. Worker 上报心跳、进度和最终结果。
6. Worker 可按配置自动执行 Git 提交和推送，供后续 PR 或验收流程使用。

## 运行环境要求

- Windows
- Node.js
- Codex CLI
- Git

运行前请确认 `node`、`npm`、`git` 和 `codex` 命令已加入系统 `PATH`，并且运行账号有权限访问项目目录和 Worker 运行目录。

## 安装依赖

在 Worker 目录中执行：

```powershell
cd C:\city-partner-worker
npm install
```

如果在仓库源码副本中验证依赖，可执行：

```powershell
cd E:\projects\city-partner-platform\infra\windows-worker
npm install
```

## 配置 .env

复制示例文件并填写真实运行配置：

```powershell
copy .env.example .env
```

`.env.example` 只包含变量名称和安全示例值。真实 `.env` 必须只保存在运行机器本地，禁止提交到 GitHub。

至少需要关注以下变量：

- `WORKER_API_URL`: Worker API 地址。
- `WORKER_TOKEN`: Worker 鉴权 Token，必须使用真实密钥替换示例值。
- `WORKER_NAME`: Worker 名称。
- `PROJECT_DIR`: Codex 执行任务时使用的项目目录。
- `POLL_INTERVAL_MS`: 任务轮询间隔。
- `HEARTBEAT_INTERVAL_MS`: 心跳上报间隔。
- `CODEX_TIMEOUT_MS`: 单次 Codex 执行超时时间。
- `GIT_AUTO_COMMIT`: 是否自动提交 Git 改动。
- `GIT_ROLLBACK_ON_FAILURE`: 任务失败时是否回滚工作区改动。
- `GIT_AUTO_PUSH`: 是否自动推送。
- `GIT_REMOTE_NAME`: Git remote 名称。
- `GIT_PUSH_BRANCH`: Git 推送分支。

禁止把 `.env`、Token、密钥、密码、Supabase Service Role Key、飞书 App Secret、GitHub Token 提交到 GitHub。

## 手动启动

在 Worker 运行目录中执行：

```powershell
cd C:\city-partner-worker
node local_worker.js
```

仓库源码副本也可以用于本地语法和依赖验证：

```powershell
cd E:\projects\city-partner-platform\infra\windows-worker
node local_worker.js
```

## start-worker.ps1

`start-worker.ps1` 用于在 Windows 环境中启动 Worker，可被手动执行或由计划任务调用。

手动执行：

```powershell
cd C:\city-partner-worker
powershell -ExecutionPolicy Bypass -File .\start-worker.ps1
```

Windows 计划任务名称固定为 `CityPartnerCodexWorker`。计划任务应调用生产运行目录中的 `start-worker.ps1`，即 `C:\city-partner-worker\start-worker.ps1`。

## Worker API 接口

Worker 通过 `WORKER_API_URL` 指向的服务端接口完成以下操作：

- 任务领取：按轮询间隔请求可执行任务，并在领取成功后锁定任务。
- 心跳上报：按心跳间隔报告 Worker 仍在线和当前任务状态。
- 进度上报：执行过程中上报阶段、日志摘要或进度信息。
- 结果上报：任务完成后上报成功、失败、退出码、错误摘要和产物信息。

具体路径以 `local_worker.js` 中当前实现为准；README 只描述协议职责，不保存任何密钥或生产地址。

## Git 自动提交和推送

Worker 可根据 `.env` 配置自动执行 Git 操作：

- `GIT_AUTO_COMMIT=true` 时，任务成功后自动提交改动。
- `GIT_AUTO_PUSH=true` 时，提交后自动推送到 `GIT_REMOTE_NAME` 和 `GIT_PUSH_BRANCH`。
- `GIT_ROLLBACK_ON_FAILURE=true` 时，任务失败后按 Worker 实现回滚工作区改动。

启用自动推送前，请确认运行账号的 Git 凭据、远端分支和仓库保护规则符合项目协作要求。

## Git 工作区隔离规则

Worker 在启动 Codex 前要求 `PROJECT_DIR` 的 Git 工作区保持干净。工作区存在已修改、已删除、已暂存、未跟踪或重命名文件时，任务会安全失败，并只上报阻塞文件路径，不上报文件内容。

任务成功运行后，Worker 会重新读取 `git status --porcelain=v1 -z`，只把本次任务产生的文件列表作为允许提交范围。暂存时禁止使用无范围的 `git add -A`；Worker 会通过 `git add -- <本次任务文件...>` 显式暂存路径，以支持新增、修改、删除、包含空格的文件名和中文文件名。暂存后还会执行 `git diff --cached --name-only` 校验，若发现暂存结果包含非本次任务文件，会取消本次暂存并上报失败。

以下文件无论何种情况都禁止提交：任意目录下名为 `.env` 的文件、`infra/windows-worker.env`、`C:\city-partner-worker.env`、`logs` 目录下文件、`*.bak` 文件，以及检测到真实 Token、Secret、Password 或 Private Key 的文件。错误报告和日志只应包含文件路径，不应包含文件内容、Token、密钥或密码。

处理任务前可先检查阻塞文件：

```powershell
git status --short
```

如果需要保留已有改动，可手工选择一种处理方式：

```powershell
# 已完成的改动：先提交到自己的分支
git add -- <file>
git commit -m "chore: save local work"

# 暂时搁置改动和未跟踪文件，不丢失内容
git stash push -u -m "save work before worker task"

# 不需要提交但要保留的文件：移动到仓库外的安全目录
Move-Item -LiteralPath <file> -Destination <safe-directory>
```

不要通过无范围的 `git add -A` 把整个工作区交给 Worker 自动提交。

## 安全要求

- 不要提交 `.env`、`.env.local` 或任何真实环境变量文件。
- 不要在源码、README、日志或示例文件中写入真实 `WORKER_TOKEN`。
- 不要写入 Supabase Service Role Key。
- 不要写入飞书 App Secret。
- 不要写入 GitHub Token。
- 日志目录和备份文件应保持在 `.gitignore` 中。

## Git safety tests

Run the worker safety tests from this directory:

```powershell
cd E:\projects\city-partner-platform\infra\windows-worker
npm install
npm test
```

The test suite uses Node.js built-in `node:test` and creates isolated temporary Git repositories under the system temp directory. It does not connect to the real Worker API, does not claim production jobs, does not read production `.env` files, and does not run `git push`.

Coverage includes:

- `git status --porcelain=v1 -z` parsing for modified, untracked, staged, deleted, renamed, spaced, Chinese, mixed index/worktree, and rename double-path output.
- Pre-task clean-worktree blocking for modified, untracked, staged, deleted, and renamed files.
- Windows path and Git relative path normalization. Backslashes are converted to `/`, repeated slashes are collapsed, leading `./` is removed, and sensitive path checks are case-insensitive.
- Safe staging with explicit `git add -- <path...>` path lists and exact `git diff --cached --name-only` verification.
- Sensitive content detection for fake `WORKER_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `FEISHU_APP_SECRET`, `GITHUB_TOKEN`, `password`, and private key markers.

Before deploying to the production Worker directory, `C:\city-partner-worker`, these checks must pass:

```powershell
npm test
node --check local_worker.js
node --check git-safety.js
git diff --check
```

`.env.example` may be committed, but it must contain placeholder values only. Real `.env` files, files under `logs`, and `*.bak` backups are always forbidden from commits. Files such as `.env.example`, `infra/windows-worker/.env.example`, `README.md`, and ordinary source files are allowed by path rules, but their contents are still scanned for sensitive values before staging.

## Worker verification split

`npm test` is the pure Node.js unit test suite for `git-safety.js`. It must not spawn `git.exe`; it only validates parsing, path normalization, path-set comparison, staged-path validation, committable-path validation, sensitive content scanning, and clean-status assertions. Production deployment is blocked unless this command reports 0 failed and 0 skipped tests.

`npm run test:integration` is the local real Git integration suite. It is implemented in `tests/git-integration.ps1`, calls the system Git directly from PowerShell, creates isolated repositories only under the system temp directory, configures a local test identity, and never connects to a real remote repository.

`npm run verify` is the deployment preflight entry point. It runs Node and Git version checks, `node --check local_worker.js`, `node --check git-safety.js`, `npm test`, the PowerShell Git integration suite, and static safety checks for unrestricted staging, destructive cleanup, remote writes, Worker API access, and production env-file reads.

Before production deployment, the logs must include:

- `GIT_INTEGRATION_TESTS_PASSED`
- `WORKER_VERIFICATION_PASSED`
- Node unit tests with 0 skipped tests

If the Node test sandbox cannot spawn Git, do not skip critical Git coverage in `node:test`. Keep the pure unit tests in Node and verify real Git behavior through the PowerShell integration suite.

When no dependencies are added, do not rerun `npm install`. If `node_modules` has file locks or EPERM errors, do not force-delete or reinstall it. These verification commands use the existing dependency tree.

## Safe production deployment

Before deploying this repository copy to the production Worker directory, run the local verification first:

```powershell
cd E:\projects\city-partner-platform\infra\windows-worker
npm run verify
```

Always start with a dry-run. Dry-run is the default mode and does not stop the scheduled task, stop `node.exe`, create backups, copy files, overwrite files, delete files, or read the production env file:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy-worker.ps1
```

Only run a real deployment when you intentionally pass `-Apply`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy-worker.ps1 -Apply
```

The deployment copies Worker source files only. It never copies `.env` from the repository, and it fails if a source `.env` is present. `.env.example` may be copied because it contains placeholders only.

The production env file must remain on the Worker machine as:

```text
C:\city-partner-worker.env
```

This path is a sibling file of the production Worker directory, not a file inside the directory. Do not create:

```text
C:\city-partner-worker\.env
```

`C:\city-partner-worker\.env` is not a valid production configuration file path.

Do not manually copy real tokens, secrets, passwords, private keys, Supabase keys, Feishu secrets, or GitHub tokens into the repository.

Use `-SkipRestart` when you want to copy files but leave restart control to a human operator:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy-worker.ps1 -Apply -SkipRestart
```

Backups are written under timestamped directories in:

```text
C:\city-partner-worker-backups
```

For example:

```text
C:\city-partner-worker-backups\yyyyMMdd-HHmmss
```

If deployment restart verification fails, the script automatically stops the scheduled task, stops the `local_worker.js` node process, restores files from the current backup, restarts the scheduled task, and exits with a non-zero code.

Success is indicated by:

```text
WORKER_DEPLOYMENT_SUCCEEDED
```

Rollback is indicated by:

```text
WORKER_DEPLOYMENT_ROLLED_BACK
```
