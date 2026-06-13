<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

---

<<<<<<< Updated upstream
# Agent 协作规则 (Codex / Cursor / Claude Code / 等)

> 本节是给所有 AI coding agent 看的统一规则。OpenAI Codex 接 GitHub PR 集成时会读这个文件。

## 项目定位

**MVP 脚手架**:
- Next.js 16 (Turbopack) + React 19 + TypeScript + Tailwind CSS v4
- 经典 shadcn/ui (slate 主题, Radix Slot, asChild) — **不是**新 shadcn 4.x base-nova
- Supabase 数据访问层双轨 (env 缺失 → MOCK 模式; env 配齐 → 真 Supabase)
- 3 个 Git 分支: main (生产) / staging (验收) / dev (开发)
- 部署: Vercel (生产域名 `city-partner-platform.vercel.app`)

## 禁止事项 (违反任何一条 = 拒绝合并)

| 类别 | 禁止 | 后果 |
|---|---|---|
| **分支** | 直接 push `main` | GitHub 保护规则拒绝, push 失败 |
| **分支** | 直接合并 PR 到 `main` | 需人类 review + 至少 1 approve |
| **基础设施** | 删除 GitHub 仓库 | Codex 无此权限 (PAT scope 限制) |
| **基础设施** | 删除 Supabase 项目 / 表 / 数据 | service_role key 不给 agent, 走 RLS 限定操作 |
| **基础设施** | 修改生产环境变量 | Vercel env vars 不在仓库, agent 看不到 |
| **生产** | 正式上线 (部署到 production) | 只有人能触发 Vercel production deploy |
| **业务** | 改支付逻辑 (暂无) | 加 PR review 强制人 review |
| **业务** | 批量群发用户消息 (飞书) | 不允许改 `notify.py` 任何循环发送 |
| **依赖** | 引入大型依赖 (>1MB) | 走 PR review, 解释必要性 |
| **依赖** | 绕过测试 / 删测试 | 走 PR review, 解释必要性 |
| **数据** | 硬编码任何生产 key | pre-commit hook 检查 |
| **数据** | commit `.env.local` / `.env` | `.gitignore` 已保护, 但 agent 不能 `git add -f` |

## 允许事项

- 读取仓库 (读所有 .md / 源码)
- 创建分支 (必须基于 `dev`, 命名 `codex/feature-name`)
- 提交代码 (在自己的 feature 分支)
- 创建 PR (PR target = `dev`, 不直接对 main)
- 评论 PR / 写 review
- 修复 bug
- 写测试 (单测 / 端到端)
- 重构 / 重命名 / 格式化

## 必备工作流

每个 Codex 任务必须**严格**按这个流程:

