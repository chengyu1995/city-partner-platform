import { NextRequest, NextResponse } from "next/server";
import { syncWorkerStatusToFeishu } from "@/lib/feishu-worker-sync";
import {
  assertWorkerAuthorized,
  assertWorkerAttemptMatchesJob,
  assertWorkerOwnsJob,
  buildRunningJobNotFoundPayload,
  buildCanonicalPlanFinalReportProjection,
  buildCanonicalWorkerReportSchema,
  buildProjectDirectorWorkerReport,
  clampProgress,
  canonicalPersistenceRuntimeEnabled,
  CANONICAL_WORKER_REPORT_SCHEMA_VERSION,
  DIAGNOSTICS_STORAGE_FIELD,
  DIAGNOSTICS_STORAGE_UNAVAILABLE,
  findHermesJob,
  finalizeCanonicalJobReportSafely,
  finalizeCanonicalPersistenceJobSafely,
  getAttemptIdFromBody,
  getBatchCodeFromBody,
  getBitableRecordId,
  getCanonicalTerminalWorkerJobStatus,
  getCreatedAtFromBody,
  getWorkerIdFromBody,
  getWorkerSupabase,
  isTerminalWorkerStatus,
  isCanonicalPersistenceJob,
  normalizeWorkerStatus,
  parseJsonBody,
  responseFromMaybe,
  terminalAttemptMatches,
  updateHermesJob,
  validateCanonicalWorkerReportSchema,
} from "@/lib/worker-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface WorkerReportBody {
  id?: string;
  job_id?: string;
  attempt_id?: string;
  lease_id?: string;
  canonical_revision?: number;
  expected_revision?: number;
  status?: string;
  progress_percent?: number;
  current_step?: string;
  status_message?: string;
  worker_id?: string;
  worker_name?: string;
  worker_instance_id?: string;
  report_schema_version?: number | string | null;
  batch_code?: string;
  job_created_at?: string;
  created_at?: string;
  git_commit_sha?: string;
  deploy_status?: string | null;
  failure_code?: string | null;
  failure_stage?: string | null;
  failure_detail?: string | null;
  verification_only?: boolean | string | null;
  worker_only?: boolean | string | null;
  allow_no_change_success?: boolean | string | null;
  execution_policy_conflict?: string | null;
  deterministic_git_operation?: boolean | string | null;
  codex_called?: boolean | string | null;
  code_changes_required?: boolean | string | null;
  codex_required?: boolean | string | null;
  git_commit_required?: boolean | string | null;
  git_push_required?: boolean | string | null;
  approval_required?: boolean | string | null;
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
  changed_files?: string[];
  committed_files?: string[];
  codex_changed_files?: string[];
  worktree_changed_files?: string[];
  task_changed_files?: string[];
  unexpected_changed_files?: string[];
  validation_results?: string[];
  github_push_status?: string;
  codex_git_push?: string | boolean | null;
  worker_git_push?: string | boolean | null;
  git_push?: string | boolean | null;
  pushed?: string | boolean | null;
  pushed_branch?: string | null;
  remote_contains_commit?: string | boolean | null;
  repository_clean_after_push?: string | boolean | null;
  terminal_state_persisted?: string | boolean | null;
  post_completion_state_applied?: string | boolean | null;
  final_report_source?: string | null;
  post_completion_source?: string | null;
  next_stage_allowed?: string | boolean | null;
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
    report_schema_version: body.report_schema_version ?? null,
    batch_code: body.batch_code ?? null,
    job_created_at: body.job_created_at ?? body.created_at ?? null,
    worker_id: body.worker_id ?? body.worker_name ?? body.worker_instance_id ?? null,
    worker_instance_id: body.worker_instance_id ?? body.worker_id ?? body.worker_name ?? null,
    output: body.output ?? null,
    pr_url: body.pr_url ?? null,
    project_name: body.project_name ?? null,
    project_dir: body.project_dir ?? null,
    files_changed: body.files_changed ?? body.changed_files ?? null,
    changed_files: body.changed_files ?? body.files_changed ?? null,
    committed_files: body.committed_files ?? null,
    codex_changed_files: body.codex_changed_files ?? null,
    worktree_changed_files: body.worktree_changed_files ?? null,
    task_changed_files: body.task_changed_files ?? null,
    unexpected_changed_files: body.unexpected_changed_files ?? null,
    validation_results: body.validation_results ?? null,
    build_passed: body.build_passed ?? null,
    test_passed: body.test_passed ?? null,
    duration_ms: body.duration_ms ?? null,
    git_commit_sha: body.git_commit_sha ?? null,
    github_push_status: body.github_push_status ?? null,
    codex_git_push: body.codex_git_push ?? null,
    worker_git_push: body.worker_git_push ?? null,
    git_push: body.git_push ?? null,
    pushed: body.pushed ?? null,
    pushed_branch: body.pushed_branch ?? null,
    remote_contains_commit: body.remote_contains_commit ?? null,
    repository_clean_after_push: body.repository_clean_after_push ?? null,
    worker_only: body.worker_only ?? null,
    execution_policy_conflict: body.execution_policy_conflict ?? null,
    deterministic_git_operation: body.deterministic_git_operation ?? null,
    codex_called: body.codex_called ?? null,
    deploy_status: body.deploy_status ?? null,
    verification_only: body.verification_only ?? null,
    allow_no_change_success: body.allow_no_change_success ?? null,
    code_changes_required: body.code_changes_required ?? null,
    codex_required: body.codex_required ?? null,
    git_commit_required: body.git_commit_required ?? null,
    git_push_required: body.git_push_required ?? null,
    approval_required: body.approval_required ?? null,
    failure_code: body.failure_code ?? null,
    failure_stage: body.failure_stage ?? null,
    failure_detail: body.failure_detail ?? null,
    terminal_state_persisted: body.terminal_state_persisted ?? null,
    post_completion_state_applied: body.post_completion_state_applied ?? null,
    final_report_source: body.final_report_source ?? body.post_completion_source ?? null,
    next_stage_allowed: body.next_stage_allowed ?? null,
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

