## 本次修改内容


## 关联任务

Feishu Task ID:


## 修改页面


## Codex 必读

> 如果是 @codex 提的 PR, 自动触发 `@codex review`.
> 如果是人提的 PR, 不用手动 @codex (Codex 接到 notification 也会 review).

## 测试方式

- [ ] 本地运行通过 (`npm run dev` 无 console 错)
- [ ] 构建通过 (`npm run build` 0 错)
- [ ] Lint 通过 (`npm run lint` 0 错)
- [ ] Typecheck 通过 (`npx tsc --noEmit` 0 错)
- [ ] 移动端检查 (浏览器 devtools 切到 375px / 768px)
- [ ] 无明显控制台报错 (F12 console 空白)

## AGENTS.md 13 禁止事项自检

- [ ] 没直接 push main
- [ ] 没改生产数据库
- [ ] 没引入大型依赖 (如有, 在 PR 描述解释为什么)
- [ ] 没绕过 / 删除测试
- [ ] 没硬编码任何生产 key
- [ ] 没 commit `.env.local` / `.env`
- [ ] 没改 `.env.ts` / `supabase.ts` 基础设施 (如是, 在 PR 描述解释)
- [ ] 没改 `package.json` / `package-lock.json` (除非 npm 自动)
- [ ] 没改 `.github/workflows/` / `CODEOWNERS` (如是, 在 PR 描述解释)
- [ ] 没改 Vercel env vars (这个由人配, 不会在 PR 里改)
- [ ] 没部署到 production (Vercel 自动部署到 preview 即可)
- [ ] 没改支付逻辑 (本项目暂无)
- [ ] 没批量群发用户消息 (飞书)

## 风险点


## 截图 / 预览链接

Vercel Preview URL:


## 是否需要老板验收

- [ ] 是
- [ ] 否
