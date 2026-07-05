# Project Director Production Mode

## 模式定义

正式项目总管模式表示：系统升级已经完成，业务需求可以进入规划，但仍必须经过项目总管拆解和老板批准后才能执行。

## 工作流

```text
新需求
  -> 项目总管理解
  -> planning_only 任务树
  -> 老板查看计划/修改计划
  -> 总管 批准执行
  -> approved_execution 分发
  -> Worker/Codex 执行
  -> 项目总管汇总
  -> 老板验收
  -> 验收反馈闭环
```

## 需求进入规则

- `新需求：状态`：展示项目状态。
- `新需求：查看计划`：展示最近计划。
- `新需求：帮助`：展示命令清单。
- `新需求：我要做一个 xxx 功能`：创建 planning_only 任务树。
- `新需求：修改计划：xxx`：记录计划调整，不分发执行。
- `选 A` / `先做首页 MVP`：输出首页 MVP 规划，创建 planning_only 记录，不分发执行。
- `选 B` / `按 B 做` / `先做完整产品规划`：输出完整 MVP 第一阶段规划，创建 planning_only 记录，不分发执行。
- `修改计划：xxx`：记录计划调整，不分发执行。

这些选择回复必须优先于普通网站需求识别处理，避免老板已经选择 A/B 后再次收到同一套 A/B 确认。

## 分发规则

- 只有 `总管 批准执行` 能触发 approved execution。
- `选 A`、`选 B`、`批准建议`、`修改计划：xxx` 都不能触发 approved execution。
- 如果总管处于暂停状态，批准执行会被阻塞。
- 已经分发过的任务树不会重复创建执行任务。
- 分发任务会带上 boss_request_id、plan_id、task_key 和 attempt contract。

## Worker/Codex 规则

- Worker 通过 `/api/worker/next` 领取任务并获得 `attempt_id`。
- Worker 通过 `/api/worker/report` 回报结果，必须携带匹配的 `attempt_id`。
- mismatch 或缺失 `attempt_id` 会被拒绝。
- 已经处于 `succeeded` 或 `failed` 的终态任务不会被后续报告覆盖。
- Codex 不负责 git commit/push，外层 Worker 负责自动提交和回报。

## 验收反馈规则

- `验收反馈：xxx` 会被项目总管接管。
- 项目总管先诊断，再创建最小修复计划。
- 修复仍需遵守 allowed_files、attempt_id 和安全边界。
- 高风险反馈必须等待老板确认。

## 安全规则

- 不允许绕过老板批准执行复杂任务。
- 不允许绕过 attempt_id。
- 不允许 failed 覆盖 succeeded。
- 不允许旧 Worker 覆盖新 Worker 结果。
- 不允许输出密钥。
- 不允许擅自改 `.env`。
- 不允许擅自改数据库结构。
- 不允许擅自部署生产。
- 不允许删除数据。
- 不允许恢复 stash 中的业务页面修改，除非老板明确批准。

## 业务页面开发入口

BATCH-19 完成后不会自动开始开发网站。老板需要先发送：

```text
新需求：启动同城搭子网站 MVP 第一阶段，请项目总管先给我产品计划、页面结构、多 Agent 分工和执行建议，先不要写代码，等我批准后再执行。
```
