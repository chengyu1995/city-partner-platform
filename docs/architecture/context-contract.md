# 上下文字段契约

适用范围：项目总经理、飞书入口、Worker job payload、Windows Worker、Codex 提示词、最终报告层和文档型知识库。

本契约只定义字段和流转规则，不要求本批修改 Worker 代码、腾讯云运行文件、产品页面、数据库或环境变量。后续实现必须以本文件为唯一字段依据。

## 核心规则

字段优先级规则：显式 HERMES_WORKER_CONTEXT > payload > request_text/original_request_text > 自动分类 > 历史上下文。

只读任务规则：read_only 任务 changed_files=[] 是正常状态，不得触发 NO_FIX_APPLIED。

写入任务规则：write_allowed 任务必须产生允许范围内变更，否则触发 NO_FIX_APPLIED。

这里的 `write_allowed` 是总称，包含 `docs_write_allowed`、`automation_system_write_allowed` 和 `product_write_allowed`。任何写入任务都必须同时满足 `task_mode`、`read_only_mode=false`、`allowed_scope` 和 `forbidden_scope`。

## 状态枚举

### project_domain

- `automation_architecture`：自动化架构文档、字段契约、知识库 schema、迭代设计。
- `automation_system`：Worker、飞书入口、腾讯云中转、最终报告层等系统代码修复。
- `governance_docs`：项目管理、流程、验收、协作文档。
- `qa_review`：只读验收、测试审核、状态盘点。
- `city_partner_product`：同城搭子产品页面和用户功能。

### task_mode

- `read_only`：只读任务，不允许任何文件变更。
- `docs_write_allowed`：只允许文档范围内写入。
- `automation_system_write_allowed`：只允许明确批准的自动化系统文件写入。
- `product_write_allowed`：只允许明确批准的产品文件写入。

### final status

- `final_report_status`：Worker 或 Codex 上报的原始终态。
- `effective_final_status`：最终报告层按契约重新计算后的有效终态。它优先于 `final_report_status`，用于老板可见报告和知识库批次记录。

## 字段契约表