1. **从 `dev` 创建 feature 分支**:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b codex/<short-task-name>
   ```

2. **本地开发 + 验证**:
   - `npm run dev` 起本地服务
   - `npm run lint` 跑 lint
   - `npm run build` 跑 build
   - `npm run typecheck` (用 `npx tsc --noEmit`)
   - **所有都过**才能 commit

3. **Commit 规范**:
   - author email 必须是 `chengyu1995@users.noreply.github.com` 或 `codex@users.noreply.github.com` (匹配 GitHub 账号)
   - 不允许 `hermes@local` / `claude@anthropic` / `codex@openai` 等内部邮件
   - commit message 写中文或英文, 但格式: `类型: 描述`
   - **不要 force push**

4. **推自己的 feature 分支**:
   ```bash
   git push -u origin codex/<short-task-name>
   ```

5. **创建 PR (target = `dev`)**:
   - 标题简短 (50 字符内)
   - 描述**必须**填 PR 模板的 6 个字段
   - 等 review (人类或 Codex 自身)
   - review approve 后**人类**合并

6. **删除 feature 分支** (合并后):
   ```bash
   git branch -d codex/<short-task-name>
   git push origin --delete codex/<short-task-name>
   ```

## Codex 必读文件 (接到任务前先读这些)

- `README.md` — 项目总览
- `docs/setup-supabase.md` — 数据库结构
- `docs/GITHUB_SETUP.md` — GitHub 集成 (跟你 PR 直接相关)
- `docs/CODEX_SETUP.md` — Codex 集成与权限 (你正在读 AGENTS.md 这节, 跟 CODEX_SETUP.md 配合)
- `AGENTS.md` (本文件) — 通用 agent 规则
- `CLAUDE.md` (如存在) — Claude Code 特定规则
- `src/lib/env.ts` — 业务代码 env 处理范式 (mock 模式)
- `src/lib/db/activities.ts` — 业务代码统一入口范式

## Codex 必避的坑
=======
# Codex 项目开发规则 (city-partner-platform)

> 这个文件是 OpenAI Codex / Claude Code / Cursor 等 AI agent 接 PR 时必读的"项目宪法".
> 任何 PR 违反下面规则 = 拒绝合并.

## 项目目标

开发一个**同城搭子平台**, 帮助用户寻找:
- 旅游搭子
- K 歌搭子
- 学习搭子
- 摩友
- 钓友
- 等兴趣伙伴

## 技术栈

- **前端**: Next.js 16 (App Router) + React 19 + TypeScript
- **样式**: Tailwind CSS v4 + 经典 shadcn/ui (slate 主题, Radix Slot + asChild)
- **数据**: Supabase (PostgREST + RLS) + 双轨模式 (env 缺失 → MOCK)
- **部署**: Vercel (生产域名 `city-partner-platform.vercel.app`)
- **CI**: GitHub Actions (lint + typecheck + build)
- **协作**: 飞书需求池 + Codex 拆任务 + Hermes 汇报

## 开发原则

### 1. 移动端优先
- 设计稿先想 375px (iPhone SE), 再扩到 768px / 1440px
- 触摸目标 ≥ 44x44 px
- 文字 ≥ 16px (iOS 不缩放)

### 2. UI 年轻、社交化、简洁
- 目标用户: **20-35 岁同城兴趣社交用户**
- 风格关键词: 年轻 / 轻社交 / 城市生活 / **卡片式** / 移动端舒服
- **不要**像后台系统
- 多留白, 大圆角 (rounded-2xl / rounded-3xl), 柔和阴影
- 配色: 不用纯黑白, 用 slate + accent 色

### 3. 不要过度工程化
- **MVP 阶段优先上线**, 不追求复杂功能
- 一次只做一个最小可用切片
- 不预判未来需求

### 4. 工作流硬规则

| 规则 | 说明 |
|---|---|
| **每次任务必须新建分支** | 从 `dev` 拉 feature 分支, 命名 `codex/<short-name>` |
| **每次任务必须提交 PR** | PR target = `dev` (永远不是 main) |
| **不允许直接修改 main** | main 受 GitHub 分支保护, push 会失败 |
| **不允许删除已有功能** | 重构要保留所有 API 兼容 |
| **不允许修改生产数据库** | Supabase RLS 限定, agent 看不到 service_role |
| **不允许引入不必要的大型依赖** | 走 PR review, 解释必要性 |
| **不确定时, 把问题交给 Hermes, 让老板选择** | 拍板不是 agent 的工作 |

### 5. AGENTS.md 13 禁止事项 (跟上面"硬规则"互补)

1. ❌ 直接 push main
2. ❌ 删除 GitHub 仓库 / Supabase 项目
3. ❌ 修改生产环境变量 (Vercel env vars)
4. ❌ 部署到 production (Vercel 自动 preview 即可)
5. ❌ 改支付逻辑 (本项目暂无, 但仍禁)
6. ❌ 批量群发用户消息 (飞书)
7. ❌ 引入 >1MB 依赖
8. ❌ 绕过 / 删除测试
9. ❌ 硬编码任何生产 key
10. ❌ commit `.env.local` / `.env`
11. ❌ 改 `src/lib/env.ts` 业务双轨 (除非明确讨论)
12. ❌ 改 `package.json` / `package-lock.json` (除非 npm 自动)
13. ❌ 改 `.github/workflows/` / `CODEOWNERS` / `.gitignore`

## PR 输出格式 (Codex 必填)

每个 PR 描述必须包含这 6 段:

```markdown
## 本次修改内容
(1-3 句话, 改动概览)

## 修改文件
- `src/xxx.tsx` (+30 -5)
- `src/yyy.ts` (新, 50 行)

## 测试方式
- [ ] 本地运行通过 (`npm run dev` 无 console 错)
- [ ] 构建通过 (`npm run build` 0 错)
- [ ] Lint 通过 (`npm run lint` 0 错)
- [ ] Typecheck 通过 (`npx tsc --noEmit` 0 错)
- [ ] 移动端检查 (375px / 768px)
- [ ] F12 console 0 错

## 风险点
(1-2 句: 这次改有什么副作用? 需不需要人类额外验证?)

## 预览链接
(Vercel Preview URL, 推送后自动生成)

