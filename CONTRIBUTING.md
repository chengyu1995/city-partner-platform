# Contributing to city-partner-platform

> 感谢考虑贡献! 这个项目用 Hermes + Codex + 人类三方协作模式. **请先读**这个文件, 了解工作流.

## 三种 contributor

| 角色 | 谁 | 能做 | 不能做 |
|---|---|---|---|
| 🧑 **人类 (chengyu1995)** | 你 | 一切, 包括最终合并 | — |
| 🤖 **Codex** | OpenAI Codex GitHub App | 写代码, 提 PR, review | 合并 main, 改生产, 删仓库 |
| 👤 **外部人类** | 任何 issue 提者 | 提 issue, 评论, 小 PR | 没仓库写权限 (除非接受 PR) |

## 仓库规则 (人类 + Codex 都遵守)

### 工作流 (提交代码)

1. **从 `dev` 创建分支**:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b <type>/<short-name>
   # type: feat / fix / chore / docs / refactor / test
   ```

2. **本地验证**:
   ```bash
   npm run lint        # 0 错
   npm run build       # 0 错
   npx tsc --noEmit    # 0 错
   ```

3. **Commit 规范**:
   - author email 必须是 `chengyu1995@users.noreply.github.com` 或 `codex@users.noreply.github.com`
   - 不允许 `xxx@local` / `claude@anthropic` / `gpt@openai` 等内部邮件
   - 格式: `类型: 描述` (e.g. `feat: 加活动分享按钮`)

4. **Push + 创 PR**:
   ```bash
   git push -u origin <branch>
   # 然后 GitHub 网页创 PR
   ```
   - **PR target = `dev`** (不是 main)
   - 填 PR 模板的 6 个字段
   - CI 必须过

5. **等 review**:
   - 人类 PR → Codex 自动 review
   - Codex PR → 人类 review (CODEOWNERS 自动指派)
   - 至少 1 个 approve

6. **人类合并**:
   - Codex **不能**合并自己的 PR
   - 合并后删除 feature 分支

### 禁止事项 (违反任一 = PR 被拒)

详见 [`AGENTS.md`](./AGENTS.md) 第 "禁止事项" 段. 摘要:

- 直接 push `main`
- 改生产环境变量 (Vercel env vars)
- 改 `src/lib/env.ts` 业务双轨 (除非明确讨论过)
- 删 GitHub 仓库 / Supabase 项目
- 部署到 production (Vercel 自动部署到 preview 即可)
- 改支付逻辑
- 批量群发用户消息
- 引入大型依赖 (>1MB)
- 绕过 / 删除测试
- 硬编码任何生产 key
- commit `.env.local` / `.env`

### 必读文件 (提交前)

- [`README.md`](./README.md) — 项目总览
- [`AGENTS.md`](./AGENTS.md) — agent 规则 (Codex 必读)
- [`docs/CODEX_SETUP.md`](./docs/CODEX_SETUP.md) — Codex 集成
- [`docs/GITHUB_SETUP.md`](./docs/GITHUB_SETUP.md) — 分支保护
- [`docs/setup-supabase.md`](./docs/setup-supabase.md) — 数据库

## Issue 模板

- **Agent task** — AI agent 接的 (Codex / Claude Code)
- **Codex 集成测试** — 验证 Codex 集成
- **Bug report** — 标准 bug
- **Feature request** — 新功能

## PR 模板

填 6 个字段:

1. 本次修改内容
2. 关联任务 (Feishu Task ID)
3. 修改页面
4. 测试方式 (6 项 checklist)
5. AGENTS.md 13 禁止事项自检
6. 风险点 + 截图 + 是否需要老板验收

## 跟 Hermes 的关系

```
飞书群 (用户)
  ↓ 提需求
飞书 Bitable (需求池)
  ↓ 新行触发
Webhook → Hermes 拆任务
  ↓ 子任务清单
Codex 接任务 → 提 PR (target = dev)
  ↓ 人类 review
main (生产)
```

Codex 是开发环节, Hermes 是入口 + 拆任务 + 汇报环节. 互不冲突.

## 求助

- **Slack/Discord** (如有): ...
- **GitHub Issues**: 用 bug 模板
- **Email**: ...
- **飞书群**: 业务群

## 行为准则

- 尊重所有 contributor
- 提 issue 时**包含** 复现步骤 / 期望 / 实际
- 改 PR 时**对应** review 反馈
- 不在 issue / PR 灌水

## 许可证

本项目用 **MIT License**. 贡献即同意你的代码用 MIT 发布.
