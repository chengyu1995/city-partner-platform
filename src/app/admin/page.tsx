/**
 * 简单后台审核 - 列出 pending 状态的搭子
 * URL: /admin
 * 访问: 不做 auth 检查 (MVP 阶段), 实际应加 IP 白名单 / basic auth
 */
import Link from "next/link";
import { PARTNER_CATEGORIES } from "@/types/db";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { ApproveButton } from "./ApproveButton";

export const dynamic = "force-dynamic";
export const runtime = "edge";

interface Props {
  searchParams: Promise<{ status?: string }>;
}

async function sbQuery<T>(path: string): Promise<T> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface Row {
  id: string;
  category: string;
  city: string;
  title: string;
  description: string;
  contact: string;
  host_name: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

export default async function AdminPage({ searchParams }: Props) {
  const params = await searchParams;
  const status = (params.status === "approved" || params.status === "rejected" ? params.status : "pending") as Row["status"];

  let items: Row[] = [];
  let error: string | null = null;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      items = await sbQuery<Row[]>(
        `partner_posts?status=eq.${status}&order=created_at.desc&limit=50&select=*`
      );
    } catch (e) {
      error = String(e);
    }
  } else {
    error = "SUPABASE_SERVICE_ROLE_KEY 未配置";
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-slate-900">🛠 搭子审核后台</h1>
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-700">
            返回首页
          </Link>
        </div>

        {/* 状态切换 */}
        <div className="mb-6 flex gap-2 border-b border-slate-200">
          {(["pending", "approved", "rejected"] as const).map((s) => (
            <Link
              key={s}
              href={`/admin?status=${s}`}
              className={[
                "border-b-2 px-4 py-2 text-sm font-bold transition-colors",
                status === s
                  ? "border-violet-500 text-violet-700"
                  : "border-transparent text-slate-500 hover:text-slate-700",
              ].join(" ")}
            >
              {s === "pending" && "⏳ 待审核"}
              {s === "approved" && "✅ 已通过"}
              {s === "rejected" && "🚫 已拒绝"}
            </Link>
          ))}
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        {items.length === 0 && !error && (
          <div className="rounded-2xl bg-white p-12 text-center shadow-sm">
            <div className="text-5xl">📭</div>
            <p className="mt-4 text-slate-600">
              {status === "pending" ? "没有待审核的搭子" : `没有${status === "approved" ? "已通过" : "已拒绝"}的搭子`}
            </p>
          </div>
        )}

        <div className="space-y-3">
          {items.map((p) => {
            const cat = PARTNER_CATEGORIES.find((c) => c.key === p.category);
            return (
              <div key={p.id} className="rounded-2xl bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span>{cat?.emoji} {p.category}</span>
                      <span>📍 {p.city}</span>
                      <span>🕐 {format(new Date(p.created_at), "MM-dd HH:mm")}</span>
                    </div>
                    <h2 className="mt-1 text-lg font-bold text-slate-900">{p.title}</h2>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{p.description}</p>
                    <div className="mt-3 text-xs text-slate-500">
                      👤 {p.host_name} · {p.contact}
                    </div>
                  </div>
                  {status === "pending" && (
                    <div className="flex flex-col gap-2">
                      <ApproveButton id={p.id} action="approved" />
                      <ApproveButton id={p.id} action="rejected" />
                    </div>
                  )}
                  {status !== "pending" && (
                    <Link
                      href={`/partners/${p.id}`}
                      className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-200"
                    >
                      查看 →
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
