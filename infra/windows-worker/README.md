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

## 安全要求

- 不要提交 `.env`、`.env.local` 或任何真实环境变量文件。
- 不要在源码、README、日志或示例文件中写入真实 `WORKER_TOKEN`。
- 不要写入 Supabase Service Role Key。
- 不要写入飞书 App Secret。
- 不要写入 GitHub Token。
- 日志目录和备份文件应保持在 `.gitignore` 中。
