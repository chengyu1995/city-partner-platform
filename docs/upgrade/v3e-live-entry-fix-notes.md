# 3E-LIVE-FIX 飞书线上入口修复说明

## 审计结论

- 飞书消息事件入口是 `src/app/api/feishu/event/route.ts`，对应 `POST /api/feishu/event`。
- 飞书 Bitable 自动化入口是 `src/app/api/feishu/requirement/route.ts` 和 `src/app/api/feishu/codex-task/route.ts`，它们只写 `hermes_queue`，不负责飞书聊天回复。
- Windows Worker 实际只轮询 Worker API：`/api/worker/next`、`/api/worker/progress`、`/api/worker/report`。本阶段没有修改 Worker 执行逻辑。
- `已收到任务` 类回复不是项目总管确认路径的回复；当前项目总管确认回复由 `src/lib/project-director-intake.ts` 的 `buildProjectDirectorReply()` 生成，固定以 `【项目总管确认】` 开头。
- `hermes_jobs queued` 写入路径在当前源码中只应出现在 `src/lib/project-director-job-builder.ts`，并且只允许由 `批准分发第 1 批` 后创建 BATCH-01 产品规划任务。

## 问题原因

线上网站类新需求没有进入项目总管流程时，会落到 `src/app/api/feishu/event/route.ts` 的通用 Hermes agent fallback。该 fallback 会继续沿用旧的需求入队和后续分解流程，最终可能形成 `hermes_jobs` 中 `status = queued`、`plan_status = approved`、`workflow_stage = execution` 的普通执行任务。

另一个风险是飞书事件入口原先先检查 `hermes_jobs` 重复任务，再进入项目总管判断。历史上已经错误创建过同文案 queued 任务时，后续相同网站需求会被 duplicate 分支截走，无法重新进入项目总管确认。

## 本次修复

- `src/lib/project-director-intake.ts`
  - 新增 `ProjectDirectorDemandKind` 和 `classifyProjectDirectorDemand()`。
  - 明确返回 `website_product_request`、`system_upgrade_request` 或 `other_request`。
  - 兼容 `新需求：` 和 `新需求:` 两种前缀。
- `src/app/api/feishu/event/route.ts`
  - 在创建会话后、任何 `hermes_jobs` duplicate 检查和 Hermes agent fallback 前，先识别 `website_product_request`。
  - 命中网站/页面/功能/产品类新需求时，只保存 `hermes_messages` 并发送 `【项目总管确认】`。
  - 该分支不写 `hermes_jobs`，不创建 queued 执行任务。

## 不受影响的路径

- `新需求：执行系统升级阶段 3F` 仍由 `isSystemUpgradeDemand()` 识别为 `system_upgrade_request`，不会进入网站项目总管确认分支。
- 系统升级类需求继续走原 Hermes 系统升级任务逻辑。
- `批准建议`、`批准任务树`、`批准分发第 1 批` 的项目总管后续流程保持不变。
- 本阶段未修改数据库结构，未执行 SQL，未修改 `.env`，未部署。
