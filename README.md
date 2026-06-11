# 同城搭子平台 (city-partner-platform)

> MVP 脚手架。技术栈：Next.js 16 + React 19 + TypeScript + Tailwind CSS v4 + 经典 shadcn/ui + Supabase。
> 数据层双轨：Supabase env 缺失时**自动 fallback 到 in-memory mock**，填真 key 切真数据库。

## 项目状态

| 项 | 状态 |
|---|---|
| Next.js | 16.2.9 (Turbopack) |
| React | 19.2.4 |
| Tailwind | v4 |
| shadcn/ui | 经典版（slate 主题，Radix Slot + asChild） |
| shadcn 组件 | button / card / input / label / dialog / avatar / separator |
| Supabase | `@supabase/ssr` + `@supabase/supabase-js`（mock 双轨） |
| Build | ✅ 通过（6 路由） |
| GitHub | 3 分支 (main/staging/dev) + 模板, 8 commits |
| 本地位置 | E:\projects\city-partner-platform (C 盘 junction 透明访问) |

## 快速开始

```bash
# 1. 装依赖（已装可跳过）
npm install

# 2. (可选) 接 Supabase 真数据库
#    没填 .env.local 也能跑，会走 MOCK 模式
cp .env.example .env.local
# 编辑 .env.local 填入 Supabase URL + anon key + service role key
# 详细步骤: docs/setup-supabase.md

# 3. 起开发服
npm run dev
# 打开 http://localhost:3000
```

## 分支策略

| 分支 | 作用 | 谁可合并 |
|---|---|---|
| `main` | 正式生产 | **只有你**（受 GitHub 保护，需 PR + review） |
| `staging` | 验收测试 | 你 + Hermes |
| `dev` | 日常开发 | 你 + Hermes + Codex（PR 形式） |

Codex **只能**在 `dev` 上提交 PR，**不能**直接 push 任何分支。

## 路由

| 路径 | 用途 |
|---|---|
| `/` | 首页 |
| `/activities` | 活动列表（SSR，从 DB 或 mock 读） |
| `/activities/[id]` | 活动详情 |
| `/activities/new` | 发起活动表单（server action） |
| `/test-supabase` | Supabase 本地连通性测试页 |

## 数据流

```
UI 组件（Server Component）
  ↓ import
src/lib/db/activities.ts      ← 业务代码统一入口
  ↓ 内部判断
src/lib/env.ts (IS_MOCK_MODE) ─┬─ true → src/lib/db/mock.ts (in-memory)
                                └─ false → @supabase/ssr → 真数据库
```

业务代码只需要 `import { listActivities, createActivity } from "@/lib/db"`，**不用关心**当前是真 Supabase 还是 mock。

## 项目结构

```
.
├── .github/
│   ├── ISSUE_TEMPLATE/agent-task.md   # AI agent 任务模板
│   └── pull_request_template.md       # PR 模板
├── docs/
│   ├── setup-supabase.sql
│   └── setup-supabase.md
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── globals.css
│   │   ├── activities/
│   │   │   ├── page.tsx
│   │   │   ├── [id]/page.tsx
│   │   │   └── new/
│   │   │       ├── page.tsx
│   │   │       ├── actions.ts
│   │   │       └── client-validate.ts
│   │   └── test-supabase/page.tsx
│   ├── components/ui/
│   ├── lib/
│   │   ├── env.ts
│   │   ├── db/
│   │   │   ├── activities.ts
│   │   │   ├── mock.ts
│   │   │   └── index.ts
│   │   └── utils.ts
│   └── types/db.ts
├── components.json
├── AGENTS.md / CLAUDE.md
└── .env.example
```

## 脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 起开发服 |
| `npm run build` | 生产构建 |
| `npm start` | 跑生产构建 |
| `npm run lint` | ESLint |

## 文档

- **[`PUSH_TO_GITHUB.md`](./PUSH_TO_GITHUB.md)** — 推到 GitHub 步骤
- **[`docs/GITHUB_SETUP.md`](./docs/GITHUB_SETUP.md)** — 分支保护规则、Codex 权限、CI 建议
- **[`docs/setup-supabase.md`](./docs/setup-supabase.md)** — 接 Supabase 真数据库
- **`src/lib/env.ts` 顶部注释** — env 设计原理

## 下一步

- [ ] GitHub 网页设分支保护规则（`docs/GITHUB_SETUP.md`）
- [ ] 部署到 Vercel
- [ ] 接登录（决策 MVP 是否先做）
- [ ] 接入飞书需求池 webhook（已在 Hermes 端搭好）
- [ ] 接入飞书通知机器人（已完成）
- [ ] 跑 Codex 拆任务 → PR 流程

## 跟 Hermes/飞书的关系

```
飞书群通知员 (Bot 1) ──→ 群成员看
                ↑
                │  notify.py 主动推
                │
Hermes (本机) ───┴──→ 飞书 Bitable 新行 (Bot 2) ──→ webhook_server.py
       ↑                                                ↓
       └──── cron 每分钟消费队列 ←── results/.md ←──┘
```

两个飞书通道独立，但可以打通：consume_queue.py 跑完后调 notify.py 回写到群。