function readNullableBooleanFlag(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  const normalized = String(value ?? "").trim();
  if (/^(true|1|yes|on)$/i.test(normalized)) return true;
  if (/^(false|0|no|off)$/i.test(normalized)) return false;
  return null;
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
    readBooleanFlag(body.git_push) ||
    readBooleanFlag(body.worker_git_push) ||
    readBooleanFlag(body.pushed) ||
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
  const verificationOnly =
    readNullableBooleanFlag(body.verification_only) ??
    readNullableBooleanFlag(payload?.verification_only) ??
    readNullableBooleanFlag(readContextField(text, "verification_only"));
  const allowNoChangeSuccess =
    readNullableBooleanFlag(body.allow_no_change_success) ??
    readNullableBooleanFlag(payload?.allow_no_change_success) ??
    readNullableBooleanFlag(readContextField(text, "allow_no_change_success"));
  const codeChangesRequired =
    readNullableBooleanFlag(body.code_changes_required) ??
    readNullableBooleanFlag(payload?.code_changes_required) ??
    readNullableBooleanFlag(readContextField(text, "code_changes_required"));
  const codexRequired =
    readNullableBooleanFlag(body.codex_required) ??
    readNullableBooleanFlag(payload?.codex_required) ??
    readNullableBooleanFlag(readContextField(text, "codex_required"));
  const gitCommitRequired =
    readNullableBooleanFlag(body.git_commit_required) ??
    readNullableBooleanFlag(payload?.git_commit_required) ??
    readNullableBooleanFlag(readContextField(text, "git_commit_required"));
  const gitPushRequired =
    readNullableBooleanFlag(body.git_push_required) ??
    readNullableBooleanFlag(payload?.git_push_required) ??
    readNullableBooleanFlag(readContextField(text, "git_push_required"));
  const deterministicGitOperation =
    readNullableBooleanFlag(body.deterministic_git_operation) ??
    readNullableBooleanFlag(payload?.deterministic_git_operation) ??
    readNullableBooleanFlag(readContextField(text, "deterministic_git_operation"));
  const codexCalled = readNullableBooleanFlag(body.codex_called);
  const approvedBatch = readString(payload?.approved_batch) ?? readContextField(text, "approved_batch");
  const workerBatch = body.batch_code ?? readContextField(text, "batch_code");
  const exactAllowedScope =
    normalizePathList(payload?.exact_allowed_scope).length > 0
      ? normalizePathList(payload?.exact_allowed_scope)
      : normalizePathList(readContextField(text, "exact_allowed_scope"));
  const changedFiles = normalizePathList(body.files_changed);
  const verificationOnlyNoChangeSuccess =
    verificationOnly === true &&
    allowNoChangeSuccess === true &&
    codeChangesRequired === false &&
    codexRequired === false &&
    gitCommitRequired === false &&
    gitPushRequired === false &&
    changedFiles.length === 0;
  const deterministicGitSuccess =
    deterministicGitOperation === true &&
    codeChangesRequired === false &&
    codexRequired === false &&
    gitCommitRequired === false &&
    gitPushRequired === true &&
    codexCalled === false &&
    readNullableBooleanFlag(body.remote_contains_commit) === true &&
    readNullableBooleanFlag(body.repository_clean_after_push) === true &&
    changedFiles.length === 0;
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
  if (writeAllowed && !deterministicGitSuccess && exactAllowedScope.length === 0) {
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
    if (verificationOnlyNoChangeSuccess || deterministicGitSuccess) {
      return null;
    }

    return {
      failureCode: "NO_FIX_APPLIED",
      failureStage: "task_goal_validation",
      errorText: "NO_FIX_APPLIED: write_allowed smoke completed with changed_files=[].",
    };
  }
  if (writeAllowed && (!body.git_commit_sha || !reportPushed(body))) {
    if (verificationOnlyNoChangeSuccess || deterministicGitSuccess) {
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

function buildWorkerReportSchemaInvalidPayload(
  validation: ReturnType<typeof validateCanonicalWorkerReportSchema>
) {
  return {
    ok: false,
    error: "worker_report_schema_invalid",
    failure_code: "WORKER_REPORT_SCHEMA_INVALID",
    failure_stage: "worker_report_validation",
    missing_fields: validation.missing_fields,
    invalid_fields: validation.invalid_fields,
    received_schema_version: validation.received_schema_version,
    supported_schema_versions: validation.supported_schema_versions,
    worker_report_schema_fallback_exhausted: false,
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

  const suppliedSchemaVersion = body.report_schema_version ?? null;
  if (suppliedSchemaVersion !== null && suppliedSchemaVersion !== undefined) {
    const schemaValidation = validateCanonicalWorkerReportSchema(body as Record<string, unknown>);
    if (!schemaValidation.ok) {
      return NextResponse.json(buildWorkerReportSchemaInvalidPayload(schemaValidation), { status: 400 });
    }
  }

  const supabase = await getWorkerSupabase();
  if (responseFromMaybe(supabase)) return supabase;

  const workerStatus = normalizeWorkerStatus(body.status);
  const terminal = isTerminalWorkerStatus(workerStatus);
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

  const canonicalPersistenceJob = isCanonicalPersistenceJob(existingJob);
  if (!canonicalPersistenceJob) {
    const ownershipError = assertWorkerOwnsJob(existingJob, workerId);
    if (ownershipError) return ownershipError;

    const attemptError = assertWorkerAttemptMatchesJob(existingJob, attemptId);
    if (attemptError) return attemptError;
  }

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
    filesChanged: body.files_changed ?? body.changed_files,
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
  const canonicalReport = buildCanonicalWorkerReportSchema({
    job: existingJob,
    body: body as Record<string, unknown>,
    finalResult: projectDirectorReport.data,
    workerId,
    attemptId,
  });
  const reportFields = {
    status: terminal ? storedStatus : workerStatus,
    claimed_by: terminal ? null : workerId,
    attempt_id: terminal ? null : attemptId,
    active_attempt_id: terminal ? null : attemptId,
    progress_percent: progressPercent,
    current_step:
      body.current_step ??
      (storedStatus === "succeeded" ? "completed" : storedStatus === "failed" ? "failed" : null),
    status_message: terminal ? projectDirectorReport.text : body.status_message ?? null,
    git_commit_sha: body.git_commit_sha ?? null,
    error_text: storedStatus === "failed" ? falsePositiveGuard?.errorText ?? errorText : null,
    result: {
      ...buildResult({ ...body, attempt_id: attemptId ?? body.attempt_id }),
      canonical_worker_report: canonicalReport,
      report_schema_version: CANONICAL_WORKER_REPORT_SCHEMA_VERSION,
      project_director_report: projectDirectorReport.data,
      project_director_report_text: projectDirectorReport.text,
      diagnostics: projectDirectorReport.data.diagnostics ?? null,
    },
    completed_at: terminal ? now : null,
    updated_at: now,
  };
  if (canonicalPersistenceJob) {
    if (!canonicalPersistenceRuntimeEnabled()) {
      return NextResponse.json(
        { ok: false, failure_code: "CANONICAL_PERSISTENCE_RUNTIME_DISABLED" },
        { status: 409 }
      );
    }
    const expectedRevision = body.expected_revision ?? body.canonical_revision;
    if (!terminal) {
      return NextResponse.json(
        { ok: false, failure_code: "CANONICAL_NONTERMINAL_REPORT_UNSUPPORTED" },
        { status: 400 }
      );
    }
    if (!attemptId || !body.lease_id || !Number.isSafeInteger(expectedRevision)) {
      return NextResponse.json(
        { ok: false, failure_code: "CANONICAL_PROTOCOL_IDENTITY_REQUIRED" },
        { status: 400 }
      );
    }
    try {
      const finalization = await finalizeCanonicalPersistenceJobSafely(supabase, {
        job_id: jobId,
        worker_id: workerId,
        attempt_id: attemptId,
        lease_id: body.lease_id,
        expected_revision: expectedRevision as number,
        report_identity: `${jobId}:${attemptId}:${body.report_schema_version ?? CANONICAL_WORKER_REPORT_SCHEMA_VERSION}:${effectiveFinalStatus}`,
        worker_execution_status: readString(projectDirectorReport.data.worker_execution_status),
        task_goal_status: readString(projectDirectorReport.data.task_goal_status),
        effective_final_status: readString(projectDirectorReport.data.effective_final_status),
        failure_code: readString(projectDirectorReport.data.failure_code),
        failure_stage: readString(projectDirectorReport.data.failure_stage),
        report_fields: reportFields,
        now,
      });
      const planId = readString(existingJob.plan_id) ?? readString(readRecord(existingJob.payload)?.plan_id);
      const canonicalPlanReport = planId
        ? await buildCanonicalPlanFinalReportProjection(supabase, planId)
        : null;
      const visibleReport = canonicalPlanReport
        ? { text: canonicalPlanReport.summary, data: canonicalPlanReport }
        : projectDirectorReport;
      const recordId = getBitableRecordId(body, existingJob);
      await syncWorkerStatusToFeishu({
        recordId,
        status: storedStatus === "cancelled" ? "failed" : storedStatus,
        stage: storedStatus === "failed" ? "failed" : "completed",
        progressPercent: 100,
        currentStep: storedStatus === "succeeded" ? "completed" : "failed",
        statusMessage: visibleReport.text,
        gitCommitSha: body.git_commit_sha ?? null,
        errorText: storedStatus === "failed" ? visibleReport.text : "",
        completedAt: now,
        updatedAt: now,
      });
      return NextResponse.json({
        ok: true,
        job: finalization.job,
        attempt_id: attemptId,
        lease_id: body.lease_id,
        canonical_revision: finalization.revision,
        project_director_report: visibleReport,
        hermes_plan_aggregated: Boolean(canonicalPlanReport),
        idempotent: finalization.idempotent,
        duplicate_report_idempotent: finalization.idempotent,
        terminal_status_persisted: true,
        canonical_report_schema_version: CANONICAL_WORKER_REPORT_SCHEMA_VERSION,
        feishu_sync: recordId ? "attempted" : "skipped_no_record_id",
      });
    } catch (errorValue) {
      return NextResponse.json(
        {
          ok: false,
          error: errorValue instanceof Error ? errorValue.message : String(errorValue),
          failure_code: "CANONICAL_TERMINAL_REPORT_REJECTED",
          failure_stage: "canonical_terminal_report",
        },
        { status: 409 }
      );
    }
  }
  const terminalFinalization = terminal
    ? await finalizeCanonicalJobReportSafely(supabase, {
        job_id: jobId,
        worker_id: workerId,
        attempt_id: attemptId ?? "",
        report_identity: `${jobId}:${attemptId ?? "missing"}:${body.report_schema_version ?? CANONICAL_WORKER_REPORT_SCHEMA_VERSION}:${effectiveFinalStatus}`,
        worker_execution_status: readString(projectDirectorReport.data.worker_execution_status),
        task_goal_status: readString(projectDirectorReport.data.task_goal_status),
        effective_final_status: readString(projectDirectorReport.data.effective_final_status),
        report_fields: reportFields,
        now,
      })
    : null;

  if (terminalFinalization && !terminalFinalization.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: terminalFinalization.conflict
          ? "terminal_report_conflict"
          : "job_finalization_rejected",
        failure_code: terminalFinalization.failure_code,
        failure_stage: terminalFinalization.failure_stage,
        terminal_immutable: terminalFinalization.terminal_immutable,
        status_unchanged: true,
        duplicate_report_detected: terminalFinalization.conflict,
      },
      { status: 409 }
    );
  }

  const existingTerminalStatus = getCanonicalTerminalWorkerJobStatus(existingJob);
  if (existingTerminalStatus || terminalFinalization?.idempotent) {
    const terminalJob = terminalFinalization?.job ?? existingJob;
    const terminalStatus = getCanonicalTerminalWorkerJobStatus(terminalJob) ?? existingTerminalStatus;
    if (!terminalAttemptMatches(terminalJob, attemptId)) {
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
      getStoredProjectDirectorReport(terminalJob) ?? projectDirectorReport;
    const storedResult = readRecord(terminalJob.result);
    const storedTerminalStatus = terminalStatus ?? normalizeWorkerStatus(terminalJob.status);
    const diagnosticsEnrichment = await enrichTerminalDiagnosticsIfMissing({
      supabase,
      jobId,
      existingJob: terminalJob,
      diagnostics: projectDirectorReport.data.diagnostics,
    });

    return NextResponse.json({
      ok: true,
      job: terminalJob,
      attempt_id: attemptId,
      project_director_report: storedProjectDirectorReport,
      idempotent: true,
      duplicate_report_detected: true,
      duplicate_report_idempotent: true,
      second_side_effect_triggered: false,
      diagnostics_enrichment_only: diagnosticsEnrichment.enriched,
      diagnostics_enrichment_reason: diagnosticsEnrichment.reason,
      non_diagnostic_side_effects: 0,
      terminal_runtime_cleanup_applied: false,
      skipped: "terminal_job_report_ignored",
      feishu_sync: "skipped_duplicate_terminal",
      git_commit_sha:
        body.git_commit_sha ??
        (typeof storedResult?.git_commit_sha === "string" ? storedResult.git_commit_sha : null),
      git_push:
        readBooleanFlag(readRecord(storedResult?.project_director_report)?.git_push) ||
        readBooleanFlag(storedResult?.git_push),
      worker_git_push:
        readBooleanFlag(readRecord(storedResult?.project_director_report)?.worker_git_push) ||
        readBooleanFlag(storedResult?.worker_git_push),
      pushed_branch:
        readString(readRecord(storedResult?.project_director_report)?.pushed_branch) ??
        readString(storedResult?.pushed_branch),
      remote_contains_commit:
        readBooleanFlag(readRecord(storedResult?.project_director_report)?.remote_contains_commit) ||
        readBooleanFlag(storedResult?.remote_contains_commit),
      repository_clean_after_push:
        readBooleanFlag(readRecord(storedResult?.project_director_report)?.repository_clean_after_push) ||
        readBooleanFlag(storedResult?.repository_clean_after_push),
      committed_files:
        normalizePathList(readRecord(storedResult?.project_director_report)?.committed_files).length > 0
          ? normalizePathList(readRecord(storedResult?.project_director_report)?.committed_files)
          : normalizePathList(storedResult?.committed_files),
      terminal_status_persisted: true,
      diagnostics_persisted: Boolean(readRecord(storedResult?.diagnostics)),
      status: storedTerminalStatus,
      acknowledged: true,
      canonical_report_schema_version: CANONICAL_WORKER_REPORT_SCHEMA_VERSION,
    });
  }

  const updateResult = terminal
    ? {
        data: terminalFinalization?.job ?? null,
        error: null,
        skippedColumns: [] as string[],
      }
    : await updateHermesJob(supabase, jobId, reportFields);
  const { data, error, skippedColumns } = updateResult;

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
    status: storedStatus === "cancelled" ? "failed" : storedStatus,
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
    canonical_report_schema_version: CANONICAL_WORKER_REPORT_SCHEMA_VERSION,
    canonical_report_submit_verified: terminal ? true : null,
    worker_report_schema_fallback_exhausted: false,
    diagnostics_persisted: terminal ? true : null,
    diagnostics_storage_field: terminal ? DIAGNOSTICS_STORAGE_FIELD : null,
  });
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "worker-report" });
}
