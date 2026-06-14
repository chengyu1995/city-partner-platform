/**
 * GET /api/admin/list - 列出搭子 (按 status 过滤)
 * 客户端 /admin 调用, 避免 server component 编译超过 3 MiB
 */
import { NextResponse, NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

export async function GET(req: NextRequest) {
  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ ok: false, error: "service role key missing" }, { status: 503 });
    }
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "pending";
    if (!["pending", "approved", "rejected"].includes(status)) {
      return NextResponse.json({ ok: false, error: "invalid status" }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const res = await fetch(
      `${supabaseUrl}/rest/v1/partner_posts?status=eq.${status}&order=created_at.desc&limit=50&select=*`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        cache: "no-store",
      }
    );

    if (!res.ok) {
      const txt = await res.text();
      return NextResponse.json({ ok: false, error: `Supabase ${res.status}: ${txt}` }, { status: 500 });
    }
    const items = await res.json();
    return NextResponse.json({ ok: true, items });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
