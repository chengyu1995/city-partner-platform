# 3E-LIVE-FIX-3 飞书回调超时测试计划

## 本地静态检查

1. 确认没有修改 `.env`、数据库 SQL、Windows Worker、Git 配置。
2. 运行类型检查：

```bash
npx tsc --noEmit
```

3. 如果能访问 Ubuntu 真实入口，在 Ubuntu 上执行：

```bash
cd /home/ubuntu/city-partner-agent
node --check worker_api.js
```

## Challenge 快速返回

在 Ubuntu worker-api 真实服务运行后执行：

```bash
curl -i -X POST http://127.0.0.1:3001/feishu/event \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"url_verification\",\"challenge\":\"test_123\"}"
```

预期：

- 3 秒内返回。
- 响应体包含 `{"challenge":"test_123"}`。
- 日志中不应出现 Supabase 查询、飞书 token 获取、消息发送或任务入队。

## Nginx 代理验证

在 Ubuntu 上检查 Nginx 配置：

```bash
sudo nginx -T | grep -A20 -B5 "location /feishu/"
```

预期：

- `/feishu/` 代理到 `http://127.0.0.1:3001/feishu/`。

公网验证：

```bash
curl -i -X POST http://150.109.71.58.nip.io/feishu/event \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"url_verification\",\"challenge\":\"test_123\"}"
```

预期同本地 3001 challenge 测试。

## Message.receive_v1 回归

1. 在飞书群或私聊发送普通系统升级需求，例如：

```text
新需求：执行系统升级阶段 3F
```

预期：

- 仍走旧系统升级流程。
- 可继续创建 `hermes_jobs` queued。

2. 发送网站类需求：

```text
新需求：做同城搭子网站首页
```

预期回复：

```text
【项目总管确认】
我理解你的需求：
你想先做同城搭子网站首页。

我的建议：
建议先做 MVP 首页，不要一开始做完整复杂平台。先让首页能清楚展示平台定位、搭子分类、找搭子入口和发布入口。

我建议先这样做：
1. 首页核心展示
2. 搭子分类入口
3. 搭子列表入口
4. 发布入口预留
5. 移动端适配

关键问题：
你希望首页首版更偏“找搭子列表”，还是更偏“发布搭子入口”？

请回复：
- 批准建议
- 选 A：找搭子列表优先
- 选 B：发布搭子入口优先
- 补充要求：你的要求
```

验收：

- 不创建 `source=feishu` 的 queued 任务。
- 不创建 `workflow_stage=execution` 的网站首页任务。

3. 在上述上下文后回复：

```text
批准建议
```

预期只回复：

```text
已收到批准，下一阶段将进入任务树草案。
```

不得直接分发任务。
