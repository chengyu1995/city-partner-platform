# Hermes V2 Schema Review Checklist

Scope: Phase 2B review only.

Reviewed SQL: `docs/setup-hermes-v2-schema.sql`

Reference documents:

- `docs/upgrade/v2-data-model.md`
- `docs/upgrade/v2-task-state-machine.md`
- `docs/upgrade/v2-task-breakdown-rules.md`
- `docs/upgrade/v2-feishu-bitable-design.md`
- `docs/upgrade/v2-safety-and-approval-rules.md`
- `docs/upgrade/v2-implementation-plan.md`

This review did not execute SQL, did not connect to Supabase, and did not modify the SQL file, database, Worker, API, business code, `.env`, or `.gitignore`.

## 1. SQL 文件总体结论

结论：SQL 草案总体符合 Phase 2B 的安全边界。它只定义 Hermes V2 新表、注释和索引，没有直接修改 V1 `hermes_jobs`，也没有包含数据迁移、回填、RLS、触发器、函数或生产执行语句。

风险等级：中。主要原因不是破坏性语句，而是执行前置条件和兼容性细节仍需确认：`gen_random_uuid()` 依赖扩展、部分跨表字段仅存 UUID 未建外键、字段命名与 Phase 1A/1D 文档存在少量漂移。

## 2. 是否存在破坏性语句检查

未发现典型破坏性语句。SQL 主要由以下语句组成：

- `create table if not exists`
- `comment on table`
- `comment on column`
- `create index if not exists`

未发现会直接删除、清空、覆盖或迁移现有数据的语句。

## 3. 是否存在 DROP TABLE、TRUNCATE、DELETE FROM、ALTER TABLE hermes_jobs 检查

检查结果：

| 语句 | 是否发现 | 结论 |
| --- | --- | --- |
| `DROP TABLE` | 否 | 无表删除风险 |
| `TRUNCATE` | 否 | 无清空表风险 |
| `DELETE FROM` | 否 | 无删除数据风险 |
| `ALTER TABLE hermes_jobs` | 否 | 未修改 V1 表 |

未发现直接触碰 `hermes_jobs` 结构或数据的语句。

## 4. 是否只创建 V2 新表

是。SQL 创建的表均属于 Phase 1A 定义的 Hermes V2 表集合：

- `projects`
- `tasks`
- `task_checkpoints`
- `task_attempts`
- `task_events`
- `agents`
- `human_decisions`
- `deployments`
- `feishu_sync_outbox`

未发现创建 V1 兼容表以外的额外业务表。

## 5. 是否保留 hermes_jobs

是。SQL 未修改、删除或重命名 `hermes_jobs`。`tasks` 表通过 `legacy_hermes_job_id` 和 `legacy_job_id` 保留 V1 兼容关联，符合 Phase 1A 和 Phase 1F 的 V1 保留原则。

执行前仍需确认：真实数据库中的 `hermes_jobs.id` 类型是否与 `tasks.legacy_hermes_job_id uuid` 一致。如果 V1 `hermes_jobs.id` 不是 UUID，后续回填设计需要转换策略或改用 text 兼容字段。

## 6. 9 张新表是否齐全

齐全。

| 表名 | SQL 中是否存在 | 结论 |
| --- | --- | --- |
| `projects` | 是 | 通过 |
| `tasks` | 是 | 通过 |
| `task_checkpoints` | 是 | 通过 |
| `task_attempts` | 是 | 通过 |
| `task_events` | 是 | 通过 |
| `agents` | 是 | 通过 |
| `human_decisions` | 是 | 通过 |
| `deployments` | 是 | 通过 |
| `feishu_sync_outbox` | 是 | 通过 |

## 7. 每张表 id、created_at、updated_at 字段检查

全部 9 张表都有：

- `id uuid primary key default gen_random_uuid()`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

风险：SQL 没有创建自动维护 `updated_at` 的触发器。后续 API/Worker 写入必须显式维护 `updated_at`，或在单独批准的迁移中增加通用触发器。

## 8. projects 表字段完整性检查

`projects` 覆盖 Phase 1A 的核心字段：项目 key、名称、描述、仓库、默认分支、worktree、生产/预览 URL、Feishu locator、settings、status、时间戳。

