import Link from "next/link";
import { mockPartnerPosts, partnerCategories, partnerCities } from "@/lib/mock-partners";

const previewPosts = mockPartnerPosts.slice(0, 3);

function partnerHref(city?: string, category?: string) {
  const params = new URLSearchParams();
  if (city) params.set("city", city);
  if (category) params.set("category", category);
  return `/partners?${params.toString()}`;
}

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f7faf8] px-4 py-5 text-slate-950 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-6xl">
        <header className="mb-6 flex items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <Link href="/" className="text-lg font-black tracking-tight sm:text-xl">
            同城搭子
          </Link>

          <nav className="flex items-center gap-2 text-sm font-bold text-slate-600">
            <Link href="/partners" className="inline-flex min-h-11 items-center rounded-full px-3 hover:text-slate-950">
              找搭子
            </Link>
            <Link
              href="/post"
              className="inline-flex min-h-11 items-center rounded-full bg-slate-950 px-4 text-white hover:bg-slate-800"
            >
              发布
            </Link>
          </nav>
        </header>

        <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:p-8 lg:p-10">
          <div className="grid gap-7 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
            <div>
              <p className="text-sm font-black text-emerald-600">同城兴趣社交 MVP</p>
              <h1 className="mt-3 text-3xl font-black leading-tight tracking-tight sm:text-5xl lg:text-6xl">
                同城找搭子，一起吃饭、运动、学习、出游
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
                先从惠州、广州、深圳、上海开始，看看附近有没有合拍的人。
              </p>

              <div className="mt-6 grid gap-3 sm:flex sm:flex-wrap">
                <Link
                  href="/partners"
                  className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-black text-white shadow-sm hover:bg-emerald-600"
                >
                  去找搭子
                </Link>
                <Link
                  href="/post"
                  className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-slate-950 px-6 text-sm font-black text-white shadow-sm hover:bg-slate-800"
                >
                  发布搭子需求
                </Link>
              </div>
            </div>

            <div className="rounded-3xl bg-emerald-50 p-5 ring-1 ring-emerald-100">
              <h2 className="text-xl font-black">没有合适的？自己发一个</h2>
              <p className="mt-3 text-sm leading-6 text-emerald-950">
                填写后先保存为本地草稿或进入待审核，不会直接公开联系方式。
              </p>
              <Link
                href="/post"
                className="mt-5 inline-flex min-h-11 items-center rounded-2xl bg-white px-5 text-sm font-black text-emerald-800 shadow-sm ring-1 ring-emerald-200 hover:bg-emerald-100"
              >
                去发布
              </Link>
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-2xl font-black">先选城市</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">首批开放 4 个城市，后续可以继续扩展。</p>
            </div>
            <Link href="/partners" className="text-sm font-black text-slate-700 hover:text-slate-950">
              查看全部城市
            </Link>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {partnerCities.map((city) => (
              <Link
                key={city}
                href={partnerHref(city)}
                className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-slate-100 px-4 text-base font-black text-slate-800 hover:bg-slate-950 hover:text-white"
              >
                {city}
              </Link>
            ))}
          </div>
        </section>

        <section className="mt-6">
          <div className="mb-4">
            <h2 className="text-2xl font-black">你想找哪种搭子？</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">按兴趣先筛一遍，更快找到合适的人。</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {partnerCategories.map((category) => (
              <Link
                key={category.name}
                href={partnerHref(undefined, category.name)}
                className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <h3 className="text-lg font-black">{category.name}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{category.desc}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="mt-8">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-black">最近有人在找</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">先看一眼需求，合适再进入列表。</p>
            </div>
            <Link href="/partners" className="hidden text-sm font-black text-slate-700 hover:text-slate-950 sm:block">
              浏览列表
            </Link>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {previewPosts.map((post) => (
              <article key={post.title} className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-700">
                    {post.city}
                  </span>
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-700">
                    {post.category}
                  </span>
                </div>
                <h3 className="mt-3 text-xl font-black">{post.title}</h3>
                <dl className="mt-4 grid gap-2 text-sm text-slate-600">
                  <div className="flex justify-between gap-3">
                    <dt className="font-bold">时间</dt>
                    <dd className="text-right">{post.startsAt}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="font-bold">地点</dt>
                    <dd className="text-right">{post.location}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="font-bold">人数</dt>
                    <dd className="text-right">{post.capacity}</dd>
                  </div>
                </dl>
                <Link
                  href={partnerHref(post.city, post.category)}
                  className="mt-5 inline-flex min-h-11 items-center rounded-2xl bg-slate-950 px-5 text-sm font-black text-white hover:bg-slate-800"
                >
                  查看详情
                </Link>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
