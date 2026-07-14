# 知识库 schema

本知识库当前采用文档型知识库，不接数据库，不接向量库。所有知识先以 Markdown 文档维护，后续如需数据库或向量索引，必须另起批次并以本 schema 为迁移依据。

## 设计目标

- 把项目事实、架构事实、失败记忆、决策记录、批次记录、Agent 分工和下一步计划分开保存。
- 避免历史上下文覆盖当前任务正文。
- 让 Worker、项目总经理、Codex 和最终报告层引用同一组字段名。
- 支持人工审阅和 Git diff，不依赖隐藏数据库状态。

## 存储形态

建议后续使用以下文档目录，BATCH-ARCH-05 只定义 schema，不创建完整知识库内容：

```text
docs/knowledge/
  project/
  architecture/
  failures/
  decisions/
  batches/
  agents/
  next-plans/
  index.md
```

每条知识使用一个 Markdown 文件，文件头使用 YAML front matter，正文写人类可读说明。索引文件只做导航，不做事实覆盖。

## 通用 front matter

```yaml
id: KB-YYYYMMDD-short-name
type: project_knowledge
project: city-partner-platform
project_domain: automation_architecture
source_batch: BATCH-ARCH-05
source_route: direct_worker_create
status: active
created_at: 2026-07-14
updated_at: 2026-07-14
owners:
  - project-director
related_files:
  - docs/architecture/context-contract.md
related_batches:
  - BATCH-ARCH-05
tags:
  - context-contract
```

通用字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 知识条目的稳定 ID，不因标题修改而变化 |
| `type` | 是 | 见下方知识类型 |
| `project` | 是 | 项目名或仓库名 |
| `project_domain` | 是 | 使用 `context-contract.md` 中定义的枚举 |
| `source_batch` | 是 | 产生或最后验证该知识的批次 |
| `source_route` | 否 | direct worker create、approved execution、manual review 等 |
| `status` | 是 | active、superseded、deprecated、draft |
| `created_at` | 是 | 首次写入日期 |
| `updated_at` | 是 | 最近更新日期 |
| `owners` | 否 | 负责维护的角色或 Agent |
| `related_files` | 否 | 相关仓库文件 |
| `related_batches` | 否 | 相关批次 |
| `tags` | 否 | 便于人工检索 |

## 知识类型

| 类型 | 目录 | 用途 | 关键字段 |
| --- | --- | --- | --- |
| `project_knowledge` | `docs/knowledge/project/` | 项目定位、业务边界、运行约束、仓库约定 | `scope`、`current_status`、`do_not_override` |
| `architecture_knowledge` | `docs/knowledge/architecture/` | 字段契约、链路设计、模块关系、接口语义 | `component`、`contract_fields`、`upstream`、`downstream` |
| `failure_memory` | `docs/knowledge/failures/` | 失败原因、误判模式、防复发规则 | `failure_code`、`trigger`、`detection`、`prevention` |
| `decision_record` | `docs/knowledge/decisions/` | 人类或项目总经理作出的架构/流程决策 | `decision`、`alternatives`、`impact`、`revisit_when` |
| `batch_record` | `docs/knowledge/batches/` | 每个批次的目标、范围、结果、commit/push/deploy 状态 | `approved_batch`、`task_mode`、`changed_files`、`effective_final_status` |
| `agent_assignment` | `docs/knowledge/agents/` | 项目总经理、飞书入口、Worker、Codex、外层 Worker、QA 的职责 | `agent`、`responsibilities`、`allowed_actions`、`forbidden_actions` |
| `next_plan` | `docs/knowledge/next-plans/` | 下一批执行顺序、前置条件、验收条件 | `next_batch`、`depends_on`、`exit_criteria` |

## 各类型 schema

### 项目知识

```yaml
type: project_knowledge
scope: automation_architecture
current_status: active
do_not_override:
  - original_request_text
  - explicit HERMES_WORKER_CONTEXT
```

正文必须说明项目事实、边界、禁止事项和当前有效状态。项目知识不能直接授权写入，写入权限仍以当前任务正文为准。

### 架构知识

```yaml
type: architecture_knowledge
component: context-contract
contract_fields:
  - task_mode
  - project_domain
upstream:
  - feishu-gateway
downstream:
  - windows-worker
```

正文必须说明组件之间的输入、输出、字段优先级和失败处理。架构知识不得覆盖当前批次 payload，只能作为实现依据。

### 失败记忆

```yaml
type: failure_memory
failure_code: NO_FIX_APPLIED
trigger: write_allowed task produced no allowed-scope diff
detection: changed_files is empty after Codex
prevention: enforce write task validation before final succeeded
```

失败记忆必须包含失败码、触发条件、检测方式、防复发措施和最后验证批次。失败记忆不能把 read-only 的 `changed_files=[]` 误判为失败。

### 决策记录

```yaml
type: decision_record
decision: document knowledge base first
alternatives:
  - database
  - vector store
impact: lower operational risk and reviewable diffs
revisit_when: document schema cannot support search or audit needs
```

决策记录必须写清选择、备选项、影响范围和重新评估条件。

### 批次记录

```yaml
type: batch_record
approved_batch: BATCH-ARCH-05
task_mode: docs_write_allowed
read_only_mode: false
changed_files:
  - docs/architecture/context-contract.md
git_commit_sha: not_created_by_codex
pushed: not_attempted_by_codex
deploy_status: not_deployed
effective_final_status: pending_outer_worker_commit
```

批次记录必须使用 `context-contract.md` 中定义的字段名。Codex 阶段不得伪造 commit SHA、push 或 deploy 结果。

### Agent 分工

```yaml
type: agent_assignment
agent: codex
responsibilities:
  - modify approved files
  - report changed files and validation results
allowed_actions:
  - edit allowed docs files
forbidden_actions:
  - git commit
  - git push
  - start dev server
```

Agent 分工必须列出职责、允许动作、禁止动作和交接对象。

### 下一步计划

```yaml
type: next_plan
next_batch: BATCH-ARCH-06
depends_on:
  - BATCH-ARCH-05
exit_criteria:
  - context fields are preserved in Worker payload
```

下一步计划只描述未来批次，不自动创建 Worker 任务，也不覆盖当前任务正文。

## 检索与引用规则

- 先读当前任务正文和 `HERMES_WORKER_CONTEXT`，再读知识库。
- 知识库提供背景和 schema，不提供本轮写入授权。
- 历史批次记录不得覆盖当前 `approved_batch`。
- 失败记忆可以提高校验严格度，但不能降低禁止范围。
- 索引文档只能指向知识条目，不复制关键字段，避免重复信息漂移。

## 当前不做的事

- 不接数据库。
- 不接向量库。
- 不做自动 embedding。
- 不把知识库作为权限系统。
- 不让知识库覆盖 `original_request_text`、payload 或显式 `HERMES_WORKER_CONTEXT`。