## 是否需要老板验收
- [ ] 是
- [ ] 否
```

## 页面风格参考

| 项 | 标准 |
|---|---|
| 圆角 | `rounded-2xl` (大块) / `rounded-lg` (按钮/输入框) |
| 阴影 | `shadow-sm` (轻) / `shadow-md` (卡片悬停) |
| 间距 | `gap-4` / `gap-6` (卡片间) |
| 文字 | 标题 `text-2xl`/`text-3xl`, 正文 `text-base`, 注释 `text-sm text-muted-foreground` |
| 配色 | 主色 `bg-primary text-primary-foreground` (不用纯黑/白) |
| 图标 | lucide-react 现有图标 (已经装好) |
| 头像 | 圆形 + border + 彩色 fallback (用户名首字) |
| 标签 | 圆角胶囊 `rounded-full px-3 py-1` |

## 必读文件 (接任务前)

- `README.md` — 项目总览
- `AGENTS.md` (本文件) — 项目宪法
- `docs/CODEX_SETUP.md` — Codex 集成指南
- `docs/GITHUB_SETUP.md` — 分支保护规则
- `docs/setup-supabase.md` — 数据库结构
- `src/lib/env.ts` — env 处理范式 (mock 模式)
- `src/lib/db/activities.ts` — 业务代码统一入口范式

## 必避的坑
>>>>>>> Stashed changes

| 坑 | 表现 | 修法 |
|---|---|---|
| 用 `localhost:3000` 测但端口被占 | dev server 起不来 | `netstat -ano \| findstr :3000` 找冲突进程, 或换端口 |
| 改了 `src/lib/env.ts` 的 fallback 逻辑 | mock 模式失效 | env.ts 是基础设施, 改前必须问人 |
| 直接改 `package.json` 加依赖 | 引入大型依赖 | 走 PR review, 解释为什么需要 |
<<<<<<< Updated upstream
| 用 `next/font/google` | 沙盒拉不到 Google Fonts | 改用系统字体, 已在 layout.tsx 修过 |
| 用了 `import { ... } from 'fs'` 在 client component | next.js 编译错 | `'use client'` 文件不能用 node 内置模块 |
| 创建 "use server" 文件但 export 同步函数 | "Server Actions must be async" | 同步函数移到 `'use client'` 文件单独 export |
| 在 server component 里 await 一个 sync 函数 | 编译错 | server component 全部 await async |

## Codex 怎么 review 别人的 PR

当被指派 review 一个 PR 时:

1. **读 PR 描述** — 6 个字段都填了吗? 没填 → 拒绝 review
2. **读 commit diff** — 改动大吗? 改了基础设施文件 (.env.ts, supabase.ts, package.json) → 叫人 review
3. **跑 CI** — `npm ci && npm run lint && npm run build` 全过吗?
4. **跑 typecheck** — `npx tsc --noEmit` 0 错吗?
5. **检查 13 个禁止事项** — 任一违反 → 拒绝 merge

## 求助 / 阻塞

如果遇到以下情况, **停下 + 报告人类**, 不要自己拍板:
=======
| 用 `next/font/google` | 沙盒拉不到 Google Fonts | 改用系统字体 |
| `"use server"` 文件 export 同步函数 | "Server Actions must be async" | 同步函数移到 `'use client'` 文件 |
| 在 server component 里 await sync 函数 | 编译错 | server component 全部 await async |
| `setState` 在 `useEffect` 里 | React 19 lint 警告 | 用 `useSyncExternalStore` |
| import `fs` / `path` 在 `'use client'` 文件 | next 编译错 | client component 只能用浏览器 API |

## 求助 / 阻塞

遇到下面情况, **停下 + 报告人类**, 不要自己拍板:
>>>>>>> Stashed changes

- 任务描述不清
- 多个解法, 不知道选哪个
- 改动会影响 mock/真 Supabase 双轨行为
- 需要新依赖
- CI 通过但本地跑不起来 (或反之)
- 跟现有功能冲突
<<<<<<< Updated upstream
=======
- 改基础设施 (env / db / api / workflows / package.json)
>>>>>>> Stashed changes

## 反馈循环

每个 PR 合并后:

<<<<<<< Updated upstream
1. **人类 review comments** — Codex 记下来, 下次同类问题不要犯
2. **CI failure** — Codex 自己修, 然后 push `--force-with-lease` (不是 `--force`)
=======
1. **人类 review comments** — 记下来, 下次同类问题不要犯
2. **CI failure** — 自己修, push `--force-with-lease` (不是 `--force`)
>>>>>>> Stashed changes
3. **Codex review feedback** — 跟人 review 同等对待

---

**Last updated**: 2026-06-13
