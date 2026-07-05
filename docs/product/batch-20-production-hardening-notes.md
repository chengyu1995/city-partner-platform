# BATCH-20 Production Hardening Notes

## 本阶段性质

BATCH-20 是正式运营前系统硬化，不开始同城搭子网站业务页面开发。

## 已补齐能力

- 飞书老板短命令完整识别。
- 项目总管系统自检命令。
- Agent 状态 / Agent 看板命令。
- Git `main/master` 分支一致性说明。
- 正式 MVP 第一阶段 planning-only 模板。

## 安全确认

- 短命令不进入 Worker/Codex 执行队列。
- 普通网站需求仍先进入 `planning_only`。
- `总管 批准执行` 仍需最近任务树，并保留暂停、重复分发和 attempt contract 防护。
- Worker report 保留 attempt_id 校验和终态幂等防护。
- 本阶段不修改业务页面、数据库结构或 `.env`。

## 云端待同步

腾讯云 `feishu_gateway_canonical.js` 不在当前仓库内，需要按 `docs/ops/cloud-feishu-gateway-boss-console-sync.md` 手动同步短命令识别规则。
