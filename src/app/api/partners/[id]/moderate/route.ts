/**
 * PATCH /api/partners/[id]/moderate - 审核接口 (admin only)
 * 简化: 不做 auth (MVP), 任何人都能调
 */
import { NextResponse, NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const raw = await req.text();
    let body: { status?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
    }

    if (!body.status || !["approved", "rejected", "pending"].includes(body.status)) {
      return NextResponse.json({ ok: false, error: "invalid status" }, { status: 400 });
    }

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ ok: false, error: "service role key missing" }, { status: 503 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const res = await fetch(`${url}/rest/v1/partner_posts?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json; charset=utf-8",
        Prefer: "return=representation",
      },
      body: new TextEncoder().encode(JSON.stringify({ status: body.status })),
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
