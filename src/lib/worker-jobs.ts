import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseService } from "@/lib/env";

type JobRecord = Record<string, unknown>;

interface SupabaseWriteError {
  message?: string;
  code?: string;
}

interface DuplicateFeishuJob {
  id: string;
  job_id?: string | null;
  request_text?: string | null;
  created_at?: string | null;
}

export interface DuplicateFeishuJobCheckResult {
  duplicate: DuplicateFeishuJob | null;
  normalizedText: string;
  error: SupabaseWriteError | null;
}

const RECORD_ID_KEYS = [
  "bitable_record_id",
  "feishu_record_id",
  "record_id",
  "bitableRecordId",
  "feishuRecordId",
  "recordId",
];

const TERMINAL_WORKER_STATUSES = new Set(["succeeded", "failed"]);
const WORKER_BATCH_CODE_PATTERN = /\bBATCH-(?:P\d+|\d+[A-Z]?)(?:-[A-Z0-9]+)?\b/gi;
const WORKER_BATCH_RELEVANT_LINE_PATTERN =
  /标题|title|修复目标|目标|批准|approved|approval|执行批次|当前批次/i;
const WORKER_BATCH_FORBIDDEN_FRAGMENT_PATTERN = /禁止范围|禁止修改|不得|不允许|forbidden|不执行/i;
const WORKER_BATCH_FORBIDDEN_SECTION_HEADING_PATTERN =
  /^\s*(?:[-*#>\d.、\s]*)?(?:【)?(?:禁止范围|禁止修改|forbidden)(?:】)?\s*[:：]?\s*$/i;
const WORKER_BATCH_FORBIDDEN_SECTION_EXIT_PATTERN =
  /标题|title|修复目标|(^|\s)目标\s*[:：]|批准|approved|approval|执行批次|当前执行批次/i;
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function findBatchCodes(text: unknown): string[] {
  const matches = String(text ?? "").match(WORKER_BATCH_CODE_PATTERN) ?? [];
  const seen = new Set<string>();
  const codes: string[] = [];

  for (const match of matches) {
    const key = match.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    codes.push(match);
  }

  return codes;
}

function stripForbiddenBatchFragments(line: string): string {
  return line.split(WORKER_BATCH_FORBIDDEN_FRAGMENT_PATTERN)[0].trim();
}

function extractRelevantBatchTextFromRequest(text: unknown): string {
  const lines = String(text ?? "").split(/\r?\n/);
  const chunks: string[] = [];
  let inForbiddenSection = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line) {
      inForbiddenSection = false;
      continue;
    }

    const isRelevantLine =
      (index === 0 && /^新需求[:：]/.test(line)) ||
      WORKER_BATCH_RELEVANT_LINE_PATTERN.test(line);

    if (WORKER_BATCH_FORBIDDEN_SECTION_HEADING_PATTERN.test(line) && !isRelevantLine) {
      inForbiddenSection = true;
      continue;
    }

    if (inForbiddenSection) {
      if (!WORKER_BATCH_FORBIDDEN_SECTION_EXIT_PATTERN.test(line)) {
        continue;
      }
      inForbiddenSection = false;
    }

    if (isRelevantLine) {
      inForbiddenSection = false;
      const cleanedLine = stripForbiddenBatchFragments(line);
      if (cleanedLine) {
        chunks.push(cleanedLine);
      }
    }
  }

  return chunks.join("\n");
}

export function extractCurrentExecutionBatchCode(
  job: JobRecord | null | undefined
): string | null {
  const titleCodes = findBatchCodes(job?.title);
  if (titleCodes.length > 0) return titleCodes[0];

  const requestText = [
    readString(job?.request_text),
    readString(job?.prompt),
    readString(job?.description),
  ]
    .filter(Boolean)
    .join("\n");
  const requestCodes = findBatchCodes(extractRelevantBatchTextFromRequest(requestText));
  return requestCodes[0] ?? null;
}

