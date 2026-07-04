import Link from "next/link";

type SearchParams = Record<string, string | string[] | undefined>;

const categories = [
  "饭搭子",
  "运动搭子",
  "学习搭子",
  "出游搭子",
  "K歌搭子",
  "旅游搭子",
  "摩友搭子",
  "钓友搭子",
];

const cities = ["广州", "深圳", "上海", "北京", "杭州"];

const partnerPosts = [
  {
    title: "周末一起探店吃饭",
    category: "饭搭子",
    city: "广州",
    time: "本周六 18:30",
    people: "还差 1 人",
    desc: "找 1-2 位附近朋友，周末一起吃饭聊天，轻松认识新朋友。",
  },
  {
    title: "下班后一起运动",
    category: "运动搭子",
    city: "深圳",
    time: "工作日 20:00",
    people: "还差 2 人",
    desc: "慢跑、羽毛球都可以，不卷强度，主要是互相督促。",
  },
  {
    title: "晚上自习搭子",
    category: "学习搭子",
    city: "上海",
    time: "今晚 19:30",
    people: "还差 1 人",
    desc: "适合备考、写作业、学编程，互相监督不摸鱼。",
  },
  {
    title: "周末城市轻旅行",
    category: "出游搭子",
    city: "杭州",
    time: "本周日 10:00",
    people: "还差 3 人",
    desc: "附近短途出游，拍照、逛街、吃饭都可以。",
  },
  {
    title: "K歌搭子约一场",
    category: "K歌搭子",
    city: "广州",
    time: "周五 21:00",
    people: "还差 2 人",
    desc: "喜欢流行歌、粤语歌都可以，轻松唱歌不尴尬。",
  },
  {
    title: "周末钓鱼搭子",
    category: "钓友搭子",
    city: "深圳",
    time: "周六 08:00",
    people: "还差 1 人",
    desc: "新手友好，注意安全，线下见面先确认地点。",
  },
];

function getParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function partnersHref(params: { category?: string; city?: string }) {
  const query = new URLSearchParams();

  if (params.category) {
    query.set("category", params.category);
  }

  if (params.city) {
    query.set("city", params.city);
  }

  const text = query.toString();
  return text ? `/partners?${text}` : "/partners";
}

