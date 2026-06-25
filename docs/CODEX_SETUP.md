# OpenAI Codex 配置指南 (chengyu1995/city-partner-platform)

> 预计 15-20 分钟。**只做一次**。

## 1. Codex 是什么 / 不是什么

| ✅ Codex 能做 | ❌ Codex 不能做 |
|---|---|
| 读仓库代码 | 决策"用哪个方案" |
| 在 feature 分支写代码 | 直接 push main / 合并 main |
| 修 bug, 写测试 | 改生产环境变量 |
| 提 PR (target = `dev`) | 部署到 production |
| review 别人的 PR | 改支付逻辑 |
| 在 PR 评论 | 批量群发用户消息 |
| 跑 CI (lint / build / typecheck) | 改 Supabase RLS / schema |

> **Codex 是开发者, 不是决策者** — 复杂决策必须人拍板。

## 2. 启用 OpenAI Codex GitHub App 集成

### 2a. 在 ChatGPT 里启用 Codex

1. 打开 https://chatgpt.com/codex
2. 用你的 OpenAI/ChatGPT 账号登录
3. 第一次会引导连 GitHub
4. 授权 Codex GitHub App 访问 `chengyu1995/city-partner-platform` 仓库

### 2b. 权限范围设置

Codex GitHub App 需要的最小权限:

| 权限 | 范围 | 必勾? |
|---|---|---|
| Read access to metadata | 必勾 | ✅ |
| Read access to code | 必勾 | ✅ |
| **Read and write access to issues** | 必勾 | ✅ (Codex 在 issue 上接任务) |
| **Read and write access to pull requests** | 必勾 | ✅ (核心) |
| **Read and write access to contents** | 必勾 | ✅ (写代码) |
| **Read access to workflows** | 可选 | ✅ (跑 CI) |
| **Read and write access to actions** | 可选 | ❌ (Codex 不该触发 workflow) |
| **Administration** | 必不勾 | ❌ (防删仓库) |
| **Pages** | 必不勾 | ❌ |
| **Webhooks** | 必不勾 | ❌ |

### 2c. 验证 Codex 接入

1. Codex 装好后, 去 https://github.com/chengyu1995/city-partner-platform/settings/installations
2. 应该看到 "OpenAI Codex" 这个 GitHub App
3. 配置: Repository access = "Only select repositories" → 选 city-partner-platform

## 3. Codex 任务工作流 (AGENTS.md 详细规则)

**任务来源**:
- 飞书需求池 Bitable 新行 (自动通过 webhook → Hermes 拆任务 → Codex 接子任务)
- 你手动在 GitHub Issue 用 `agent-task.md` 模板提
- 你在 PR 里 @codex 触发 review

**Codex 接到任务后**:

1. **读 `AGENTS.md`** — 顶部有 13 个禁止事项, 违反任一 = 拒绝合并
2. **创建 feature 分支** from `dev`:
   ```bash
   git checkout dev && git pull
   git checkout -b codex/<short-name>
   ```
3. **写代码 + 测试** — 必须本机过 `npm run lint && npm run build && npx tsc --noEmit`
4. **Commit**:
   - author email 必须是 `codex@users.noreply.github.com` (匹配 Codex 的 GitHub App bot)
   - 不允许 `hermes@local` / `claude@anthropic` / `codex@openai`
5. **Push + 创 PR** (target = `dev`, **不是 main**):
   - PR 描述用 `pull_request_template.md` 的 6 个字段
6. **Codex 自我 review** (CI 跑过)
7. **等 chengyu1995 review** + approve
8. **人合并 PR** (Codex 不合并 main)

## 4. PR review 触发方式

### 4a. 手动 @codex review (推荐起步)

在 PR 评论里:
```
@codex review
```
Codex 会自动 review, 检查 AGENTS.md 13 条规则 + CI 通过 + diff 合理性。

### 4b. 自动 review (高级, 可选)

加 GitHub Action 触发 Codex review:
- 当 PR 提到 `dev` 分支时, 自动 @codex
- 见第 7 节

### 4c. Review 指南 (Codex review 时看这个)

`AGENTS.md` 第 "Codex 怎么 review 别人的 PR" 段列了 5 步:
1. 读 PR 描述 (6 字段都填了吗?)
2. 读 commit diff (动了基础设施文件没?)
3. 跑 CI (lint + build + typecheck 都过?)
4. 检查 13 条禁止事项
5. 任一违反 → 拒绝 merge

## 5. 权限隔离 3 层防线

| 防线 | 机制 | Codex 状态 |
|---|---|---|
| **第 1 层** | GitHub App 权限 (见 2b 表) | Codex 只能读+写 PR/代码, 不能改 admin |
| **第 2 层** | Git 分支保护 (main 强制 PR + 1 review) | Codex push main 被 GitHub 拒 |
| **第 3 层** | CODEOWNERS 自动指派 review | 改基础设施必须有 chengyu1995 review |

