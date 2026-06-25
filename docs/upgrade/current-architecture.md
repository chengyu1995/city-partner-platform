# 当前架构记录

更新日期: 2026-06-25

## 当前项目目录

```text
.
├── .github/
│   ├── ISSUE_TEMPLATE/
│   └── workflows/
├── app/
├── docs/
│   ├── requirements/
│   ├── test-issues/
│   └── upgrade/
├── public/
├── scripts/
├── src/
│   ├── app/
│   │   ├── activities/
│   │   ├── admin/
│   │   ├── api/
│   │   ├── partners/
│   │   ├── post/
│   │   └── test-supabase/
│   ├── components/
│   │   └── ui/
│   ├── lib/
│   │   └── db/
│   └── types/
└── node_modules/
```

## 现有 API 路由

| 路由 | 方法 | 当前用途 |
|---|---|---|
| `/api/admin/list` | `GET` | 按 `status` 查询搭子需求后台列表, 依赖 `SUPABASE_SERVICE_ROLE_KEY` |
| `/api/partners` | `GET` | 查询已审核搭子需求, 支持 `category` / `city` 过滤 |
| `/api/partners` | `POST` | 新建搭子需求, 写入 `partner_posts`, 默认 `status=pending` |
| `/api/partners/[id]/moderate` | `PATCH` | 审核搭子需求, 将状态改为 `approved` / `rejected` / `pending` |
| `/api/reports` | `POST` | 提交搭子举报, 写入 `reports` |
| `/api/feishu/requirement` | `POST` | 飞书需求池新增后入队到 `hermes_queue`, `event_type=new_requirement` |
| `/api/feishu/codex-task` | `POST` | 飞书任务看板 Codex 任务就绪后入队到 `hermes_queue`, `event_type=codex_task_ready` |
| `/api/feishu/event` | `GET` | 飞书事件订阅健康检查 |
| `/api/feishu/event` | `POST` | 飞书事件订阅 webhook, 处理 URL 验证、消息事件、对话持久化和 Hermes 回复 |
| `/api/feishu/decompose-callback` | `GET` | 返回飞书回写相关 env 配置状态 |
| `/api/feishu/decompose-callback` | `POST` | Hermes 拆解完成后回写飞书 Bitable 任务记录 |
| `/api/feishu/create-tables` | `GET` | 返回一键建飞书 Bitable 表接口说明 |
| `/api/feishu/create-tables` | `POST` | 通过飞书 API 创建 8 张 Bitable 项目协作表 |
| `/api/queue/status` | `GET` | 查询 `hermes_queue` 队列统计、最近记录和 `task_results` 最近结果 |

## Supabase 数据表

| 表 | 来源文件 | 当前用途 |
|---|---|---|
| `activities` | `docs/setup-supabase.sql` | 旧版活动列表和详情数据, 支持公开读取、公开创建 |
| `partner_posts` | `docs/setup-partner-posts.sql`, `docs/setup-v0.1-upgrade.sql` | 当前搭子需求发布主表, 含分类、城市、描述、联系方式、发起人、时间、审核状态 |
| `reports` | `docs/setup-supabase-v2.sql`, `docs/setup-v0.1-upgrade.sql`, `docs/fix-reports-schema.sql` | 搭子需求举报表 |
| `profiles` | `docs/setup-supabase-v2.sql` | 用户资料表, 预留给 Supabase Auth 用户资料 |
| `categories` | `docs/setup-supabase-v2.sql` | 分类表, 预置旅游、K 歌、学习、摩友、钓友 |
| `hermes_queue` | `docs/setup-hermes-queue.sql` | 飞书自动化和 Codex 任务的异步队列表 |
| `task_results` | `docs/setup-hermes-queue.sql` | Hermes LLM 拆解结果表 |
| `hermes_jobs` | `docs/setup-hermes-jobs.sql` | 本地 Hermes Worker 任务表, 当前设计为 1 个需求对应 1 个任务 |
| `hermes_conversations` | `docs/setup-hermes-conversations.sql` | 飞书私聊/群聊会话表 |
| `hermes_messages` | `docs/setup-hermes-conversations.sql` | Hermes 对话消息表 |

