import { NextRequest, NextResponse } from "next/server";
import { syncWorkerStatusToFeishu } from "@/lib/feishu-worker-sync";
import {
  assertWorkerAuthorized,
  getBitableRecordId,
  getWorkerSupabase,
  responseFromMaybe,
  updateHermesJob,
} from "@/lib/worker-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function getWorkerId(req: NextRequest): string {
  return req.headers.get("x-worker-id") ?? req.nextUrl.searchParams.get("worker_id") ?? "unknown-worker";
}

async function handleNext(req: NextRequest) {
  const unauthorized = assertWorkerAuthorized(req);
  if (unauthorized) return unauthorized;

  const supabase = await getWorkerSupabase();
  if (responseFromMaybe(supabase)) return supabase;

  const { data: job, error } = await supabase
    .from("hermes_jobs")
    .select("*")
    .in("status", ["queued", "pending"])
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ ok: true, job: null });
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { data: claimedJob, error: updateError, skippedColumns } = await updateHermesJob(supabase, job.id, {
    status: "running",
    claimed_by: getWorkerId(req),
    claimed_at: now,
    expires_at: expiresAt,
    progress_percent: 0,
    current_step: "等待 Worker 领取",
    status_message: "Worker 已领取任务",
    updated_at: now,
  });

  if (updateError) {
    return NextResponse.json({ ok: false, error: updateError.message ?? "claim failed" }, { status: 500 });
  }
  if (skippedColumns.length > 0) {
    console.log(`[worker/next] skipped missing hermes_jobs columns: ${skippedColumns.join(", ")}`);
  }

  const recordId = getBitableRecordId(claimedJob, job);
  await syncWorkerStatusToFeishu({
    recordId,
    status: "running",
    stage: "execution",
    progressPercent: 0,
    currentStep: "等待 Worker 领取",
    statusMessage: "Worker 已领取任务",
    updatedAt: now,
  });

  return NextResponse.json({ ok: true, job: claimedJob ?? job, feishu_sync: recordId ? "attempted" : "skipped_no_record_id" });
}

export async function GET(req: NextRequest) {
  return handleNext(req);
}

export async function POST(req: NextRequest) {
  return handleNext(req);
}
