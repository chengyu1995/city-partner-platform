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