已包含必要约束：

- `projects_key_unique`
- `projects_status_check`

风险：

- `feishu_app_token` 字段按注释定义为非密 locator，但名称容易被误解为密钥。执行前需确认该字段只存 app token/table locator，不存 app secret。
- `default_base_branch` 默认值为 `master`，与当前 Worker 任务前置条件一致，但如果项目 Git 规范切回 `dev`，需要项目级配置而非硬编码依赖。

## 9. tasks 表字段完整性检查

`tasks` 覆盖 Phase 1A/1B 的主体字段：项目、父任务、V1 legacy、来源、Feishu locator、任务类型/层级、标题、描述、验收、prompt、仓库/分支、优先级、状态、阶段、进度、人工决策、依赖、尝试次数、最新结果、时间戳。

补充字段值得保留：

- `need_human_decision`
- `requires_human_decision boolean generated always as (need_human_decision) stored`
- `risk_level`
- `dependency_task_ids uuid[]`

风险：

- `dependency_task_ids uuid[]` 不能由外键约束保证引用有效，后续 API/Worker 必须校验依赖任务存在且无环。
- `last_attempt_id uuid` 未引用 `task_attempts(id)`，可以避免建表顺序循环，但会牺牲数据库层完整性。
- Phase 1A 中 `requires_human_decision` 是主字段，SQL 使用生成列做兼容别名，后续 API 应统一写 `need_human_decision`。

## 10. task_checkpoints 表字段完整性检查

`task_checkpoints` 覆盖 checkpoint 的核心字段：任务、尝试、顺序、类型、标题、状态、进度、Git ref/SHA、worktree、clean 状态、变更路径、验证状态、证据、创建者、时间戳。

风险：

- `attempt_id` 未建外键到 `task_attempts(id)`。
- `created_by_agent_id` 未建外键到 `agents(id)`。
- Phase 1C 中 checkpoint 作为逻辑节点存在，SQL 当前将其作为独立元数据表，符合设计；如果 Feishu 需要 checkpoint 行出现在 Task Details，后续同步层需做映射。

## 11. task_attempts 表字段完整性检查

`task_attempts` 覆盖执行尝试、Worker claim、heartbeat、进度、Git 结果、输出引用、错误和失败分类字段。

已包含重要约束：

- 状态 check
- 进度 0 到 100
- `attempt_number >= 1`
- `duration_ms` 非负

风险：

- `claim_token` 当前允许为空，但 Phase 1A/1B 设计中 claim token 是所有权校验核心字段。建议在进入真实 Worker V2 之前确认是否应设为 `not null`，或者只允许准备态为空。
- 缺少 `(task_id, attempt_number)` 唯一约束，可能允许同一任务出现重复尝试编号。
- `agent_id` 未建外键到 `agents(id)`。

## 12. task_events 表字段完整性检查

`task_events` 覆盖项目、任务、尝试、agent、人工决策、部署、事件类型、状态变化、严重级别、消息、payload、幂等键和时间戳。

风险：

- `attempt_id`、`agent_id`、`human_decision_id`、`deployment_id` 未建外键。
- 未对 `event_type` 设置 check constraint，灵活性高，但容易产生事件命名漂移。后续 API 应集中定义事件常量。
- `idempotency_key` 有部分索引但不是 unique，不能单独防止重复事件。

## 13. agents 表字段完整性检查

`agents` 覆盖项目、agent 名称、角色、类型、external id、capabilities、状态、heartbeat/last seen、metadata 和时间戳。

风险：

- Phase 1A 和 Phase 1D 文档多处使用 `agents.name`，SQL 使用 `agent_name`。这属于字段命名漂移，后续 API/Feishu 同步必须统一，否则容易出现读取字段错误。
- `capabilities jsonb` 默认数组，语义清晰，但无 schema 校验。
- `project_id` 允许为空，符合全局 agent 场景；若某些 Worker 只能服务单项目，应用层需校验。

## 14. human_decisions 表字段完整性检查

`human_decisions` 覆盖项目、任务、尝试、决策类型、决策状态、问题、选项、选择结果、文本、请求/决策 agent、外部渠道、过期/决策/解决时间、metadata 和时间戳。

