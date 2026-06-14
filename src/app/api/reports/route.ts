/**
 * POST /api/reports - 举报搭子
 */
import { NextResponse, NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    let body: { post_id?: string; reason?: string; contact?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
    }

    if (!body.post_id || !body.reason || body.reason.trim().length < 3) {
      return NextResponse.json({ ok: false, error: "缺少 post_id 或 reason" }, { status: 400 });
    }
    if (body.reason.length > 500) {
      return NextResponse.json({ ok: false, error: "reason 太长 (max 500)" }, { status: 400 });
    }

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ ok: false, error: "service role key missing" }, { status: 503 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const res = await fetch(`${url}/rest/v1/reports`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json; charset=utf-8",
        Prefer: "return=representation",
      },
      body: new TextEncoder().encode(
        JSON.stringify({
          post_id: body.post_id,
          reason: body.reason.trim(),
          contact: body.contact?.trim() || null,
        })
      ),
    });

    if (!res.ok) {
      const txt = await res.text();
      return NextResponse.json({ ok: false, error: `Supabase ${res.status}: ${txt}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
