import { NextRequest, NextResponse } from "next/server";
import {
  assertWorkerAuthorized,
  assertWorkerOwnsJob,
  findHermesJob,
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
    status_message: body.status_message ?? "Worker 心跳正常",
    updated_at: now,
  });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message ?? "heartbeat update failed" }, { status: 500 });
  }
  if (skippedColumns.length > 0) {
    console.log(`[worker/heartbeat] skipped missing hermes_jobs columns: ${skippedColumns.join(", ")}`);
  }

  return NextResponse.json({ ok: true, job: data });
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
