## Codex PR 模板 (简化版)

> 这个模板专门给 Codex 提的 PR 用, 字段更少, 必填项更聚焦.
> 普通 PR 用 `pull_request_template.md` (完整 6 字段).

## 本次修改

(1-2 句话, 改动概览)

## 关联任务

Issue: #
Feishu Task ID:

## 必填 checklist (Codex 必走)

- [ ] 我在 feature 分支 `codex/<name>` (不是 main, 不是 dev)
- [ ] 我没改 AGENTS.md 第 "禁止事项" 段任一条
- [ ] 我没改 `src/lib/env.ts` / `src/lib/db/` / `src/app/api/` (除非 issue 明确要求)
- [ ] 我没加新依赖 (除非 issue 明确要求)
- [ ] 我没改 Vercel env vars / 部署配置
- [ ] 我没 commit `.env.local` / `.env` / 任何 secret
- [ ] commit author email 是 `codex@users.noreply.github.com`
- [ ] 本地跑过 `npm run lint && npm run build` 全过
- [ ] 本地跑过 `npx tsc --noEmit` 0 错
- [ ] PR 描述里我已说明测试方式 (怎么验证我的改动 work)

## Vercel Preview

(自动生成) Vercel 会在 PR 评论里发 Preview URL, 人类会点开看

## 风险

(1-2 句: 这次改有什么副作用? 需不需要人类额外验证?)

## 截图 (UI 改动时)

(贴图)
