# 故障排查

## 文档状态

- 整理批次：BATCH-22 项目文件分类和项目档案
- 更新时间：2026-07-07
- 本文件只整理排查入口和处置边界，不执行修复。

## Windows Worker 强制边界

当前 Worker 模式下，Codex 只负责修改文件和汇报结果：

- 不执行 `npm run dev`、`next dev`、`npx next dev`。
- 不使用 `Start-Process` 或后台命令启动 dev server。
- 不启动浏览器。
- 不执行 `git add`、`git commit`、`git push`。
- 不创建分支、不修改 Git 配置、不调用 GitHub 写入接口。
- 本地预览恢复失败或静态诊断失败只能记录 warning。

## 常见问题

| 问题 | 表现 | 当前处置 |
| --- | --- | --- |
| 端口被占用 | 本地预览无法启动。 | Windows Worker 模式不启动预览，只记录 warning；需要预览时由外层 Worker 或人工处理。 |
| mock 模式异常 | Supabase env 缺失后页面或数据异常。 | 不擅自修改 `src/lib/env.ts`，先确认是否符合 env 缺失进入 MOCK 的设计。 |
| Next.js 16 API 变更 | 使用旧 Next.js 习惯导致构建失败。 | 写代码前读取 `node_modules/next/dist/docs/` 对应文档；本批不写代码。 |
| A/B 选择重复确认 | 老板回复 `选 A` 或 `选 B` 后又收到普通需求确认。 | 检查 choice routing 是否在普通网站需求识别之前。 |
| Worker report 409 | `attempt_id` 缺失或不匹配。 | Worker 必须回传领取任务时获得的 active attempt id。 |
| 终态报告被覆盖 | 已 succeeded/failed 的任务被后续报告覆盖。 | 终态报告必须幂等，重复上报只能返回已有结果。 |
| 飞书报告信息不足 | 只回传一行 succeeded/failed。 | 使用 BATCH-27 完整项目总管报告模板。 |
| 密钥泄露风险 | 文档、日志或报告出现 token、secret、service key。 | 只记录变量名和用途；真实值不得进入仓库。 |
| 旧方案误用 | 旧 Vercel 飞书入口、旧首页 MVP 模板被当作当前依据。 | 按 `docs/projects/archive.md` 标记为归档/废弃。 |
| 批次号混淆 | BATCH-22 既有 choice routing，又有项目档案整理。 | 在日志中按语义区分，不互相覆盖。 |

## 静态验证建议

文档治理任务可做以下静态验证：

- 确认目标文档存在。
- 执行 `git diff --name-only` 检查变更范围。
- 执行 `git status --short` 检查工作区状态。
- 如涉及 TypeScript 代码，执行 `npx tsc --noEmit`。
- 如涉及 lint 范围，执行 `npm run lint`。

本 BATCH-22 不涉及业务代码，因此不需要启动本地服务或浏览器。

## 高风险操作处理

遇到以下情况必须停止并交给老板确认：

- 修改数据库、RLS、SQL 或删除数据。
- 修改 `.env`、`.env.local`、Vercel env 或生产环境变量。
- 生产部署、绑定域名、正式上线。
- 新增依赖或修改 `package.json`。
- 需要恢复 stash、备份、`.bak` 或旧方案作为当前代码。
- 不明确是否要从 BATCH-P3、P4 或 P5 继续。

## 文档排查入口

| 主题 | 入口 |
| --- | --- |
| 项目分类 | `docs/PROJECT_INDEX.md` |
| 当前状态 | `docs/CURRENT_STATE.md` |
| 决策记录 | `docs/DECISIONS.md` |
| 批次状态 | `docs/BATCH_LOG.md` |
| 验收状态 | `docs/ACCEPTANCE_LOG.md` |
| 同城搭子网站下一步 | `docs/NEXT_TASK_CARD.md` |
| 自动化系统 | `docs/projects/feishu-gm-automation.md` |
| 运维配置 | `docs/projects/ops-config.md` |
| 归档内容 | `docs/projects/archive.md` |
## Error Fingerprint Memory

The automation system keeps lightweight repeated-failure memory without database or env changes.

Known fingerprints:

- `QA_TASK_MODE_MISMATCH`: `BATCH-QA-*` was misclassified as `automation_system_write_allowed`.
- `DOCS_INSUFFICIENT_OUTPUT`: `BATCH-37-DOCS-*` only changed `docs/projects/feishu-gm-automation.md`.
- `READ_ONLY_LOCKED_DOCS`: `docs_write_allowed` was locked by `read_only_mode=true`.
- `PATH_PARSE_FIRST_CHAR_LOSS`: `git status` path parsing lost the first character.
- `FALSE_SUCCEEDED`: task goal was incomplete but reported `succeeded`.
- `INCOMPLETE_QA_REPORT`: `BATCH-QA-*` returned only status/diff or missed required QA report sections.
- `QA_REPORT_FIELD_MATCH_TOO_STRICT`: QA report content was present, but field matching was too strict and caused `INCOMPLETE_QA_REPORT`.
- `QA_REPORT_NATURAL_LANGUAGE_MATCH_UNSTABLE`: QA report natural language was complete but unstable to match; prefer `QA_REPORT_FIELDS`.
- `BATCH_FIX_PRODUCT_MISROUTED_TO_AUTOMATION`: `BATCH-FIX-*` product repair was misrouted to automation/docs mode and changed system files instead of product pages.
- `BATCH_FIX_PRODUCT_MISCLASSIFIED_AS_AUTOMATION_SYSTEM`: `BATCH-FIX-*` product repair was classified as `automation_system` during the new-demand classification stage.
- `EXPLICIT_TASK_MODE_OVERRIDDEN`: boss-provided `project_domain` / `task_mode` / `read_only_mode` fields were overwritten by automatic routing, historical failed-job fields, or inferred docs/product scope. First occurrence is warning, second is duplicate warning, third and later must be blocked.
- `PRODUCT_WRITE_PROMPT_POLLUTED_BY_READ_ONLY_LOCK`: product repair was already `product_write_allowed`, but the Codex prompt still contained a read-only lock and caused `NO_FIX_APPLIED`.
- `BUSINESS_PAGE_BOUNDARY_VIOLATION`: automation/docs/read-only tasks touched frozen product pages. This must not be raised for `city_partner_product` + `product_write_allowed` changes inside `src/app/**`; product tasks remain blocked from Worker, gateway, env, and database files.
- `ORIGINAL_BATCH_CONTEXT_MISSING`: approved BATCH-FIX execution did not carry the original `新需求：BATCH-FIX-*` full request text.

Escalation:

- Count 1: record `warning`.
- Count 2: report `repeated_warning`.
- Count 3 or more: mark `blocked` and require a system-fix batch before creating more tasks of the same type.
