import { NextRequest, NextResponse } from "next/server";
import { syncWorkerStatusToFeishu } from "@/lib/feishu-worker-sync";
import {
  assertWorkerAuthorized,
  assertWorkerAttemptMatchesJob,
  assertWorkerOwnsJob,
  buildAttemptPayload,
  clampProgress,
  findHermesJob,
  getAttemptIdFromBody,
  getBitableRecordId,
  getWorkerIdFromBody,
  getWorkerSupabase,
  isTerminalWorkerStatus,
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
  attempt_id?: string;
  status?: string;
  progress_percent?: number;
  current_step?: string;
  status_message?: string;
  worker_id?: string;
  worker_name?: string;
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
  const currentStep = body.current_step ?? (workerStatus === "queued" ? "waiting_worker_claim" : "running");
  const { data: existingJob, error: findError } = await findHermesJob(supabase, jobId);
  if (findError) {
    return NextResponse.json({ ok: false, error: findError.message ?? "job lookup failed" }, { status: 500 });
  }
  if (!existingJob) {
    return NextResponse.json({ ok: false, error: "job not found" }, { status: 404 });
  }

  const workerId = getWorkerIdFromBody(body);
  const ownershipError = assertWorkerOwnsJob(existingJob, workerId);
  if (ownershipError) return ownershipError;

  const attemptId = getAttemptIdFromBody(body);
  const attemptError = assertWorkerAttemptMatchesJob(existingJob, attemptId);
  if (attemptError) return attemptError;

  if (isTerminalWorkerStatus(existingJob.status)) {
    return NextResponse.json({
      ok: true,
      job: existingJob,
      idempotent: true,
      skipped: "terminal_job_progress_ignored",
    });
  }

  const { data, error, skippedColumns } = await updateHermesJob(supabase, jobId, {
    status: body.status ?? "running",
    claimed_by: workerId,
    progress_percent: workerStatus === "queued" ? 0 : progressPercent,
    current_step: currentStep,
    status_message: body.status_message ?? null,
    ...(attemptId
      ? {
          attempt_id: attemptId,
          active_attempt_id: attemptId,
          payload: buildAttemptPayload(existingJob, {
            attempt_id: attemptId,
            job_id: jobId,
            worker_id: workerId,
            status: workerStatus,
            updated_at: now,
          }),
        }
      : {}),
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

  return NextResponse.json({
    ok: true,
    job: data,
    attempt_id: attemptId,
    feishu_sync: recordId ? "attempted" : "skipped_no_record_id",
  });
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "worker-progress" });
}