export default async function PartnersPage({
  searchParams,
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const selectedCategory = getParam(params.category) ?? "";
  const selectedCity = getParam(params.city) ?? "";

  const filteredPartners = partnerPosts.filter((item) => {
    const categoryMatched = selectedCategory
      ? item.category === selectedCategory
      : true;

    const cityMatched = selectedCity ? item.city === selectedCity : true;

    return categoryMatched && cityMatched;
  });

  return (
    <main className="min-h-screen bg-[#f8faf7] px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-6xl">
        <header className="mb-8 flex items-center justify-between gap-4 border-b border-slate-200 pb-5">
          <Link href="/" className="text-xl font-black tracking-tight">
            同城搭子
          </Link>

          <nav className="flex items-center gap-3 text-sm font-bold text-slate-600">
            <Link href="/" className="hover:text-slate-950">
              首页
            </Link>
            <Link href="/partners" className="text-slate-950">
              找搭子
            </Link>
            <Link
              href="/post"
              className="rounded-full bg-slate-950 px-4 py-2 text-white hover:bg-slate-800"
            >
              发布需求
            </Link>
          </nav>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
          <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200 sm:p-8">
            <p className="mb-3 text-sm font-black uppercase tracking-[0.25em] text-emerald-600">
              Partner List
            </p>

            <h1 className="text-4xl font-black leading-tight tracking-tight sm:text-6xl">
              找附近正在发起的邀约
            </h1>

            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
              按城市和兴趣筛选同城搭子。先线上确认需求，线下见面注意安全。
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/partners"
                className="rounded-full bg-slate-950 px-5 py-3 text-sm font-bold text-white"
              >
                全部邀约
              </Link>

              <Link
                href="/post"
                className="rounded-full bg-white px-5 py-3 text-sm font-bold text-slate-800 shadow-sm ring-1 ring-slate-200"
              >
                发布我的需求
              </Link>
            </div>
          </div>

          <aside className="rounded-3xl bg-emerald-50 p-6 ring-1 ring-emerald-100">
            <p className="text-sm font-bold text-emerald-700">当前筛选</p>
            <p className="mt-3 text-2xl font-black">
              {selectedCity || "全部城市"} / {selectedCategory || "全部分类"}
            </p>
            <p className="mt-3 text-sm leading-6 text-emerald-900">
              共找到 {filteredPartners.length} 个匹配邀约。
            </p>
          </aside>
        </div>

        <section className="mt-8 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-black">按分类找搭子</h2>
            <Link href="/partners" className="text-sm font-bold text-slate-500">
              清除筛选
            </Link>
          </div>

          <div className="flex gap-3 overflow-x-auto pb-2">
            {categories.map((category) => {
              const active = selectedCategory === category;

              return (
                <Link
                  key={category}
                  href={partnersHref({ category, city: selectedCity })}
                  className={`min-h-11 shrink-0 rounded-full px-4 py-3 text-sm font-bold transition ${
                    active
                      ? "bg-slate-950 text-white shadow-md"
                      : "bg-slate-50 text-slate-700 ring-1 ring-slate-200 hover:bg-white"
                  }`}
                >
                  {category}
                </Link>
              );
            })}
          </div>
        </section>

        <section className="mt-6 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="mb-4 text-lg font-black">按城市筛选</h2>

          <div className="flex gap-3 overflow-x-auto pb-2">
            {cities.map((city) => {
              const active = selectedCity === city;

              return (
                <Link
                  key={city}
                  href={partnersHref({ city, category: selectedCategory })}
                  className={`min-h-11 shrink-0 rounded-full px-4 py-3 text-sm font-bold transition ${
                    active
                      ? "bg-emerald-500 text-white shadow-md"
                      : "bg-slate-50 text-slate-700 ring-1 ring-slate-200 hover:bg-white"
                  }`}
                >
                  {city}
                </Link>
              );
            })}
          </div>
        </section>

        <section className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredPartners.length > 0 ? (
            filteredPartners.map((partner) => (
              <article
                key={`${partner.title}-${partner.city}`}
                className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <div className="mb-4 flex flex-wrap gap-2 text-xs font-black">
                  <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">
                    {partner.category}
                  </span>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">
                    {partner.city}
                  </span>
                  <span className="rounded-full bg-orange-50 px-3 py-1 text-orange-700">
                    {partner.people}
                  </span>
                </div>

                <h3 className="text-2xl font-black tracking-tight">
                  {partner.title}
                </h3>

                <p className="mt-2 text-sm font-bold text-slate-500">
                  {partner.time}
                </p>

                <p className="mt-4 text-sm leading-6 text-slate-600">
                  {partner.desc}
                </p>

                <div className="mt-5 flex gap-3">
                  <Link
                    href={partnersHref({
                      category: partner.category,
                      city: partner.city,
                    })}
                    className="inline-flex min-h-11 items-center justify-center rounded-2xl bg-emerald-500 px-4 text-sm font-bold text-white hover:bg-emerald-600"
                  >
                    查看同类
                  </Link>

                  <Link
                    href="/post"
                    className="inline-flex min-h-11 items-center justify-center rounded-2xl bg-slate-950 px-4 text-sm font-bold text-white hover:bg-slate-800"
                  >
                    我也发布
                  </Link>
                </div>
              </article>
            ))
          ) : (
            <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200 md:col-span-2 lg:col-span-3">
              <h3 className="text-2xl font-black">暂时没有匹配的搭子</h3>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                可以换个城市或分类，也可以先发布自己的搭子需求。
              </p>
              <Link
                href="/post"
                className="mt-5 inline-flex min-h-11 items-center rounded-2xl bg-slate-950 px-5 text-sm font-bold text-white"
              >
                发布需求
              </Link>
            </div>
          )}
        </section>

        <section className="mt-8 rounded-3xl bg-slate-950 p-6 text-white">
          <h2 className="text-xl font-black">安全提示</h2>
          <ul className="mt-4 grid gap-3 text-sm leading-6 text-slate-200 md:grid-cols-3">
            <li>线下见面建议选择公共场所。</li>
            <li>不要提前转账，不要轻信陌生人借钱。</li>
            <li>首次见面把行程告诉朋友或家人。</li>
          </ul>
        </section>
      </section>
    </main>
  );
}
