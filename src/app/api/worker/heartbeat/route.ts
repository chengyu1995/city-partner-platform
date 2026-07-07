import { NextRequest, NextResponse } from "next/server";
import {
  assertWorkerAuthorized,
  assertWorkerAttemptMatchesJob,
  assertWorkerOwnsJob,
  buildAttemptPayload,
  buildRunningJobNotFoundPayload,
  findHermesJob,
  getAttemptIdFromBody,
  getBatchCodeFromBody,
  getCreatedAtFromBody,
  getWorkerIdFromBody,
  getWorkerIdFromRequest,
  getWorkerSupabase,
  isTerminalWorkerStatus,
  parseJsonBody,
  responseFromMaybe,
  updateHermesJob,
} from "@/lib/worker-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface WorkerHeartbeatBody {
  id?: string;
  job_id?: string;
  worker_id?: string;
  worker_name?: string;
  attempt_id?: string;
  batch_code?: string;
  job_created_at?: string;
  created_at?: string;
  status_message?: string;
}

export async function POST(req: NextRequest) {
  const unauthorized = assertWorkerAuthorized(req);
  if (unauthorized) return unauthorized;

  const body = await parseJsonBody<WorkerHeartbeatBody>(req);
  if (responseFromMaybe(body)) return body;

  const jobId = body.job_id ?? body.id;
  if (!jobId) {
    return NextResponse.json({ ok: false, error: "job_id is required" }, { status: 400 });
  }

  const supabase = await getWorkerSupabase();
  if (responseFromMaybe(supabase)) return supabase;

  const workerId = getWorkerIdFromBody(body);
  const attemptId = getAttemptIdFromBody(body);
  const { data: existingJob, error: findError } = await findHermesJob(supabase, jobId);
  if (findError) {
    return NextResponse.json({ ok: false, error: findError.message ?? "job lookup failed" }, { status: 500 });
  }
  if (!existingJob) {
    return NextResponse.json(
      buildRunningJobNotFoundPayload({
        endpoint: "worker/heartbeat",
        jobId,
        attemptId,
        batchCode: getBatchCodeFromBody(body),
        createdAt: getCreatedAtFromBody(body),
        workerId,
      }),
      { status: 404 }
    );
  }

  const ownershipError = assertWorkerOwnsJob(existingJob, workerId);
  if (ownershipError) return ownershipError;

  const attemptError = assertWorkerAttemptMatchesJob(existingJob, attemptId);
  if (attemptError) return attemptError;

  if (isTerminalWorkerStatus(existingJob.status)) {
    return NextResponse.json({
      ok: true,
      job: existingJob,
      idempotent: true,
      skipped: "terminal_job_heartbeat_ignored",
    });
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { data, error, skippedColumns } = await updateHermesJob(supabase, jobId, {
    status: "running",
    claimed_by: workerId,
    heartbeat_at: now,
    expires_at: expiresAt,
    status_message: body.status_message ?? "Worker heartbeat ok",
    ...(attemptId
      ? {
          attempt_id: attemptId,
          active_attempt_id: attemptId,
          payload: buildAttemptPayload(existingJob, {
            attempt_id: attemptId,
            job_id: jobId,
            worker_id: workerId,
            status: "running",
            heartbeat_at: now,
            updated_at: now,
          }),
        }
      : {}),
    updated_at: now,
  });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message ?? "heartbeat update failed" }, { status: 500 });
  }
  if (skippedColumns.length > 0) {
    console.log(`[worker/heartbeat] skipped missing hermes_jobs columns: ${skippedColumns.join(", ")}`);
  }

  return NextResponse.json({ ok: true, job: data, attempt_id: attemptId });
}

export async function GET(req: NextRequest) {
  const unauthorized = assertWorkerAuthorized(req);
  if (unauthorized) return unauthorized;

  return NextResponse.json({
    ok: true,
    route: "worker-heartbeat",
    worker_id: getWorkerIdFromRequest(req),
  });
}
