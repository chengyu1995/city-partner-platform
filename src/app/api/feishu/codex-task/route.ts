/**
 * 飞书自动化 2: 任务看板任务就绪 (执行角色=Codex)
 * 飞书 Bitable 自动化 → POST /api/feishu/codex-task
 * 入队到 Supabase hermes_queue
 */
import { NextResponse, NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

async function sbInsert(table: string, row: Record<string, unknown>) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const body = JSON.stringify(row);
  const bytes = new TextEncoder().encode(body);
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json; charset=utf-8",
      Prefer: "return=representation",
    },
    body: bytes,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${res.status}: ${err}`);
  }
  return await res.json();
}

export async function POST(req: NextRequest) {
  try {
    const rawText = await req.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawText);
    } catch (e) {
      return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
    }

    const data = await sbInsert("hermes_queue", {
      event_type: "codex_task_ready",
      payload,
      status: "pending",
    });
    return NextResponse.json({ ok: true, queue_id: data[0].id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
