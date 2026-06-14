"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { PARTNER_CATEGORIES, type PartnerCategory } from "@/types/db";

interface Props {
  active: PartnerCategory | undefined;
}

export function CategoryFilter({ active }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setCategory(c: PartnerCategory | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (c === null) params.delete("category");
    else params.set("category", c);
    router.push(`/partners?${params.toString()}`);
  }

  return (
    <div className="mb-6 flex flex-wrap gap-2">
      <button
        onClick={() => setCategory(null)}
        className={[
          "rounded-full px-4 py-2 text-sm font-bold transition-all",
          active === undefined
            ? "bg-slate-900 text-white shadow-md"
            : "bg-white text-slate-700 ring-1 ring-slate-200 hover:ring-violet-300",
        ].join(" ")}
      >
        全部
      </button>
      {PARTNER_CATEGORIES.map((c) => {
        const isActive = active === c.key;
        return (
          <button
            key={c.key}
            onClick={() => setCategory(c.key)}
            className={[
              "rounded-full px-4 py-2 text-sm font-bold transition-all",
              isActive
                ? `bg-gradient-to-r ${c.color} text-white shadow-md`
                : "bg-white text-slate-700 ring-1 ring-slate-200 hover:ring-violet-300",
            ].join(" ")}
          >
            <span className="mr-1">{c.emoji}</span>
            {c.key}
          </button>
        );
      })}
    </div>
  );
}
