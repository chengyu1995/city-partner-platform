# 自动化系统项目：飞书总经理 / 腾讯云中转 / Worker / Codex / Hermes

## 项目定位

该项目是同城搭子网站的自动化执行系统，负责接收飞书需求、进入项目总管 planning、等待老板批准、分发 Worker/Codex 执行任务，并把结果按项目总管模板回报。

本档案只整理系统资料，不修改自动化代码、不触发 Worker 任务、不调用 GitHub 写入接口。

## 核心链路

```text
飞书需求
  -> 飞书总经理模式 / 项目总管
  -> planning_only 任务树
  -> 老板查看计划或修改计划
  -> 总管 批准执行
  -> Worker API 任务队列
  -> Windows Worker 领取任务
  -> Codex 修改文件
  -> 外层 Worker 负责 Git 提交和推送
  -> Worker report
  -> 飞书项目总管报告
```

## 模块分类

| 模块 | 说明 | 主要资料 |
| --- | --- | --- |
| 飞书总经理模式 | 识别需求、命令、验收反馈和老板选择。 | `docs/ops/project-director-mode.md`、`docs/ops/project-director-production-mode.md` |
| 腾讯云 feishu-gateway | 接收飞书事件和中转 Worker API。 | `docs/WORKER_ARCHITECTURE.md`、`docs/ops/cloud-feishu-gateway-choice-routing-fix.md` |
| worker-api | 提供 Worker 领取任务、上报进度和终态报告的接口。 | `src/app/api/worker/*`、`docs/ops/worker-final-report-template.md` |
| Windows Worker | 本地领取任务并调用 Codex。 | `infra/windows-worker/README.md` |
| Codex 执行链路 | 只负责文件修改和结果汇报，Git 由外层 Worker 处理。 | `infra/windows-worker/README.md` |
| Hermes / Agent 调度 | 拆分任务、生成 Agent 任务树和批准执行计划。 | `docs/ops/agent-dispatch-architecture.md` |
| 老板控制台命令 | 状态、帮助、暂停、恢复、批准执行、Agent 状态。 | `docs/ops/boss-feishu-command-guide.md`、`docs/ops/agent-status-dashboard.md` |
| Worker 安全检查 | attempt_id、终态幂等、Git 安全、密钥脱敏。 | `docs/upgrade/batch-17-project-director-loop.md`、`infra/windows-worker/README.md` |
| 批次批准解析 | A/B 选择、修改计划、批准建议优先于普通需求。 | `docs/product/batch-22-choice-routing-notes.md` |
| 飞书回报模板 | 成功/失败终态统一项目总管报告。 | `docs/ops/worker-final-report-template.md` |

## 当前有效规则

- 普通网站需求不直接进入 Codex。
- `选 A`、`选 B`、`批准建议`、`修改计划：xxx` 只进入 planning，不创建执行任务。
- 只有 `总管 批准执行` 可以进入 approved execution。
- Worker 领取任务后必须使用匹配的 `attempt_id` 上报 heartbeat、progress 和 report。
- succeeded/failed 终态必须幂等，不允许后续报告覆盖。
- Codex 不执行 Git 提交、推送、建分支或 GitHub 写入。

## 相关批次

| 批次 | 内容 |
| --- | --- |
| BATCH-17 | 建立项目总管任务分发与老板验收闭环。 |
| BATCH-18 | 静态全链路验收。 |
| BATCH-20 | 运营前系统硬化和控制台命令优先级。 |
| BATCH-22 choice routing | 修复 A/B 选择和修改计划路由顺序。 |
| BATCH-27 | Worker 完成后飞书项目总管报告模板。 |

## 禁止范围

- 不直接输出或执行产品规划。
- 不绕过老板批准创建 Worker/Codex 执行任务。
- 不记录真实 token、secret、service key。
- 不修改生产环境变量。
- 不修改数据库。
- 不部署生产。
- 不删除旧备份文件。

## BATCH-38A 空跑防护规则

- Worker 执行成功不等于任务目标完成；最终报告必须同时区分 `Worker execution` 和 `Task goal`。
- 如果任务正文要求修复、新增、更新、补齐、建立或修改，但 Codex 结束后没有任何文件变更，Worker 必须上报 failed。
- 该失败统一使用 `NO_FIX_APPLIED`，并进入失败报告和验证结果，不允许作为 Git warning 后继续 succeeded。
- 如果任务明确要求修改指定文件，而变更文件没有命中任何指定文件，也必须按 `NO_FIX_APPLIED` failed。
- 当前执行批次只从标题、修复目标和批准语句提取；禁止从“禁止范围”中的 BATCH-P3、BATCH-P4 或历史批次文字提取当前批次。
- `总管 批准修复` 等价进入 `总管 批准执行` 链路，但只能执行对应失败批次的最小修复任务；找不到匹配批次时不得分发其他批次。
- 自动化系统修复任务归类为 `automation_system`，不得把同城搭子产品页面、首批城市、首批分类、访客浏览、本地草稿或待审核流程作为完成依据。
- 文档整理、测试审核和运营类任务分别归类为 `governance_docs`、`qa_review` 和 `operations`。

## BATCH-38A 腾讯云同步记录

- 已同步腾讯云 `/home/ubuntu/city-partner-agent/worker_api.js`：云端 Worker report 会把变更型任务的空跑 succeeded 改判为 failed，并在错误文本中写入 `NO_FIX_APPLIED`、`Worker execution` 和 `Task goal`。
- 已同步腾讯云 `/home/ubuntu/city-partner-agent/feishu_gateway_canonical.js`：`总管 批准修复` 进入批准执行链路；批次只从标题、修复目标和批准语句提取；自动化、文档、测试、运营任务不会套用同城搭子产品上下文。
- 腾讯云备份文件：`worker_api.js.bak.batch38a-20260709104241`、`feishu_gateway_canonical.js.bak.batch38a-20260709104241`。
- 腾讯云 PM2 已重启 `worker-api` 和 `feishu-gateway`；未修改远端 `.env`、数据库、Vercel 配置，也未执行部署。