function classifyWorkerTaskDomain(text: unknown): string {
  const value = String(text ?? "");

  if (/文档整理|整理文档|归档|governance[_ -]?docs/i.test(value)) return "governance_docs";
  if (/Worker|Codex|Hermes|飞书|项目总管|总管|自动化|路由|上报|NO_FIX_APPLIED|git_commit_sha|attempt_id|automation[_ -]?system/i.test(value)) {
    return "automation_system";
  }
  if (/测试审核|测试|审核|验收|复测|qa[_ -]?review|QA review|test review/i.test(value)) return "qa_review";
  if (/运营|运维|发布|部署|上线|监控|operations?|ops|release|deploy/i.test(value)) return "operations";

  return "general";
}

function isSafePostgrestFilterValue(value: string): boolean {
  return /^[A-Za-z0-9._:@-]+$/.test(value);
}

export function getWorkerIdFromRequest(req: NextRequest): string {
  return (
    readString(req.headers.get("x-worker-id")) ??
    readString(req.headers.get("x-worker-name")) ??
    readString(req.nextUrl.searchParams.get("worker_id")) ??
    readString(req.nextUrl.searchParams.get("worker_name")) ??
    "unknown-worker"
  );
}

export function getWorkerIdFromBody(body: {
  worker_id?: unknown;
  worker_name?: unknown;
  workerId?: unknown;
  workerName?: unknown;
}): string {
  return (
    readString(body.worker_id) ??
    readString(body.worker_name) ??
    readString(body.workerId) ??
    readString(body.workerName) ??
    "unknown-worker"
  );
}

export function getAttemptIdFromBody(body: {
  attempt_id?: unknown;
  attemptId?: unknown;
}): string | null {
  return readString(body.attempt_id) ?? readString(body.attemptId);
}

export function getBatchCodeFromBody(body: {
  batch_code?: unknown;
  batchCode?: unknown;
  dispatch_batch?: unknown;
  task_code?: unknown;
}): string | null {
  return (
    readString(body.batch_code) ??
    readString(body.batchCode) ??
    readString(body.dispatch_batch) ??
    readString(body.task_code)
  );
}

export function getCreatedAtFromBody(body: {
  created_at?: unknown;
  createdAt?: unknown;
  job_created_at?: unknown;
  jobCreatedAt?: unknown;
}): string | null {
  return (
    readString(body.job_created_at) ??
    readString(body.jobCreatedAt) ??
    readString(body.created_at) ??
    readString(body.createdAt)
  );
}

export function buildRunningJobNotFoundPayload(input: {
  jobId: string;
  attemptId: string | null;
  batchCode?: string | null;
  createdAt?: string | null;
  workerId?: string | null;
  endpoint: string;
}): Record<string, unknown> {
  return {
    ok: false,
    error: "running_job_not_found",
    endpoint: input.endpoint,
    job_id: input.jobId,
    batch_code: input.batchCode ?? "not_provided",
    attempt_id: input.attemptId ?? "not_provided",
    created_at: input.createdAt ?? "not_provided",
    worker_id: input.workerId ?? "not_provided",
    message:
      "Worker reported a job id that does not exist in hermes_jobs. Check stale Worker state, duplicate attempts, and whether the final report used the claimed job id.",
  };
}

export function createWorkerAttemptId(jobId: string, workerId: string, now = Date.now()): string {
  const safeJob = jobId.replace(/[^A-Za-z0-9._:-]/g, "_");
  const safeWorker = workerId.replace(/[^A-Za-z0-9._:-]/g, "_");
  return `${safeJob}:${safeWorker}:${now.toString(36)}`;
}

export function getClaimedBy(job: JobRecord | null | undefined): string | null {
  if (!job) return null;
  return readString(job.claimed_by);
}

export function getActiveAttemptId(job: JobRecord | null | undefined): string | null {
  if (!job) return null;
  const payload = readRecord(job.payload);
  const result = readRecord(job.result);
  const activeAttempt = readRecord(payload?.active_attempt);

  return (
    readString(job.active_attempt_id) ??
    readString(job.attempt_id) ??
    readString(activeAttempt?.attempt_id) ??
    readString(payload?.attempt_id) ??
    readString(result?.attempt_id)
  );
}

