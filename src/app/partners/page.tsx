/**
 * 搭子列表页 —— 年轻化卡片
 */
import Link from "next/link";
import { listPartnerPosts } from "@/lib/db";
import { PARTNER_CATEGORIES, type PartnerCategory } from "@/types/db";
import { CategoryFilter } from "./CategoryFilter";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";

export const dynamic = "force-dynamic";
export const runtime = "edge";

interface SearchProps {
  searchParams: Promise<{ category?: string; city?: string }>;
}

const CATEGORY_MAP: Record<string, { emoji: string; color: string }> = Object.fromEntries(
  PARTNER_CATEGORIES.map((c) => [c.key, { emoji: c.emoji, color: c.color }])
);

export default async function PartnersPage({ searchParams }: SearchProps) {
  const params = await searchParams;
  const category = (PARTNER_CATEGORIES.some((c) => c.key === params.category) ? params.category : undefined) as PartnerCategory | undefined;
  const city = params.city && params.city.trim().length > 0 ? params.city.trim() : undefined;
  const items = await listPartnerPosts({ category, city });

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-amber-50">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:py-12">
        {/* Header */}
        <div className="mb-6 flex items-end justify-between sm:mb-8">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
              {city ? `📍 ${city} 的搭子` : category ? `${PARTNER_CATEGORIES.find((c) => c.key === category)?.emoji} ${category}搭子` : "找搭子"}
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              {items.length > 0 ? `${items.length} 个同城搭子在等你` : "还没有搭子帖，发第一个吧"}
            </p>
          </div>
          <Link
            href="/post"
            className="rounded-full bg-gradient-to-r from-violet-500 to-pink-500 px-5 py-2.5 text-sm font-bold text-white shadow-md transition-transform hover:scale-105 active:scale-95"
          >
            ✨ 发搭子
          </Link>
        </div>

        {/* 当前过滤标签 */}
        {(category || city) && (
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <span>当前筛选:</span>
            {category && (
              <Link
                href={city ? `/partners?city=${encodeURIComponent(city)}` : "/partners"}
                className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-3 py-1 text-violet-700 hover:bg-violet-200"
              >
                {category} ✕
              </Link>
            )}
            {city && (
              <Link
                href={category ? `/partners?category=${encodeURIComponent(category)}` : "/partners"}
                className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-amber-700 hover:bg-amber-200"
              >
                {city} ✕
              </Link>
            )}
            <Link href="/partners" className="text-slate-500 underline-offset-2 hover:underline">
              清除全部
            </Link>
          </div>
        )}

        {/* 分类筛选 */}
        <CategoryFilter active={category} />

        {/* 卡片列表 */}
        {items.length === 0 ? (
          <div className="rounded-3xl bg-white p-12 text-center shadow-sm">
            <div className="text-5xl">😢</div>
            <p className="mt-4 text-slate-600">还没有这个分类的搭子帖</p>
            <Link
              href="/post"
              className="mt-6 inline-block rounded-full bg-gradient-to-r from-violet-500 to-pink-500 px-6 py-2.5 text-sm font-bold text-white shadow-md"
            >
              我来发第一个
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {items.map((p) => {
              const meta = CATEGORY_MAP[p.category] || { emoji: "📌", color: "from-slate-500 to-slate-400" };
              return (
                <Link
                  key={p.id}
                  href={`/partners/${p.id}`}
                  className="group block overflow-hidden rounded-2xl bg-white shadow-sm transition-all hover:-translate-y-1 hover:shadow-xl"
                >
                  {/* 顶条色块 */}
                  <div className={`bg-gradient-to-r ${meta.color} px-4 py-3`}>
                    <div className="flex items-center gap-2 text-white">
                      <span className="text-xl">{meta.emoji}</span>
                      <span className="text-sm font-bold">{p.category}</span>
                      <span className="ml-auto text-xs opacity-80">📍 {p.city}</span>
                    </div>
                  </div>
                  <div className="p-5">
                    <h2 className="line-clamp-1 text-lg font-bold text-slate-900 group-hover:text-violet-600">
                      {p.title}
                    </h2>
                    <p className="mt-2 line-clamp-2 text-sm text-slate-600">{p.description}</p>
                    <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
                      <span>👤 {p.host_name}</span>
                      {p.starts_at && (
                        <span>🕐 {format(new Date(p.starts_at), "M月d日 HH:mm", { locale: zhCN })}</span>
                      )}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
