# 下一步任务卡

## 当前状态

BATCH-ARCH-05 已进入文档补齐阶段，目标是统一项目总经理、飞书入口、Worker job payload、Windows Worker、最终报告层和知识库之间的上下文字段契约。

本阶段属于 `automation_architecture`，不是产品开发任务，也不是 Worker 代码修复任务。当前只允许更新架构文档和指定项目文档。

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

- 更新 `docs/architecture/**`。
- 更新 `docs/NEXT_TASK_CARD.md`。
- 更新 `docs/projects/feishu-gm-automation.md`。
- 做静态验证：目标文件是否存在、`git diff --name-only` 是否只命中允许范围。

## 字段契约摘要

字段优先级规则：显式 HERMES_WORKER_CONTEXT > payload > request_text/original_request_text > 自动分类 > 历史上下文。

只读任务规则：read_only 任务 changed_files=[] 是正常状态，不得触发 NO_FIX_APPLIED。

写入任务规则：write_allowed 任务必须产生允许范围内变更，否则触发 NO_FIX_APPLIED。

## 下一步建议

下一批从 BATCH-ARCH-06 开始：

BATCH-ARCH-06：字段契约落地到 job payload。

目标：
- 按 `docs/architecture/context-contract.md` 统一 Worker job payload 字段。
- 保留 `project_domain`、`task_mode`、`read_only_mode`、`allowed_scope`、`forbidden_scope`、`original_request_text`、`route` 和 `approved_batch`。
- 禁止用历史上下文覆盖显式 `HERMES_WORKER_CONTEXT`。
- approved execution 丢失 `original_request_text` 时失败，而不是回退到历史文档。

后续顺序：

1. BATCH-ARCH-06：字段契约落地到 job payload。
2. BATCH-ARCH-07：Windows Worker 与 Codex prompt 字段保护。
3. BATCH-ARCH-08：最终报告层有效终态统一。
4. BATCH-ARCH-09：文档型知识库目录与索引。
5. BATCH-ARCH-10：端到端静态验收与交接。
