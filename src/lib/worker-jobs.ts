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

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export interface WorkerJobClaimDiagnostics {
  jobId: string;
  batchCode: string;
  title: string;
  bossOriginalTextPreview: string;
  createdAt: string;
  attemptId: string;
}

export interface WorkerJobBatchConsistencyResult {
  ok: boolean;
  errorCode: "TASK_BATCH_MISMATCH" | null;
  approvedBatch: string | null;
  jobBatch: string | null;
  message: string;
}

function compactText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeBatchCode(value: unknown): string | null {
  const raw = readString(value);
  if (!raw) return null;
  const match = raw.match(/\bBATCH-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?\b/i);
  return match ? match[0].toUpperCase() : null;
}

function findBatchCodeInText(value: unknown): string | null {
  return normalizeBatchCode(compactText(value));
}

export function getWorkerJobBatchCode(job: JobRecord | null | undefined): string | null {
  const payload = readRecord(job?.payload);

  return (
    normalizeBatchCode(job?.batch_code) ??
    normalizeBatchCode(payload?.batch_code) ??
    normalizeBatchCode(job?.dispatch_batch) ??
    normalizeBatchCode(payload?.dispatch_batch) ??
    normalizeBatchCode(job?.task_code) ??
    findBatchCodeInText(job?.request_text) ??
    findBatchCodeInText(job?.title)
  );
}

export function getWorkerJobTitle(job: JobRecord | null | undefined): string {
  const payload = readRecord(job?.payload);

  return (
    readString(job?.title) ??
    readString(payload?.task_title) ??
    readString(payload?.title) ??
    readString(job?.task_title) ??
    readString(job?.job_id) ??
    "untitled"
  );
}

export function getWorkerJobBossOriginalText(job: JobRecord | null | undefined): string {
  const payload = readRecord(job?.payload);

  return (
    readString(job?.boss_original_text) ??
    readString(job?.bossOriginalText) ??
    readString(payload?.boss_original_text) ??
    readString(payload?.bossOriginalText) ??
    readString(payload?.original_demand) ??
    readString(payload?.raw_message_text) ??
    readString(job?.original_demand) ??
    readString(job?.request_text) ??
    ""
  );
}

export function getExplicitlyApprovedBatchFromText(text: string): string | null {
  const compacted = compactText(text);
  const patterns = [
    /(?:仅|只)\s*批准\s*(?:的是|为|:|：)?\s*(BATCH-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)/i,
    /(?:仅|只)\s*(?:允许|执行|领取|处理)\s*(?:的是|为|:|：)?\s*(BATCH-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)/i,
    /only\s+(?:approve|approved|allow|execute|run)\s+(BATCH-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = compacted.match(pattern);
    if (match) return normalizeBatchCode(match[1]);
  }

  return null;
}

export function validateWorkerJobBatchConsistency(
  job: JobRecord | null | undefined
): WorkerJobBatchConsistencyResult {
  const bossOriginalText = getWorkerJobBossOriginalText(job);
  const approvedBatch = getExplicitlyApprovedBatchFromText(bossOriginalText);
  const jobBatch = getWorkerJobBatchCode(job);

  if (!approvedBatch) {
    return {
      ok: true,
      errorCode: null,
      approvedBatch: null,
      jobBatch,
      message: "no explicit single-batch approval found",
    };
  }

  if (jobBatch === approvedBatch) {
    return {
      ok: true,
      errorCode: null,
      approvedBatch,
      jobBatch,
      message: "job batch matches boss approval",
    };
  }

  return {
    ok: false,
    errorCode: "TASK_BATCH_MISMATCH",
    approvedBatch,
    jobBatch,
    message: [
      "TASK_BATCH_MISMATCH",
      `approved_batch=${approvedBatch}`,
      `job_batch=${jobBatch ?? "missing"}`,
      `job_id=${readString(job?.id) ?? "missing"}`,
      `title=${getWorkerJobTitle(job)}`,
      `boss_original_text_preview=${compactText(bossOriginalText).slice(0, 200)}`,
    ].join("\n"),
  };
}

export function buildWorkerJobClaimDiagnostics(
  job: JobRecord | null | undefined,
  attemptId: string | null
): WorkerJobClaimDiagnostics {
  return {
    jobId: readString(job?.id) ?? "missing",
    batchCode: getWorkerJobBatchCode(job) ?? "unknown",
    title: getWorkerJobTitle(job),
    bossOriginalTextPreview: compactText(getWorkerJobBossOriginalText(job)).slice(0, 200),
    createdAt: readString(job?.created_at) ?? "unknown",
    attemptId: attemptId ?? "legacy-no-attempt-id",
  };
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
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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

export function buildProjectDirectorWorkerReport(input: {
  job: JobRecord | null;
  workerId: string;
  attemptId: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  resultText?: string | null;
  output?: string | null;
  filesChanged?: string[];
  gitCommitSha?: string | null;
  buildPassed?: boolean | null;
  testPassed?: boolean | null;
  errorText?: string | null;
}): { text: string; data: Record<string, unknown> } {
  const correlation = getProjectDirectorJobCorrelation(input.job);
  const filesChanged =
    input.filesChanged && input.filesChanged.length > 0
      ? input.filesChanged
      : readStringArray(readRecord(input.job?.result)?.files_changed);
  const validation = [
    `build=${input.buildPassed === undefined || input.buildPassed === null ? "unknown" : input.buildPassed ? "passed" : "failed"}`,
    `test=${input.testPassed === undefined || input.testPassed === null ? "unknown" : input.testPassed ? "passed" : "failed"}`,
  ];
  const needsBossConfirmation = input.status === "succeeded";
  const summary =
    input.resultText?.trim() ||
    input.output?.trim() ||
    (input.status === "failed" ? input.errorText?.trim() : "") ||
    "Worker did not provide a detailed result.";

  const data = {
    boss_request_id: correlation.boss_request_id,
    plan_id: correlation.plan_id,
    task_key: correlation.task_key,
    original_demand: correlation.original_demand,
    worker_id: input.workerId,
    attempt_id: input.attemptId,
    status: input.status,
    what_changed: summary,
    files_changed: filesChanged,
    validation_result: validation,
    commit_hash: input.gitCommitSha ?? null,
    needs_boss_confirmation: needsBossConfirmation,
    next_step: needsBossConfirmation
      ? "Boss should review the changed files and validation result, then confirm acceptance or send acceptance feedback."
      : "Project director should inspect the failure reason and decide whether to retry or revise the plan.",
    error: input.errorText ?? null,
  };

  const text = [
    "[Project Director Worker Report]",
    `boss_request_id: ${correlation.boss_request_id ?? "unknown"}`,
    `plan_id: ${correlation.plan_id ?? "unknown"}`,
    `task_key: ${correlation.task_key ?? "unknown"}`,
    `attempt_id: ${input.attemptId ?? "missing"}`,
    `worker_id: ${input.workerId}`,
    `status: ${input.status}`,
    "",
    "What changed:",
    summary,
    "",
    "Changed files:",
    ...(filesChanged.length ? filesChanged.map((file) => `- ${file}`) : ["- none reported"]),
    "",
    "Validation:",
    ...validation.map((item) => `- ${item}`),
    "",
    `Commit hash: ${input.gitCommitSha || "not reported"}`,
    `Needs boss confirmation: ${needsBossConfirmation ? "yes" : "no"}`,
    `Next step: ${data.next_step}`,
  ].join("\n");

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