| 字段 | 由哪里生成 | 由哪里保存 | 由哪里读取 | 允许谁覆盖 | 禁止谁覆盖 | 丢失时如何处理 |
| --- | --- | --- | --- | --- | --- | --- |
| `project_domain` | 飞书入口、项目总经理或显式 `HERMES_WORKER_CONTEXT` | Worker job payload、Codex prompt、最终报告、批次记录 | Windows Worker、Codex、最终报告层、知识库 | 显式 `HERMES_WORKER_CONTEXT`、老板批准的当前任务正文 | 历史批次、`NEXT_TASK_CARD`、自动分类结果、禁止范围文本 | 按字段优先级规则重建；仍无法确定时写入失败码 `PROJECT_DOMAIN_MISSING`，写入任务不得执行 |
| `task_mode` | 飞书入口、项目总经理、Worker job payload 或显式上下文 | Worker job payload、Codex prompt、最终报告、批次记录 | Windows Worker、Codex、最终报告层 | 显式 `HERMES_WORKER_CONTEXT`、当前任务正文中明确字段 | 历史上下文、旧 read-only 残留、禁止范围中的批次名 | 按字段优先级规则重建；仍无法确定时保守降级为 `read_only`，若任务正文明确要求写入则失败 `TASK_MODE_MISSING` |
| `read_only_mode` | 由 `task_mode` 派生，或由显式上下文给出 | Worker job payload、Codex prompt、最终报告 | Windows Worker、Git 安全层、最终报告层 | 显式 `HERMES_WORKER_CONTEXT`；没有显式值时由 `task_mode` 派生 | 历史 read-only 残留、自动分类、报告层后置猜测 | 缺失时从 `task_mode` 派生；`read_only` 为 `true`，其余写入模式为 `false` |
| `allowed_scope` | 当前任务正文、项目总经理批准文本、显式上下文 | Worker job payload、Codex prompt、最终报告 | Windows Worker、Codex、最终报告层 | 显式 `HERMES_WORKER_CONTEXT`、当前任务正文 | 历史批次、产品背景、禁止范围文本 | read-only 可为空；写入任务缺失时失败 `ALLOWED_SCOPE_MISSING` |
| `forbidden_scope` | 当前任务正文、项目总经理批准文本、显式上下文 | Worker job payload、Codex prompt、最终报告 | Windows Worker、Codex、最终报告层 | 显式 `HERMES_WORKER_CONTEXT`、当前任务正文 | 自动分类缩小禁止范围、历史上下文删除禁止项 | 缺失时套用对应 `task_mode` 默认禁止范围；无法套用时失败 `FORBIDDEN_SCOPE_MISSING` |
| `original_request_text` | 首次进入飞书入口或 direct worker create 的完整原始任务正文 | Worker job payload、任务记录、最终报告、批次记录 | 项目总经理、Windows Worker、Codex prompt、最终报告层、知识库 | 只允许首次创建时写入；可用 `original_request_text_base64` 解码恢复同一内容 | 后续摘要、`NEXT_TASK_CARD`、`PROJECT_INDEX`、历史批次文档、自动分类 | approved execution 丢失时失败 `ORIGINAL_REQUEST_TEXT_MISSING`；不得用历史文档替代 |
| `route` | 飞书入口或 direct worker create 入口 | Worker job payload、最终报告、批次记录 | Windows Worker、最终报告层、知识库 | 当前入口生成方；显式上下文 | 自动分类、历史上下文 | 缺失时记录 `ROUTE_MISSING`；若影响权限判断则失败，否则作为 warning |
| `payload` | Worker API 创建 job 时组装 | Worker job 队列、最终报告摘要 | Windows Worker、Codex prompt 构造器、最终报告层 | Worker API 在创建时；后续只能补充派生字段 | Codex、历史文档、最终报告层 | 缺失时失败 `PAYLOAD_MISSING`，不得只凭自然语言继续写入 |
| `approved_batch` | 项目总经理批准语句或 direct worker create 的当前批次 | Worker job payload、Codex prompt、最终报告、批次记录 | Windows Worker、Codex、最终报告层、知识库 | 当前任务正文中的显式批次 | 禁止范围、历史批次列表、项目索引 | approved execution 缺失时失败 `APPROVED_BATCH_MISSING`；direct worker create 可从任务标题恢复 |
| `attempt_id` | Windows Worker 领取 job 时生成 | Worker heartbeat、progress、final report、批次记录 | Worker API、最终报告层、知识库 | Windows Worker 当前领取流程 | Codex、飞书入口、历史报告 | 上报阶段缺失时失败 `ATTEMPT_ID_MISSING` |
| `worker_stage` | Windows Worker 执行阶段机 | heartbeat、progress、final report | Worker API、最终报告层、飞书报告 | Windows Worker | Codex、历史上下文 | 缺失时标记 `unknown` 并记录 `WORKER_STAGE_MISSING`；终态报告不得省略 |
| `final_report_status` | Windows Worker 或 Codex 执行结果汇总 | final report、飞书报告、批次记录 | 最终报告层、知识库 | 最终报告提交方 | 历史报告、飞书展示层 | 缺失时失败 `FINAL_REPORT_STATUS_MISSING` |
| `effective_final_status` | 最终报告层按契约重算 | final report、飞书报告、批次记录、失败记忆 | 飞书报告、知识库、后续批次规划 | 只能由最终报告层计算 | Codex、Windows Worker 原始成功状态、历史上下文 | 缺失时必须现场计算；无法计算时失败 `EFFECTIVE_FINAL_STATUS_MISSING` |
| `changed_files` | Windows Worker 在 Codex 后通过静态 Git diff 采集 | final report、批次记录、失败记忆 | 最终报告层、知识库、外层 Git Worker | Windows Worker 采集结果；外层 Worker 可在提交前重新确认 | Codex 手写估计、历史报告 | read_only 缺失按 `[]` 处理并记录 warning；write_allowed 缺失或为空触发 `NO_FIX_APPLIED` |
| `git_commit_sha` | 外层 Worker 完成 commit 后生成 | final report、批次记录 | 飞书报告、知识库、验收流程 | 外层 Worker | Codex、Windows Worker、历史上下文 | Codex 阶段应为 `not_created_by_codex` 或空；外层提交后仍缺失则记录 `GIT_COMMIT_SHA_MISSING` |
| `pushed` | 外层 Worker push 后生成布尔值 | final report、批次记录 | 飞书报告、知识库、验收流程 | 外层 Worker | Codex、Windows Worker、历史上下文 | Codex 阶段应为 `false` 或 `not_attempted_by_codex`；外层目标要求 push 但缺失时记录 `PUSH_STATUS_MISSING` |
| `deploy_status` | 部署系统或外层 Worker 在被批准部署时生成 | final report、批次记录 | 飞书报告、知识库、运维验收 | 部署系统或外层 Worker | Codex、历史上下文、未批准任务 | 未部署任务固定为 `not_deployed`；未经批准不得自动部署 |

## 覆盖边界

