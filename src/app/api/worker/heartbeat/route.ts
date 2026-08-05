import { NextRequest, NextResponse } from "next/server";
import {
  assertWorkerAuthorized,
  buildCanonicalHeartbeatTransition,
  buildRunningJobNotFoundPayload,
  canonicalPersistenceRuntimeEnabled,
  findHermesJob,
  getAttemptIdFromBody,
  getBatchCodeFromBody,
  getCreatedAtFromBody,
  getWorkerIdFromBody,
  getWorkerIdFromRequest,
  getWorkerSupabase,
  isCanonicalPersistenceJob,
  parseJsonBody,
  persistCanonicalRuntimeSignalSafely,
  persistCanonicalWorkerRuntimeSignal,
  responseFromMaybe,
} from "@/lib/worker-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface WorkerHeartbeatBody {
  id?: string;
  job_id?: string;
  worker_id?: string;
  worker_name?: string;
  attempt_id?: string;
  lease_id?: string;
  canonical_revision?: number;
  expected_revision?: number;
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

  if (isCanonicalPersistenceJob(existingJob)) {
    if (!canonicalPersistenceRuntimeEnabled()) {
      return NextResponse.json(
        { ok: false, failure_code: "CANONICAL_PERSISTENCE_RUNTIME_DISABLED" },
        { status: 409 }
      );
    }
    const expectedRevision = body.expected_revision ?? body.canonical_revision;
    if (!attemptId || !body.lease_id || !Number.isSafeInteger(expectedRevision)) {
      return NextResponse.json(
        { ok: false, failure_code: "CANONICAL_PROTOCOL_IDENTITY_REQUIRED" },
        { status: 400 }
      );
    }
    try {
      const result = await persistCanonicalWorkerRuntimeSignal(supabase, {
        job_id: jobId,
        worker_id: workerId,
        attempt_id: attemptId,
        lease_id: body.lease_id,
        expected_revision: expectedRevision as number,
        signal: "heartbeat",
        lease_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      return NextResponse.json({
        ok: true,
        job: result.job,
        attempt_id: attemptId,
        lease_id: body.lease_id,
        canonical_revision: result.revision,
        terminal_heartbeat_is_noop: result.terminal_noop === true,
        idempotent: result.idempotent === true,
      });
    } catch (errorValue) {
      return NextResponse.json(
        {
          ok: false,
          error: errorValue instanceof Error ? errorValue.message : String(errorValue),
          failure_code: "CANONICAL_HEARTBEAT_REJECTED",
          failure_stage: "canonical_heartbeat",
        },
        { status: 409 }
      );
    }
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const transition = buildCanonicalHeartbeatTransition(existingJob, {
    worker_id: workerId,
    attempt_id: attemptId,
    now,
    expires_at: expiresAt,
    status_message: body.status_message,
  });
  if (transition.terminal) {
    return NextResponse.json({
      ok: true,
      job: existingJob,
      idempotent: true,
      terminal_heartbeat_is_noop: true,
    });
  }
  if (!transition.ok || !transition.patch) {
    return NextResponse.json(
      {
        ok: false,
        error: "canonical_heartbeat_rejected",
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
    signal: "heartbeat",
    expected_job: existingJob,
    patch: transition.patch,
  });
  const { data, error } = persistence;

  if (error) {
    return NextResponse.json({ ok: false, error: error.message ?? "heartbeat update failed" }, { status: 500 });
  }
  if (persistence.terminal && data) {
    return NextResponse.json({
      ok: true,
      job: data,
      attempt_id: attemptId,
      idempotent: true,
      terminal_heartbeat_is_noop: true,
      runtime_cas_race_lost: persistence.race_lost,
    });
  }
  if (!persistence.ok || !data) {
    return NextResponse.json(
      {
        ok: false,
        error: "canonical_heartbeat_race_lost",
        failure_code: persistence.failure_code,
        failure_stage: persistence.failure_stage,
      },
      { status: 409 }
    );
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
