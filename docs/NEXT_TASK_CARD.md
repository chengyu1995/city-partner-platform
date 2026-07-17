# 下一步任务卡

## 当前状态

BATCH-ARCH-10 已完成端到端静态验收与交接文档补齐。

本阶段属于 `automation_architecture`。当前结果只代表文档静态验收，不自动授权产品开发、Worker 代码修复、部署或数据库变更。

## 本批结论

- 飞书 direct worker create 和项目总经理 approved execution 都会保留当前任务正文，并写入统一上下文字段。
- Worker claim 会通过 payload 继续传递字段，并补充当前 `attempt_id`。
- Windows Worker prompt 会展示 `[Worker job payload contract]`，让 Codex 看到任务模式、允许范围、禁止范围和终态字段。
- 最终报告层会重算 `effective_final_status`，并生成失败记忆状态、terminal index 和自动迭代建议。
- `failure_stage` 已在 normalized final result 和自动修复建议中流转，但 terminal index 当前不保存 `failure_stage`。

完整验收报告：`docs/architecture/batch-arch-10-static-validation.md`

## 当前禁止

- 不执行产品开发批次。
- 不直接修改业务页面。
- 不修改 `app/**`、`src/app/**`、`src/lib/**`。
- 不修改 `infra/windows-worker/**` 或 `work/tencent-cloud/**`。
- 不修改数据库、环境变量、腾讯云运行文件、`package.json`、`tsconfig.json`。
- 不启动 dev server。
- 不打开浏览器。
- 不部署。
- Codex 不执行 `git add`、`git commit`、`git push` 或创建分支。

## 当前允许

- 读取仓库做静态盘点。
- 更新 `docs/architecture/**`。
- 更新 `docs/NEXT_TASK_CARD.md`。
- 更新 `docs/projects/feishu-gm-automation.md`。
- 做静态验证：目标文件是否存在，`git diff --name-only` 是否只命中允许范围。

## 下一步建议

需要老板选择后再执行：

1. `BATCH-ARCH-11`：`automation_system_write_allowed` 小修复批次，把 `failure_stage` 写入 terminal index，并补充对应测试。
2. `BATCH-ARCH-SMOKE-01`：`read_only` smoke 批次，只跑现有字段链路的静态测试和终态报告样例，不修改文件。

若没有老板批准，下一步只能做只读盘点和文档检查。
