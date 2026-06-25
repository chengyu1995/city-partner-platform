## 任务名称

给首页加 dark mode 切换按钮

## 关联飞书需求 ID

N/A (Codex 集成测试用, 不走飞书)

## 背景

当前首页 https://city-partner-platform.vercel.app 一直显示亮色背景 (slate 主题), 用户没法定制 dark mode. 多个用户反馈夜间看刺眼.

技术栈已经用 Tailwind v4 + shadcn/ui (slate), 这两个都原生支持 dark mode (`dark:` class), 切换只需要在 `<html>` 标签加/去 `dark` class.

## 需求说明

1. **首页 (`src/app/page.tsx`) 右上角**加一个图标按钮 (用 lucide-react 现有的 `Sun` / `Moon` 图标, 已经装好).
2. 点击切换 `<html>` 标签的 `dark` class (用 `document.documentElement.classList`).
3. **持久化**选择到 `localStorage` (key: `theme`), 刷新页面后保持.
4. **避免 FOUC** (Flash of Unstyled Content): 在 `src/app/layout.tsx` 顶部加一个 `<script>`, 在 hydration 前读 localStorage 设置 `dark` class.
5. **图标**: 亮色模式显示 `Moon` (点击切到 dark), dark 模式显示 `Sun` (点击切回 light).

## 验收标准

- [ ] 首页右上角有图标按钮 (24x24 px, 跟导航栏对齐)
- [ ] 点击按钮: 亮色 → dark 模式, dark → 亮色
- [ ] 页面背景、文字、卡片、按钮**都跟着切换** (不只是按钮图标)
- [ ] 刷新页面后, 选中的模式**保持**
- [ ] 首页、/activities、/activities/[id]、/activities/new 4 个路由**都正常切换** (不只是首页)
- [ ] 移动端 (375px 宽) 按钮不溢出, 点击区域 ≥ 32x32 px
- [ ] F12 console 0 错
- [ ] 没引入新依赖 (用现有的 lucide-react)

## 技术要求

- Next.js 16 (App Router)
- TypeScript
- Tailwind CSS v4 (已配 dark mode, 看 `globals.css`)
- Supabase (不涉及)
- shadcn/ui 经典版 (用现有的 `Button` 组件 + lucide 图标)

## 禁止事项

(同 `AGENTS.md` 13 条禁止事项, 此处不重复)

**特别注意这次**:
- 不要改 `src/app/globals.css` (Tailwind v4 + slate 主题已配好 dark 模式, 不要重写)
- 不要引入 `next-themes` 等大型依赖 (用原生 localStorage 就够)
- 不要改 `src/lib/env.ts` / `src/lib/db/` (跟这个任务无关)
- 不要碰 `package.json` / `package-lock.json`
- 不要 push main, 走 PR (target = dev)
- commit email 用 `codex@users.noreply.github.com` (匹配 Codex 身份)

## 输出要求

- PR 链接 (target = dev 分支)
- 修改文件列表 (应该 ≤ 3 个: page.tsx / layout.tsx / 可能 new 一个 client component)
- 测试方式:
  - 本地 `npm run dev`, 访问 http://localhost:3000
  - 点切换按钮, 验证 dark mode 切了
  - 刷新页面, 验证持久化
  - 切到 /activities 验证其他路由也行
- 风险说明: 这个改动影响 4 个路由的视觉, 跑 build 验证

## 关联

- `AGENTS.md` (agent 必读)
- `docs/CODEX_SETUP.md` (Codex 集成指南)
- `src/app/page.tsx` (要改的文件)
- `src/app/layout.tsx` (要改的文件)
- `src/app/globals.css` (参考, 别改)
- `src/components/ui/button.tsx` (参考, 用 Button + asChild)
