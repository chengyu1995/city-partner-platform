import Link from "next/link";
import { PARTNER_CATEGORIES } from "@/types/db";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-amber-50">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_30%_20%,rgba(168,85,247,0.15),transparent_50%),radial-gradient(circle_at_70%_60%,rgba(236,72,153,0.15),transparent_50%)]" />
        <div className="mx-auto max-w-5xl px-4 py-16 text-center sm:py-24">
          <div className="inline-flex items-center rounded-full bg-white/80 px-4 py-1.5 text-xs font-medium text-violet-700 shadow-sm ring-1 ring-violet-100 backdrop-blur">
            ✨ 20-35 岁同城兴趣社交
          </div>
          <h1 className="mt-6 text-5xl font-extrabold tracking-tight text-slate-900 sm:text-6xl md:text-7xl">
            <span className="block">找搭子</span>
            <span className="block bg-gradient-to-r from-violet-500 via-pink-500 to-amber-500 bg-clip-text text-transparent">
              就现在
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base text-slate-600 sm:text-lg">
            旅游、K 歌、学习、摩友、钓友...
            <br className="hidden sm:block" />
            找兴趣相投的同城朋友，几秒钟发个搭子帖
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
            <Link
              href="/post"
              className="w-full rounded-full bg-gradient-to-r from-violet-500 to-pink-500 px-8 py-4 text-base font-bold text-white shadow-lg transition-all hover:-translate-y-0.5 hover:shadow-xl active:scale-95 sm:w-auto"
            >
              🚀 我要发搭子
            </Link>
            <Link
              href="/partners"
              className="w-full rounded-full bg-white px-8 py-4 text-base font-bold text-slate-800 shadow-md ring-1 ring-slate-200 transition-all hover:ring-violet-300 sm:w-auto"
            >
              👀 看看大家发了啥
            </Link>
          </div>
        </div>
      </section>

      {/* 分类卡片 */}
      <section className="mx-auto max-w-5xl px-4 pb-16">
        <h2 className="mb-6 text-center text-2xl font-bold text-slate-800">想玩什么？</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 sm:gap-4">
          {PARTNER_CATEGORIES.map((c) => (
            <Link
              key={c.key}
              href={`/partners?category=${encodeURIComponent(c.key)}`}
              className={`group flex flex-col items-center justify-center gap-2 rounded-2xl bg-gradient-to-br ${c.color} px-4 py-6 text-white shadow-md transition-transform hover:-translate-y-1 hover:shadow-xl`}
            >
              <span className="text-3xl sm:text-4xl">{c.emoji}</span>
              <span className="text-sm font-bold sm:text-base">{c.key}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
