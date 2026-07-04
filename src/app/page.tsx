import Link from "next/link";
import { PARTNER_CATEGORIES, type PartnerCategory } from "@/types/db";

const POPULAR_CITIES = ["北京", "上海", "广州", "深圳", "杭州", "成都"];

const CATEGORY_COPY: Record<PartnerCategory, { title: string; desc: string }> = {
  旅游: { title: "旅游搭子", desc: "周边游、看展、短途出发" },
  K歌: { title: "K 歌搭子", desc: "练歌、包厢、麦霸局" },
  学习: { title: "学习搭子", desc: "自习、备考、读书打卡" },
  摩友: { title: "摩友搭子", desc: "骑行路线、周末约跑" },
  钓友: { title: "钓友搭子", desc: "野钓、路亚、装备交流" },
};

function categoryHref(category: PartnerCategory) {
  return `/partners?category=${encodeURIComponent(CATEGORY_COPY[category].title)}`;
}

const MOCK_PARTNER_POSTS = [
  {
    id: "travel-weekend-hangzhou",
    category: "旅游" as PartnerCategory,
    city: "杭州",
    title: "周六西湖 Citywalk，想找 2 个拍照搭子",
    time: "本周六 14:00",
    people: "2-3 人",
    host: "阿宁",
    tags: ["轻松路线", "女生优先"],
  },
  {
    id: "karaoke-friday-shanghai",
    category: "K歌" as PartnerCategory,
    city: "上海",
    title: "五角场周五晚 K 歌，粤语歌友来",
    time: "周五 20:00",
    people: "4-6 人",
    host: "小宇",
    tags: ["粤语", "AA"],
  },
  {
    id: "study-sunday-beijing",
    category: "学习" as PartnerCategory,
    city: "北京",
    title: "国贸咖啡店自习，一起刷题 3 小时",
    time: "周日 10:00",
    people: "2 人",
    host: "Mia",
    tags: ["安静", "考研"],
  },
];

const SAFETY_TIPS = ["线下见面注意安全", "不提前转账", "首次见面建议选择公共场所"];

