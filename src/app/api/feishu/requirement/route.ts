/**
 * 飞书自动化 1: 需求池新增
 * 飞书 Bitable 自动化 → POST /api/feishu/requirement
 * 入队到 Supabase hermes_queue
 */
import { NextResponse, NextRequest } from "next/server";
import { getSupabaseService } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    const supabase = getSupabaseService();
    if (!supabase) {
      return NextResponse.json(
        { ok: false, error: "service client not available" },
        { status: 500 }
      );
    }
    const { data, error } = await supabase
      .from("hermes_queue")
      .insert({
        event_type: "new_requirement",
        payload,
        status: "pending",
      })
      .select()
      .single();
    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true, queue_id: data.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
