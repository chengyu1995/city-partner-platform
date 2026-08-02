import { NextRequest, NextResponse } from "next/server";
import { syncWorkerStatusToFeishu } from "@/lib/feishu-worker-sync";
import {
  assertWorkerAuthorized,
  buildAttemptPayload,
  buildCanonicalClaimTransition,
  buildTerminalJobCleanupFields,
  claimHermesJob,
  createWorkerAttemptId,
  findHermesJob,
  getActiveAttemptId,
  getBitableRecordId,
  getCanonicalTerminalWorkerJobStatus,
  getProjectDirectorJobCorrelation,
  getWorkerIdFromRequest,
  getWorkerSupabase,
  isJobSelectable,
  isCanonicalClaimPersisted,
  responseFromMaybe,
  rollbackFailedClaimSafely,
  updateHermesJob,
  validateJobStateInvariant,
} from "@/lib/worker-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function releaseTerminalJob(
  supabase: Awaited<ReturnType<typeof getWorkerSupabase>>,
  job: Record<string, unknown>,
  terminalStatus: string
) {
  if (responseFromMaybe(supabase)) return { data: null, error: null, skippedColumns: [] };
  return updateHermesJob(
    supabase,
    String(job.id),
    buildTerminalJobCleanupFields(job, terminalStatus)
  );
}