function readLineValue(content: string, key: string): string | null {
  const line = content.split(/\r?\n/).find((item) => item.startsWith(`${key}: `));
  return line ? line.slice(key.length + 2).trim() || null : null;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function placeholder(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : "未提供";
}

function sanitizeReportText(value: unknown): string {
  return String(value ?? "")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[redacted]")
    .replace(/\b(sb_secret|service_role|app_secret|tenant_access_token|access_token|refresh_token|api_key|password)\b\s*[:=]\s*['"]?[^'"\s,}]+/gi, "$1=[redacted]")
    .replace(/\b(WORKER_TOKEN|WORKER_API_TOKEN|HERMES_WORKER_TOKEN|FEISHU_APP_SECRET|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_JWT_SECRET)\b\s*[:=]\s*['"]?[^'"\s,}]+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 40)}\n...[已截断，保留关键字段]`;
}

function readDiagnosticLine(content: string, label: string): string | null {
  const line = content
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith(`${label}：`) || item.trim().startsWith(`${label}:`));

  if (!line) return null;
  return line.replace(new RegExp(`^\\s*${label}[：:]\\s*`), "").trim() || null;
}

function isActionableEngineeringFailure(errorText: string): boolean {
  return /pathspec|git add|git commit|git push|typescript|tsc|eslint|lint|build|permission|access denied|eacces/i.test(
    errorText
  );
}

function buildFailureNextStep(errorText: string): string {
  const explicitSuggestion = readDiagnosticLine(errorText, "建议修复动作");
  const explicitApproval = readDiagnosticLine(errorText, "是否建议老板回复“总管 批准修复”");

  if (explicitSuggestion) {
    return explicitApproval === "是"
      ? `${explicitSuggestion}\n建议老板回复：“总管 批准修复”。`
      : explicitSuggestion;
  }

  if (isActionableEngineeringFailure(errorText)) {
    return "这是可修复工程错误。项目总管应基于失败阶段和关键错误生成最小范围修复建议；如不涉及越权操作，建议老板回复：“总管 批准修复”。";
  }

  return "需要老板查看失败原因后决定是否重试、扩大修改范围或调整需求。";
}

function listLines(items: string[], emptyText: string, maxItems = 40): string[] {
  if (!items.length) return [`- ${emptyText}`];
  const visibleItems = items.slice(0, maxItems).map((item) => `- ${sanitizeReportText(item)}`);
  if (items.length > maxItems) {
    visibleItems.push(`- ...已截断 ${items.length - maxItems} 项`);
  }
  return visibleItems;
}

function numberedLines(items: string[], emptyText: string, maxItems = 5): string[] {
  if (!items.length) return [`1. ${emptyText}`];
  const visibleItems = items.slice(0, maxItems).map((item, index) => `${index + 1}. ${sanitizeReportText(item)}`);
  if (items.length > maxItems) {
    visibleItems.push(`${maxItems + 1}. ...已截断 ${items.length - maxItems} 项`);
  }
  return visibleItems;
}

function pathMatchesAny(path: string, prefixes: string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix));
}

function hasEnvChange(filesChanged: string[]): boolean {
  return filesChanged.some((file) => {
    const normalized = file.replace(/\\/g, "/");
    return /(^|\/)\.env(\.|$)/.test(normalized) || normalized.endsWith(".env");
  });
}

function buildSafetyBoundary(filesChanged: string[], deployStatus?: string | null): string[] {
  const businessPageChanged = filesChanged.some((file) =>
    pathMatchesAny(file, ["src/app/page.tsx", "src/app/partners", "src/app/post"])
  );
  const databaseChanged = filesChanged.some((file) =>
    pathMatchesAny(file, ["docs/setup-supabase.sql", "docs/setup-hermes-jobs.sql", "docs/setup-hermes-v2-schema.sql", "supabase"])
  );

  return [
    `是否修改业务页面：首页//partners//post：${businessPageChanged ? "是" : "否"}`,
    `是否修改数据库：${databaseChanged ? "是" : "否"}`,
    `是否修改 .env：${hasEnvChange(filesChanged) ? "是" : "否"}`,
    `是否部署：${deployStatus ? deployStatus : "否"}`,
    "是否启动 dev server：否",
  ];
}

function extractCompletionItems(summary: string): string[] {
  return summary
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 5);
}

export function getProjectDirectorJobCorrelation(job: JobRecord | null | undefined): {
  boss_request_id: string | null;
  plan_id: string | null;
  task_key: string | null;
  original_demand: string | null;
} {
  const payload = readRecord(job?.payload);
  const requestText = readString(job?.request_text) ?? readString(job?.prompt) ?? "";

  return {
    boss_request_id:
      readString(payload?.boss_request_id) ?? readLineValue(requestText, "boss_request_id"),
    plan_id:
      readString(payload?.plan_id) ??
      readString(payload?.task_tree_id) ??
      readLineValue(requestText, "plan_id"),
    task_key:
      readString(payload?.task_key) ??
      readString(job?.task_code) ??
      readLineValue(requestText, "task_key"),
    original_demand:
      readString(payload?.original_demand) ?? readLineValue(requestText, "original_demand"),
  };
}

function getJobBatchCode(job: JobRecord | null | undefined): string | null {
  return extractCurrentExecutionBatchCode(job);
}

export function buildProjectDirectorWorkerReport(input: {
  job: JobRecord | null;
  workerId: string;
  attemptId: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  projectName?: string | null;
  projectDir?: string | null;
  resultText?: string | null;
  output?: string | null;
  filesChanged?: unknown;
  validationResults?: unknown;
  gitCommitSha?: string | null;
  githubPushStatus?: string | null;
  deployStatus?: string | null;
  buildPassed?: boolean | null;
  testPassed?: boolean | null;
  errorText?: string | null;
}): { text: string; data: Record<string, unknown> } {
  const correlation = getProjectDirectorJobCorrelation(input.job);
  const batchCode = getJobBatchCode(input.job);
  const submittedFilesChanged = readStringArray(input.filesChanged);
  const filesChanged =
    submittedFilesChanged.length > 0
      ? submittedFilesChanged
      : readStringArray(readRecord(input.job?.result)?.files_changed);
  const submittedValidationResults = readStringArray(input.validationResults);
  const validation = [
    ...(submittedValidationResults.length > 0 ? submittedValidationResults : []),
    `build=${input.buildPassed === undefined || input.buildPassed === null ? "未提供" : input.buildPassed ? "通过" : "失败"}`,
    `test=${input.testPassed === undefined || input.testPassed === null ? "未提供" : input.testPassed ? "通过" : "失败"}`,
  ];
  const needsBossConfirmation = input.status === "succeeded";
  const summary =
    input.resultText?.trim() ||
    input.output?.trim() ||
    (input.status === "failed" ? input.errorText?.trim() : "") ||
    "未提供";
  const demand =
    correlation.original_demand ??
    readString(input.job?.request_text) ??
    readString(input.job?.prompt) ??
    null;
  const taskDomain = classifyWorkerTaskDomain(
    [demand, readString(input.job?.title), readString(input.job?.job_type)].filter(Boolean).join("\n")
  );
  const jobId = readString(input.job?.id) ?? readString(input.job?.job_id);
  const statusTitle =
    input.status === "succeeded"
      ? "✅ Codex 任务执行成功"
      : input.status === "failed"
        ? "❌ Codex 任务执行失败"
        : `Codex 任务状态：${input.status}`;
  const gitCommitSha = input.gitCommitSha ?? readString(input.job?.git_commit_sha);
  const githubPushStatus = input.githubPushStatus ?? "未提供";
  const completionItems = input.status === "failed" ? [] : extractCompletionItems(summary);
  const safetyBoundary = buildSafetyBoundary(filesChanged, input.deployStatus);
  const sanitizedError = input.errorText ? sanitizeReportText(input.errorText) : "";
  const failureStage = input.status === "failed"
    ? readDiagnosticLine(sanitizedError, "失败阶段") ?? "未提供"
    : null;
  const keyError = input.status === "failed"
    ? readDiagnosticLine(sanitizedError, "关键错误") ?? truncateText(sanitizedError, 500)
    : null;
  const failureSuggestion = input.status === "failed"
    ? buildFailureNextStep(sanitizedError)
    : null;
  const workerExecutionStatus =
    input.status === "failed" && /NO_FIX_APPLIED/i.test(sanitizedError)
      ? "succeeded_until_task_goal_validation"
      : input.status === "failed"
        ? "failed"
        : input.status === "succeeded"
          ? "succeeded"
          : input.status;
  const taskGoalStatus =
    input.status === "succeeded"
      ? "completed"
      : /NO_FIX_APPLIED/i.test(sanitizedError)
        ? "failed_no_fix_applied"
        : input.status === "failed"
          ? "failed"
          : "running";

  const data = {
    job_id: jobId,
    batch_code: batchCode,
    boss_request_id: correlation.boss_request_id,
    plan_id: correlation.plan_id,
    task_key: correlation.task_key,
    original_demand: demand,
    project_name: input.projectName ?? "同城搭子网站",
    project_dir: input.projectDir ?? "未提供",
    worker_id: input.workerId,
    attempt_id: input.attemptId,
    status: input.status,
    status_title: statusTitle,
    task_domain: taskDomain,
    worker_execution_status: workerExecutionStatus,
    task_goal_status: taskGoalStatus,
    what_changed: sanitizeReportText(summary),
    files_changed: filesChanged,
    validation_result: validation,
    commit_hash: gitCommitSha ?? null,
    github_push_status: githubPushStatus,
    safety_boundary: safetyBoundary,
    needs_boss_confirmation: needsBossConfirmation,
    next_step: needsBossConfirmation
      ? "可以进入下一批次；如本批次影响关键链路，请老板验收后再继续。"
      : failureSuggestion ?? "需要老板查看失败原因后决定是否重试、扩大修改范围或调整需求。",
    failure_stage: failureStage,
    key_error: keyError,
    repair_suggestion: failureSuggestion,
    error: sanitizedError || null,
  };

  const requiredHeader = [
    statusTitle,
    `任务编号：${placeholder(jobId)}`,
    `job_id：${placeholder(jobId)}`,
    `实际执行批次：${placeholder(batchCode)}`,
    `attempt_id：${placeholder(input.attemptId)}`,
    `需求：${placeholder(truncateText(sanitizeReportText(demand), 800))}`,
    `项目名称：${placeholder(input.projectName ?? "同城搭子网站")}`,
    `项目目录：${placeholder(input.projectDir)}`,
    `任务分类：${taskDomain}`,
    `Worker 执行状态：${workerExecutionStatus}`,
    `任务目标状态：${taskGoalStatus}`,
    "",
    "本阶段性质：",
    batchCode
      ? `${taskDomain} ${batchCode}：Worker/Codex 任务执行结果`
      : `${taskDomain}：Worker/Codex 任务执行结果`,
    "",
    "执行结果摘要：",
    truncateText(sanitizeReportText(summary), 1200),
    input.status === "failed" ? `失败阶段：${failureStage}` : "",
    input.status === "failed" ? `关键错误：${keyError || "未提供"}` : "",
    "",
    "修改文件：",
    ...listLines(filesChanged, "未提供"),
    "",
    "完成内容：",
    ...numberedLines(completionItems, input.status === "failed" ? "任务失败，未生成完成内容" : "未提供"),
    "",
    "验证结果：",
    ...listLines(validation, "未提供"),
    "",
    "安全边界：",
    ...listLines(safetyBoundary, "未提供"),
    "",
    "Git 自动备份：",
    `commit SHA：${gitCommitSha || "未生成"}`,
    `GitHub 推送状态：${placeholder(githubPushStatus)}`,
    "",
    "下一步建议：",
    data.next_step,
  ];

  const text = requiredHeader.join("\n");

  return { text, data };
}

export function buildAttemptPayload(
  job: JobRecord | null | undefined,
  attempt: {
    attempt_id: string;
    job_id: string;
    worker_id: string;
    status: string;
    started_at?: string;
    heartbeat_at?: string;
    updated_at: string;
  }
): Record<string, unknown> {
  const payload = readRecord(job?.payload) ?? {};
  return {
    ...payload,
    attempt_id: attempt.attempt_id,
    active_attempt: {
      ...(readRecord(payload.active_attempt) ?? {}),
      ...attempt,
    },
  };
}

export function isTerminalWorkerStatus(value: unknown): boolean {
  return TERMINAL_WORKER_STATUSES.has(String(value || ""));
}

export function assertWorkerOwnsJob(
  job: JobRecord | null,
  workerId: string
): NextResponse | null {
  const claimedBy = getClaimedBy(job);
  if (!claimedBy || claimedBy === workerId) return null;

  return NextResponse.json(
    {
      ok: false,
      error: "worker does not own this job",
      claimed_by: claimedBy,
      worker_id: workerId,
    },
    { status: 409 }
  );
}

export function assertWorkerAttemptMatchesJob(
  job: JobRecord | null,
  attemptId: string | null
): NextResponse | null {
  const activeAttemptId = getActiveAttemptId(job);
  if (!activeAttemptId) return null;
  if (attemptId === activeAttemptId) return null;

  return NextResponse.json(
    {
      ok: false,
      error: attemptId
        ? "attempt_id does not match active job attempt"
        : "attempt_id is required for active job attempt",
      active_attempt_id: activeAttemptId,
      attempt_id: attemptId,
    },
    { status: 409 }
  );
}

export function assertWorkerAuthorized(req: NextRequest): NextResponse | null {
  const expected =
    process.env.WORKER_TOKEN?.trim() ??
    process.env.WORKER_API_TOKEN?.trim() ??
    process.env.HERMES_WORKER_TOKEN?.trim() ??
    "";
  if (!expected) return null;

  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function getWorkerSupabase(): Promise<SupabaseClient | NextResponse> {
  const supabase = await getSupabaseService();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "service client not available" }, { status: 500 });
  }
  return supabase;
}

