/**
 * 飞书自动化 1: 需求池新增
 * 飞书 Bitable 自动化 → POST /api/feishu/requirement
 * 入队到 Supabase hermes_queue
 */
import { NextResponse, NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 直接 fetch (不用 supabase-js, 避免 edge runtime JSON 序列化问题) */
async function sbInsert(table: string, row: Record<string, unknown>) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  // 用 utf-8 编码, 显式 charset 头, 避免 latin-1 转义
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
    // 用 req.text() + 显式 JSON.parse 处理, 而不是 req.json() 避免潜在编码问题
    const rawText = await req.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawText);
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: "invalid JSON" },
        { status: 400 }
      );
    }

    const data = await sbInsert("hermes_queue", {
      event_type: "new_requirement",
      payload,
      status: "pending",
    });
    return NextResponse.json({ ok: true, queue_id: data[0].id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
