# 同城搭子网站继续开发任务卡

## 项目名称

同城搭子网站

## 项目分类

产品项目

## 当前状态

- BATCH-P1 产品范围和页面结构文档已存在。
- BATCH-P2 信息架构、文案、状态文案、移动端优先级文档已存在。
- BATCH-P3 实现说明已存在，记录静态页面和本地草稿/待审核前端流程。
- BATCH-22 项目治理整理完成后，产品项目资料统一从 `docs/projects/city-partner-website.md` 和本任务卡进入。
- 本批没有修改业务代码、页面代码、数据库或环境变量。

## 当前阶段

建议阶段：BATCH-P3 静态验收/补齐。

如果老板确认 BATCH-P3 已经完成并验收通过，下一步才建议单独批准 BATCH-P4。

## 项目目录

- 产品文档：`docs/product/`
- 产品档案：`docs/projects/city-partner-website.md`
- 首页路由：`app/page.tsx`、`src/app/page.tsx`
- 搭子列表：`app/partners/page.tsx`、`src/app/partners/page.tsx`
- 发布页：`app/post/page.tsx`、`src/app/post/page.tsx`
- mock 和本地草稿：`src/lib/mock-partners.ts`、`src/lib/local-drafts.ts`

## 最近 commit

`9a81556 docs: add worker failure repair guidance`

## 已完成内容

- 产品目标、首批城市、首批分类、页面范围已在 BATCH-P1 文档中明确。
- 首页、搭子列表页、发布搭子页的信息架构和文案已在 BATCH-P2 文档中明确。
- BATCH-P3 实现说明记录了首页、列表页、发布页的静态页面结构，以及本地草稿/待审核前端流程。
- 联系方式安全、真实数据库、登录、审核后台、生产部署都保留为后续单独批准事项。

## 未完成内容

- BATCH-P3 的当前页面代码和运行效果尚未在本批验收。
- BATCH-P4 本地草稿/待审核流程是否需要继续增强尚未批准。
- BATCH-P5 数据库、RLS、登录、审核和联系方式安全策略尚未批准。
- `app/` 与 `src/app/` 双入口的实际使用边界需要单独审计。
- BATCH-23 和 BATCH-28 缺少独立批次归档资料。

## 当前问题

- 不能直接从项目档案整理跳到业务开发。
- 不能用旧首页 MVP 模板或旧产品规划模板作为当前执行依据。
- 后续如果修改 `/`、`/partners`、`/post`，必须由老板按具体 BATCH 单独批准。
- 任何数据库、环境变量、生产部署、联系方式公开策略都属于高风险范围。

## 下一步建议

建议创建下一批任务：

`BATCH-P3 静态验收/补齐：核对首页、搭子列表页、发布页是否符合 BATCH-P1/P2 文档，只做最小范围修复，不接数据库、不强制登录、不公开联系方式。`

如果老板确认 BATCH-P3 已验收通过，再创建：

`BATCH-P4 本地草稿 / 待审核流程增强：在不接真实数据库的前提下完善本地草稿、待审核状态、去重和反馈。`

## 建议分发 Agent

- `documentation_agent`：核对 P1/P2/P3 文档和验收口径。
- `product_manager`：确认 P3 是否足够进入 P4。
- `frontend_developer`：仅在批准后处理页面最小修复。
- `testing_engineer`：做静态验证、TypeScript、ESLint 和路由文件检查。
- `ops_engineer`：确认不触碰部署、env、数据库和生产配置。

## 禁止范围

- 不修改数据库、RLS、SQL。
- 不修改 `.env`、`.env.local` 或生产环境变量。
- 不部署生产。
- 不启动 dev server。
- 不打开浏览器，除非后续任务明确改变 Worker 规则。
- 不执行旧 BATCH。
- 不删除 `.bak` 文件。
- 不公开真实联系方式。
- 不跳过老板批准进入 BATCH-P4/P5。

## 验收标准

- 变更范围只包含被批准的文件。
- 未经批准不得修改 `/`、`/partners`、`/post` 页面代码。
- 静态验证通过或把失败记录为 warning。
- `git diff --name-only` 没有出现数据库、env、部署配置或未批准业务文件。
- `git status --short` 可解释所有变更来源。
- TypeScript/ESLint 如被要求执行，结果需记录。
- 最终报告列出修改文件、验证结果、风险和下一步建议。
