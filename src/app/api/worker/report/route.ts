import { NextRequest, NextResponse } from "next/server";
import { syncWorkerStatusToFeishu } from "@/lib/feishu-worker-sync";
import {
  assertWorkerAuthorized,
  assertWorkerAttemptMatchesJob,
  assertWorkerOwnsJob,
  buildRunningJobNotFoundPayload,
  buildProjectDirectorWorkerReport,
  clampProgress,
  DIAGNOSTICS_STORAGE_FIELD,
  DIAGNOSTICS_STORAGE_UNAVAILABLE,
  findHermesJob,
  getAttemptIdFromBody,
  getBatchCodeFromBody,
  getBitableRecordId,
  getCreatedAtFromBody,
  getWorkerIdFromBody,
  getWorkerSupabase,
  isTerminalWorkerStatus,
  normalizeWorkerStatus,
  parseJsonBody,
  responseFromMaybe,
  terminalAttemptMatches,
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
  batch_code?: string;
  job_created_at?: string;
  created_at?: string;
  git_commit_sha?: string;
  deploy_status?: string | null;
  failure_code?: string | null;
  failure_stage?: string | null;
  verification_only?: boolean | string | null;
  allow_no_change_success?: boolean | string | null;
  worker_execution_status?: string | null;
  task_goal_status?: string | null;
  effective_final_status?: string | null;
  diagnostics?: Record<string, unknown> | null;
  result_text?: string;
  error_text?: string;
  error?: string;
  output?: string;
  pr_url?: string;
  project_name?: string;
  project_dir?: string;
  files_changed?: string[];
  validation_results?: string[];
  github_push_status?: string;
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
    batch_code: body.batch_code ?? null,
    job_created_at: body.job_created_at ?? body.created_at ?? null,
    worker_id: body.worker_id ?? body.worker_name ?? null,
    output: body.output ?? null,
    pr_url: body.pr_url ?? null,
    project_name: body.project_name ?? null,
    project_dir: body.project_dir ?? null,
    files_changed: body.files_changed ?? null,
    validation_results: body.validation_results ?? null,
    build_passed: body.build_passed ?? null,
    test_passed: body.test_passed ?? null,
    duration_ms: body.duration_ms ?? null,
    git_commit_sha: body.git_commit_sha ?? null,
    github_push_status: body.github_push_status ?? null,
    deploy_status: body.deploy_status ?? null,
    verification_only: body.verification_only ?? null,
    allow_no_change_success: body.allow_no_change_success ?? null,
    result_text: body.result_text ?? null,
    diagnostics: body.diagnostics ?? null,
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getStoredProjectDirectorReport(job: Record<string, unknown>) {
  const result = readRecord(job.result);
  const storedText = typeof result?.project_director_report_text === "string"
    ? result.project_director_report_text
    : null;
  const storedData = readRecord(result?.project_director_report);

  return storedText
    ? {
        text: storedText,
        data: storedData ?? {},
      }
    : null;
}

function getStoredDiagnostics(job: Record<string, unknown>): Record<string, unknown> | null {
  const result = readRecord(job.result);
  return readRecord(result?.diagnostics);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBooleanFlag(value: unknown): boolean {
  if (value === true) return true;
  return /^(true|1|yes|on)$/i.test(String(value ?? "").trim());
}

function fullReportText(job: Record<string, unknown>, body: WorkerReportBody): string {
  return [job.request_text, body.result_text, body.output, body.error_text, body.error, body.status_message]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
}

function readContextField(text: string, fieldName: string): string | null {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`(?:^|\\n|\\r)\\s*[\`'"]?${escaped}[\`'"]?\\s*[:=]\\s*([^\\r\\n]+)`, "i"));
  return match ? match[1].replace(/^`|`$/g, "").trim() || null : null;
}

function normalizePathList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string") {
    return value.split(/[\r\n,]+/g).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function reportPushed(body: WorkerReportBody): boolean {
  return (
    /^(success|succeeded|pushed|true|yes)$/i.test(String(body.github_push_status || "").trim()) ||
    /^(success|succeeded|pushed|pending)$/i.test(String(body.deploy_status || "").trim())
  );
}

