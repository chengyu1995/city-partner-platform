"use client";

import { Suspense, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  clearLocalPostDrafts,
  dedupeLocalPostDrafts,
  getLocalPostDraftsServerSnapshot,
  getLocalPostDraftsSnapshot,
  subscribeLocalPostDrafts,
  type LocalPostDraft,
} from "@/lib/local-drafts";
import { mockPartnerPosts, partnerCategories, partnerCities, partnerStatusText } from "@/lib/mock-partners";

const statusText: Record<LocalPostDraft["status"], string> = {
  draft: "草稿",
  pending_review: partnerStatusText.pending_review,
};

const cities = ["全部", ...partnerCities];
const categories = ["全部", ...partnerCategories.map((category) => category.name)];

const examplePartners: LocalPostDraft[] = mockPartnerPosts.map((post) => ({
  ...post,
  contactType: "",
  contactValue: "",
}));

function hrefWith(params: { city?: string; category?: string }) {
  const query = new URLSearchParams();
  if (params.city && params.city !== "全部") query.set("city", params.city);
  if (params.category && params.category !== "全部") query.set("category", params.category);
  const text = query.toString();
  return text ? `/partners?${text}` : "/partners";
}

function filterItems(items: LocalPostDraft[], city: string, category: string) {
  return items.filter((item) => {
    const cityOk = city === "全部" || item.city === city;
    const categoryOk = category === "全部" || item.category === category;
    return cityOk && categoryOk;
  });
}

function PartnerCard({ item, isLocal }: { item: LocalPostDraft; isLocal?: boolean }) {
  return (
    <article className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex flex-wrap gap-2">
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-700">{item.city}</span>
        <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-700">
          {item.category}
        </span>
        <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-black text-amber-800">
          {isLocal ? "本地草稿" : statusText[item.status]}
        </span>
      </div>

      <h2 className="mt-3 text-2xl font-black leading-tight">{item.title}</h2>
      <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-600">{item.description}</p>

      <dl className="mt-4 grid gap-3 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="font-bold text-slate-500">时间</dt>
          <dd className="text-right font-semibold">{item.startsAt}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="font-bold text-slate-500">地点</dt>
          <dd className="text-right font-semibold">{item.location}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="font-bold text-slate-500">人数</dt>
          <dd className="text-right font-semibold">{item.capacity}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="font-bold text-slate-500">状态</dt>
          <dd className="text-right font-semibold">{statusText[item.status]}</dd>
        </div>
      </dl>

      <div className="mt-4 rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">
        暂不开放联系方式。联系方式展示策略不在本批实现，后续需要老板单独批准。
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <Link
          href={`/partners/${item.id}`}
          className="inline-flex min-h-11 items-center rounded-2xl bg-emerald-500 px-5 text-sm font-black text-white hover:bg-emerald-600"
        >
          查看
        </Link>
        <Link
          href="/post"
          className="inline-flex min-h-11 items-center rounded-2xl bg-slate-950 px-5 text-sm font-black text-white hover:bg-slate-800"
        >
          我也要找搭子
        </Link>
      </div>
    </article>
  );
}

function PartnersPageFallback() {
  return (
    <main className="min-h-screen bg-[#f7faf8] px-4 py-5 text-slate-950 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-6xl rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-3xl font-black">正在加载搭子需求</h1>
      </section>
    </main>
  );
}

