# 3E-LIVE-FIX-4 Ubuntu Feishu Intake Test Plan

## Boundaries

- Do not modify Windows Worker.
- Do not modify Codex invocation logic.
- Do not modify database schema.
- Do not execute SQL.
- Do not modify `.env`.
- Do not output tokens, app secrets, service keys, or Authorization headers.
- Do not deploy Vercel.
- Do not let website/product requests write `hermes_jobs.status = queued` or `workflow_stage = execution`.
- Keep system-upgrade requests on the existing queued path.

## Static Checks On Ubuntu

```bash
cd /home/ubuntu/city-partner-agent
node --check worker_api.js
```

Expected:

- Exit code `0`.
- No syntax errors.

## Local Challenge Test On Ubuntu

Run against the local worker-api service port used by Nginx, for example:

```bash
curl -sS -X POST http://127.0.0.1:3001/feishu/event \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"test_123"}'
```

Expected exact body:

```json
{"challenge":"test_123"}
```

The response must return before Supabase, Feishu token, reply, or queue code runs.

## Public Challenge Test

Run against the live public callback:

```bash
curl -sS -X POST http://150.109.71.58/feishu/event \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"test_123"}'
```

Expected exact body:

```json
{"challenge":"test_123"}
```

## Simulated Website/Product Message

Use a Feishu-like payload. Adjust only non-secret IDs to match the route's existing test helper or local handler expectations:

```bash
curl -sS -X POST http://127.0.0.1:3001/feishu/event \
  -H "Content-Type: application/json" \
  -d '{
    "schema":"2.0",
    "header":{"event_type":"im.message.receive_v1"},
    "event":{
      "message":{
        "message_id":"test_msg_website_home",
        "chat_id":"test_chat",
        "message_type":"text",
        "content":"{\"text\":\"新需求：做同城搭子网站首页\"}"
      },
      "sender":{"sender_id":{"open_id":"test_open_id"}}
    }
  }'
```

Expected:

- Classified as `website_product_request`.
- Feishu reply begins with `【项目总管确认】`.
- Reply includes:
  - `我理解你的需求：`
  - `我的建议：`
  - `我建议先这样做：`
  - `关键问题：`
  - `请回复：批准建议 / 选 A / 选 B / 补充要求`
- No new `hermes_jobs` row is inserted with `status = queued`.
- No new `hermes_jobs` row is inserted with `workflow_stage = execution`.
- The route must not fall through to `已收到任务`.
- If `sendFeishuReply` fails, the request still must not be queued.

## Simulated System Upgrade Message

```bash
curl -sS -X POST http://127.0.0.1:3001/feishu/event \
  -H "Content-Type: application/json" \
  -d '{
    "schema":"2.0",
    "header":{"event_type":"im.message.receive_v1"},
    "event":{
      "message":{
        "message_id":"test_msg_system_upgrade_3f",
        "chat_id":"test_chat",
        "message_type":"text",
        "content":"{\"text\":\"新需求：执行系统升级阶段 3F\"}"
      },
      "sender":{"sender_id":{"open_id":"test_open_id"}}
    }
  }'
```

Expected:

- Classified as `system_upgrade_request`.
- Does not enter website/product project-director confirmation branch.
- Continues through the existing `hermes_jobs queued` system-upgrade path.
- Existing system-upgrade acknowledgement behavior remains unchanged.

## Log Review

Review worker logs after each test:

```bash
journalctl -u worker-api --since "10 minutes ago" --no-pager
```

If the service name differs, use the actual unit name.

Expected:

- No tokens, app secrets, service keys, Authorization headers, or raw env values.
- Website/product request logs show routing to project-director confirmation.
- System-upgrade request logs show existing queued routing.
- Reply failure logs contain only safe error metadata such as `error.message`.

## Git Status For Outer Worker

The outer Worker should run:

```bash
git status --porcelain=v1
```

Expected changed files:

```text
M /home/ubuntu/city-partner-agent/worker_api.js
?? docs/upgrade/v3e-ubuntu-feishu-intake-fix-notes.md
?? docs/upgrade/v3e-ubuntu-feishu-intake-test-plan.md
```

In this Windows workspace, only the two docs files are expected because the Ubuntu file is not mounted here.
