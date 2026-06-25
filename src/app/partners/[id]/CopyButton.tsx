"use client";

/**
 * 复制按钮 —— client component (因为 onClick 需要 navigator)
 */
import { useState } from "react";

interface Props {
  text: string;
  label?: string;
}

export function CopyButton({ text, label = "📋 复制" }: Props) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          } catch {
            alert("复制失败, 请手动选择文本");
          }
        }
      }}
      className="rounded-full bg-slate-900 px-4 py-2 text-sm font-bold text-white shadow-md transition-transform hover:scale-105"
    >
      {done ? "✓ 已复制" : label}
    </button>
  );
}