function PartnersPageContent() {
  const searchParams = useSearchParams();
  const selectedCity = searchParams.get("city") ?? "全部";
  const selectedCategory = searchParams.get("category") ?? "全部";
  const localDrafts = dedupeLocalPostDrafts(
    useSyncExternalStore(
      subscribeLocalPostDrafts,
      getLocalPostDraftsSnapshot,
      getLocalPostDraftsServerSnapshot,
    ),
  );

  const filteredExamples = filterItems(examplePartners, selectedCity, selectedCategory);
  const filteredDrafts = filterItems(localDrafts, selectedCity, selectedCategory);
  const totalCount = filteredExamples.length + filteredDrafts.length;

  return (
    <main className="min-h-screen bg-[#f7faf8] px-4 py-5 text-slate-950 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-col gap-4 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/" className="text-lg font-black tracking-tight sm:text-xl">
            同城搭子
          </Link>

          <nav className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-600">
            <Link href="/" className="inline-flex min-h-11 items-center rounded-full px-3 hover:text-slate-950">
              首页
            </Link>
            <Link
              href="/post"
              className="inline-flex min-h-11 items-center rounded-full bg-slate-950 px-4 text-white hover:bg-slate-800"
            >
              发布搭子需求
            </Link>
          </nav>
        </header>

        <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:p-6">
          <h1 className="text-3xl font-black tracking-tight sm:text-5xl">同城搭子</h1>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            按城市和分类筛选，先看看有没有时间、地点都合适的需求。访客可以浏览，不要求登录。
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-3 text-sm font-black text-slate-700">城市</p>
              <div className="flex flex-wrap gap-2">
                {cities.map((city) => (
                  <Link
                    key={city}
                    href={hrefWith({ city, category: selectedCategory })}
                    className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold ${
                      selectedCity === city
                        ? "bg-slate-950 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    {city}
                  </Link>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-3 text-sm font-black text-slate-700">分类</p>
              <div className="flex flex-wrap gap-2">
                {categories.map((category) => (
                  <Link
                    key={category}
                    href={hrefWith({ city: selectedCity, category })}
                    className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-bold ${
                      selectedCategory === category
                        ? "bg-slate-950 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    {category}
                  </Link>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-900">
            {totalCount > 0 ? `当前找到 ${totalCount} 条搭子需求` : "当前筛选下暂无搭子需求"}
          </div>
        </section>

        {localDrafts.length > 0 ? (
          <section className="mt-6 rounded-3xl bg-amber-50 p-5 shadow-sm ring-1 ring-amber-100 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-2xl font-black">我的本地草稿 / 待审核预览</h2>
                <p className="mt-2 text-sm leading-6 text-amber-900">
                  本地草稿只保存在当前设备或当前浏览环境，换设备可能看不到。
                </p>
              </div>
              <button
                type="button"
                onClick={clearLocalPostDrafts}
                className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-2xl bg-white px-5 text-sm font-black text-amber-900 shadow-sm ring-1 ring-amber-200 hover:bg-amber-100"
              >
                清空本地草稿
              </button>
            </div>

            {filteredDrafts.length > 0 ? (
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                {filteredDrafts.map((draft) => (
                  <PartnerCard key={draft.id} item={draft} isLocal />
                ))}
              </div>
            ) : (
              <div className="mt-5 rounded-2xl bg-white p-4 text-sm leading-6 text-slate-600 ring-1 ring-amber-100">
                当前城市和分类下没有本地草稿。清除筛选后可以查看本机保存的全部草稿。
              </div>
            )}
          </section>
        ) : null}

        <section className="mt-6 grid gap-4 md:grid-cols-2">
          {filteredExamples.length > 0 ? (
            filteredExamples.map((partner) => <PartnerCard key={partner.id} item={partner} />)
          ) : (
            <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200 md:col-span-2">
              <h2 className="text-2xl font-black">暂时还没有搭子需求</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                可以切换城市或分类看看，或先发布一条本地需求。
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link
                  href="/partners"
                  className="inline-flex min-h-11 items-center rounded-2xl bg-white px-5 text-sm font-black text-slate-950 shadow-sm ring-1 ring-slate-200 hover:bg-slate-100"
                >
                  换个城市 / 分类
                </Link>
                <Link
                  href="/post"
                  className="inline-flex min-h-11 items-center rounded-2xl bg-slate-950 px-5 text-sm font-black text-white hover:bg-slate-800"
                >
                  去发布
                </Link>
              </div>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

export default function PartnersPage() {
  return (
    <Suspense fallback={<PartnersPageFallback />}>
      <PartnersPageContent />
    </Suspense>
  );
}
