import { NextRequest, NextResponse } from "next/server";
import { syncWorkerStatusToFeishu } from "@/lib/feishu-worker-sync";
import {
  assertWorkerAuthorized,
  assertWorkerAttemptMatchesJob,
  assertWorkerOwnsJob,
  buildProjectDirectorWorkerReport,
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

interface WorkerReportBody {
  id?: string;
  job_id?: string;
  attempt_id?: string;
  status?: string;
  progress_percent?: number;
  current_step?: string;
  status_message?: string;
  worker_id?: string;
  worker_name?: string;
  git_commit_sha?: string;
  deploy_status?: string | null;
  result_text?: string;
  error_text?: string;
  error?: string;
  output?: string;
  pr_url?: string;
  files_changed?: string[];
  build_passed?: boolean;
  test_passed?: boolean;
  duration_ms?: number;
  bitable_record_id?: string;
  feishu_record_id?: string;
  record_id?: string;
}

function buildResult(body: WorkerReportBody): Record<string, unknown> {
  return {
    attempt_id: body.attempt_id ?? null,
    worker_id: body.worker_id ?? body.worker_name ?? null,
    output: body.output ?? null,
    pr_url: body.pr_url ?? null,
    files_changed: body.files_changed ?? null,
    build_passed: body.build_passed ?? null,
    test_passed: body.test_passed ?? null,
    duration_ms: body.duration_ms ?? null,
    git_commit_sha: body.git_commit_sha ?? null,
    deploy_status: body.deploy_status ?? null,
    result_text: body.result_text ?? null,
  };
}

export async function POST(req: NextRequest) {
  const unauthorized = assertWorkerAuthorized(req);
  if (unauthorized) return unauthorized;

  const body = await parseJsonBody<WorkerReportBody>(req);
  if (responseFromMaybe(body)) return body;

  const jobId = body.job_id ?? body.id;
  if (!jobId) {
    return NextResponse.json({ ok: false, error: "job_id is required" }, { status: 400 });
  }

  const supabase = await getWorkerSupabase();
  if (responseFromMaybe(supabase)) return supabase;

  const workerStatus = normalizeWorkerStatus(body.status);
  const terminal = workerStatus === "succeeded" || workerStatus === "failed";
  const now = new Date().toISOString();
  const progressPercent = terminal ? 100 : clampProgress(body.progress_percent, 0);
  const errorText = body.error_text ?? body.error ?? null;
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

  const projectDirectorReport = buildProjectDirectorWorkerReport({
    job: existingJob,
    workerId,
    attemptId,
    status: workerStatus,
    resultText: body.result_text,
    output: body.output,
    filesChanged: body.files_changed,
    gitCommitSha: body.git_commit_sha,
    buildPassed: body.build_passed,
    testPassed: body.test_passed,
    errorText,
  });

  if (isTerminalWorkerStatus(existingJob.status)) {
    return NextResponse.json({
      ok: true,
      job: existingJob,
      attempt_id: attemptId,
      project_director_report: projectDirectorReport,
      idempotent: true,
      skipped: "terminal_job_report_ignored",
    });
  }

  const { data, error, skippedColumns } = await updateHermesJob(supabase, jobId, {
    status: workerStatus,
    claimed_by: workerId,
    attempt_id: attemptId,
    active_attempt_id: attemptId,
    progress_percent: progressPercent,
    current_step:
      body.current_step ??
      (workerStatus === "succeeded" ? "completed" : workerStatus === "failed" ? "failed" : null),
    status_message: body.status_message ?? null,
    git_commit_sha: body.git_commit_sha ?? null,
    error_text: workerStatus === "failed" ? errorText : null,
    result: {
      ...buildResult({ ...body, attempt_id: attemptId ?? body.attempt_id }),
      project_director_report: projectDirectorReport.data,
      project_director_report_text: projectDirectorReport.text,
    },
    completed_at: terminal ? now : null,
    updated_at: now,
  });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message ?? "update failed" }, { status: 500 });
  }
  if (skippedColumns.length > 0) {
    console.log(`[worker/report] skipped missing hermes_jobs columns: ${skippedColumns.join(", ")}`);
  }

  const recordId = getBitableRecordId(body, data, existingJob);
  await syncWorkerStatusToFeishu({
    recordId,
    status: workerStatus,
    stage: workerStatus === "failed" ? "failed" : terminal ? "completed" : "execution",
    progressPercent,
    currentStep:
      body.current_step ??
      (workerStatus === "succeeded" ? "completed" : workerStatus === "failed" ? "failed" : null),
    statusMessage: body.status_message ?? null,
    gitCommitSha: body.git_commit_sha ?? null,
    errorText: workerStatus === "failed" ? errorText : "",
    completedAt: terminal ? now : null,
    updatedAt: now,
  });

  return NextResponse.json({
    ok: true,
    job: data,
    attempt_id: attemptId,
    project_director_report: projectDirectorReport,
    feishu_sync: recordId ? "attempted" : "skipped_no_record_id",
  });
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "worker-report" });
}