## 飞书任务链路

```text
飞书 Bitable 需求池新增
  → 飞书自动化 POST /api/feishu/requirement
  → Vercel API 写 hermes_queue(new_requirement, pending)
  → GitHub Actions hermes-decompose.yml 每 5 分钟运行
  → scripts/hermes_decompose_runner.py 拉 pending 队列
  → MiniMax LLM 拆任务
  → 写 task_results
  → 标记 hermes_queue 为 done 或 failed
  → 可选 POST /api/feishu/decompose-callback 回写 Bitable 任务看板
  → 通过 FEISHU_BOT_WEBHOOK 推送飞书群通知
```

```text
飞书 Bitable 任务看板记录更新为 Codex 待执行
  → 飞书自动化 POST /api/feishu/codex-task
  → Vercel API 写 hermes_queue(codex_task_ready, pending)
  → 后续同一套 GitHub Actions + Hermes runner 消费链路
```

```text
飞书事件订阅 / 群聊或私聊消息
  → POST /api/feishu/event
  → URL 验证或解密事件
  → 仅处理 im.message.receive_v1
  → 私聊直接处理, 群聊需包含 Hermes 或 @ 提及
  → 写 hermes_conversations / hermes_messages
  → src/lib/hermes-agent.ts 调用 Hermes Agent
  → 飞书 im/v1/messages 回复
```

```text
飞书 Bitable 初始化
  → POST /api/feishu/create-tables 或 scripts/create-bitable-tables.py
  → 创建 8 张 Bitable 表: 需求池、任务看板、老板决策中心、设计稿与页面、Bug 与风险、上线记录、日报周报、Agent 配置表
```

## 当前已知风险

| 风险 | 当前位置 |
|---|---|
| `/api/partners/[id]/moderate` 注释标明 MVP 简化为不做 auth, 任何人可调用审核接口 | `src/app/api/partners/[id]/moderate/route.ts` |
| 多个 API 路由直接使用 `SUPABASE_SERVICE_ROLE_KEY`, env 缺失时返回 503 或 500, mock 模式不覆盖全部写入链路 | `src/app/api/admin/list/route.ts`, `src/app/api/partners/route.ts`, `src/app/api/reports/route.ts`, `src/app/api/queue/status/route.ts` |
| `hermes_queue` / `task_results` RLS 当前对 select、insert、update 较开放, 适合 MVP 验证但不适合长期暴露 | `docs/setup-hermes-queue.sql` |
| `reports` 在不同 SQL 文件中存在两套设计, 字段和 RLS 策略需要以线上实际执行版本为准 | `docs/setup-supabase-v2.sql`, `docs/setup-v0.1-upgrade.sql`, `docs/fix-reports-schema.sql` |
| 飞书自动化依赖多组外部 env 和 secrets, 包括 Supabase、MiniMax、飞书机器人、飞书应用和 Bitable token, 任一缺失会中断对应链路 | `docs/feishu-automation.md`, `.github/workflows/hermes-decompose.yml` |
| 飞书中文 payload 曾出现编码问题, 部分路由已用 `arrayBuffer` + `TextDecoder("utf-8")` 规避, 但不是所有飞书入口都完全一致 | `src/app/api/feishu/requirement/route.ts`, `src/app/api/feishu/codex-task/route.ts`, `src/app/api/feishu/decompose-callback/route.ts` |
| `src/types/supabase.ts` 仍是占位类型, 真实 Supabase 表结构没有由 CLI 类型完整生成 | `src/types/supabase.ts` |
| 仓库同时存在 `main`、`master`、`dev`、`staging` 等分支, 项目文档要求日常 PR target 为 `dev`, 但当前本地工作分支为 `master` | `README.md`, `AGENTS.md` |