function getCategoryMeta(category: PartnerCategory) {
  return PARTNER_CATEGORIES.find((item) => item.key === category);
}

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f8faf7] text-slate-900">
      <section className="mx-auto flex max-w-6xl flex-col px-4 pb-6 pt-5 sm:px-6 lg:min-h-[92vh] lg:px-8">
        <nav className="flex items-center justify-between rounded-full bg-white/90 px-4 py-3 shadow-sm ring-1 ring-slate-200/70">
          <Link href="/" className="flex min-h-11 items-center gap-2 font-bold text-slate-950">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 text-base text-white">
              搭
            </span>
            <span>同城搭子</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/partners"
              className="inline-flex min-h-11 items-center rounded-full bg-slate-100 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 sm:px-4"
            >
              分类
            </Link>
            <Link
              href="/partners"
              className="inline-flex min-h-11 items-center rounded-full bg-slate-100 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 sm:px-4"
            >
              推荐
            </Link>
            <Link
              href="/post"
              className="inline-flex min-h-11 items-center rounded-full bg-slate-950 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 sm:px-4"
            >
              发布需求
            </Link>
          </div>
        </nav>

        <div className="grid flex-1 items-center gap-8 py-8 lg:grid-cols-[1.04fr_0.96fr] lg:py-12">
          <div>
            <div className="inline-flex min-h-9 items-center rounded-full bg-emerald-100 px-4 text-sm font-semibold text-emerald-800">
              找旅游、K 歌、学习、摩友、钓友搭子
            </div>
            <h1 className="mt-5 max-w-3xl text-4xl font-black leading-tight tracking-normal text-slate-950 sm:text-5xl lg:text-6xl">
              同城搭子，找到附近同频的人
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
              想出门、练歌、学习、骑行或钓鱼时，先在这里看看同城正在约什么，也可以直接发布你的搭子需求。
            </p>

            <div className="mt-6 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-slate-200/80">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase text-slate-400">当前城市</p>
                  <p className="mt-1 text-lg font-bold text-slate-950">杭州</p>
                </div>
                <Link
                  href="/partners?city=杭州"
                  className="inline-flex min-h-11 items-center rounded-full bg-emerald-50 px-4 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-100 transition hover:bg-emerald-100"
                >
                  进入城市
                </Link>
              </div>
              <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
                {POPULAR_CITIES.map((city) => (
                  <Link
                    key={city}
                    href={`/partners?city=${encodeURIComponent(city)}`}
                    className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-200"
                  >
                    {city}
                  </Link>
                ))}
              </div>
            </div>

            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/partners"
                className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-emerald-500 px-6 text-base font-bold text-white shadow-md shadow-emerald-200 transition hover:bg-emerald-600"
              >
                找搭子
              </Link>
              <Link
                href="/post"
                className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-white px-6 text-base font-bold text-slate-800 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50"
              >
                发布需求
              </Link>
            </div>
            <div className="mt-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
              {PARTNER_CATEGORIES.map((category) => (
                  <Link
                    key={category.key}
                    href={categoryHref(category.key)}
                    className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200"
                  >
                  <span aria-hidden>{category.emoji}</span>
                  <span>{category.key}</span>
                </Link>
              ))}
            </div>
          </div>

          <div className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-slate-200/80 sm:p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-emerald-700">今日推荐</p>
                <h2 className="mt-1 text-2xl font-black text-slate-950">同城搭子预览</h2>
              </div>
              <Link href="/partners" className="text-sm font-semibold text-slate-500 hover:text-slate-900">
                查看全部
              </Link>
            </div>
            <div className="mt-4 space-y-3">
              {MOCK_PARTNER_POSTS.map((post) => {
                const meta = getCategoryMeta(post.category);
                return (
                  <Link
                    key={post.id}
                    href={`${categoryHref(post.category)}&city=${encodeURIComponent(post.city)}`}
                    className="block rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-100 transition hover:-translate-y-0.5 hover:bg-white hover:shadow-md"
                  >
                    <div className="flex gap-3">
                      <div
                        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br ${
                          meta?.color ?? "from-slate-500 to-slate-400"
                        } text-xl text-white`}
                      >
                        {meta?.emoji ?? "📌"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
                          <span>{post.city}</span>
                          <span>{post.category}搭子</span>
                          <span>{post.time}</span>
                        </div>
                        <h3 className="mt-1 line-clamp-2 text-base font-bold leading-6 text-slate-950">
                          {post.title}
                        </h3>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                            {post.people}
                          </span>
                          <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                            发起人 {post.host}
                          </span>
                          {post.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-bold text-emerald-700">按兴趣出发</p>
            <h2 className="mt-1 text-2xl font-black text-slate-950 sm:text-3xl">五类搭子入口</h2>
          </div>
          <Link href="/partners" className="hidden text-sm font-semibold text-slate-500 hover:text-slate-900 sm:block">
            浏览全部搭子
          </Link>
        </div>
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {PARTNER_CATEGORIES.map((category) => {
            const copy = CATEGORY_COPY[category.key];
            return (
              <Link
                key={category.key}
                href={categoryHref(category.key)}
                className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200/80 transition hover:-translate-y-1 hover:shadow-md"
              >
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br ${category.color} text-2xl text-white`}
                >
                  {category.emoji}
                </div>
                <h3 className="mt-4 text-lg font-black text-slate-950">{copy.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">{copy.desc}</p>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-4 rounded-3xl bg-slate-950 p-5 text-white sm:p-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <p className="text-sm font-bold text-emerald-300">安全提示</p>
            <h2 className="mt-2 text-2xl font-black">开心约搭子，也要保护自己</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {SAFETY_TIPS.map((tip) => (
              <div key={tip} className="rounded-2xl bg-white/10 p-4 text-sm font-semibold leading-6 ring-1 ring-white/10">
                {tip}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-12 pt-4 sm:px-6 lg:px-8">
        <div className="rounded-3xl bg-white p-5 text-center shadow-sm ring-1 ring-slate-200/80 sm:p-8">
          <h2 className="text-2xl font-black text-slate-950">没看到合适的？自己发一个</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-slate-500 sm:text-base">
            写清楚城市、时间、人数和期待的活动方式，让同城的人更快找到你。
          </p>
          <div className="mt-5 flex justify-center">
            <Link
              href="/post"
              className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-slate-950 px-6 text-base font-bold text-white transition hover:bg-slate-800"
            >
              我要发布需求
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
