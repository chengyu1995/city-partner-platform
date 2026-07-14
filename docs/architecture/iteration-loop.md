# 自动化架构迭代闭环

本文件定义 BATCH-ARCH-05 之后的执行顺序。当前批次只补齐文档契约，不修改 Worker 代码、腾讯云运行文件、产品页面、数据库或环境变量。

## 当前基线

- BATCH-GM-FINAL-GUARD-04-SMOKE-01 已 succeeded，最终报告层不再误杀 Worker succeeded。
- 下一阶段目标是统一项目总经理、飞书入口、Worker job payload、Windows Worker、最终报告层和知识库之间的字段契约。
- BATCH-ARCH-05 产物是后续实现的依据：`context-contract.md`、`knowledge-base-schema.md`、`iteration-loop.md`、`NEXT_TASK_CARD.md` 和 `feishu-gm-automation.md`。

## 通用执行原则

- 每批只使用本批原始任务正文作为唯一执行来源。
- `docs/NEXT_TASK_CARD.md`、`docs/PROJECT_INDEX.md` 和历史批次文档只提供导航，不替代 `original_request_text`。
- 字段优先级规则：显式 HERMES_WORKER_CONTEXT > payload > request_text/original_request_text > 自动分类 > 历史上下文。
- 只读任务规则：read_only 任务 changed_files=[] 是正常状态，不得触发 NO_FIX_APPLIED。
- 写入任务规则：write_allowed 任务必须产生允许范围内变更，否则触发 NO_FIX_APPLIED。
- 自动化系统修复任务不得修改产品页面、数据库、环境变量或腾讯云运行文件，除非任务正文明确批准对应文件。

## BATCH-ARCH-06 到 BATCH-ARCH-10

### BATCH-ARCH-06：字段契约落地到 job payload

目标：
- 按 `context-contract.md` 统一 Worker job payload 的字段名。
- 保留 `project_domain`、`task_mode`、`read_only_mode`、`allowed_scope`、`forbidden_scope`、`original_request_text`、`route`、`approved_batch`。
- 禁止用历史上下文覆盖显式 `HERMES_WORKER_CONTEXT`。

验收：
- payload 中能看到完整上下文字段。
- approved execution 丢失 `original_request_text` 时失败，而不是回退到历史文档。
- 字段缺失有明确失败码。

### BATCH-ARCH-07：Windows Worker 与 Codex prompt 字段保护

目标：
- Windows Worker 读取 payload 后生成稳定的 Codex prompt。
- prompt 中明确允许范围、禁止范围、任务模式和 Git 禁令。
- read-only 与 write_allowed 的行为在 prompt 和本地校验中一致。

验收：
- read-only 任务不会要求 Codex 产出 diff。
- docs_write_allowed 任务只允许 docs 范围。
- automation_system_write_allowed 任务不会触碰产品页面。

### BATCH-ARCH-08：最终报告层有效终态统一

目标：
- 最终报告层重算 `effective_final_status`。
- 报告中稳定输出 `final_report_status`、`effective_final_status`、`changed_files`、`git_commit_sha`、`pushed`、`deploy_status`。
- 区分 Worker succeeded、任务目标完成和外层 Git 状态。

验收：
- read-only 的 `changed_files=[]` 不触发 `NO_FIX_APPLIED`。
- write_allowed 无允许范围 diff 时触发 `NO_FIX_APPLIED`。
- Codex 未提交时不伪造 commit SHA 或 pushed 状态。

### BATCH-ARCH-09：文档型知识库目录与索引

目标：
- 按 `knowledge-base-schema.md` 建立文档型知识库目录和索引。
- 将项目知识、架构知识、失败记忆、决策记录、批次记录、Agent 分工、下一步计划分开。
- 建立批次记录模板，供后续 Worker 报告写入或人工补录。

验收：
- 不接数据库。
- 不接向量库。
- 知识库不覆盖当前任务正文，只作为检索和决策参考。

### BATCH-ARCH-10：端到端静态验收与交接

目标：
- 对 BATCH-ARCH-06 到 09 的字段流转做静态验收。
- 检查从飞书入口到最终报告再到知识库记录的字段是否一致。
- 输出下一阶段是否可以进入自动化系统代码修复或继续文档补齐。

验收：
- 报告列出每个字段的来源、保存点、读取点和最终值。
- 报告列出 read-only、docs_write_allowed、automation_system_write_allowed、product_write_allowed 四类任务的通过/失败条件。
- 不部署，不启动 dev server，不打开浏览器。

## 闭环规则

1. 计划层只产生任务正文和批准语句。
2. payload 层保存结构化字段。
3. Worker 层执行并采集静态事实。
4. 最终报告层计算有效终态。
5. 知识库层沉淀批次结果和失败记忆。
6. 下一批只引用知识库作为背景，仍以本批原始任务正文为唯一执行来源。

## 下一批入口

下一批从 BATCH-ARCH-06 开始。BATCH-ARCH-06 的前置条件是本批 5 个目标文档存在，并且 `git diff --name-only` 只出现允许范围文件。