风险：

- Phase 1A/1D 文档中字段常写作 `status`，SQL 使用 `decision_status`。这可能是为了避免歧义，但后续 API/Feishu 字段映射必须明确。
- `attempt_id`、`requested_by_agent_id`、`decided_by_agent_id` 未建外键。
- `question text not null` 比 Phase 1A 文档更严格，合理但需要确认所有 approval/review 类型都能提供问题文本。

## 15. deployments 表字段完整性检查

`deployments` 覆盖项目、任务、尝试、provider、environment、部署状态、Git commit/branch、preview/production/deployment URL、provider id、callback 幂等键、时间戳、错误和 payload。

风险：

- Phase 1A/1D 文档中常称 `status`，SQL 使用 `deploy_status`。后续 API/Feishu 同步需要统一映射。
- `git_commit_sha text not null` 要求所有 deployment 记录都有 commit。对于手工或 provider 回调先到、commit 未解析的场景，可能需要先不建记录或延迟写入。
- `attempt_id` 未建外键到 `task_attempts(id)`。

## 16. feishu_sync_outbox 表字段完整性检查

`feishu_sync_outbox` 覆盖项目、任务、尝试、部署、人工决策、同步类型、目标类型、目标 app/table/record/chat/message、operation、payload、desired_payload、状态、重试、下次/上次/成功时间、错误、幂等键和时间戳。

风险：

- Phase 1A/1D 文档中常称 `status`、`attempt_count`，SQL 使用 `sync_status`、`retry_count`。命名更具体，但需要同步层统一。
- `operation text not null` 没有 check constraint，后续可能出现 `upsert_record`、`update_record`、`send_message` 等拼写漂移。
- `target_app_token` 注释定义为非密 locator，执行前必须确认不存 app secret。

## 17. 外键关系风险检查

已建外键：

- `tasks.project_id -> projects(id)`
- `tasks.parent_task_id -> tasks(id)`
- `task_checkpoints.task_id -> tasks(id)`
- `task_attempts.task_id -> tasks(id)`
- `task_events.project_id -> projects(id)`
- `task_events.task_id -> tasks(id)`
- `agents.project_id -> projects(id)`
- `human_decisions.project_id -> projects(id)`
- `human_decisions.task_id -> tasks(id)`
- `deployments.project_id -> projects(id)`
- `deployments.task_id -> tasks(id)`
- `feishu_sync_outbox.project_id -> projects(id)`
- `feishu_sync_outbox.task_id -> tasks(id)`

未建外键但语义上有关联的字段：

- `tasks.last_attempt_id`
- `task_checkpoints.attempt_id`
- `task_checkpoints.created_by_agent_id`
- `task_attempts.agent_id`
- `task_events.attempt_id`
- `task_events.agent_id`
- `task_events.human_decision_id`
- `task_events.deployment_id`
- `human_decisions.attempt_id`
- `human_decisions.requested_by_agent_id`
- `human_decisions.decided_by_agent_id`
- `deployments.attempt_id`
- `feishu_sync_outbox.attempt_id`
- `feishu_sync_outbox.deployment_id`
- `feishu_sync_outbox.human_decision_id`

结论：当前设计降低了建表顺序和循环依赖复杂度，但把一部分完整性责任交给应用层。进入执行前应决定是否接受这种折中，或分阶段 `alter table add constraint` 补齐外键。

## 18. 索引数量与必要性检查

SQL 定义了 40 个索引，覆盖主要查询维度：

- 项目状态/key
- 任务项目、父任务、状态优先级、人工决策、层级、风险、legacy、Feishu record、依赖数组
- checkpoint task/attempt/status
- attempt task/agent/status/worker/heartbeat/commit
- event project/task/attempt/type/idempotency
- agent project/name/role status/heartbeat
- decision project/task/attempt/status/decided_at
- deployment project/task/attempt/environment status/commit/callback key
- outbox project/task/status next attempt/target/idempotency

风险：

- 索引数量对空库和早期 MVP 可接受，但生产大表写入会有维护成本。
- `idempotency_key` 索引不是 unique，无法单独保证幂等。
- `dependency_task_ids` GIN 索引适合包含查询，但数组依赖仍缺乏引用完整性。

