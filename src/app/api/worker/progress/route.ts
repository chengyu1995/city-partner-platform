import { NextRequest, NextResponse } from "next/server";
import { syncWorkerStatusToFeishu } from "@/lib/feishu-worker-sync";
import {
  assertWorkerAuthorized,
  clampProgress,
  findHermesJob,
  getBitableRecordId,
  getWorkerSupabase,
  normalizeWorkerStatus,
  parseJsonBody,
  responseFromMaybe,
  updateHermesJob,
} from "@/lib/worker-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface WorkerProgressBody {
  id?: string;
  job_id?: string;
  status?: string;
  progress_percent?: number;
  current_step?: string;
  status_message?: string;
  bitable_record_id?: string;
  feishu_record_id?: string;
  record_id?: string;
}

export async function POST(req: NextRequest) {
  const unauthorized = assertWorkerAuthorized(req);
  if (unauthorized) return unauthorized;

  const body = await parseJsonBody<WorkerProgressBody>(req);
  if (responseFromMaybe(body)) return body;

  const jobId = body.job_id ?? body.id;
  if (!jobId) {
    return NextResponse.json({ ok: false, error: "job_id is required" }, { status: 400 });
  }

  const supabase = await getWorkerSupabase();
  if (responseFromMaybe(supabase)) return supabase;

  const now = new Date().toISOString();
  const progressPercent = clampProgress(body.progress_percent, 0);
  const workerStatus = normalizeWorkerStatus(body.status);
  const currentStep =
    body.current_step ?? (workerStatus === "queued" ? "等待 Worker 领取" : "执行中");
  const { data: existingJob } = await findHermesJob(supabase, jobId);
  const { data, error, skippedColumns } = await updateHermesJob(supabase, jobId, {
    status: body.status ?? "running",
    progress_percent: workerStatus === "queued" ? 0 : progressPercent,
    current_step: currentStep,
    status_message: body.status_message ?? null,
    updated_at: now,
  });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message ?? "update failed" }, { status: 500 });
  }
  if (skippedColumns.length > 0) {
    console.log(`[worker/progress] skipped missing hermes_jobs columns: ${skippedColumns.join(", ")}`);
  }

  const recordId = getBitableRecordId(body, data, existingJob);
  await syncWorkerStatusToFeishu({
    recordId,
    status: workerStatus === "queued" ? "queued" : "running",
    stage: "execution",
    progressPercent: workerStatus === "queued" ? 0 : progressPercent,
    currentStep,
    statusMessage: body.status_message ?? null,
    updatedAt: now,
  });

  return NextResponse.json({ ok: true, job: data, feishu_sync: recordId ? "attempted" : "skipped_no_record_id" });
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "worker-progress" });
}
