# GitHub 仓库配置指南 (chengyu1995/city-partner-platform)

> 预计 5-10 分钟。**只做一次**。

## 0. 现状

✅ **已完成** (我做的)：
- 仓库创建: https://github.com/chengyu1995/city-partner-platform
- 3 个分支: main / staging / dev
- Issue 模板: `.github/ISSUE_TEMPLATE/agent-task.md`
- PR 模板: `.github/pull_request_template.md`
- 9 commits on main

❌ **你做**（GitHub 网页操作）：
- main 分支保护规则
- staging / dev 分支保护（可选）
- Codex 权限隔离
- 生产 secrets 隔离
- (可选) CI workflow

---

## 1. main 分支保护规则（必做）

> 这是"防止 AI 把线上弄坏"的核心防线。

1. 打开 https://github.com/chengyu1995/city-partner-platform/settings/branches
2. 点 **Add branch protection rule**
3. **Branch name pattern**: 填 `main`
4. 勾选以下选项：

| 选项 | 必勾? | 作用 |
|---|---|---|
| **Require a pull request before merging** | ✅ 必勾 | 禁止直接 push, 必须 PR |
| **Require approvals** | ✅ 必勾 | 至少 1 个 review |
| **Dismiss stale pull request approvals when new commits are pushed** | ✅ 推荐 | 新 commit 推上来后,旧 approval 失效 |
| **Require status checks to pass before merging** | ✅ 必勾 | CI 必须通过 |
| **Require linear history** | ❌ 跳过 | 允许 merge commit, 调试方便 |
| **Include administrators** | ✅ 必勾 | 管理员也受保护, 避免你手快直接 push |
| **Do not allow force pushes** | ✅ 必勾 | 禁止 `git push -f` 到 main |
| **Allow deletions** | ❌ 取消 | 禁止删 main 分支 |
| **Allow force with lease** | ❌ 跳过 | |

5. 点 **Create** 保存

**Status checks** 那段先空着, 等第 4 节配好 CI 后回来选 check name。

---

## 2. staging / dev 分支保护

### 2a. staging 保护 (推荐)

跟 main 一样, 但 **不需要 review** (你自己直接合并验收用):
- `Require a pull request before merging` 勾
- `Require approvals` **不勾**
- `Include administrators` 勾
- `Do not allow force pushes` 勾
- 名字: `staging`

### 2b. dev 保护 (Codex 日常开发用)

**最宽松**:
- `Require a pull request before merging` 勾 (Codex 提交 PR, 你/Hermes 决定要不要合)
- `Require approvals` 不勾 (Hermes 申请合并时 review)
- `Include administrators` 勾
- `Do not allow force pushes` 勾
- 名字: `dev`

### 2c. (推荐) 把 main 设为默认分支

1. https://github.com/chengyu1995/city-partner-platform/settings/branches
2. 右上 **"Switch to another branch"** 旁边的 ⚙ → **Set as default**
3. 选 `dev` (开发最常起步的分支)

---

## 3. Codex / AI 工具权限隔离

### 3a. 现状分析

- Codex 用 **你的 GitHub 账号** 跑 (通过 PAT 或 GitHub App)
- 你账号有 repo 完整权限
- **无法在 GitHub 层面**区分"你本人" vs "AI 工具"
- **靠 main 分支保护**强制 AI 不能直接合 main

### 3b. 关键保护

- **main 受保护** (第 1 节) → 任何 push 到 main 被拒, 必须走 PR
- **Codex 必须配 fine-grained PAT**, 只勾 `Contents: Read and write`, **不勾** `Administration: write` (避免 Codex 改仓库设置 / 删分支)
- **不要给 Codex classic PAT** (classic PAT 权限太大)

### 3c. (可选) 用 GitHub App 隔离 Codex

如果你想更严格:
1. 创建一个新的 GitHub account `codex-bot`
2. 用这个账号跑 Codex
3. 加 `codex-bot` 为仓库 collaborator, 权限只勾 `Write`
4. 它在分支保护下, 仍然不能直 push main

---

## 4. 生产环境 secrets 隔离

### 4a. 仓库 Secrets (供 Vercel / GitHub Actions 用)