## 19. Supabase / PostgreSQL 兼容性检查

语法总体兼容 PostgreSQL/Supabase：

- `uuid`
- `timestamptz`
- `jsonb`
- `uuid[]`
- `generated always as (...) stored`
- partial index
- GIN index
- `comment on`

风险：

- `gen_random_uuid()` 依赖 `pgcrypto` 扩展。Supabase 通常支持，但目标库必须确认扩展已启用。
- SQL 未包含 `create extension if not exists pgcrypto;`。如果人工执行环境未启用扩展，第一张表创建会失败。
- SQL 未包含 RLS 策略。作为 Phase 2B 审核草案可以接受，但不能直接视为完整生产迁移。

## 20. uuid 默认值函数检查

所有主键使用：

```sql
default gen_random_uuid()
```

风险：需要 `pgcrypto` 扩展。人工执行前必须确认：

```sql
select gen_random_uuid();
```

能够在目标环境执行，或由人类批准后先执行：

```sql
create extension if not exists pgcrypto;
```

不建议由 Agent 自动执行扩展创建。

## 21. jsonb 字段使用检查

`jsonb` 用于 settings、metadata、payload、result_payload、options、capabilities、changed_paths、untracked_paths、desired_payload 等扩展型字段，符合 Phase 1A/1D 的设计目标。

风险：

- `jsonb` 字段没有 schema 校验，字段漂移风险较高。
- 不应在 `jsonb` 中存储 secrets、claim token、完整日志或大块 stdout/stderr。
- Feishu outbox 的 `payload` 和 `desired_payload` 需要后续同步层做脱敏和大小控制。

## 22. 状态枚举使用 text 还是 check constraint 的风险分析

SQL 使用 `text` 字段加 check constraint，而不是 PostgreSQL enum 类型。

优点：

- 后续新增状态更容易通过修改 check constraint 演进。
- 避免 enum 类型变更在迁移和回滚中的复杂度。
- 更适合 MVP 和多阶段灰度。

风险：

- 多表状态字段命名不同：`status`、`decision_status`、`deploy_status`、`sync_status`。
- 部分枚举未覆盖文档中的全部显示别名，例如 Feishu `waiting_review` 只应作为显示别名，不应进入内部状态。
- `event_type` 和 `operation` 未加 check，仍有漂移空间。

结论：text + check constraint 是合理选择，但必须由 API/Worker 统一常量和映射。

## 23. 是否可能与现有表名冲突

可能存在低到中风险。表名 `projects`、`tasks`、`agents`、`deployments` 都是通用名称，如果 Supabase 当前项目已有同名业务表，`create table if not exists` 不会报错，但后续 `comment on column` 或 `create index` 可能因字段不匹配失败，或更严重地把 V2 语义叠到已有表上。

人工执行前必须确认目标 schema 中不存在同名非 Hermes 表。若存在冲突，应考虑加前缀，例如 `hermes_projects`、`hermes_tasks`，或使用独立 schema。

## 24. 是否可能与未来 API 改造冲突

存在中风险：

- `agents.agent_name` 与文档/Feishu 设计里的 `agents.name` 不一致。
- `human_decisions.decision_status`、`deployments.deploy_status`、`feishu_sync_outbox.sync_status` 与文档中的泛称 `status` 需要 API 映射。
- `claim_token` 可空可能与 Worker claim 所有权校验冲突。
- `last_attempt_id` 无外键会要求 API 自己保证最新尝试引用正确。

这些问题不阻止审核继续，但建议在 API Phase 3 前统一字段契约。

## 25. 是否可能与 Worker V2 改造冲突

存在中风险：

- Worker claim 需要唯一 claim token 和原子领取策略，SQL 目前只提供表结构，没有唯一约束、claim 函数或事务策略。
- `(task_id, attempt_number)` 未唯一，Worker 并发创建 attempt 时可能出现重复编号。
- 进度单调性只能由 Worker/API 保证，数据库没有约束。
- heartbeat stale 和 timeout 需要 Worker/API 定义时间窗口，SQL 只提供字段。

