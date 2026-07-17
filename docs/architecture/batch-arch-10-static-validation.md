# BATCH-ARCH-10 端到端静态验收报告

## 任务边界

- `project_domain=automation_architecture`
- `task_mode=docs_write_allowed`
- 本批只做静态验收和文档交接。
- 本批不修改产品页面、Worker 代码、腾讯云运行文件、数据库、环境变量、`package.json` 或 `tsconfig.json`。
- 本批不启动 dev server、不打开浏览器、不部署、不执行 `git add` / `git commit` / `git push`。

## 静态验收范围

本次验收只读取现有实现和文档，确认字段从入口到终态报告的契约是否一致：

| 阶段 | 读取依据 | 验收结论 |
| --- | --- | --- |
| 飞书 direct worker create | `src/app/api/feishu/event/route.ts` 中 `insertDirectWorkerTask` | 入口会构造 `contractPayload`，写入 `request_text` 的 `HERMES_WORKER_CONTEXT` 和 `hermes_jobs.payload`。 |
| 项目总经理 approved execution | `src/lib/project-director-job-builder.ts` 中 `buildContextPayload`、`buildDocsWriteContext`、`buildAgentDispatchContext` | approved execution 会把字段写入 request text 和 payload，`original_request_text` 保留当前任务正文。 |
| Worker claim | `src/app/api/worker/next/route.ts` 与 `src/lib/worker-jobs.ts` 中 `buildAttemptPayload` | Worker 领取任务时会保留 payload 字段，补充当前 `attempt_id` 和 `active_attempt`。 |
| Windows Worker prompt | `infra/windows-worker/local_worker.js` 中 `[Worker job payload contract]` | Codex prompt 会展示上下文字段、允许范围、禁止范围、终态字段和 Git/部署状态字段。 |
| 最终报告层 | `src/lib/worker-jobs.ts` 中 `buildProjectDirectorWorkerReport` 与 `normalizeWorkerFinalResult` | 最终报告层会重算 `effective_final_status`，输出失败记忆、终态索引和自动迭代建议。 |
| 飞书终态同步 | `src/app/api/worker/report/route.ts` | 终态报告会保存项目总管报告并同步到飞书；重复终态上报返回已有报告，避免重复写终态。 |

## 字段流转验收

| 字段 | 来源 | 保存点 | 读取点 | BATCH-ARCH-10 静态最终值 |
| --- | --- | --- | --- | --- |
| `context_source` | `buildWorkerJobPayloadContract` 按显式上下文、payload、原始正文或自动分类计算 | payload、final report data | Worker、最终报告层 | 已实现。缺显式上下文时输出 `CONTEXT_MISSING_WARNING`。 |
| `context_reconstruct_failed` | `buildWorkerJobPayloadContract` | payload、final report data | Worker、最终报告层 | 已实现。写入任务缺少关键范围时会标记失败。 |
| `project_domain` | 飞书入口、项目总经理上下文、payload 或自动分类 | request text、payload、final report | Worker、Codex prompt、最终报告层 | 已实现，当前架构批次应为 `automation_architecture`。 |
| `task_mode` | 显式 `HERMES_WORKER_CONTEXT`、payload、原始正文或分类 | request text、payload、final report | Worker、Codex prompt、最终报告层 | 已实现，优先级符合契约。 |
| `read_only_mode` | 显式字段或由 `task_mode` 派生 | request text、payload、final report | Worker、Git 安全层、最终报告层 | 已实现；read-only 与 write-allowed 会分开验收。 |
| `allowed_scope` | 当前任务正文或项目总经理批准文本 | request text、payload、final report | Worker、Codex prompt、范围校验 | 已实现。写入任务缺失时视为重建失败。 |
| `forbidden_scope` | 当前任务正文或项目总经理批准文本 | request text、payload、final report | Worker、Codex prompt、范围校验 | 已实现。自动分类不得缩小禁止范围。 |
| `original_request_text` | 飞书入口原文、direct worker create 原文或 approved execution 当前正文 | request text、payload、final report | 项目总经理、Worker、Codex prompt、最终报告层 | 已实现。不得由 `NEXT_TASK_CARD` 或历史文档替代。 |
| `route` | 飞书入口或项目总经理 dispatch | request text、payload、final report | Worker、最终报告层、知识库 | 已实现。 |
| `payload` | Worker API 创建 job 时组装 | `hermes_jobs.payload`、final report data | Worker claim、Codex prompt、最终报告层 | 已实现，claim 时通过 `buildAttemptPayload` 继续传递。 |
| `approved_batch` | 当前批准批次 | request text、payload、final report、terminal key | Worker、最终报告层、知识库 | 已实现，是 `job_id::approved_batch` 幂等键的一部分。 |
| `attempt_id` | Worker claim 生成 | payload、active attempt、heartbeat/progress/report | Worker API、最终报告层 | 已实现，report route 会校验 attempt ownership。 |
| `worker_stage` / `workflow_stage` | Worker claim 和报告流程 | payload、final report | Worker、最终报告层 | 已实现，`workflow_stage` 兼容 `worker_stage`。 |
| `final_report_status` | Worker 原始上报状态 | final report、final result | 最终报告层、飞书报告 | 已实现。 |
| `effective_final_status` | 最终报告层按任务目标重算 | final report、terminal index、飞书报告 | 知识库、自动迭代 | 已实现。不能只信任 Worker `succeeded`。 |
| `failure_code` | 最终报告层分类 | final report、terminal index、自动迭代 | 失败记忆、自动修复建议 | 已实现。非任务失败不会写失败记忆。 |
| `failure_stage` | 最终报告层分类 | final report、自动迭代建议 | 失败记忆/自动修复建议 | 部分实现。规范化结果和报告中存在，但 `terminal_index` 当前不保存该字段。 |
| `changed_files` | Worker/Codex 后静态 diff 采集 | final report、payload/report data | 任务目标校验、范围校验 | 已实现。read-only 允许 `[]`，write-allowed 成功但 `[]` 会触发 `NO_FIX_APPLIED`。 |
| `git_commit_sha` | 外层 Worker commit 后生成 | final report、terminal index | 飞书报告、知识库、验收流程 | 已实现。Codex 阶段不伪造 SHA。 |
| `next_batch` | 报告文本、显式字段或批次推断 | normalized final result、terminal index | 自动迭代 | 已实现。成功时可继续 `next_batch`。 |
| `completed_at` | 终态报告时生成 | final report、terminal index | 飞书报告、知识库 | 已实现。 |
| `pushed` | 外层 Worker push 状态 | final report data | 飞书报告、验收流程 | 已实现。 |
| `deploy_status` | 部署系统或外层 Worker | final report data | 飞书报告、运维验收 | 已实现，未部署任务保持未部署/null 状态。 |

