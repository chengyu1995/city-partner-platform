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

interface WorkerReportBody {
  id?: string;
  job_id?: string;
  status?: string;
  progress_percent?: number;
  current_step?: string;
  status_message?: string;
  git_commit_sha?: string;
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
    output: body.output ?? null,
    pr_url: body.pr_url ?? null,
    files_changed: body.files_changed ?? null,
    build_passed: body.build_passed ?? null,
    test_passed: body.test_passed ?? null,
    duration_ms: body.duration_ms ?? null,
    git_commit_sha: body.git_commit_sha ?? null,
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
  const { data: existingJob } = await findHermesJob(supabase, jobId);

  const { data, error, skippedColumns } = await updateHermesJob(supabase, jobId, {
    status: workerStatus,
    progress_percent: progressPercent,
    current_step:
      body.current_step ??
      (workerStatus === "succeeded" ? "已完成" : workerStatus === "failed" ? "失败" : null),
    status_message: body.status_message ?? null,
    git_commit_sha: body.git_commit_sha ?? null,
    error_text: workerStatus === "failed" ? errorText : null,
    result: buildResult(body),
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
      (workerStatus === "succeeded" ? "已完成" : workerStatus === "failed" ? "失败" : null),
    statusMessage: body.status_message ?? null,
    gitCommitSha: body.git_commit_sha ?? null,
    errorText: workerStatus === "failed" ? errorText : "",
    completedAt: terminal ? now : null,
    updatedAt: now,
  });

  return NextResponse.json({ ok: true, job: data, feishu_sync: recordId ? "attempted" : "skipped_no_record_id" });
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "worker-report" });
}
