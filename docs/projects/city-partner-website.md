# 产品项目：同城搭子网站

## 项目定位

同城搭子网站是当前仓库的产品项目，用于帮助 20-35 岁同城兴趣社交用户寻找饭搭子、运动搭子、学习搭子、出游搭子、K 歌搭子、摩友搭子、钓友搭子等兴趣伙伴。

本档案只整理现有资料，不新增首页设计、不生成完整产品规划模板、不执行业务开发。

## 产品目标

第一阶段目标是让用户快速理解平台定位，浏览同城搭子需求，并低成本提交一条本地草稿或待审核的搭子需求。

暂不做范围：

- 真实登录和账号体系。
- 个人主页。
- 举报、拉黑和运营审核后台。
- 站内私信和通知。
- 支付、会员和订单。
- 数据库、RLS、生产部署和联系方式安全策略。

## 页面结构

| 页面 | 路由 | 当前资料来源 |
| --- | --- | --- |
| 首页 | `/` | `docs/product/mvp-stage-1-page-structure.md`、`docs/product/mvp-stage-1-information-architecture.md` |
| 搭子列表页 | `/partners` | `docs/product/mvp-stage-1-page-structure.md`、`docs/product/mvp-stage-1-page-copy.md` |
| 发布搭子页 | `/post` | `docs/product/mvp-stage-1-fields.md`、`docs/product/mvp-stage-1-state-copy.md` |
| 搭子详情页 | `/partners/[id]` | 后续批次再确认 |
| 登录、个人主页、审核页 | 待定 | 不在 MVP 第一阶段默认执行 |

当前仓库同时存在 `app/` 与 `src/app/` 下的页面文件，实际 Next.js 入口需要后续单独审计。本批不修改这些页面。

## BATCH-P1 文档

BATCH-P1 已产出：

- `docs/product/mvp-stage-1-final-plan.md`
- `docs/product/mvp-stage-1-page-structure.md`
- `docs/product/mvp-stage-1-fields.md`
- `docs/product/mvp-stage-1-agent-plan.md`
- `docs/product/mvp-stage-1-batch-plan.md`
- `docs/product/batch-p1-acceptance-criteria.md`

结论：P1 是产品范围和页面结构定稿，不写代码。

## BATCH-P2 后续建议

BATCH-P2 已产出：

- `docs/product/mvp-stage-1-information-architecture.md`
- `docs/product/mvp-stage-1-page-copy.md`
- `docs/product/mvp-stage-1-state-copy.md`
- `docs/product/mvp-stage-1-mobile-priority.md`
- `docs/product/batch-p2-acceptance-criteria.md`

结论：P2 是信息架构和文案细化，不写代码。P2 建议后续进入 BATCH-P3，但必须单独批准。

## BATCH-P3 资料

仓库已有 `docs/product/batch-p3-implementation-notes.md`，记录：

- 首页静态结构。
- 搭子列表页静态筛选和卡片。
- 发布页基础表单。
- 本地 mock 数据和 localStorage 草稿。
- 不接 Supabase、不强制登录、不公开联系方式。

本 BATCH-22 只记录该资料存在，不对 P3 页面运行效果做验收。

## 产品相关 docs/product/*

`docs/product/` 中除 P1/P2/P3 当前资料外，还包含早期批次和历史模板。后续执行时应优先使用：

- P1/P2/P3 当前批次资料。
- `docs/NEXT_TASK_CARD.md`。
- 老板最新批准的 BATCH 任务。

早期首页 MVP 或旧 planning 模板应按归档处理，不得直接作为当前执行依据。

## 同城搭子网站继续开发任务卡

继续开发入口为：

- `docs/NEXT_TASK_CARD.md`

当前建议从 BATCH-P3 静态验收/补齐开始。若老板确认 BATCH-P3 已验收通过，再进入 BATCH-P4。
