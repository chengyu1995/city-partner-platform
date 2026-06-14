/**
 * POST /api/partners —— 新建搭子需求
 * GET  /api/partners —— 列出搭子需求 (带可选过滤)
 */
import { NextResponse, NextRequest } from "next/server";
import { getSupabaseServer } from "@/lib/env";
import { validatePartnerPostInput } from "@/lib/db/partner-posts";
import type { NewPartnerPost, PartnerCategory } from "@/types/db";

export const dynamic = "force-dynamic";
export const runtime = "edge";

/** 用纯 fetch + TextEncoder (绕开 supabase-js edge runtime UTF-8 bug) */
async function sbJson<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json; charset=utf-8",
  };
  if (method === "POST" || method === "PATCH") headers.Prefer = "return=representation";

  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== undefined ? new TextEncoder().encode(JSON.stringify(body)) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${res.status}: ${txt}`);
  }
  return res.json() as Promise<T>;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const category = url.searchParams.get("category") as PartnerCategory | null;
  const city = url.searchParams.get("city") || undefined;

  const params = new URLSearchParams();
  params.set("select", "*");
  params.set("order", "created_at.desc");
  if (category) params.set("category", `eq.${category}`);
  if (city) params.set("city", `ilike.*${city}*`);

  try {
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const data = await sbJson<unknown[]>("GET", `partner_posts?${params}`);
      return NextResponse.json({ ok: true, items: data });
    }
  } catch (e) {
    console.error("[api/partners] GET error:", e);
  }
  return NextResponse.json({ ok: true, items: [] });
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    let body: Partial<NewPartnerPost>;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
    }

    const fieldErrors = validatePartnerPostInput(body);
    if (Object.keys(fieldErrors).length > 0) {
      return NextResponse.json({ ok: false, fieldErrors }, { status: 400 });
    }

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json(
        { ok: false, error: "Supabase 未配置 (mock 模式不支持 POST)" },
        { status: 503 }
      );
    }

    const data = await sbJson<[{ id: string }]>("POST", "partner_posts", body);
    return NextResponse.json({ ok: true, id: data[0].id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
