# 归档项目

## 项目定位

本文件标记旧方案、备份文件、旧模板和已废弃逻辑。归档内容只可作为历史参考，不得作为当前执行依据。

本批不删除 `.bak` 文件，不恢复旧方案，不修改归档文件内容。

## 归档/废弃范围

| 内容 | 状态 | 说明 |
| --- | --- | --- |
| 旧 Vercel 飞书入口方案 | 归档/废弃 | 当前自动化以项目总管、腾讯云中转、Worker API 和 Windows Worker 链路为准。 |
| 旧首页 MVP 模板 | 归档/废弃 | 不得绕过当前 `docs/NEXT_TASK_CARD.md` 和老板批准直接进入首页开发。 |
| 旧错误解析逻辑 | 归档/废弃 | 当前以 BATCH-17/18/20/22/27 的项目总管、choice routing、Worker report 规则为准。 |
| 旧 feishu gateway 备份文件 | 归档/废弃 | 可保留备份，不得作为当前线上逻辑直接复制。 |
| `.bak` 文件 | 归档/备份 | 禁止删除，禁止把备份内容当作当前执行依据。 |
| 已废弃方案 | 归档/废弃 | 需要复用时必须重新开任务并由老板批准。 |

## 可能涉及的历史资料

以下文件或资料仅作历史参考，具体是否仍有效需以当前任务卡和老板批准为准：

- `docs/product/batch-01-homepage-mvp.md`
- `docs/product/mvp-stage-1-planning-template.md`
- `docs/feishu-automation.md`
- `docs/CLOUDFLARE_PAGES_MIGRATION.md`
- `docs/vercel-delete-tfpf.md`
- `infra/windows-worker/*.bak`
- 云端 `feishu_gateway_canonical.js.bak.*`

## 当前有效替代入口

| 旧内容 | 当前入口 |
| --- | --- |
| 旧首页 MVP 模板 | `docs/NEXT_TASK_CARD.md`、`docs/projects/city-partner-website.md` |
| 旧飞书入口方案 | `docs/projects/feishu-gm-automation.md`、`docs/WORKER_ARCHITECTURE.md` |
| 旧 Worker 回报 | `docs/ops/worker-final-report-template.md` |
| 旧批次记录 | `docs/BATCH_LOG.md`、`docs/ACCEPTANCE_LOG.md` |

## 归档使用规则

- 可以读取归档资料了解历史背景。
- 不可以直接执行归档方案。
- 不可以把归档方案写入当前任务 prompt 作为执行依据。
- 不可以删除备份文件。
- 不可以从归档资料复制真实密钥、token、webhook 或 service key。
- 如需恢复归档内容，必须先创建新任务并说明恢复原因、影响范围和验收标准。
