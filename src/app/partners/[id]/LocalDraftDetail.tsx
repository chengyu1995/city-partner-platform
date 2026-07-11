"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import {
  dedupeLocalPostDrafts,
  getLocalPostDraftsServerSnapshot,
  getLocalPostDraftsSnapshot,
  subscribeLocalPostDrafts,
} from "@/lib/local-drafts";

export function LocalDraftDetail({ id }: { id: string }) {
  const localDrafts = dedupeLocalPostDrafts(
    useSyncExternalStore(
      subscribeLocalPostDrafts,
      getLocalPostDraftsSnapshot,
      getLocalPostDraftsServerSnapshot,
    ),
  );
  const draft = localDrafts.find((item) => item.id === id);

  if (!draft) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-amber-50">
        <div className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
          <Link href="/partners" className="mb-6 inline-flex items-center text-sm text-slate-500 hover:text-slate-700">
            ← 返回列表
          </Link>
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h1 className="text-2xl font-extrabold text-slate-900">未找到这个搭子需求</h1>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              它可能只保存在另一台设备，或本机草稿已经被清空。
            </p>
          </div>
        </div>
      </div>
    );
  }

  const contactText = draft.contactValue || "联系方式暂不公开";

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-amber-50">
      <div className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
        <Link href="/partners" className="mb-6 inline-flex items-center text-sm text-slate-500 hover:text-slate-700">
          ← 返回列表
        </Link>

        <div className="overflow-hidden rounded-3xl bg-gradient-to-r from-slate-500 to-slate-400 p-6 text-white shadow-xl">
          <div className="flex items-center gap-2 text-sm font-bold opacity-90">
            <span className="text-2xl">📌</span>
            <span>{draft.category}</span>
          </div>
          <h1 className="mt-3 text-2xl font-extrabold sm:text-3xl">{draft.title}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm opacity-90">
            <span>📍 {draft.city}</span>
            {draft.startsAt ? <span>🕐 {draft.startsAt}</span> : null}
          </div>
        </div>

        <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-bold text-slate-400">详情</h2>
          <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed text-slate-800">{draft.description}</p>
        </div>

        <div className="mt-4 rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-bold text-slate-400">发起人</h2>
          <div className="mt-3 flex items-center justify-between">
            <div>
              <p className="text-lg font-bold text-slate-900">👤 {draft.hostName}</p>
              <p className="mt-1 text-base text-violet-600">{contactText}</p>
            </div>
          </div>
        </div>

        <div className="mt-6 text-center text-xs text-slate-400">本地保存于 {draft.createdAt}</div>
      </div>
    </div>
  );
}
