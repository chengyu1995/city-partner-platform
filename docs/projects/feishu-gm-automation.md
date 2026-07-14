# 自动化系统项目：飞书总经理 / 腾讯云中转 / Worker / Codex / Hermes

## 项目定位

该项目是同城搭子平台的自动化执行系统，负责接收飞书需求、进入项目总经理 planning、等待老板批准、分发 Worker/Codex 执行任务，并把结果按项目总经理模板回报。

本文档只记录自动化架构和协作规则，不授权修改产品页面、数据库、环境变量或腾讯云运行文件。

## 核心链路

```text
飞书需求
  -> 飞书入口 / 项目总经理
  -> planning 或 direct worker create
  -> 老板批准执行
  -> Worker API 任务队列
  -> Windows Worker 领取任务
  -> Codex 修改允许范围文件
  -> 外层 Worker 负责 Git commit / push
  -> Worker final report
  -> 飞书项目总经理报告
  -> 文档型知识库沉淀
```

## 当前统一字段

字段契约以 `docs/architecture/context-contract.md` 为准。所有入口和报告层必须使用同一组字段：

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
- `final_report_status`
- `effective_final_status`
- `changed_files`
- `git_commit_sha`
- `pushed`
- `deploy_status`

字段优先级规则：显式 HERMES_WORKER_CONTEXT > payload > request_text/original_request_text > 自动分类 > 历史上下文。

只读任务规则：read_only 任务 changed_files=[] 是正常状态，不得触发 NO_FIX_APPLIED。

写入任务规则：write_allowed 任务必须产生允许范围内变更，否则触发 NO_FIX_APPLIED。

## 模块分工

| 模块 | 职责 | 禁止事项 |
| --- | --- | --- |
| 飞书入口 | 接收需求、保留原始正文、识别 route、创建 planning 或 Worker job | 不用历史批次覆盖当前任务正文 |
| 项目总经理 | 生成计划、等待批准、明确 approved batch 和任务模式 | 不跳过老板批准直接执行产品任务 |
| Worker API | 保存 payload、分发任务、接收 heartbeat/progress/final report | 不信任缺失关键字段的写入任务 |
| Windows Worker | 领取任务、生成 Codex prompt、执行静态校验、上报结果 | 不执行未批准范围，不在 read-only 下写入 |
| Codex | 只修改任务允许范围内文件并汇报验证结果 | 不创建分支，不 commit，不 push，不部署，不启动 dev server |
| 外层 Worker | 根据验收目标处理 Git commit/push 并补充 SHA 状态 | 不让 Codex 代替 Git 操作 |
| 最终报告层 | 计算 `effective_final_status`，区分 Worker 成功和任务目标完成 | 不只凭 `status=succeeded` 判定成功 |
| 文档型知识库 | 沉淀项目知识、架构知识、失败记忆、决策、批次、Agent 分工和下一步计划 | 不作为当前任务正文的替代来源 |

## BATCH-ARCH-05 记录

任务性质：

- 自动化架构文档与 schema 设计任务。
- 不是产品开发任务。
- 不是系统代码修复任务。
- 不修改 Worker 代码。
- 不修改腾讯云运行文件。
- 不修改产品页面。

本批产物：

- `docs/architecture/context-contract.md`
- `docs/architecture/knowledge-base-schema.md`
- `docs/architecture/iteration-loop.md`
- `docs/NEXT_TASK_CARD.md`
- `docs/projects/feishu-gm-automation.md`

本批结论：

- 采用文档型知识库。
- 当前不接数据库。
- 当前不接向量库。
- `original_request_text` 是 approved execution 的关键字段，不得用 `NEXT_TASK_CARD`、`PROJECT_INDEX` 或历史批次文档替代。
- `effective_final_status` 必须由最终报告层重算。

## 后续批次顺序

1. BATCH-ARCH-06：字段契约落地到 job payload。
2. BATCH-ARCH-07：Windows Worker 与 Codex prompt 字段保护。
3. BATCH-ARCH-08：最终报告层有效终态统一。
4. BATCH-ARCH-09：文档型知识库目录与索引。
5. BATCH-ARCH-10：端到端静态验收与交接。

## 有效边界

- 当前自动化架构任务不得修改 `/`、`/partners`、`/post` 业务页面。
- 当前自动化架构任务不得修改 `src/app/page.tsx`、`src/app/partners/**`、`src/app/post/**`。
- 当前文档任务不得修改 `infra/windows-worker/**`、`work/tencent-cloud/**`、数据库、环境变量、`package.json` 或 `tsconfig.json`。
- Codex 完成后只汇报修改文件、验证结果、commit 状态和 commit SHA；Git 提交与推送由外层 Worker 自动完成。
