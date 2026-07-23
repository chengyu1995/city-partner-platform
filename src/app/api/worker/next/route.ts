import { NextRequest, NextResponse } from "next/server";
import { syncWorkerStatusToFeishu } from "@/lib/feishu-worker-sync";
import {
  assertWorkerAuthorized,
  buildAttemptPayload,
  claimHermesJob,
  createWorkerAttemptId,
  getBitableRecordId,
  getProjectDirectorJobCorrelation,
  getWorkerIdFromRequest,
  getWorkerSupabase,
  responseFromMaybe,
  updateHermesJob,
} from "@/lib/worker-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handleNext(req: NextRequest) {
  const unauthorized = assertWorkerAuthorized(req);
  if (unauthorized) return unauthorized;

  const supabase = await getWorkerSupabase();
  if (responseFromMaybe(supabase)) return supabase;

  const { data: job, error } = await supabase
    .from("hermes_jobs")
    .select("*")
    .in("status", ["queued", "pending"])
    .is("claimed_by", null)
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
  const workerId = getWorkerIdFromRequest(req);
  const attemptId = createWorkerAttemptId(job.id, workerId);
  const { data: claimedJob, error: updateError, skippedColumns } = await claimHermesJob(
    supabase,
    job.id,
    workerId,
    {
      status: "running",
      claimed_by: workerId,
      claimed_at: now,
      attempt_id: attemptId,
      active_attempt_id: attemptId,
      expires_at: expiresAt,
      progress_percent: 0,
      current_step: "waiting_worker_claim",
      status_message: "Worker claimed job",
      payload: buildAttemptPayload(job, {
        attempt_id: attemptId,
        job_id: job.id,
        worker_id: workerId,
        status: "running",
        started_at: now,
        updated_at: now,
      }),
      request_text: [
        String(job.request_text ?? "")
          .replace(/\n*HERMES_WORKER_ATTEMPT_CONTEXT:\n(?:`[^`\r\n]+=[^`\r\n]*`\n?)+/g, "")
          .trim(),
        [
          "HERMES_WORKER_ATTEMPT_CONTEXT:",
          `\`attempt_id=${attemptId}\``,
          `\`active_attempt_id=${attemptId}\``,
          `\`worker_id=${workerId}\``,
          `\`claimed_at=${now}\``,
        ].join("\n"),
      ].filter(Boolean).join("\n\n").trim(),
      updated_at: now,
    }
  );

  if (updateError) {
    return NextResponse.json(
      { ok: false, error: updateError.message ?? "claim failed" },
      { status: 500 }
    );
  }
  if (!claimedJob) {
    return NextResponse.json({ ok: true, job: null, skipped: "already_claimed_or_not_runnable" });
  }
  if (skippedColumns.length > 0) {
    console.log(`[worker/next] skipped missing hermes_jobs columns: ${skippedColumns.join(", ")}`);
  }

  const claimedPayload =
    claimedJob.payload && typeof claimedJob.payload === "object" && !Array.isArray(claimedJob.payload)
      ? (claimedJob.payload as Record<string, unknown>)
      : null;
  const activeAttempt =
    claimedPayload?.active_attempt && typeof claimedPayload.active_attempt === "object"
      ? (claimedPayload.active_attempt as Record<string, unknown>)
      : null;
  const persistedAttemptId =
    claimedJob.active_attempt_id ??
    claimedJob.attempt_id ??
    activeAttempt?.attempt_id ??
    claimedPayload?.attempt_id;
  if (persistedAttemptId !== attemptId) {
    await updateHermesJob(supabase, job.id, {
      status: job.status ?? "queued",
      claimed_by: null,
      claimed_at: null,
      attempt_id: null,
      active_attempt_id: null,
      expires_at: null,
      progress_percent: 0,
      current_step: null,
      status_message: null,
      request_text: String(claimedJob.request_text ?? job.request_text ?? "")
        .replace(/\n*HERMES_WORKER_ATTEMPT_CONTEXT:\n(?:`[^`\r\n]+=[^`\r\n]*`\n?)+/g, "")
        .trim(),
      updated_at: new Date().toISOString(),
    });
    return NextResponse.json(
      {
        ok: false,
        error: "claim attempt contract was not persisted",
        failure_code: "WORKER_ATTEMPT_PERSISTENCE_FAILED",
        failure_stage: "worker_claim",
        worker_created: false,
        job_id: job.id,
        attempt_id: attemptId,
      },
      { status: 500 }
    );
  }

  const recordId = getBitableRecordId(claimedJob, job);
  const projectDirector = getProjectDirectorJobCorrelation(claimedJob);
  await syncWorkerStatusToFeishu({
    recordId,
    status: "running",
    stage: "execution",
    progressPercent: 0,
    currentStep: "waiting_worker_claim",
    statusMessage: "Worker claimed job",
    updatedAt: now,
  });

  return NextResponse.json({
    ok: true,
    job: claimedJob,
    attempt_id: attemptId,
    project_director: {
      ...projectDirector,
      attempt_id: attemptId,
      attempt_contract:
        "echo this attempt_id in heartbeat, progress, and report; mismatches are rejected",
    },
    feishu_sync: recordId ? "attempted" : "skipped_no_record_id",
  });
}

export async function GET(req: NextRequest) {
  return handleNext(req);
}

export async function POST(req: NextRequest) {
  return handleNext(req);
}