1. https://github.com/chengyu1995/city-partner-platform/settings/secrets/actions
2. **New repository secret**, 加生产环境的真 key:
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://qfubesklrqoqvuufefvq.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `sb_publishable_OdQg2aC_56JDrEwjrXK6lA_VdzfxR2Q` (这个是 publishable 可以暴露)
   - **`SUPABASE_SERVICE_ROLE_KEY` 不要加到仓库 secrets** (它只用于服务端, Vercel 在自己的环境变量里设)
3. ⚠️ **永远不要**把 `SUPABASE_SERVICE_ROLE_KEY` 写进仓库 secrets, 因为:
   - GitHub Actions log 可能会 echo 它
   - 任何贡献者都能看到 (如果你后来开 PR)
   - Vercel 自己有项目级 env vars, **用那边**

### 4b. Vercel 项目级 env vars (推荐)

1. https://vercel.com → 选项目 → Settings → Environment Variables
2. 加:
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://qfubesklrqoqvuufefvq.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = (同左)
   - `SUPABASE_SERVICE_ROLE_KEY` = (同左, **Vercel 会加密存**)
3. **不要**把同样变量名加到 GitHub 仓库 secrets (双源真相会乱)

### 4c. Codex 看到的 env

- Codex 跑在你 **Codespace / 容器**里
- **看不到**仓库 secrets (除非你显式 `secrets.X` 引用)
- **看不到** Vercel env vars
- **只能看到** `.env.local` (本地开发, 你手动建, 已经在 .gitignore)
- **所以**: 你本地 `.env.local` 里的 key 不会被 Codex 看到, 也不会被 push

---

## 5. (推荐) CI 检查 workflow

> 让 main 保护规则里的 "Require status checks" 有东西可勾。

### 5a. 基础 CI: 跑 `npm run build` + `npm run lint`

新建 `.github/workflows/ci.yml`(让我帮你写也行):

```yaml
name: CI
on:
  push:
    branches: [main, staging, dev]
  pull_request:
    branches: [main, staging, dev]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run build
        env:
          # CI 跑 build 不需要真 Supabase, 用占位
          NEXT_PUBLIC_SUPABASE_URL: https://placeholder.supabase.co
          NEXT_PUBLIC_SUPABASE_ANON_KEY: placeholder
```

### 5b. 回到 main 保护规则, 加上 status check

1. https://github.com/chengyu1995/city-partner-platform/settings/branches
2. 编辑 `main` 规则
3. **"Require status checks to pass before merging"** 段
4. 搜 `build` (上面 workflow 里的 job 名), 勾上
5. 保存

---

## 6. 验证所有规则都生效

1. 切到 dev 分支
2. 改一个文件
3. `git commit` + `git push` (应该 OK, dev 没要求 review)
4. 创建 PR: dev → main
5. **应该看到**:
   - "Review required" 提示
   - CI check 在跑
   - 不能直接 Merge
6. 等 CI 跑完
7. 用另一个账号 / 朋友 review + approve
8. 才能 Merge

---

## 7. 何时需要 review

| 谁 | 能合并哪个 |
|---|---|
| 你 (admin) | **任何** (但 main 必须先自己 PR 1 个 review) |
| Hermes | dev / staging (PR 形式) |
| Codex | dev (PR 形式, 不能合) |

如果只有你一个人, 那"review" 可以是:
- 你**用另一个浏览器**登录另一个 GitHub 账号
- 或者用 [pull request reviews by CODEOWNERS](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#code-owners) 自动通过
- 或者暂时**关掉 review 要求**直到你有团队

---

## 8. 检查清单 (做完后)

- [ ] main 保护: Require PR + 1 approval + status check + include admins + 禁 force push
- [ ] staging 保护: Require PR, no review, 禁 force push
- [ ] dev 保护: Require PR, no review, 禁 force push
- [ ] 默认分支设为 dev
- [ ] Codex PAT 是 fine-grained, 只勾 Contents: Read and write
- [ ] Vercel 项目级 env vars 配齐 (不要复制到 GitHub secrets)
- [ ] CI workflow 加了, 跑过
- [ ] main 保护规则里加了 status check (`build` job)

---

## 9. (可选) 给未来 Agent 工作流

把 `agent-task.md` 模板 + `pull_request_template.md` 模板**已自动**套用到:
- 新建 issue 时, "Agent task" 模板可选
- 创建 PR 时, 自动套用 PR 模板内容

Codex / Cursor / Claude Code 看到这些模板, 就会知道要按这个格式交付。
