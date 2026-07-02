# 3E-FIX-2 Worker API 检查清单

## 文件范围

- [ ] 仅修改 `infra/windows-worker/start-worker.ps1`
- [ ] 仅修改 `docs/upgrade/v3e-worker-api-fix-notes.md`
- [ ] 仅修改 `docs/upgrade/v3e-worker-api-checklist.md`
- [ ] 未修改 `infra/windows-worker/.env.example`
- [ ] 未修改真实 `.env`
- [ ] 未写入真实 token 或密钥

## 启动脚本

- [ ] `start-worker.ps1` 未写死 `C:\city-partner-worker`
- [ ] `start-worker.ps1` 默认使用脚本所在目录作为 `WorkerDir`
- [ ] `start-worker.ps1` 启动当前目录下的 `local_worker.js`
- [ ] 日志仍写入 Worker 脚本目录下的 `logs\scheduled-worker.log`

## Worker 配置

- [ ] `WORKER_API_URL` 使用根地址：

```text
http://150.109.71.58.nip.io
```

- [ ] `WORKER_API_URL` 不包含 `/api/worker`
- [ ] `PROJECT_DIR` 使用真实项目目录：

```text
D:\Projects\01-active\city-partner-platform
```

- [ ] `GIT_AUTO_PUSH=true` 仅表示 Worker 成功执行任务并提交后才会 push

## 错误排查

- [ ] `fetch failed` 表示 API 地址或服务器不可达
- [ ] `HTTP 404 nginx` 表示 Nginx 路径或 URL 拼接错误
- [ ] `HTTP 401 unauthorized` 表示 token 不一致
- [ ] `/api/worker/api/worker/next` 表示 `WORKER_API_URL` 多写了 `/api/worker`

## 静态验证

```powershell
node --check infra/windows-worker/local_worker.js
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $null = [scriptblock]::Create((Get-Content -Raw 'infra/windows-worker/start-worker.ps1')); 'ok'"
```

```powershell
git status --porcelain=v1
```

验证时不得启动真实 Worker，不得调用真实 API，不得修改 `.env` 或 `.env.example`。