## BATCH-42A read-only and cloud fallback

- Windows Worker now keeps a process-level read-only Git write lock. When `read_only_mode=true`, `git add`, `git commit`, and `git push` are refused with `READ_ONLY_MODE_VIOLATION`.
- A read-only task that leaves any Git diff fails during task-goal validation with `READ_ONLY_MODE_VIOLATION`; the failure report lists changed files and does not use `completed_with_warning`.
- Final reports include separate fields for Worker execution status, task goal status, read-only violation, no-op run, committed, and pushed.
- Tencent Cloud `/home/ubuntu/city-partner-agent/worker_api.js` now coerces a reported `succeeded` terminal report to `failed` when `read_only_mode=true` but `files_changed`, `git_commit_sha`, or a successful push is present.
- Tencent Cloud `worker_api.js` still coerces mutation-task empty reports to `failed` with `NO_FIX_APPLIED`.
- Tencent Cloud `/home/ubuntu/city-partner-agent/feishu_gateway_canonical.js` keeps `总管 批准修复` on the approved-execution path, extracts the current batch only from title/repair/approval text, and keeps `governance_docs`, `automation_system`, `qa_review`, and `operations` separate from city-partner product context.
- Tencent Cloud backups for this batch: `worker_api.js.bak.batch42a-20260709120234`, `feishu_gateway_canonical.js.bak.batch42a-20260709120234`.

## BATCH-GM-STABILIZE-01 task_mode and final-status guard

- Unified task modes are `read_only`, `docs_write_allowed`, `automation_system_write_allowed`, and `product_write_allowed`.
- `BATCH-43` is `read_only`; any diff, commit SHA, or successful push fails with `READ_ONLY_MODE_VIOLATION`.
- `BATCH-37-FIX` and governance-doc tasks are `docs_write_allowed`, even if an older `read_only_mode=true` flag is present.
- `BATCH-44`, `BATCH-45A`, Worker, Gateway, Codex, Hermes, route, and report fixes are `automation_system_write_allowed`, even if an older `read_only_mode=true` flag is present.
- Effective final status is failed when `READ_ONLY_MODE_VIOLATION`, `OUT_OF_SCOPE_BUSINESS_CHANGE`, `NO_FIX_APPLIED`, failed task-goal status, or read-only Git side effects are present.
- Tencent Cloud `worker_api.js` recomputes `effective_final_status` from the report payload instead of trusting `body.status=succeeded`.
- Tencent Cloud `feishu_gateway_canonical.js` preserves `original_request_text`, `approved_batch`, `task_mode`, `read_only_mode`, `allowed_scope`, `forbidden_scope`, `task_goal`, and `project_domain` in Worker request text.
- Tencent Cloud backups for this stabilization: `worker_api.js.bak.gm-stabilize-20260709163919`, `feishu_gateway_canonical.js.bak.gm-stabilize-20260709163919`.

## BATCH-GM-STABILIZE-02 smoke-test mode guard

- `BATCH-GM-SMOKE-*` is always `read_only`; it is a final validation smoke test and may not write files.
- `docs_write_allowed` is limited to `BATCH-37-FIX`, explicit `docs_write_allowed`, or mutation requests that name a `docs/` path.
- `automation_system_write_allowed` is limited to explicit Worker, Gateway, worker-api, project-director, worker-jobs, local_worker, or git-safety repair tasks.
- When task-mode inference cannot resolve a write mode, the Worker conservatively falls back to `read_only`.
- `pollOnce` reports use the scoped `taskModeForReport` value so success and failure report paths cannot throw `taskMode is not defined`.

## BATCH-GM-STABILIZE-03 docs task priority and cloud terminal guard

- `BATCH-37-DOCS-*` and `BATCH-37-FIX` resolve to `docs_write_allowed` with `read_only_mode=false`; stale outer `read_only_mode=true` flags do not demote them to read-only.
- A docs task locked by an outer read-only flag fails with `TASK_MODE_MISMATCH` instead of reporting `succeeded`.
- Docs write tasks must produce a `docs/**` diff or fail with `NO_FIX_APPLIED`.
- Tencent Cloud `worker_api.js` scans the full JSON report body before accepting `succeeded`; unfinished task-goal text, `TASK_MODE_MISMATCH`, read-only locks, and known failure codes coerce `effective_final_status=failed`.
- Tencent Cloud `feishu_gateway_canonical.js` emits `approved_batch`, `task_mode=docs_write_allowed`, `read_only_mode=false`, `allowed_scope=docs/**`, `forbidden_scope`, and `original_request_text` for `BATCH-37-DOCS-*`.

## BATCH-37-DOCS-02 approved docs execution

- Approval source: `总管 批准执行：仅批准 BATCH-37-DOCS-02`.
- Task classification: `automation_system`; task mode: `docs_write_allowed`; read-only mode: `false`.
- Allowed scope: `docs/**` only. Forbidden scope remains `src/app/**`, `src/lib/db/mock.ts`, `src/types/db.ts`, env, database, worker, and Tencent Cloud files.
- Completion requires a real `docs/**` diff. If no documentation change is produced, task-goal validation must fail with `NO_FIX_APPLIED`.
- Final reporting must separate Worker execution status from task goal status, and must explicitly report `NO_FIX_APPLIED`, `READ_ONLY_MODE_VIOLATION`, read-only violation, empty run, committed, and pushed fields.
- This batch does not validate city-partner product pages, product batches, first-city/category content, guest browsing, local drafts, or pending-review flows.