建议 Worker V2 前补充 claim API/事务设计，不要让 Worker 直接用简单 select/update 实现领取。

## 26. 是否可能与飞书同步改造冲突

存在中风险：

- `feishu_sync_outbox.operation` 未枚举，可能导致同步 worker 分支处理漂移。
- outbox 没有唯一幂等约束，重复同步项需要应用层合并或去重。
- `target_app_token`、`target_table_id`、`target_record_id` 等 locator 字段允许为空，适合多目标，但同步 worker 必须按 `target_type` 校验必填项。
- Phase 1D 设计的多 Bitable 表绑定规则只在 `tasks.feishu_record_id` 中有直接字段，其他表可能需要 metadata 或后续 mapping 设计。

## 27. 人工执行 SQL 前必须确认的事项

人工执行前至少确认：

1. 目标环境是 local、staging 还是 production。
2. 已有备份或可恢复点，并记录恢复负责人。
3. 当前 schema 是否已有同名表。
4. `pgcrypto` / `gen_random_uuid()` 是否可用。
5. V1 `hermes_jobs` 仍可读写，且 runtime mode 保持 V1。
6. 没有任何应用、Worker、API、Feishu 代码会在执行后立刻切到 V2。
7. 字段命名漂移已被 API/Worker/Feishu 契约接受或修订。
8. 是否需要补齐外键、唯一约束、RLS、updated_at 触发器。
9. SQL 中没有真实 key、token、app secret、service role 或连接串。
10. 执行者具备数据库变更审批权限。

## 28. 建议执行顺序

建议顺序：

1. 在本地或 staging clone 数据库验证 `gen_random_uuid()`。
2. 确认没有同名表冲突。
3. 人工运行建表语句，不运行任何数据迁移或回填。
4. 人工运行注释语句。
5. 人工运行索引语句。
6. 查询 9 张表结构，确认字段、约束、索引存在。
7. 验证 `hermes_jobs` 未变化。
8. 保持 runtime mode 为 V1，不启用 V2 API/Worker。
9. 记录执行日志和回滚入口。

## 29. 回滚注意事项

如果 SQL 尚未执行：无需数据库回滚，只需保留审核结论。

如果已在非生产执行且需要回滚：

- 优先确认是否已有 V2 测试数据。
- 若无数据且已获批准，可按依赖反序删除 V2 新表。
- 若已有数据，先导出或保留审计记录，再由人类批准清理。
- 不要删除或修改 `hermes_jobs`。
- 不要通过 Agent 自动执行数据库回滚。

如果已在生产执行：

- 不应自动 drop 表。
- 保持 runtime mode 为 V1。
- 禁用任何 V2 writer。
- 由人类按备份/恢复流程处理。

## 30. 是否建议进入阶段 2C

建议有条件进入阶段 2C：可以进入“SQL 修订、约束确认和人工执行前审批材料”阶段；不建议直接进入任何执行数据库 SQL 的阶段。

进入 2C 前应把本清单中的中风险项转成明确决策：哪些通过 SQL 修订解决，哪些由 API/Worker/Feishu 应用层保证。

## 31. 如果不建议进入 2C，列出必须修复的问题

不建议进入“执行型 2C”。若 2C 会执行 SQL，则必须先修复或确认：

1. 确认 `pgcrypto` / `gen_random_uuid()` 前置条件，必要时由人类批准扩展创建。
2. 确认通用表名不会与现有表冲突。
3. 统一 `agents.agent_name` vs `agents.name` 的字段契约。
4. 统一 `decision_status`、`deploy_status`、`sync_status` 与文档/API/Feishu 的映射。
5. 决定是否补齐 attempt、agent、decision、deployment、outbox 相关外键。
6. 决定是否增加 `(task_id, attempt_number)` 唯一约束。
7. 决定 `claim_token` 是否必须 `not null`。
8. 明确 `updated_at` 由应用层维护还是数据库触发器维护。
9. 明确 RLS 不在本 SQL 中，生产使用前需要单独批准 RLS 方案。
10. 明确 outbox 幂等键是否需要 unique 或应用层去重。

最终审核结论：SQL 草案当前适合作为 V2 schema draft 继续审查和修订，不适合作为未经人工审批的生产迁移直接执行。
