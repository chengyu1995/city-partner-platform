# 同城搭子网站 MVP 第一阶段执行批次建议

## 文档状态

- 阶段：BATCH-P1
- 性质：执行批次建议
- 当前批准范围：只执行 BATCH-P1 产品范围和页面结构定稿

## 批次总览

| 批次 | 目标 | 是否当前批准 | 允许产出 |
| --- | --- | --- | --- |
| BATCH-P1 | 产品范围和页面结构定稿 | 是 | 规划文档、页面结构、字段清单、Agent 分工、验收标准 |
| BATCH-P2 | 页面信息架构和文案细化 | 否 | 待老板批准后再做 |
| BATCH-P3 | 前端页面最小实现 | 否 | 待老板批准后再做 |
| BATCH-P4 | 本地草稿 / 待审核流程实现 | 否 | 待老板批准后再做 |
| BATCH-P5 | 数据库、审核、登录、联系方式安全策略评估 | 否 | 待老板批准后再做 |

## BATCH-P1 当前执行内容

- 输出最终 MVP 范围。
- 输出页面清单。
- 输出字段清单。
- 输出多 Agent 分工。
- 输出执行批次建议。
- 输出 BATCH-P1 允许修改范围。
- 输出 BATCH-P1 禁止修改范围。
- 输出验收标准。

## BATCH-P2 建议范围

目标：在不改代码或经单独批准后，细化页面信息架构、文案、空状态、错误状态和移动端内容优先级。

建议产出：

- 首页内容层级。
- 搭子列表筛选结构。
- 发布页表单分组。
- 空状态、成功状态、失败状态文案。
- 移动端 375px 信息优先级。

前置条件：老板单独批准 BATCH-P2。

## BATCH-P3 建议范围

目标：实现最小可用前端页面。

建议产出：

- 首页入口和首批城市/分类展示。
- 搭子列表页基础筛选和卡片。
- 发布页基础表单。

前置条件：老板单独批准 BATCH-P3，并明确允许修改对应页面代码。

## BATCH-P4 建议范围

目标：实现本地草稿 / 待审核流程。

建议产出：

- 本地草稿保存。
- 待审核状态反馈。
- 表单校验和重复提交处理。
- 不接真实数据库时的 mock 或 local storage 边界。

前置条件：老板单独批准 BATCH-P4，并确认是否允许使用本地存储。

## BATCH-P5 建议范围

目标：评估并设计真实数据库、RLS、登录、审核和联系方式安全策略。

建议产出：

- Supabase schema 草案。
- RLS 策略草案。
- 登录方案。
- 联系方式展示/隐藏/审核策略。
- 举报和内容安全策略。

前置条件：老板单独批准 BATCH-P5。执行 SQL、修改数据库、修改 `.env` 或部署必须再次单独确认。

## BATCH-P1 允许修改范围

本批只允许修改以下文件：

- `docs/product/mvp-stage-1-final-plan.md`
- `docs/product/mvp-stage-1-page-structure.md`
- `docs/product/mvp-stage-1-fields.md`
- `docs/product/mvp-stage-1-agent-plan.md`
- `docs/product/mvp-stage-1-batch-plan.md`
- `docs/product/batch-p1-acceptance-criteria.md`

## BATCH-P1 禁止修改范围

- 不允许修改首页 `/`、`/partners`、`/post` 页面代码。
- 不允许修改 `app/page.tsx`、`app/post/page.tsx`、`app/partners/page.tsx`。
- 不允许修改 `src/app/page.tsx`、`src/app/post/page.tsx`、`src/app/partners/page.tsx`。
- 不允许写 UI 代码。
- 不允许修改数据库结构。
- 不允许执行 SQL。
- 不允许修改 `.env`。
- 不允许部署。
- 不允许启动 `next dev`、`npm run dev` 或 `npx next dev`。
- 不允许执行 BATCH-P2 到 BATCH-P5。

## 推荐执行顺序

1. 完成 BATCH-P1 文档并验收。
2. 老板确认是否进入 BATCH-P2。
3. BATCH-P2 再细化文案、信息架构和页面状态。
4. BATCH-P3 才进入页面代码实现。
5. BATCH-P4 再实现本地草稿 / 待审核。
6. BATCH-P5 单独讨论真实数据库、登录、审核和联系方式安全。
