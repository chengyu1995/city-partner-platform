#!/usr/bin/env python3
"""
Hermes 拆任务 runner - GitHub Action 调用
- 拉 Supabase hermes_queue pending
- 用 minimax LLM 拆任务
- 写 task_results
- 推 Bot 1 群通知
"""
import os
import sys
import json
import urllib.request
import urllib.error


SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
LLM_KEY = os.environ.get("MINIMAX_CN_API_KEY", "")
BOT_HOOK = os.environ.get("FEISHU_BOT_WEBHOOK", "")

print(f"[debug] SUPABASE_URL={SUPABASE_URL!r} len(SUPABASE_KEY)={len(SUPABASE_KEY)}", flush=True)


def sb(method, path, body=None):
    """Supabase REST helper"""
    full_url = f"{SUPABASE_URL}/rest/v1/{path}"
    print(f"[debug] {method} {full_url}", flush=True)
    req = urllib.request.Request(
        full_url,
        data=json.dumps(body).encode() if body else None,
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
        method=method,
    )
    return json.loads(urllib.request.urlopen(req, timeout=15).read())


def llm(prompt):
    """minimax LLM 调用"""
    req = urllib.request.Request(
        "https://api.minimax.chat/v1/text/chatcompletion_v2",
        data=json.dumps(
            {
                "model": "MiniMax-Text-01",
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
            }
        ).encode(),
        headers={
            "Authorization": f"Bearer {LLM_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    resp = json.loads(urllib.request.urlopen(req, timeout=60).read())
    return resp.get("choices", [{}])[0].get("message", {}).get("content", "")


def notify(text):
    """推 Bot 1"""
    if not BOT_HOOK:
        print(f"NO BOT_HOOK, skip notify: {text[:80]}")
        return
    try:
        req = urllib.request.Request(
            BOT_HOOK,
            data=json.dumps({"msg_type": "text", "content": {"text": text}}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        result = json.loads(urllib.request.urlopen(req, timeout=10).read())
        print(f"NOTIFY ok: {result.get('msg', '')[:80]}")
    except Exception as e:
        print(f"NOTIFY failed: {e}")


def extract_json(text):
    """从 LLM 响应里提取首个完整 JSON 对象"""
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("MISSING SUPABASE ENV")
        return 1
    if not LLM_KEY:
        print("MISSING MINIMAX_CN_API_KEY")
        return 1

    # 拉 pending
    tasks = sb("GET", "hermes_queue?status=eq.pending&order=created_at.asc&limit=5&select=*")
    print(f"pending: {len(tasks)}")

    if not tasks:
        return 0

    for task in tasks:
        qid = task["id"]
        etype = task["event_type"]
        payload = task["payload"]

        # 标 processing
        sb(
            "PATCH",
            f"hermes_queue?id=eq.{qid}",
            {
                "status": "processing",
                "attempt_count": task.get("attempt_count", 0) + 1,
            },
        )

        try:
            title = payload.get("title", "(无标题)")
            desc = payload.get("description", "")
            acceptance = payload.get("acceptance", "")

            prompt = (
                "你是 Hermes (项目总管 agent). 把下面这个需求拆成可执行的子任务.\n\n"
                f"标题: {title}\n描述: {desc}\n验收: {acceptance}\n\n"
                '输出 JSON (只输出一个 JSON 对象, 不要其他文字):\n'
                "{\n"
                '  "summary": "<一句话总结这个需求>",\n'
                '  "subtasks": [\n'
                "    {\n"
                '      "title": "<子任务标题>",\n'
                '      "action": "<具体动作>",\n'
                '      "needs": "<需要的资源>",\n'
                '      "eta": "<预估工时, e.g. 1h/30m>",\n'
                '      "owner": "<Codex / Hermes / 老板>"\n'
                "    }\n"
                "  ]\n"
                "}"
            )

            raw = llm(prompt)
            result = extract_json(raw)
            if not result:
                raise ValueError(f"LLM 解析失败: {raw[:200]}")

            # 写 results
            sb(
                "POST",
                "task_results",
                {
                    "source_queue_id": qid,
                    "summary": result.get("summary", ""),
                    "subtasks": result.get("subtasks", []),
                    "model": "MiniMax-Text-01",
                },
            )

            # 标 done
            sb(
                "PATCH",
                f"hermes_queue?id=eq.{qid}",
                {"status": "done", "processed_at": "now()"},
            )

            # 推群
            sub_count = len(result.get("subtasks", []))
            msg = (
                f"【Hermes 拆任务】\n"
                f"需求: {title}\n"
                f"总结: {result.get('summary', '')}\n"
                f"子任务数: {sub_count}\n\n"
                f"查看详情: https://city-partner-platform.vercel.app/api/queue/status"
            )
            notify(msg)
            print(f"OK {qid} done ({sub_count} subtasks)")

        except Exception as e:
            err = str(e)[:500]
            sb("PATCH", f"hermes_queue?id=eq.{qid}", {"status": "failed", "last_error": err})
            print(f"FAIL {qid}: {err}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
