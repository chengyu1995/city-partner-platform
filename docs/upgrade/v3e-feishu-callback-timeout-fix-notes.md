# 3E-LIVE-FIX-3 飞书回调超时修复记录

## 审计结论

- 当前 Windows 工作区不可访问 `/home/ubuntu/city-partner-agent/worker_api.js`，仓库内也没有 `worker_api.js` 副本。
- 仓库内可审计的飞书事件入口是 `src/app/api/feishu/event/route.ts`，对应 `POST /api/feishu/event`，不是本次线上报错的 `POST /feishu/event`。
- 当前工作区无法读取 Ubuntu Nginx 配置，因此未能直接确认 `/feishu/` 是否代理到 `http://127.0.0.1:3001/feishu/`。
- `src/app/api/feishu/event/route.ts` 已支持 `im.message.receive_v1`。
- `url_verification` 原逻辑会在读取 env 和可选解密后返回 challenge。本次已把明文 `{"type":"url_verification","challenge":"..."}` 的返回提前到 JSON 解析之后，避免连接 Supabase、调用飞书 API 或进入复杂业务逻辑。

## 代码路径

- “已收到任务”类自然语言回复来自飞书事件入口后续的 Agent 路径：`src/app/api/feishu/event/route.ts` 调用 `runAgent(text, history)`，具体系统提示和工具执行在 `src/lib/hermes-agent.ts`。
- `hermes_jobs` queued 创建路径主要有两类：
  - `src/lib/hermes-agent.ts` 中 Agent 工具按旧系统升级流程写入 `hermes_jobs`。
  - `src/lib/project-director-job-builder.ts` 的 `insertBatch01ProductPlanningJobs()` 在项目总管分发阶段写入 `hermes_jobs`，行数据包含 `status: "queued"` 和 `workflow_stage: "execution"`。
- `source=feishu` 的 `hermes_jobs` 写入来自旧 Agent/工具链路，不来自项目总管网站需求确认链路。

## 本次修改

- `src/app/api/feishu/event/route.ts`
  - 明文 challenge 在 `req.text()` 和 `JSON.parse()` 后立即返回 `{ "challenge": payload.challenge }`。
  - 该分支不会创建 Supabase client、不会调用飞书 token API、不会查询或写入数据库。
- `src/lib/project-director-intake.ts`
  - `新需求：做同城搭子网站首页` 识别为 `website_product_request` 后，回复固定的项目总管确认文案。
  - 老板回复 `批准建议` 时回复 `已收到批准，下一阶段将进入任务树草案。`。

## 行为说明

- 网站类需求仍只写入 `hermes_messages`，不会直接 insert `hermes_jobs` queued，也不会进入 `workflow_stage=execution`。
- 系统升级类需求仍先被 `classifyProjectDirectorDemand()` 判定为 `system_upgrade_request`，不会进入网站项目总管确认分支，旧系统升级入队流程不受本次修改影响。
- 本次未修改数据库结构，未执行 SQL，未修改真实 `.env`，未修改 Windows Worker。

## 未完成项

- Ubuntu 实际运行的 `/home/ubuntu/city-partner-agent/worker_api.js` 不在当前可写工作区，无法在本次 Windows Worker 会话内直接修补真实 3001 入口。
- 需要在 Ubuntu 主机上把同样的明文 challenge 快速返回逻辑放到 `POST /feishu/event` 路由最前面，并重启 worker-api 服务。
