import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseService } from "@/lib/env";

type JobRecord = Record<string, unknown>;

interface SupabaseWriteError {
  message?: string;
  code?: string;
}

const RECORD_ID_KEYS = [
  "bitable_record_id",
  "feishu_record_id",
  "record_id",
  "bitableRecordId",
  "feishuRecordId",
  "recordId",
];

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