3 层叠加 = **Codex 物理上无法**:
- 删仓库 (没 Administration 权限)
- 改生产 env (env vars 在 Vercel, 不在 repo)
- 直接 push main (分支保护)
- 合并自己的 PR (CODEOWNERS 强制人 review)

## 6. Codex 不应直接做的事 — 列表

下面这些情况, **停下 + 报告人类**, 不要自己拍板:

- 任务描述不清
- 多个解法, 不知道选哪个
- 改 `src/lib/env.ts` (mock/真 Supabase 双轨核心)
- 改 `src/lib/db/` 业务入口
- 改 `src/app/api/` 任何 route
- 加新依赖 (任何 package.json 改动)
- 改 `package-lock.json` (除非 `npm install` 自动产生)
- 改 `tsconfig.json` / `next.config.ts` / `components.json`
- 改 `.github/workflows/` / `.github/CODEOWNERS` / `.gitignore`
- 部署到 production (Vercel 部署只能人触发)
- 改 `docs/setup-supabase.md` / `docs/GITHUB_SETUP.md` / `docs/CODEX_SETUP.md`

## 7. (可选) 自动 review workflow

新建 `.github/workflows/codex-auto-review.yml`:

```yaml
name: Codex Auto Review
on:
  pull_request:
    branches: [dev, staging]
    types: [opened, synchronize, reopened]

jobs:
  request-review:
    runs-on: ubuntu-latest
    steps:
      - name: Comment to request Codex review
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: '@codex review'
            });
```

**注意**:
- 这会让 Codex 在每个 PR **自动**被 @review
- 资源消耗: Codex API 收费, 自动 review 会增加 cost
- **建议**: 起步**关闭**自动 review, 等你熟悉 Codex 后再开

## 8. Codex 任务示例 (你 issue 模板 agent-task.md)

```markdown
## 任务名称
给 /activities/[id] 页面加分享按钮

## 关联飞书需求 ID
feishu-rec-001

## 背景
现在活动详情页没法分享到微信, 用户反馈多次

## 需求说明
1. 在活动详情页右上角加"分享"按钮
2. 点击复制活动链接到剪贴板
3. 复制成功 toast 提示

## 验收标准
- [ ] 按钮在桌面和移动端都显示
- [ ] 复制内容是 https://city-partner-platform.vercel.app/activities/<id>
- [ ] 复制成功显示 "已复制" toast 2 秒

## 技术要求
- Next.js
- TypeScript
- Tailwind CSS
- Supabase

## 禁止事项
(同 AGENTS.md 13 条)

## 输出要求
- PR 链接
- 修改文件列表
- 测试方式
- 风险说明
```

Codex 接到这个 issue 后会自动:
1. 创建 `codex/activities-share-button` 分支 from dev
2. 改 `src/app/activities/[id]/page.tsx` + `src/components/ui/button.tsx` (用现有 button 加 asChild)
3. 写测试 (vitest 或 playwright)
4. 跑 CI 全过
5. 提 PR (target = dev)
6. 评论 `@codex review` 触发自我 review
7. 等你 review + 合并

## 9. 监控 Codex 行为

- **GitHub 活动**: https://github.com/chengyu1995/city-partner-platform/settings/installations → OpenAI Codex → Activity
- **Codex 用量**: https://chatgpt.com/codex/settings
- **PR 历史**: https://github.com/chengyu1995/city-partner-platform/pulls?q=is%3Apr+author%3Acodex

## 10. 故障排查

| 问题 | 原因 | 修法 |
|---|---|---|
| Codex 接到任务但没反应 | GitHub App 权限不对 | 重新装, 确认勾了 6 个权限 (2b 表) |
| Codex 推 PR 失败 (commit email) | Codex 用了 `codex@openai.com` 等 | 跟 Codex 文档说: 改用 `codex@users.noreply.github.com` |
| Codex 合并了 PR 到 main | 分支保护没配 | 配 main 保护: `docs/GITHUB_SETUP.md` 第 1 节 |
| Codex 改了基础设施文件 | CODEOWNERS 没生效 | 确认 `.github/CODEOWNERS` 在 repo, 改基础设施必须人 review |
| Codex 持续提低质量 PR | Review 没认真 | 调 PR 模板更严格, 加 checklist |

## 11. 与 Hermes 的关系

```
飞书群 (用户)
  ↓ 提需求
飞书 Bitable (需求池)
  ↓ 新行触发
Webhook → Hermes (云端 webhook 入口)
  ↓ LLM 拆子任务
Codex 任务清单
  ↓ Codex 接每个子任务
GitHub PR (target = dev)
  ↓ 人类 review
main (生产)
```

**Codex 是开发环节, Hermes 是入口/拆任务/汇报环节**. 它们不冲突:
- Hermes 看仓库元数据 (issue, PR 列表)
- Codex 看代码 (实际写代码)

---

**Last updated**: 2026-06-13
