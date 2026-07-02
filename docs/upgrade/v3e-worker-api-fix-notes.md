# 3E-FIX-2 Worker API 修复说明

## 本阶段范围

本阶段只修复 Windows Worker 启动脚本和配置说明：

- `infra/windows-worker/start-worker.ps1`
- `docs/upgrade/v3e-worker-api-fix-notes.md`
- `docs/upgrade/v3e-worker-api-checklist.md`

不得修改 `infra/windows-worker/.env.example`，也不得修改真实 `.env`。文档中不得写入真实 token 或密钥。

## 启动脚本行为

`start-worker.ps1` 不再写死旧目录 `C:\city-partner-worker`。

脚本默认使用自身所在目录作为 `WorkerDir`，并启动该目录下的 `local_worker.js`。当前仓库中脚本目录为：

```text
D:\Projects\01-active\city-partner-platform\infra\windows-worker
```

因此计划任务或手动启动该脚本时，应确保 `local_worker.js` 与脚本位于同一目录。

## 正确配置

Windows Worker 的真实项目目录应配置为：

```text
PROJECT_DIR=D:\Projects\01-active\city-partner-platform
```

Worker API 根地址应配置为：

```text
WORKER_API_URL=http://150.109.71.58.nip.io
```

不要把 `WORKER_API_URL` 写成 `/api/worker` 结尾，例如不要写成：

```text
http://150.109.71.58.nip.io/api/worker
```

原因是 `local_worker.js` 会自动拼接以下路径：

- `/api/worker/next`
- `/api/worker/report`

`GIT_AUTO_PUSH=true` 只表示 Worker 在成功执行任务并完成提交后才会 push。它不是 Worker 启动时立即 push，也不代表失败任务会 push。

## 常见错误判断

- `fetch failed`：API 地址错误、服务器不可达，或网络连接失败。
- `HTTP 404 nginx`：Nginx 路径配置错误，或 `WORKER_API_URL` 与 `local_worker.js` 拼接后的路径不正确。
- `HTTP 401 unauthorized`：Worker 使用的 token 与服务端配置不一致。
- 请求路径出现 `/api/worker/api/worker/next`：`WORKER_API_URL` 多写了 `/api/worker`，应改为根地址 `http://150.109.71.58.nip.io`。

## 验证边界

本阶段验证只做静态检查：

- 检查 `local_worker.js` 语法。
- 检查 `start-worker.ps1` PowerShell 语法。
- 检查 Git 工作区中只有允许文件被修改。

本阶段不启动真实 Worker，不调用真实 API，不修改 `.env`，不修改 `.env.example`。