- 当前任务正文中的显式字段是本轮执行事实，历史批次只能作为参考。
- `docs/NEXT_TASK_CARD.md`、`docs/PROJECT_INDEX.md` 和历史批次文档不得替代 `original_request_text`。
- 禁止范围只能扩大，不能被自动分类缩小。
- `effective_final_status` 不信任单一 `status=succeeded`。它必须结合 `task_mode`、`read_only_mode`、`changed_files`、范围校验、commit/push/deploy 状态和失败码重算。
- read-only 任务出现任何 diff、commit SHA、成功 push 或部署记录，均应失败 `READ_ONLY_MODE_VIOLATION`。
- docs write 任务只允许命中 `docs/**` 或任务正文列出的更窄文档范围。
- automation system write 任务不得修改产品页面。
- product write 任务不得修改 Worker、飞书入口、腾讯云运行文件、数据库或环境变量。

## 丢失字段处理顺序

1. 读取显式 `HERMES_WORKER_CONTEXT`。
2. 读取 job `payload` 中的结构化字段。
3. 回退到 `request_text` 或 `original_request_text`。
4. 必要时运行自动分类，但只能补缺，不能覆盖更高优先级字段。
5. 历史上下文只能作为最后参考，并且不得覆盖当前任务正文。
6. 仍缺失关键写入权限字段时，任务必须停止并报告明确失败码。

## 本批 BATCH-ARCH-05 适用结论

- `project_domain=automation_architecture`
- `task_mode=docs_write_allowed`
- `read_only_mode=false`
- `allowed_scope=docs/architecture/**, docs/NEXT_TASK_CARD.md, docs/projects/feishu-gm-automation.md`
- `route=direct_worker_create`
- Codex 只修改指定文档，不执行 Git commit、push、部署或本地 dev server。

## BATCH-ARCH-06D implementation note

BATCH-ARCH-06D moves the contract from documentation into the Worker execution chain.

Implemented contract fields:

- `project_domain`
- `task_mode`
- `read_only_mode`
- `allowed_scope`
- `forbidden_scope`
- `original_request_text`
- `route`
- `payload`
- `approved_batch`
- `attempt_id`
- `workflow_stage`
- `final_report_status`
- `effective_final_status`
- `changed_files`
- `git_commit_sha`
- `pushed`
- `deploy_status`

Resolution order is explicit `HERMES_WORKER_CONTEXT`, then structured job `payload`, then current `request_text` or `original_request_text`, then automatic classification. `docs/NEXT_TASK_CARD.md`, `docs/PROJECT_INDEX.md`, and historical batch documents must not replace `original_request_text`.

`read_only` tasks may finish with `changed_files=[]` without `NO_FIX_APPLIED`. Any write-allowed task (`docs_write_allowed`, `automation_system_write_allowed`, or `product_write_allowed`) that reports success with no changed files must be treated as `NO_FIX_APPLIED`, and `effective_final_status` must become `failed`.

Final reports must show all four status layers separately:

- Worker execution status
- Task goal status
- `original_worker_status`
- `effective_final_status`

## BATCH-ARCH-07 normalized context contract

BATCH-ARCH-07 defines a single normalized context entry for Worker execution. Codex prompt generation, scope validation, task-goal validation, and final reporting must all read the same normalized context object.

Required normalized fields:

- `context_source`
- `context_reconstruct_failed`
- `project_domain`
- `task_mode`
- `read_only_mode`
- `allowed_scope`
- `forbidden_scope`
- `original_request_text`
- `route`
- `payload`
- `approved_batch`
- `attempt_id`
- `worker_stage`

Resolution order:

1. Explicit `HERMES_WORKER_CONTEXT`
2. Structured job `payload`
3. `original_request_text`
4. `request_text`
5. Automatic classification
6. Historical context, only as last-resort reference

When multiple `HERMES_WORKER_CONTEXT` blocks are present, Worker selects one preferred block instead of merging fields. The selected block must have the fewest missing core fields, prefer the current task text over nested historical text, and then prefer the block closest to the original demand. Nested `original_request_text_base64` may restore the original demand text, but it must not merge or expand `allowed_scope` / `forbidden_scope`.

If explicit `HERMES_WORKER_CONTEXT` is missing, Worker may fall back to structured payload or current task text, but it must emit `CONTEXT_MISSING_WARNING`. Missing explicit context must not silently become `product_write_allowed` or `read_only`.

Codex prompts must show the final effective normalized fields and must state that Codex only edits `allowed_scope`, respects `forbidden_scope`, does not run `git add`, `git commit`, or `git push`, and performs no writes for `read_only` tasks. Final reports must include `context_source`, `context_reconstruct_failed`, `project_domain`, `task_mode`, `read_only_mode`, `allowed_scope`, `forbidden_scope`, `approved_batch`, and `route`.
