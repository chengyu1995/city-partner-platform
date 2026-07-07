# 运维配置项目

## 项目定位

本项目记录腾讯云服务器、PM2 服务、飞书 Webhook、Vercel、Supabase、Windows Worker 和环境变量说明。

本文件只记录变量名称和用途，不记录真实 token、secret、service key、密码或 webhook 完整值。

## 腾讯云服务器

用途：

- 承载飞书事件中转。
- 承载 Worker API 或 `worker_api.js` 镜像。
- 将飞书请求、Worker 拉取、Worker report 串联起来。

相关资料：

- `docs/WORKER_ARCHITECTURE.md`
- `docs/ops/cloud-feishu-gateway-boss-console-sync.md`
- `docs/ops/cloud-feishu-gateway-choice-routing-fix.md`

注意：

- 云端 `feishu_gateway_canonical.js` 不在当前仓库内时，需要人工同步规则。
- 上线前应保留备份，但 `.bak` 文件不得删除或提交新的真实密钥。

## PM2 服务

用途：

- 管理腾讯云 Node 服务，例如 `worker-api` 或飞书 gateway。
- 查看服务状态、日志和重启状态。

相关资料：

- `docs/WORKER_ARCHITECTURE.md`
- `docs/projects/feishu-gm-automation.md`

## 飞书 Webhook

用途：

- 接收飞书事件。
- 发送飞书群回报。
- 连接项目总管需求、验收反馈和 Worker 终态报告。

变量名：

| 变量名 | 用途 |
| --- | --- |
| `FEISHU_BOT_WEBHOOK` | 飞书机器人群回报 webhook。 |
| `FEISHU_APP_ID` | 飞书应用 ID。 |
| `FEISHU_APP_SECRET` | 飞书应用 secret，禁止写入仓库。 |
| `FEISHU_API_TOKEN` | 内部 API 鉴权 token，禁止写入仓库。 |
| `FEISHU_ENCRYPT_KEY` | 飞书事件加密 key，禁止写入仓库。 |

## Vercel

用途：

- 承载 Next.js 应用 Production 和 Preview。
- 管理 Vercel 项目级环境变量。

相关资料：

- `docs/VERCEL_SETUP.md`
- `docs/VERCEL_ENV_VARS.md`

变量名：

| 变量名 | 用途 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 URL，前端可读取。 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/publishable key，前端可读取。 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key，只能服务端使用。 |

## Supabase

用途：

- 提供数据存储和 RLS。
- 支撑同城搭子业务数据和 Hermes/Worker 队列资料。
- env 缺失时业务层应进入 MOCK 模式。

相关资料：

- `docs/setup-supabase.md`
- `docs/setup-supabase-v2.md`
- `docs/setup-hermes-jobs.sql`
- `docs/setup-hermes-queue.sql`

变量名：

| 变量名 | 用途 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase URL。 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 客户端 anon key。 |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端高权限 key，禁止进入客户端和文档真实值。 |
| `SUPABASE_JWT_SECRET` | Supabase JWT secret，禁止写入仓库。 |
| `SUPABASE_URL` | 部分脚本或 GitHub Actions 使用的 Supabase URL 名称。 |
| `SUPABASE_SERVICE_KEY` | 部分服务端脚本使用的 service key 名称。 |

## Windows Worker

用途：

- 本地轮询 Worker API。
- 调用 Codex CLI 修改文件。
- 上报进度和终态报告。
- Git 提交和推送由外层 Worker 控制，不由 Codex 执行。

相关资料：

- `infra/windows-worker/README.md`
- `infra/windows-worker/.env.example`

变量名：

| 变量名 | 用途 |
| --- | --- |
| `WORKER_API_URL` | Worker API 地址。 |
| `WORKER_TOKEN` | Worker 鉴权 token，禁止写入仓库真实值。 |
| `WORKER_NAME` | Worker 名称。 |
| `WORKER_ID` | Worker ID，若实现使用该字段。 |
| `PROJECT_DIR` | Codex 执行的项目目录。 |
| `CODEX_CWD` | Codex 工作目录，历史方案可能使用。 |
| `POLL_INTERVAL_MS` | Worker 轮询间隔。 |
| `HEARTBEAT_INTERVAL_MS` | 心跳上报间隔。 |
| `CODEX_TIMEOUT_MS` | Codex 执行超时。 |
| `GIT_AUTO_COMMIT` | 外层 Worker 是否自动提交。 |
| `GIT_AUTO_PUSH` | 外层 Worker 是否自动推送。 |
| `GIT_REMOTE_NAME` | Git remote 名称。 |
| `GIT_PUSH_BRANCH` | Worker 推送目标分支。 |

## Bitable 和 LLM

变量名：

| 变量名 | 用途 |
| --- | --- |
| `BITABLE_APP_TOKEN` | 飞书 Bitable app token，禁止写入仓库真实值。 |
| `BITABLE_TABLE_ID` | 飞书 Bitable 表 ID。 |
| `MINIMAX_CN_API_KEY` | LLM API key，禁止写入仓库真实值。 |
| `DECOMPOSE_CALLBACK_URL` | 拆任务回调地址。 |

## 安全要求

- 不在文档中记录真实值。
- 不读取或打印 `.env` 内容。
- 不把 `SUPABASE_SERVICE_ROLE_KEY` 暴露给客户端。
- 不把飞书 app secret、Worker token、GitHub token、LLM key 写入仓库。
- 运维配置变更必须由老板或具备权限的人确认。