function buildFalsePositiveSuccessGuard(
  job: Record<string, unknown>,
  body: WorkerReportBody,
  workerStatus: string
): { failureCode: string; failureStage: string; errorText: string } | null {
  if (workerStatus !== "succeeded") return null;

  const payload = readRecord(job.payload);
  const text = fullReportText(job, body);
  const taskMode = readString(payload?.task_mode) ?? readContextField(text, "task_mode");
  const finalMode = readString(payload?.final_mode) ?? readContextField(text, "final_mode");
  const requestedMode = readString(payload?.requested_mode) ?? readContextField(text, "requested_mode");
  const repairMode =
    readBooleanFlag(payload?.repair_mode) ||
    readBooleanFlag(readContextField(text, "repair_mode"));
  const verificationOnly =
    readBooleanFlag(body.verification_only) ||
    readBooleanFlag(payload?.verification_only) ||
    readBooleanFlag(readContextField(text, "verification_only"));
  const allowNoChangeSuccess =
    readBooleanFlag(body.allow_no_change_success) ||
    readBooleanFlag(payload?.allow_no_change_success) ||
    readBooleanFlag(readContextField(text, "allow_no_change_success"));
  const approvedBatch = readString(payload?.approved_batch) ?? readContextField(text, "approved_batch");
  const workerBatch = body.batch_code ?? readContextField(text, "batch_code");
  const exactAllowedScope =
    normalizePathList(payload?.exact_allowed_scope).length > 0
      ? normalizePathList(payload?.exact_allowed_scope)
      : normalizePathList(readContextField(text, "exact_allowed_scope"));
  const changedFiles = normalizePathList(body.files_changed);
  const verificationOnlyNoChangeSuccess =
    repairMode && (verificationOnly || allowNoChangeSuccess) && changedFiles.length === 0;
  const writeAllowed =
    finalMode === "write_allowed" ||
    requestedMode === "write_allowed" ||
    taskMode === "automation_system_write_allowed";
  const readOnlyExecution =
    taskMode === "read_only" ||
    finalMode === "read_only" ||
    /read_only_mode\s*[:=]\s*true|allowed_scope\s*[:=]\s*git status\s*\/\s*git diff only|只读任务锁死|只执行\s*git\s*status|只执行\s*git\s*diff/i.test(text);

  if (/running_job_not_found|running_job_not_found_or_not_owned|WORKER_ATTEMPT_MISMATCH/i.test(text)) {
    return {
      failureCode: "WORKER_ATTEMPT_LIFECYCLE_FAILED",
      failureStage: "worker_lifecycle",
      errorText: "WORKER_ATTEMPT_LIFECYCLE_FAILED: heartbeat/progress ownership failed before terminal report.",
    };
  }
  if (writeAllowed && readOnlyExecution) {
    return {
      failureCode: "APPROVAL_CONTEXT_MODE_MISMATCH",
      failureStage: "approval_context_rehydration",
      errorText: "APPROVAL_CONTEXT_MODE_MISMATCH: write_allowed task was executed with read_only context.",
    };
  }
  if (writeAllowed && exactAllowedScope.length === 0) {
    return {
      failureCode: "APPROVAL_CONTEXT_MODE_MISMATCH",
      failureStage: "approval_context_rehydration",
      errorText: "APPROVAL_CONTEXT_MODE_MISMATCH: write_allowed task is missing exact_allowed_scope.",
    };
  }
  if (approvedBatch && workerBatch && approvedBatch !== workerBatch) {
    return {
      failureCode: "APPROVED_BATCH_MISMATCH",
      failureStage: "approval_context_rehydration",
      errorText: "APPROVED_BATCH_MISMATCH: approved batch and Worker batch do not match.",
    };
  }
  if (writeAllowed && changedFiles.length === 0) {
    if (verificationOnlyNoChangeSuccess) {
      return null;
    }

    return {
      failureCode: "NO_FIX_APPLIED",
      failureStage: "task_goal_validation",
      errorText: "NO_FIX_APPLIED: write_allowed smoke completed with changed_files=[].",
    };
  }
  if (writeAllowed && (!body.git_commit_sha || !reportPushed(body))) {
    if (verificationOnlyNoChangeSuccess) {
      return null;
    }

    return {
      failureCode: "GIT_PUBLISH_REQUIRED",
      failureStage: "git_publish_validation",
      errorText: "GIT_PUBLISH_REQUIRED: write_allowed smoke requires git_commit_sha and successful push.",
    };
  }

  return null;
}

