# 决策记录

## 文档状态

- 整理批次：BATCH-22 项目文件分类和项目档案
- 更新时间：2026-07-07
- 本文件只记录项目治理决策，不生成新的产品规划或业务方案。

## 决策列表

| 编号 | 决策 | 原因 | 影响范围 |
| --- | --- | --- | --- |
| D-001 | 当前仓库按五类项目整理：产品、自动化系统、运维配置、验收反馈、归档。 | 老板原始指令要求按这五类整理项目内容。 | `docs/PROJECT_INDEX.md` 和 `docs/projects/*` |
| D-002 | 同城搭子网站继续归为产品项目。 | 现有 P1/P2/P3 文档均围绕同城搭子网站 MVP。 | `docs/projects/city-partner-website.md`、`docs/NEXT_TASK_CARD.md` |
| D-003 | 自动化链路归为独立系统项目，不混入产品项目。 | 飞书总经理、腾讯云中转、Worker、Codex、Hermes 属于执行系统，不是同城搭子网站页面功能。 | `docs/projects/feishu-gm-automation.md` |
| D-004 | 运维配置只记录变量名和用途，不记录真实值。 | 老板明确禁止记录真实 token、secret、service key。 | `docs/projects/ops-config.md` |
| D-005 | 旧方案和 `.bak` 文件必须标记为归档/废弃。 | 避免旧 Vercel 飞书入口、旧首页 MVP 模板、旧解析逻辑继续影响当前执行。 | `docs/projects/archive.md` |
| D-006 | BATCH-22 当前整理任务与历史 BATCH-22 choice routing 修复同时记录，但语义区分。 | 仓库已有 `batch-22-choice-routing-notes.md`，本次老板又批准 BATCH-22 做项目档案整理。 | `docs/BATCH_LOG.md` |
| D-007 | 下一步同城搭子网站建议从 BATCH-P3 静态验收/补齐开始。 | P1/P2 文档已存在，P3 实现说明存在但本批没有执行页面验收。 | `docs/NEXT_TASK_CARD.md` |
| D-008 | 不跳到 BATCH-P4，除非老板确认 BATCH-P3 已验收。 | BATCH-P4 涉及本地草稿/待审核流程继续实现或强化，必须建立在 P3 已验收之上。 | 后续 Worker 任务 |

## 当前禁止越界

- 不修改同城搭子网站业务代码。
- 不修改 `/`、`/partners`、`/post` 页面代码。
- 不设计首页。
- 不进入完整产品规划模板。
- 不执行 BATCH-P2、BATCH-P3、BATCH-P4 或后续业务开发。
- 不修改数据库。
- 不修改环境变量。
- 不启动 dev server。
- 不删除 `.bak` 文件。
- 不执行 Git 提交或推送。

## 待老板确认

- 是否将 BATCH-P3 视为已完成并进入验收。
- 若 BATCH-P3 已验收，是否批准进入 BATCH-P4。
- BATCH-23 和 BATCH-28 是否需要补充独立批次总结文档。
- `app/` 与 `src/app/` 双入口是否需要单独开审计任务。