async function handleNext(req: NextRequest) {
  const unauthorized = assertWorkerAuthorized(req);
  if (unauthorized) return unauthorized;

  const supabase = await getWorkerSupabase();
  if (responseFromMaybe(supabase)) return supabase;

  const { data: queuedJobs, error } = await supabase
    .from("hermes_jobs")
    .select("*")
    .in("status", ["queued", "pending"])
    .is("claimed_by", null)
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  let job: (Record<string, unknown> & { id: string }) | null = null;
  for (const queuedJob of (queuedJobs ?? []) as Record<string, unknown>[]) {
    const terminalStatus = getCanonicalTerminalWorkerJobStatus(queuedJob);
    const invariant = validateJobStateInvariant(queuedJob);
    if (!invariant.ok) {
      console.warn("[worker/next] canonical job invariant violation", {
        job_id: queuedJob.id,
        failure_code: invariant.failure_code,
        violated_invariants: invariant.violations.map((item: { code: string }) => item.code),
      });
      continue;
    }
    if (!terminalStatus && isJobSelectable(queuedJob)) {
      job = queuedJob as Record<string, unknown> & { id: string };
      break;
    }
    if (!terminalStatus) continue;
    const cleanupResult = await releaseTerminalJob(supabase, queuedJob, terminalStatus);
    if (cleanupResult.error) {
      return NextResponse.json(
        {
          ok: false,
          error: cleanupResult.error.message ?? "terminal job cleanup failed",
          failure_code: "TERMINAL_JOB_CLEANUP_FAILED",
          failure_stage: "eligibility_terminal_cleanup",
          worker_next_returned: false,
        },
        { status: 500 }
      );
    }
  }
  if (!job) {
    return NextResponse.json({ ok: true, job: null });
  }
  const jobId = String(job.id);

  const { data: preClaimJob, error: preClaimError } = await findHermesJob(supabase, jobId);
  if (preClaimError) {
    return NextResponse.json(
      { ok: false, error: preClaimError.message ?? "pre-claim terminal check failed" },
      { status: 500 }
    );
  }
  const preClaimTerminalStatus = getCanonicalTerminalWorkerJobStatus(preClaimJob ?? job);
  if (preClaimTerminalStatus) {
    const cleanupResult = await releaseTerminalJob(
      supabase,
      preClaimJob ?? job,
      preClaimTerminalStatus
    );
    if (cleanupResult.error) {
      return NextResponse.json(
        {
          ok: false,
          error: cleanupResult.error.message ?? "terminal job cleanup failed",
          failure_code: "TERMINAL_JOB_CLEANUP_FAILED",
          failure_stage: "pre_claim_terminal_cleanup",
          worker_next_returned: false,
          codex_called: false,
          git_mutation_executed: false,
        },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      job: null,
      skipped: "terminal_job_excluded_before_claim",
      worker_next_returned: false,
      execution_aborted: true,
      codex_called: false,
      git_mutation_executed: false,
    });
  }

  const preClaimInvariant = validateJobStateInvariant(preClaimJob ?? job);
  if (!preClaimInvariant.ok || !isJobSelectable(preClaimJob ?? job)) {
    return NextResponse.json(
      {
        ok: false,
        error: "job_state_invariant_violation",
        failure_code: preClaimInvariant.failure_code ?? "JOB_NOT_SELECTABLE",
        failure_stage: "worker_claim",
        violated_invariants: preClaimInvariant.violations.map((item: { code: string }) => item.code),
        worker_next_returned: false,
      },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const workerId = getWorkerIdFromRequest(req);
  const attemptId = createWorkerAttemptId(jobId, workerId);
  const canonicalClaim = buildCanonicalClaimTransition(preClaimJob ?? job, {
    worker_id: workerId,
    attempt_id: attemptId,
    lease_id: `lease:${attemptId}`,
    now,
    expires_at: expiresAt,
  });
  if (!canonicalClaim.ok || !canonicalClaim.patch) {
    return NextResponse.json(
      {
        ok: false,
        error: "job_state_invariant_violation",
        failure_code: canonicalClaim.failure_code ?? "JOB_NOT_SELECTABLE",
        failure_stage: "worker_claim",
        violated_invariants: canonicalClaim.violations ?? [],
        worker_next_returned: false,
      },
      { status: 409 }
    );
  }
  const { data: claimedJob, error: updateError, skippedColumns } = await claimHermesJob(
    supabase,
    jobId,
    workerId,
    {
      ...canonicalClaim.patch,
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
        job_id: jobId,
        worker_id: workerId,
        status: "running",
        started_at: now,
        updated_at: now,
      }),
      updated_at: now,
    },
    { updated_at: String((preClaimJob ?? job).updated_at ?? "") || null }
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


  const { data: persistedClaimedJob, error: postClaimError } = await findHermesJob(
    supabase,
    jobId
  );
  if (postClaimError) {
    return NextResponse.json(
      { ok: false, error: postClaimError.message ?? "post-claim terminal check failed" },
      { status: 500 }
    );
  }
  const postClaimTerminalStatus = getCanonicalTerminalWorkerJobStatus(
    persistedClaimedJob ?? claimedJob
  );
  if (postClaimTerminalStatus) {
    const cleanupResult = await releaseTerminalJob(
      supabase,
      persistedClaimedJob ?? claimedJob,
      postClaimTerminalStatus
    );
    if (cleanupResult.error) {
      return NextResponse.json(
        {
          ok: false,
          error: cleanupResult.error.message ?? "terminal job cleanup failed",
          failure_code: "TERMINAL_JOB_CLEANUP_FAILED",
          failure_stage: "post_claim_terminal_cleanup",
          worker_next_returned: false,
          execution_aborted: true,
          codex_called: false,
          git_mutation_executed: false,
        },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      job: null,
      attempt_id: attemptId,
      skipped: "terminal_job_detected_after_claim",
      worker_next_returned: false,
      execution_aborted: true,
      codex_called: false,
      git_mutation_executed: false,
    });
  }

  const runnableClaimedJob = persistedClaimedJob ?? claimedJob;

  const persistedAttemptId = getActiveAttemptId(runnableClaimedJob);
  if (persistedAttemptId !== attemptId || !isCanonicalClaimPersisted(runnableClaimedJob, attemptId)) {
    const rollback = await rollbackFailedClaimSafely(supabase, {
      job_id: jobId,
      worker_id: workerId,
      attempt_id: attemptId,
      now: new Date().toISOString(),
    });
    if (!rollback.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "failed claim rollback rejected",
          failure_code: rollback.failure_code,
          failure_stage: rollback.failure_stage,
          rollback_applied: false,
          rollback_skipped_reason: rollback.rollback_skipped_reason,
          terminal_report_won: false,
          worker_created: false,
          job_id: jobId,
          attempt_id: attemptId,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: "claim attempt contract was not persisted",
        failure_code: "WORKER_ATTEMPT_PERSISTENCE_FAILED",
        failure_stage: "worker_claim",
        worker_created: false,
        job_id: jobId,
        attempt_id: attemptId,
        rollback_applied: rollback.rollback_applied,
        rollback_skipped_reason: rollback.rollback_skipped_reason,
        terminal_report_won: rollback.terminal_report_won,
      },
      { status: 500 }
    );
  }

  const recordId = getBitableRecordId(runnableClaimedJob, job);
  const projectDirector = getProjectDirectorJobCorrelation(runnableClaimedJob);
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
    job: runnableClaimedJob,
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
