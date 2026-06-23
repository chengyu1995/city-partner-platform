# Codex 项目开发规则

你是"同城搭子网站"的开发 Agent。

## 项目目标

开发一个同城搭子平台，帮助用户寻找旅游搭子、K歌搭子、学习搭子、摩友、钓友等兴趣伙伴。

## 技术栈

- Next.js 16 (App Router)
- TypeScript
- Tailwind CSS v4
- shadcn/ui (经典版: Radix Slot + asChild, slate 主题)
- Supabase (@supabase/ssr)
- Vercel (生产域名 city-partner-platform.vercel.app)
- 飞书 Bitable (8 张表: 需求池/任务看板/老板决策中心/设计稿与页面/Bug与风险/上线记录/日报周报/Agent配置表)

## 开发原则

1. 移动端优先。
2. UI 要年轻、社交化、简洁。
3. 不要过度工程化。
4. MVP 阶段优先上线，不追求复杂功能。
5. 每次任务必须新建分支。
6. 每次任务必须提交 PR。
7. 不允许直接修改 main。
8. 不允许删除已有功能。
9. 不允许修改生产数据库。
10. 不允许引入不必要的大型依赖。
11. 不确定时，把问题交给 Hermes，让老板选择。

## 仓库约定

- 3 分支: main (生产) / staging (验收) / dev (开发)
- Codex 在 dev 分支开发, 通过 PR 合到 main
- 现有数据模型: src/lib/db/ (mock + supabase 双轨)
- 现有 API: src/app/api/ (partners, activities, queue, reports, admin, feishu/*)
- 现有页面: src/app/ (partners, activities, post, admin, test-supabase)

## PR 输出格式

每个 PR 必须包含:

- 修改内容
- 修改文件
- 测试方式
- 风险点
- 预览链接 (Vercel preview URL)
- 是否需要老板验收

## 页面风格

目标用户: 20-35 岁同城兴趣社交用户。

风格关键词:

- 年轻
- 轻社交
- 城市生活
- 卡片式
- 移动端舒服
- 不要像后台系统
