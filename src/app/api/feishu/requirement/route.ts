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
    // 关键: 不能用 req.text() — Next 16 / undici 在 content-type 缺 charset 时
    // 会按 latin-1 解码, 中文变乱码. 直接拿 ArrayBuffer 强制按 UTF-8 解.
    const buf = await req.arrayBuffer();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const rawText = decoder.decode(buf);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawText);
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: "invalid JSON", raw_head: rawText.slice(0, 200) },
        { status: 400 }
      );
    }
    // 调试: 记录实际收到的 payload 头 200 字符, 排查乱码
    console.log("[feishu/requirement] received:", rawText.slice(0, 500));

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
