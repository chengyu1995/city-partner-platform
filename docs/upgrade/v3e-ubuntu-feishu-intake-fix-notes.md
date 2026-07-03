# 3E-LIVE-FIX-4 Ubuntu Feishu Intake Fix Notes

## Scope

This stage targets the live Ubuntu entrypoint:

```text
/home/ubuntu/city-partner-agent/worker_api.js
POST /feishu/event
```

The current Windows workspace cannot read or write that file. The path is not present at:

- `\home\ubuntu\city-partner-agent\worker_api.js`
- `C:\home\ubuntu\city-partner-agent\worker_api.js`
- `D:\home\ubuntu\city-partner-agent\worker_api.js`

The repository also does not contain a `worker_api.js` copy outside ignored dependency/build directories. Because of that, the live handler implementation could not be directly patched in this session.

## Required Ubuntu Audit

Run this audit on the Ubuntu host before editing:

1. Open `/home/ubuntu/city-partner-agent/worker_api.js`.
2. Locate `app.post("/feishu/event", ...)`.
3. Confirm whether the `url_verification` fast path exists at the very top of the route, before any Supabase, Feishu token, reply, or queue logic.
4. Search for the reply text containing `已收到任务`; that is the current acknowledgement path that must not be used for website/product intake.
5. Search for writes to `hermes_jobs`, especially inserts containing `status: "queued"` or `workflow_stage: "execution"`.
6. Confirm how `message.receive_v1` events extract plain text. Typical Feishu text messages store JSON in `event.message.content`, with a `text` field after `JSON.parse`.
7. Confirm the intake prefix check handles both `新需求：` and `新需求:`.
8. Confirm `system_upgrade_request` is classified when the normalized text contains `执行系统升级阶段`.
9. Confirm `website_product_request` is classified when the normalized text starts with `新需求：` or `新需求:` and contains website/product keywords such as `网站`, `首页`, `页面`, `功能`, `产品`, `搭子`, `平台`, `做`, `开发`, `设计`, or `上线`.
10. Confirm `reply_sent_at` and `reply_error` update logic, if present, only records reply result and never promotes website/product requests to queued execution tasks.
11. Confirm `sendFeishuReply` can be reused without logging tokens, app secrets, service keys, or raw Authorization headers.
12. Confirm the file directly connects to Supabase and inserts into `hermes_jobs`; if so, the website/product guard must run before that insert path.

## Required Behavior

`url_verification` must still return immediately:

```json
{"challenge":"test_123"}
```

For a normal Feishu `message.receive_v1` event, extract the plain message text first. The exact text:

```text
新需求：做同城搭子网站首页
```

must be classified as:

```text
website_product_request
```

That request must not insert any row into `hermes_jobs` with:

- `status = queued`
- `workflow_stage = execution`

Instead, it must reply directly to Feishu with project-director confirmation text beginning with:

```text
【项目总管确认】
我理解你的需求：
我的建议：
我建议先这样做：
关键问题：
请回复：批准建议 / 选 A / 选 B / 补充要求
```

If the Feishu reply fails, the website/product request must still not be converted into a queued execution task.

The system upgrade text:

```text
新需求：执行系统升级阶段 3F
```

must continue through the existing queued system-upgrade path.

## Minimal Patch Shape For Ubuntu

Keep the change small and insert the guard immediately before any `hermes_jobs` queued insert or generic task acknowledgement path:

```js
function extractFeishuPlainText(payload) {
  const message = payload?.event?.message;
  if (!message) return "";

  if (typeof message.content === "string") {
    try {
      const parsed = JSON.parse(message.content);
      if (typeof parsed.text === "string") return parsed.text.trim();
    } catch {
      return message.content.trim();
    }
  }

  if (typeof message.content?.text === "string") {
    return message.content.text.trim();
  }

  return "";
}

function stripNewDemandPrefix(text) {
  return text.replace(/^新需求[：:]\s*/, "").trim();
}

function classifyFeishuDemand(text) {
  const normalized = text.trim();
  if (!/^新需求[：:]/.test(normalized)) return "other_request";
  if (normalized.includes("执行系统升级阶段")) return "system_upgrade_request";

  const body = stripNewDemandPrefix(normalized);
  const websiteKeywords = [
    "网站",
    "首页",
    "页面",
    "功能",
    "产品",
    "搭子",
    "平台",
    "做",
    "开发",
    "设计",
    "上线",
  ];

  if (websiteKeywords.some((keyword) => body.includes(keyword))) {
    return "website_product_request";
  }

  return "other_request";
}
```

Route guard:

```js
const text = extractFeishuPlainText(req.body);
const demandKind = classifyFeishuDemand(text);

if (demandKind === "website_product_request") {
  const reply = [
    "【项目总管确认】",
    `我理解你的需求：${stripNewDemandPrefix(text)}`,
    "我的建议：建议先进入项目总管确认流程，明确首页目标、首屏信息、核心入口和移动端优先级后再拆执行任务。",
    "我建议先这样做：先确定 MVP 首页范围，再产出任务树草案，经批准后再分发执行。",
    "关键问题：你希望首页首版更偏找搭子列表，还是更偏发布搭子入口？",
    "请回复：批准建议 / 选 A / 选 B / 补充要求",
  ].join("\n");

  try {
    await sendFeishuReply(/* existing message id / open id args */, reply);
    // If the existing schema has reply_sent_at, update it here only as metadata.
  } catch (error) {
    // If the existing schema has reply_error, update it here only as metadata.
    console.error("[feishu] project director reply failed", {
      message: error?.message,
    });
  }

  return res.json({ ok: true, routed: "project_director_confirmation" });
}
```

The actual Ubuntu patch must adapt the `sendFeishuReply` arguments to the current implementation. Do not log request headers, tokens, app secrets, service keys, or raw env values.

## Verification Status From This Session

- Ubuntu actual Feishu entrypoint file: expected at `/home/ubuntu/city-partner-agent/worker_api.js`, but not accessible from this Windows workspace.
- `url_verification`: not re-tested against Ubuntu in this session because the live file and service are outside the accessible workspace.
- Website request queued prevention: not verifiable in this session without patching the Ubuntu file.
- System upgrade queued behavior: not verifiable in this session without patching the Ubuntu file.
- Git commit SHA: not available; Git commit and push are handled by the outer Worker per the Windows Worker rules.
