"use client";

import { useState } from "react";

interface Props {
  postId: string;
}

export function ReportButton({ postId }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [contact, setContact] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ post_id: postId, reason, contact: contact || undefined }),
    });
    setSubmitting(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "提交失败");
      return;
    }
    setDone(true);
    setTimeout(() => {
      setOpen(false);
      setReason("");
      setContact("");
      setDone(false);
    }, 2000);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600"
      >
        🚩 举报
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-t-2xl bg-white p-6 shadow-2xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {done ? (
              <div className="py-8 text-center">
                <div className="text-5xl">✅</div>
                <p className="mt-4 text-sm text-slate-700">举报已收到, 我们会尽快处理</p>
              </div>
            ) : (
              <>
                <h3 className="text-lg font-bold text-slate-900">🚩 举报这条搭子</h3>
                <p className="mt-1 text-xs text-slate-500">我们会审核所有举报, 虚假举报会处理。</p>
                <form onSubmit={onSubmit} className="mt-4 space-y-3">
                  <div>
                    <label className="mb-1 block text-sm font-bold text-slate-800">举报原因 *</label>
                    <textarea
                      required
                      minLength={3}
                      maxLength={500}
                      rows={3}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="请说明: 虚假信息/骚扰/违法/...等"
                      className="w-full resize-none rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200 focus:ring-2 focus:ring-rose-400"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-bold text-slate-800">
                      你的联系方式 <span className="text-xs font-normal text-slate-400">(可选)</span>
                    </label>
                    <input
                      type="text"
                      value={contact}
                      onChange={(e) => setContact(e.target.value)}
                      placeholder="需要回复你时怎么联系"
                      className="w-full rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200 focus:ring-2 focus:ring-rose-400"
                    />
                  </div>
                  {error && <p className="text-xs text-red-600">{error}</p>}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      className="flex-1 rounded-full bg-slate-100 px-4 py-2 text-sm font-bold text-slate-700"
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      disabled={submitting || reason.trim().length < 3}
                      className="flex-1 rounded-full bg-rose-500 px-4 py-2 text-sm font-bold text-white shadow-md transition-transform hover:scale-105 active:scale-95 disabled:opacity-50"
                    >
                      {submitting ? "提交中..." : "提交举报"}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