async function enrichTerminalDiagnosticsIfMissing(input: {
  supabase: Parameters<typeof updateHermesJob>[0];
  jobId: string;
  existingJob: Record<string, unknown>;
  diagnostics: unknown;
}) {
  if (!Object.prototype.hasOwnProperty.call(input.existingJob, "result")) {
    return { enriched: false, reason: "result_column_not_loaded" };
  }
  if (getStoredDiagnostics(input.existingJob)) {
    return { enriched: false, reason: "diagnostics_present" };
  }
  const diagnostics = readRecord(input.diagnostics);
  if (!diagnostics) {
    return { enriched: false, reason: "diagnostics_not_provided" };
  }

  const result = readRecord(input.existingJob.result) ?? {};
  const { data, error, skippedColumns } = await updateHermesJob(input.supabase, input.jobId, {
    result: {
      ...result,
      diagnostics,
    },
    updated_at: typeof input.existingJob.updated_at === "string" ? input.existingJob.updated_at : new Date().toISOString(),
  });

  if (error || skippedColumns.includes("result")) {
    return { enriched: false, reason: "diagnostics_storage_unavailable" };
  }

  return { enriched: Boolean(data), reason: data ? "diagnostics_enriched" : "diagnostics_enrichment_not_applied" };
}

function buildDiagnosticsStorageUnavailablePayload(input: {
  jobId: string;
  attemptId: string | null;
  terminalStatusPersisted: boolean;
  skippedColumns: string[];
}) {
  return {
    ok: false,
    error: "diagnostics_storage_unavailable",
    failure_code: DIAGNOSTICS_STORAGE_UNAVAILABLE,
    failure_stage: "report",
    job_id: input.jobId,
    attempt_id: input.attemptId,
    diagnostics_storage_field: DIAGNOSTICS_STORAGE_FIELD,
    terminal_status_persisted: input.terminalStatusPersisted,
    diagnostics_persisted: false,
    terminal_report_idempotent: false,
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
  const workerId = getWorkerIdFromBody(body);
  const attemptId = getAttemptIdFromBody(body);
  const { data: existingJob, error: findError } = await findHermesJob(supabase, jobId);
  if (findError) {
    return NextResponse.json({ ok: false, error: findError.message ?? "job lookup failed" }, { status: 500 });
  }
  if (!existingJob) {
    return NextResponse.json(
      buildRunningJobNotFoundPayload({
        endpoint: "worker/report",
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

  const falsePositiveGuard = buildFalsePositiveSuccessGuard(existingJob, body, workerStatus);
  const projectDirectorReport = buildProjectDirectorWorkerReport({
    job: existingJob,
    workerId,
    attemptId,
    status: falsePositiveGuard ? "failed" : workerStatus,
    projectName: body.project_name,
    projectDir: body.project_dir,
    resultText: body.result_text,
    output: body.output,
    filesChanged: body.files_changed,
    validationResults: body.validation_results,
    gitCommitSha: body.git_commit_sha,
    githubPushStatus: body.github_push_status,
    deployStatus: body.deploy_status,
    buildPassed: body.build_passed,
    testPassed: body.test_passed,
    errorText: falsePositiveGuard?.errorText ?? errorText,
    failureCode: falsePositiveGuard?.failureCode ?? body.failure_code,
    failureStage: falsePositiveGuard?.failureStage ?? body.failure_stage,
    workerExecutionStatus: falsePositiveGuard ? "failed" : body.worker_execution_status,
    taskGoalStatus: falsePositiveGuard ? "failed" : body.task_goal_status,
    effectiveFinalStatus: falsePositiveGuard ? "failed" : body.effective_final_status,
  });
  const effectiveFinalStatus = normalizeWorkerStatus(projectDirectorReport.data.effective_final_status);
  const storedStatus = terminal && isTerminalWorkerStatus(effectiveFinalStatus) ? effectiveFinalStatus : workerStatus;

  if (isTerminalWorkerStatus(existingJob.status)) {
    if (!terminalAttemptMatches(existingJob, attemptId)) {
      return NextResponse.json(
        {
          ok: false,
          error: "stale_attempt_terminal_report",
          stale_attempt: true,
          duplicate_report_detected: false,
          status_unchanged: true,
          diagnostics_persisted: false,
          attempt_id: attemptId,
        },
        { status: 409 }
      );
    }

    const storedProjectDirectorReport =
      getStoredProjectDirectorReport(existingJob) ?? projectDirectorReport;
    const storedResult = readRecord(existingJob.result);
    const storedTerminalStatus =
      normalizeWorkerStatus(existingJob.status) === "failed" ? "failed" : "succeeded";
    const diagnosticsEnrichment = await enrichTerminalDiagnosticsIfMissing({
      supabase,
      jobId,
      existingJob,
      diagnostics: projectDirectorReport.data.diagnostics,
    });

    return NextResponse.json({
      ok: true,
      job: existingJob,
      attempt_id: attemptId,
      project_director_report: storedProjectDirectorReport,
      idempotent: true,
      duplicate_report_detected: true,
      duplicate_report_idempotent: true,
      second_side_effect_triggered: false,
      diagnostics_enrichment_only: diagnosticsEnrichment.enriched,
      diagnostics_enrichment_reason: diagnosticsEnrichment.reason,
      non_diagnostic_side_effects: 0,
      skipped: "terminal_job_report_ignored",
      feishu_sync: "skipped_duplicate_terminal",
      git_commit_sha:
        body.git_commit_sha ??
        (typeof storedResult?.git_commit_sha === "string" ? storedResult.git_commit_sha : null),
      terminal_status_persisted: true,
      diagnostics_persisted: Boolean(readRecord(storedResult?.diagnostics)),
      status: storedTerminalStatus,
    });
  }

  const { data, error, skippedColumns } = await updateHermesJob(supabase, jobId, {
    status: storedStatus,
    claimed_by: workerId,
    attempt_id: attemptId,
    active_attempt_id: attemptId,
    progress_percent: progressPercent,
    current_step:
      body.current_step ??
      (storedStatus === "succeeded" ? "completed" : storedStatus === "failed" ? "failed" : null),
    status_message: terminal ? projectDirectorReport.text : body.status_message ?? null,
    git_commit_sha: body.git_commit_sha ?? null,
    error_text: storedStatus === "failed" ? falsePositiveGuard?.errorText ?? errorText : null,
    result: {
      ...buildResult({ ...body, attempt_id: attemptId ?? body.attempt_id }),
      project_director_report: projectDirectorReport.data,
      project_director_report_text: projectDirectorReport.text,
      diagnostics: projectDirectorReport.data.diagnostics ?? null,
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
  if (terminal && skippedColumns.includes("result")) {
    console.error("[worker/report] diagnostics storage unavailable", {
      job_id: jobId,
      storage_field: DIAGNOSTICS_STORAGE_FIELD,
      skipped_columns: skippedColumns,
    });
    return NextResponse.json(
      buildDiagnosticsStorageUnavailablePayload({
        jobId,
        attemptId,
        terminalStatusPersisted: Boolean(data),
        skippedColumns,
      }),
      { status: 500 }
    );
  }

  const recordId = getBitableRecordId(body, data, existingJob);
  await syncWorkerStatusToFeishu({
    recordId,
    status: storedStatus,
    stage: storedStatus === "failed" ? "failed" : terminal ? "completed" : "execution",
    progressPercent,
    currentStep:
      body.current_step ??
      (storedStatus === "succeeded" ? "completed" : storedStatus === "failed" ? "failed" : null),
    statusMessage: terminal ? projectDirectorReport.text : body.status_message ?? null,
    gitCommitSha: body.git_commit_sha ?? null,
    errorText: workerStatus === "failed" ? projectDirectorReport.text : "",
    completedAt: terminal ? now : null,
    updatedAt: now,
  });

  return NextResponse.json({
    ok: true,
    job: data,
    attempt_id: attemptId,
    project_director_report: projectDirectorReport,
    feishu_sync: recordId ? "attempted" : "skipped_no_record_id",
    terminal_status_persisted: terminal,
    diagnostics_persisted: terminal ? true : null,
    diagnostics_storage_field: terminal ? DIAGNOSTICS_STORAGE_FIELD : null,
  });
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "worker-report" });
}
