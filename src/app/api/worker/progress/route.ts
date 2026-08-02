import { NextRequest, NextResponse } from "next/server";
import { syncWorkerStatusToFeishu } from "@/lib/feishu-worker-sync";
import {
  assertWorkerAuthorized,
  buildCanonicalProgressTransition,
  buildRunningJobNotFoundPayload,
  clampProgress,
  findHermesJob,
  getAttemptIdFromBody,
  getBatchCodeFromBody,
  getBitableRecordId,
  getCreatedAtFromBody,
  getWorkerIdFromBody,
  getWorkerSupabase,
  parseJsonBody,
  persistCanonicalRuntimeSignalSafely,
  responseFromMaybe,
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
  batch_code?: string;
  job_created_at?: string;
  created_at?: string;
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
  const currentStep = body.current_step ?? "running";
  const workerId = getWorkerIdFromBody(body);
  const attemptId = getAttemptIdFromBody(body);
  const { data: existingJob, error: findError } = await findHermesJob(supabase, jobId);
  if (findError) {
    return NextResponse.json({ ok: false, error: findError.message ?? "job lookup failed" }, { status: 500 });
  }
  if (!existingJob) {
    return NextResponse.json(
      buildRunningJobNotFoundPayload({
        endpoint: "worker/progress",
        jobId,
        attemptId,
        batchCode: getBatchCodeFromBody(body),
        createdAt: getCreatedAtFromBody(body),
        workerId,
      }),
      { status: 404 }
    );
  }

  const transition = buildCanonicalProgressTransition(existingJob, {
    worker_id: workerId,
    attempt_id: attemptId,
    now,
    progress_percent: progressPercent,
    current_step: currentStep,
    status_message: body.status_message,
  });
  if (transition.terminal) {
    return NextResponse.json({
      ok: true,
      job: existingJob,
      idempotent: true,
      terminal_progress_is_noop: true,
    });
  }
  if (!transition.ok || !transition.patch) {
    return NextResponse.json(
      {
        ok: false,
        error: "canonical_progress_rejected",
        failure_code: transition.failure_code,
        failure_stage: transition.failure_stage,
        violated_invariants: transition.violations ?? [],
      },
      { status: 409 }
    );
  }
  const persistence = await persistCanonicalRuntimeSignalSafely(supabase, {
    job_id: jobId,
    worker_id: workerId,
    attempt_id: attemptId ?? "",
    signal: "progress",
    expected_job: existingJob,
    patch: transition.patch,
  });
  const { data, error } = persistence;

  if (error) {
    return NextResponse.json({ ok: false, error: error.message ?? "update failed" }, { status: 500 });
  }
  if (persistence.terminal && data) {
    return NextResponse.json({
      ok: true,
      job: data,
      attempt_id: attemptId,
      idempotent: true,
      terminal_progress_is_noop: true,
      runtime_cas_race_lost: persistence.race_lost,
    });
  }
  if (!persistence.ok || !data) {
    return NextResponse.json(
      {
        ok: false,
        error: "canonical_progress_race_lost",
        failure_code: persistence.failure_code,
        failure_stage: persistence.failure_stage,
      },
      { status: 409 }
    );
  }

  const recordId = getBitableRecordId(body, data, existingJob);
  await syncWorkerStatusToFeishu({
    recordId,
    status: "running",
    stage: "execution",
    progressPercent,
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
