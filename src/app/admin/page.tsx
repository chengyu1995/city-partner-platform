/**
 * /admin 页面 - 客户端组件, 避免 3 MiB worker limit
 * 改用 client fetch /api/admin/list
 */
"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ApproveButton } from "./ApproveButton";

interface Post {
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

const TABS = [
  { key: "pending", label: "⏳ 待审核" },
  { key: "approved", label: "✅ 已通过" },
  { key: "rejected", label: "🚫 已拒绝" },
] as const;

type Status = (typeof TABS)[number]["key"];

const CAT_META: Record<string, { emoji: string }> = {
  旅游: { emoji: "✈️" },
  K歌: { emoji: "🎤" },
  学习: { emoji: "📚" },
  摩友: { emoji: "🏍️" },
  钓友: { emoji: "🎣" },
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${m}-${day} ${hh}:${mm}`;
}

function AdminInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const status: Status = (searchParams.get("status") as Status) || "pending";

  const [items, setItems] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/admin/list?status=${status}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setItems(d.items);
        else setError(d.error || "加载失败");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [status]);

  function onChanged() {
    fetch(`/api/admin/list?status=${status}`)
      .then((r) => r.json())
      .then((d) => d.ok && setItems(d.items));
  }

  return (
    <>
      <div className="mb-6 flex gap-2 border-b border-slate-200">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin?status=${t.key}`}
            className={[
              "border-b-2 px-4 py-2 text-sm font-bold transition-colors",
              status === t.key
                ? "border-violet-500 text-violet-700"
                : "border-transparent text-slate-500 hover:text-slate-700",
            ].join(" ")}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading && (
        <div className="rounded-2xl bg-white p-12 text-center shadow-sm">
          <div className="text-3xl">⏳</div>
          <p className="mt-3 text-slate-500">加载中...</p>
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="rounded-2xl bg-white p-12 text-center shadow-sm">
          <div className="text-5xl">📭</div>
          <p className="mt-4 text-slate-600">
            {status === "pending" ? "没有待审核的搭子" : `没有${status === "approved" ? "已通过" : "已拒绝"}的搭子`}
          </p>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="space-y-3">
          {items.map((p) => {
            const cat = CAT_META[p.category] ?? { emoji: "📌" };
            return (
              <div key={p.id} className="rounded-2xl bg-white p-5 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span>{cat.emoji} {p.category}</span>
                      <span>📍 {p.city}</span>
                      <span>🕐 {formatTime(p.created_at)}</span>
                    </div>
                    <h2 className="mt-1 text-lg font-bold text-slate-900">{p.title}</h2>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{p.description}</p>
                    <div className="mt-3 text-xs text-slate-500">
                      👤 {p.host_name} · {p.contact}
                    </div>
                  </div>
                  {status === "pending" ? (
                    <div className="flex flex-col gap-2">
                      <ApproveButton id={p.id} action="approved" onChanged={onChanged} />
                      <ApproveButton id={p.id} action="rejected" onChanged={onChanged} />
                    </div>
                  ) : (
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
      )}
    </>
  );
}

export default function AdminPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-slate-900">🛠 搭子审核后台</h1>
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-700">
            返回首页
          </Link>
        </div>
        <Suspense fallback={
          <div className="rounded-2xl bg-white p-12 text-center shadow-sm">
            <div className="text-3xl">⏳</div>
            <p className="mt-3 text-slate-500">加载中...</p>
          </div>
        }>
          <AdminInner />
        </Suspense>
      </div>
    </div>
  );
}
