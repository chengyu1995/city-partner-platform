import Link from "next/link";

type PageProps = {
  searchParams?: Promise<{
    city?: string;
    category?: string;
  }>;
};

const partners = [
  {
    id: "p1",
    title: "周末一起探店吃饭",
    city: "广州",
    category: "饭搭子",
    desc: "找 1-2 位附近朋友，周末一起吃饭聊天。",
  },
  {
    id: "p2",
    title: "下班后一起运动",
    city: "深圳",
    category: "运动搭子",
    desc: "慢跑、羽毛球都可以，轻松一点。",
  },
  {
    id: "p3",
    title: "晚上自习搭子",
    city: "上海",
    category: "学习搭子",
    desc: "互相监督学习，适合备考和提升技能。",
  },
  {
    id: "p4",
    title: "周边出游拍照",
    city: "广州",
    category: "出游搭子",
    desc: "想找同城朋友一起 Citywalk、拍照、喝咖啡。",
  },
  {
    id: "p5",
    title: "周末 K 歌组局",
    city: "深圳",
    category: "K歌搭子",
    desc: "轻松唱歌，不拼酒，找 2-4 个同城搭子。",
  },
];

const categories = ["全部", "饭搭子", "运动搭子", "学习搭子", "出游搭子", "K歌搭子", "旅游搭子", "摩友搭子", "钓友搭子"];
const cities = ["全部", "广州", "深圳", "上海"];

function hrefWith(params: { city?: string; category?: string }) {
  const query = new URLSearchParams();
  if (params.city && params.city !== "全部") query.set("city", params.city);
  if (params.category && params.category !== "全部") query.set("category", params.category);
  const text = query.toString();
  return text ? `/partners?${text}` : "/partners";
}

export default async function PartnersPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const selectedCity = params?.city ?? "全部";
  const selectedCategory = params?.category ?? "全部";

  const filteredPartners = partners.filter((partner) => {
    const cityOk = selectedCity === "全部" || partner.city === selectedCity;
    const categoryOk = selectedCategory === "全部" || partner.category === selectedCategory;
    return cityOk && categoryOk;
  });

  return (
    <main className="min-h-screen bg-[#f8faf7] px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-6xl">
        <header className="mb-8 flex items-center justify-between border-b border-slate-200 pb-5">
          <Link href="/" className="text-xl font-black">
            同城搭子
          </Link>

          <nav className="flex items-center gap-4 text-sm font-bold text-slate-600">
            <Link href="/" className="hover:text-slate-950">
              首页
            </Link>
            <Link href="/post" className="rounded-full bg-slate-950 px-4 py-2 text-white hover:bg-slate-800">
              发布需求
            </Link>
          </nav>
        </header>

        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm font-black uppercase tracking-[0.25em] text-emerald-600">
            Partners
          </p>

          <div className="mt-4 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-4xl font-black tracking-tight sm:text-5xl">
                找附近正在发起的邀约
              </h1>
              <p className="mt-4 text-sm leading-7 text-slate-600">
                当前筛选：{selectedCity} / {selectedCategory}
              </p>
            </div>

            <Link
              href="/post"
              className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-black text-white hover:bg-emerald-600"
            >
              我也发布需求
            </Link>
          </div>

          <div className="mt-7 grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-3 text-sm font-black text-slate-700">城市</p>
              <div className="flex flex-wrap gap-2">
                {cities.map((city) => (
                  <Link
                    key={city}
                    href={hrefWith({ city, category: selectedCategory })}
                    className={`rounded-full px-4 py-2 text-sm font-bold ${
                      selectedCity === city
                        ? "bg-slate-950 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-white"
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
                    className={`rounded-full px-4 py-2 text-sm font-bold ${
                      selectedCategory === category
                        ? "bg-slate-950 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-white"
                    }`}
                  >
                    {category}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-2">
          {filteredPartners.length > 0 ? (
            filteredPartners.map((partner) => (
              <article
                key={partner.id}
                className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <div className="flex flex-wrap gap-2 text-xs font-bold text-slate-500">
                  <span>{partner.city}</span>
                  <span>{partner.category}</span>
                </div>
                <h2 className="mt-3 text-2xl font-black">{partner.title}</h2>
                <p className="mt-3 text-sm leading-7 text-slate-600">{partner.desc}</p>
                <div className="mt-5 flex flex-wrap gap-3">
                  <Link
                    href={hrefWith({ city: partner.city, category: partner.category })}
                    className="inline-flex min-h-11 items-center rounded-2xl bg-emerald-500 px-5 text-sm font-black text-white hover:bg-emerald-600"
                  >
                    查看同类搭子
                  </Link>
                  <Link
                    href="/post"
                    className="inline-flex min-h-11 items-center rounded-2xl bg-slate-950 px-5 text-sm font-black text-white hover:bg-slate-800"
                  >
                    发布类似需求
                  </Link>
                </div>
              </article>
            ))
          ) : (
            <div className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200 md:col-span-2">
              <h2 className="text-2xl font-black">暂时没有匹配的搭子</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                可以换个城市或分类，也可以先发布自己的搭子需求。
              </p>
              <Link
                href="/post"
                className="mt-5 inline-flex min-h-11 items-center rounded-2xl bg-slate-950 px-5 text-sm font-black text-white hover:bg-slate-800"
              >
                发布需求
              </Link>
            </div>
          )}
        </section>

        <section className="mt-8 rounded-3xl bg-slate-950 p-6 text-white">
          <h2 className="text-2xl font-black">安全提示</h2>
          <ul className="mt-4 grid gap-3 text-sm leading-6 text-slate-200 md:grid-cols-3">
            <li>线下见面建议选择公共场所。</li>
            <li>不要提前转账，不要轻信陌生人借钱。</li>
            <li>不要泄露身份证、银行卡、家庭住址等隐私。</li>
          </ul>
        </section>
      </section>
    </main>
  );
}