export async function parseJsonBody<T>(req: NextRequest): Promise<T | NextResponse> {
  const rawText = new TextDecoder("utf-8", { fatal: false }).decode(await req.arrayBuffer());
  try {
    return JSON.parse(rawText) as T;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
}

export function responseFromMaybe<T>(value: T | NextResponse): value is NextResponse {
  return value instanceof NextResponse;
}

export function normalizeFeishuTaskText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

async function findDuplicateByRequestText(
  supabase: SupabaseClient,
  requestText: string,
  createdAfter: string
): Promise<{ data: DuplicateFeishuJob | null; error: SupabaseWriteError | null }> {
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("id, job_id, request_text, created_at")
    .eq("source", "feishu")
    .in("status", ["queued", "running"])
    .eq("request_text", requestText)
    .gte("created_at", createdAfter)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return { data: (data as DuplicateFeishuJob | null) ?? null, error };
}

export async function findRecentDuplicateFeishuJob(
  supabase: SupabaseClient,
  rawText: string,
  now = Date.now()
): Promise<DuplicateFeishuJobCheckResult> {
  const normalizedText = normalizeFeishuTaskText(rawText);
  if (!normalizedText) return { duplicate: null, normalizedText, error: null };

  const createdAfter = new Date(now - 30 * 60 * 1000).toISOString();
  const candidates = [normalizedText];
  if (rawText !== normalizedText) candidates.push(rawText);

  for (const candidate of candidates) {
    const { data, error } = await findDuplicateByRequestText(supabase, candidate, createdAfter);
    if (error) return { duplicate: null, normalizedText, error };
    if (data) return { duplicate: data, normalizedText, error: null };
  }

  return { duplicate: null, normalizedText, error: null };
}

function isMissingColumnError(error: SupabaseWriteError | null): boolean {
  const message = error?.message ?? "";
  return error?.code === "PGRST204" || /column .* does not exist/i.test(message);
}

function extractMissingColumn(error: SupabaseWriteError | null): string | null {
  const message = error?.message ?? "";
  const quoted = message.match(/'([^']+)' column/);
  if (quoted) return quoted[1];
  const plain = message.match(/column "([^"]+)"/i);
  return plain ? plain[1] : null;
}

