/**
 * 队列状态查询 (调试用)
 * GET /api/queue/status → 最近 20 条 + 统计
 */
import { NextResponse } from "next/server";
import { getSupabaseService } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "edge";

export async function GET() {
  const supabase = await getSupabaseService();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "service client not available" }, { status: 500 });
  }

  // 统计
  const { data: stats } = await supabase
    .from("hermes_queue")
    .select("status")
    .then((res) => {
      if (res.error) return { data: [] };
      const counts: Record<string, number> = {};
      for (const r of res.data ?? []) {
        counts[r.status] = (counts[r.status] ?? 0) + 1;
      }
      return { data: counts };
    });

  // 最近 20 条
  const { data: recent, error } = await supabase
    .from("hermes_queue")
    .select("id, event_type, status, created_at, processed_at, attempt_count, last_error")
    .order("created_at", { ascending: false })
    .limit(20);

  // 最近 5 条结果
  const { data: results } = await supabase
    .from("task_results")
    .select("id, source_queue_id, summary, model, created_at")
    .order("created_at", { ascending: false })
    .limit(5);

  return NextResponse.json({
    ok: true,
    stats,
    recent: recent ?? [],
    results: results ?? [],
    error: error?.message,
  });
}
