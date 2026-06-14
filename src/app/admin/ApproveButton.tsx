"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  id: string;
  action: "approved" | "rejected";
}

export function ApproveButton({ id, action }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setError(null);
    const res = await fetch(`/api/partners/${id}/moderate`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ status: action }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "操作失败");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex flex-col items-end">
      <button
        onClick={onClick}
        disabled={isPending}
        className={[
          "rounded-lg px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-transform hover:scale-105 active:scale-95 disabled:opacity-50",
          action === "approved" ? "bg-emerald-500 hover:bg-emerald-600" : "bg-rose-500 hover:bg-rose-600",
        ].join(" ")}
      >
        {isPending ? "..." : action === "approved" ? "✓ 通过" : "✕ 拒绝"}
      </button>
      {error && <span className="mt-1 text-xs text-red-600">{error}</span>}
    </div>
  );
}