export async function updateHermesJob(
  supabase: SupabaseClient,
  jobId: string,
  fields: JobRecord
): Promise<{ data: JobRecord | null; error: SupabaseWriteError | null; skippedColumns: string[] }> {
  let pendingFields = { ...fields };
  const skippedColumns: string[] = [];

  for (let attempt = 0; attempt < 8; attempt++) {
    const { data, error } = await supabase
      .from("hermes_jobs")
      .update(pendingFields)
      .eq("id", jobId)
      .select("*")
      .maybeSingle();

    if (!error) return { data: (data as JobRecord | null) ?? null, error: null, skippedColumns };
    if (!isMissingColumnError(error)) return { data: null, error, skippedColumns };

    const missingColumn = extractMissingColumn(error);
    if (!missingColumn || !(missingColumn in pendingFields)) {
      return { data: null, error, skippedColumns };
    }
    skippedColumns.push(missingColumn);
    const rest = { ...pendingFields };
    delete rest[missingColumn];
    pendingFields = rest;
  }

  return {
    data: null,
    error: { message: "too many missing columns while updating hermes_jobs" },
    skippedColumns,
  };
}

export async function claimHermesJob(
  supabase: SupabaseClient,
  jobId: string,
  workerId: string,
  fields: JobRecord
): Promise<{ data: JobRecord | null; error: SupabaseWriteError | null; skippedColumns: string[] }> {
  const claimedFields = { ...fields };
  const skippedColumns: string[] = [];

  for (let attempt = 0; attempt < 8; attempt++) {
    let query = supabase
      .from("hermes_jobs")
      .update(claimedFields)
      .eq("id", jobId)
      .in("status", ["queued", "pending"]);

    query = isSafePostgrestFilterValue(workerId)
      ? query.or(`claimed_by.is.null,claimed_by.eq.${workerId}`)
      : query.is("claimed_by", null);

    const { data, error } = await query.select("*").maybeSingle();

    if (!error) return { data: (data as JobRecord | null) ?? null, error: null, skippedColumns };
    if (!isMissingColumnError(error)) return { data: null, error, skippedColumns };

    const missingColumn = extractMissingColumn(error);
    if (!missingColumn || !(missingColumn in claimedFields)) {
      return { data: null, error, skippedColumns };
    }
    skippedColumns.push(missingColumn);
    delete claimedFields[missingColumn];
  }

  return {
    data: null,
    error: { message: "too many missing columns while claiming hermes_jobs" },
    skippedColumns,
  };
}

export async function findHermesJob(
  supabase: SupabaseClient,
  jobId: string
): Promise<{ data: JobRecord | null; error: SupabaseWriteError | null }> {
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  return { data: (data as JobRecord | null) ?? null, error };
}

function readNestedRecordId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of RECORD_ID_KEYS) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function getBitableRecordId(...sources: unknown[]): string | null {
  for (const source of sources) {
    const direct = readNestedRecordId(source);
    if (direct) return direct;
    if (source && typeof source === "object") {
      const record = source as Record<string, unknown>;
      const payload = readNestedRecordId(record.payload);
      if (payload) return payload;
      const result = readNestedRecordId(record.result);
      if (result) return result;
      const raw = readNestedRecordId(record.raw);
      if (raw) return raw;
    }
  }
  return null;
}

export function normalizeWorkerStatus(value: unknown): "queued" | "running" | "succeeded" | "failed" {
  if (value === "failed" || value === "error") return "failed";
  if (value === "succeeded" || value === "success" || value === "completed") return "succeeded";
  if (value === "queued" || value === "pending") return "queued";
  return "running";
}

export function clampProgress(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}
