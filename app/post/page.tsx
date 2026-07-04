/**
 * 发布搭子需求页面 —— 年轻化 UI
 * 移动端优先 + 大色块分类卡片 + Emoji 图标
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PARTNER_CATEGORIES, type PartnerCategory, type NewPartnerPost, type PartnerPostFormErrors } from "@/types/db";

export default function PostPartnerPage() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [errors, setErrors] = useState<PartnerPostFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [form, setForm] = useState<Partial<NewPartnerPost>>({
    category: undefined,
    city: "",
    title: "",
    description: "",
    contact: "",
    host_name: "",
    starts_at: "",
  });

  function update<K extends keyof NewPartnerPost>(key: K, value: NewPartnerPost[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setErrors({});

    const res = await fetch("/api/partners", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!data.ok) {
      if (data.fieldErrors) setErrors(data.fieldErrors);
      else setSubmitError(data.error || "提交失败");
      return;
    }
    startTransition(() => router.push(`/partners/${data.id}`));
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-amber-50">
      <div className="mx-auto max-w-2xl px-4 py-6 sm:py-12">
        {/* Header */}
        <div className="mb-8 text-center sm:mb-10">
          <div className="inline-flex items-center rounded-full bg-gradient-to-r from-violet-500 to-pink-500 px-4 py-1 text-xs font-medium text-white shadow-md">
            ✨ 同城搭子 · 发布你的需求
          </div>
          <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
            找搭子 · 就现在
          </h1>
          <p className="mt-2 text-sm text-slate-600 sm:text-base">
            填好下面 6 项，几秒钟就能发出你的搭子帖
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-6">
          {/* 1. 分类（卡片大色块） */}
          <div>
            <label className="mb-3 block text-sm font-bold text-slate-800">
              1️⃣ 你想找什么搭子？
            </label>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
              {PARTNER_CATEGORIES.map((c) => {
                const active = form.category === c.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => update("category", c.key)}
                    className={[
                      "group relative flex flex-col items-center justify-center gap-1 rounded-2xl px-3 py-4 text-sm font-bold transition-all",
                      "active:scale-95 hover:-translate-y-0.5",
                      active
                        ? `bg-gradient-to-br ${c.color} text-white shadow-lg ring-2 ring-offset-2 ring-violet-400`
                        : "bg-white text-slate-700 shadow-sm hover:shadow-md ring-1 ring-slate-200",
                    ].join(" ")}
                  >
                    <span className="text-2xl">{c.emoji}</span>
                    <span>{c.key}</span>
                  </button>
                );
              })}
            </div>
            {errors.category && <p className="mt-2 text-xs text-red-600">{errors.category}</p>}
          </div>

          {/* 2. 城市 + 时间 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-bold text-slate-800">2️⃣ 你的城市</label>
              <input
                type="text"
                value={form.city ?? ""}
                onChange={(e) => update("city", e.target.value)}
                placeholder="北京 / 上海 / 杭州..."
                className="w-full rounded-xl border-0 bg-white px-4 py-3 text-base shadow-sm ring-1 ring-slate-200 focus:ring-2 focus:ring-violet-500"
              />
              {errors.city && <p className="mt-1 text-xs text-red-600">{errors.city}</p>}
            </div>
            <div>
              <label className="mb-2 block text-sm font-bold text-slate-800">
                预计见面时间 <span className="text-xs font-normal text-slate-400">(可选)</span>
              </label>
              <input
                type="datetime-local"
                value={form.starts_at ?? ""}
                onChange={(e) => update("starts_at", e.target.value || null)}
                className="w-full rounded-xl border-0 bg-white px-4 py-3 text-base shadow-sm ring-1 ring-slate-200 focus:ring-2 focus:ring-violet-500"
              />
            </div>
          </div>

          {/* 3. 标题 */}
          <div>
            <label className="mb-2 block text-sm font-bold text-slate-800">3️⃣ 标题（让人一眼看懂）</label>
            <input
              type="text"
              value={form.title ?? ""}
              onChange={(e) => update("title", e.target.value)}
              placeholder="例：周末去阿那亚看海"
              maxLength={80}
              className="w-full rounded-xl border-0 bg-white px-4 py-3 text-base shadow-sm ring-1 ring-slate-200 focus:ring-2 focus:ring-violet-500"
            />
            {errors.title && <p className="mt-1 text-xs text-red-600">{errors.title}</p>}
          </div>

          {/* 4. 描述 */}
          <div>
            <label className="mb-2 block text-sm font-bold text-slate-800">4️⃣ 详细描述（让人知道怎么约）</label>
            <textarea
              value={form.description ?? ""}
              onChange={(e) => update("description", e.target.value)}
              placeholder="说清楚：和谁、几个人、什么时间、在哪集合、需要带什么..."
              rows={4}
              maxLength={500}
              className="w-full resize-none rounded-xl border-0 bg-white px-4 py-3 text-base shadow-sm ring-1 ring-slate-200 focus:ring-2 focus:ring-violet-500"
            />
            <p className="mt-1 text-right text-xs text-slate-400">{(form.description ?? "").length} / 500</p>
            {errors.description && <p className="mt-1 text-xs text-red-600">{errors.description}</p>}
          </div>

          {/* 5. 联系方式 + 昵称 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-bold text-slate-800">5️⃣ 联系方式</label>
              <input
                type="text"
                value={form.contact ?? ""}
                onChange={(e) => update("contact", e.target.value)}
                placeholder="微信号 / 手机号 / 飞书..."
                className="w-full rounded-xl border-0 bg-white px-4 py-3 text-base shadow-sm ring-1 ring-slate-200 focus:ring-2 focus:ring-violet-500"
              />
              {errors.contact && <p className="mt-1 text-xs text-red-600">{errors.contact}</p>}
            </div>
            <div>
              <label className="mb-2 block text-sm font-bold text-slate-800">6️⃣ 你的昵称</label>
              <input
                type="text"
                value={form.host_name ?? ""}
                onChange={(e) => update("host_name", e.target.value)}
                placeholder="让大家怎么称呼你"
                className="w-full rounded-xl border-0 bg-white px-4 py-3 text-base shadow-sm ring-1 ring-slate-200 focus:ring-2 focus:ring-violet-500"
              />
              {errors.host_name && <p className="mt-1 text-xs text-red-600">{errors.host_name}</p>}
            </div>
          </div>

          {/* 提交 */}
          <div className="space-y-3 pt-4">
            <button
              type="submit"
              disabled={isPending}
              className="w-full rounded-2xl bg-gradient-to-r from-violet-500 to-pink-500 px-6 py-4 text-lg font-bold text-white shadow-lg transition-all hover:shadow-xl active:scale-95 disabled:opacity-50"
            >
              {isPending ? "发布中..." : "🚀 立即发布"}
            </button>
            {submitError && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{submitError}</p>
            )}
            <Link
              href="/partners"
              className="block text-center text-sm text-slate-500 underline-offset-2 hover:underline"
            >
              先看看大家发了啥
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
