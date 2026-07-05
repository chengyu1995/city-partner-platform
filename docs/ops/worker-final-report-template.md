# Worker Final Report Template

系统升级阶段：BATCH-27

## 目标

Worker/Codex 任务进入 `succeeded` 或 `failed` 终态后，飞书必须收到完整项目总管报告，不能只回报一行状态。

## 飞书完成报告模板

```text
✅ Codex 任务执行成功 / ❌ Codex 任务执行失败
任务编号：<job_id 或 未提供>
job_id：<job_id 或 未提供>
attempt_id：<attempt_id 或 未提供>
需求：<需求原文或 未提供>
项目名称：同城搭子网站
项目目录：<项目目录或 未提供>

本阶段性质：
系统升级阶段 BATCH-27：统一 Worker 完成后飞书项目总管报告模板

执行结果摘要：
<Worker/Codex 结果摘要；过长时截断>

修改文件：
- <path>
- 未提供

完成内容：
1. <完成内容>
1. 未提供 / 任务失败，未生成完成内容

验证结果：
- <验证项> 通过
- <验证项> warning
- <验证项> 失败原因
- 未提供

安全边界：
- 是否修改业务页面：首页//partners//post：是/否
- 是否修改数据库：是/否
- 是否修改 .env：是/否
- 是否部署：否/状态值
- 是否启动 dev server：否

Git 自动备份：
commit SHA：<sha 或 未生成>
GitHub 推送状态：<状态或 未提供>

下一步建议：
<是否可以进入下一批次，或需要老板验收/批准/选择>
```

## 字段兜底

- `job_id`、需求、修改文件、验证结果、commit SHA 是必保留字段。
- 字段缺失时统一使用 `未提供`、`未生成` 或 `不适用`，不能省略字段。
- 飞书消息过长时可以截断摘要，但必须保留任务编号、状态、修改文件、验证结果、commit SHA。
- 报告生成会脱敏 token、app secret、service key、Bearer token 等敏感文本。

## 云端同步说明

本次仓库内同步点：

- `infra/windows-worker/local_worker.js`：终态上报补充 `project_name`、`project_dir`、`files_changed`、`validation_results`、`github_push_status`、`git_commit_sha`。
- `src/app/api/worker/report/route.ts`：终态飞书 `status_message` 改为完整项目总管报告。
- `src/lib/worker-jobs.ts`：统一生成 BATCH-27 报告文本和结构化数据。

如果腾讯云端存在独立 `worker_api.js`，需要同步同等逻辑：

1. 终态 report payload 保留 `job_id`、`attempt_id`、需求、修改文件、验证结果、commit SHA。
2. succeeded/failed 都调用同一个最终报告模板。
3. 飞书写入字段使用完整报告文本，不只写 `succeeded` 或 `failed`。
4. 保留 attempt_id 校验和幂等保护：已终态任务重复 report 只返回已有结果，不重复覆盖。
5. 输出日志必须脱敏，不打印 token、app_secret、service key、`.env` 内容。

云端验证方法：

- 构造 succeeded report，确认飞书包含任务编号、需求、修改文件、验证结果、commit SHA。
- 构造 failed report，确认飞书包含同样字段和失败原因。
- 使用错误 attempt_id 重放 report，确认被拒绝或不覆盖当前任务。
- 对同一终态任务重复 report，确认幂等，不重复改写最终状态。