## 任务模式验收矩阵

| 任务模式 | 通过条件 | 失败条件 | 主要失败码 |
| --- | --- | --- | --- |
| `read_only` | `changed_files=[]`，无 commit、push、deploy，报告可只读完成。 | 出现文件变更、commit SHA、push 或部署记录。 | `READ_ONLY_MODE_VIOLATION` |
| `docs_write_allowed` | 仅命中当前批准的 `docs/**` 或更窄文档范围，并且有实际文档 diff。 | 无 diff、命中产品/Worker/数据库/env/包管理文件、越过禁止范围。 | `NO_FIX_APPLIED`、`OUT_OF_SCOPE_CHANGE` |
| `automation_system_write_allowed` | 仅命中明确批准的自动化系统文件，并保留产品页面、数据库、env 和部署禁止范围。 | 无 diff、改产品页面、改数据库/env/腾讯云运行文件或越过禁止范围。 | `NO_FIX_APPLIED`、`OUT_OF_SCOPE_CHANGE`、`TASK_MODE_MISMATCH` |
| `product_write_allowed` | 仅命中明确批准的产品页面或产品文档范围，不触碰 Worker、飞书入口、数据库、env 或部署配置。 | 无 diff、改自动化系统/数据库/env/部署配置或越过禁止范围。 | `NO_FIX_APPLIED`、`OUT_OF_SCOPE_CHANGE`、`TASK_MODE_MISMATCH` |

## 发现的问题

1. `failure_stage` 已在 normalized final result、项目总管报告数据和自动修复建议中流转，但 `buildTerminalJobIndex` 当前只保存 `failure_code`，没有保存 `failure_stage`。如果后续要求 terminal index 完整支持 `failure_stage` 检索，需要单独批准自动化系统代码批次修复。
2. `docs/NEXT_TASK_CARD.md` 保留了 ARCH-06 旧入口和 ARCH-10 handoff 两段信息，容易让后续批次误判当前进度。本批已将下一任务卡更新为 ARCH-10 验收后的交接状态。

## 结论

BATCH-ARCH-06 到 BATCH-ARCH-09 的字段主链路已经能静态贯通：入口保留原始正文和上下文字段，Worker claim 继续传递 payload，Windows Worker prompt 展示统一字段，最终报告层重算有效终态，并生成失败记忆状态、终态索引和自动迭代建议。

ARCH-10 后不建议直接进入产品开发。下一步应由老板选择：

- 若要修复发现的问题，批准一个 `automation_system_write_allowed` 小批次，把 `failure_stage` 写入 terminal index 并补测试。
- 若不急于修复该索引字段，批准一个只读 smoke 批次，对现有 Worker 字段链路跑静态测试和终态报告样例。
