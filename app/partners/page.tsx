import Link from "next/link";

const categories = ["饭搭子", "运动搭子", "学习搭子", "出游搭子", "K歌搭子"];

export default function PartnersPage({
  searchParams,
}: {
  searchParams?: { category?: string; city?: string };
}) {
  const category = searchParams?.category ?? "全部分类";
  const city = searchParams?.city ?? "全部城市";

  return (
    <main className="min-h-screen bg-[#f8faf7] px-4 py-8 text-slate-950 sm:px-8">
      <section className="mx-auto max-w-6xl">
        <div className="mb-8 flex items-center justify-between gap-4 border-b border-slate-200 pb-5">
          <Link href="/" className="text-xl font-black">
            同城搭子
          </Link>
          <Link
            href="/post"
            className="rounded-full bg-slate-950 px-5 py-3 text-sm font-bold text-white"
          >
            发布需求
          </Link>
        </div>

        <div className="mb-8 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <p className="mb-2 text-sm font-bold text-emerald-600">搭子列表</p>
          <h1 className="text-4xl font-black tracking-tight">
            找附近正在发起的邀约
          </h1>
          <p className="mt-4 text-slate-600">
            当前筛选：{city} / {category}
          </p>
        </div>

        <div className="mb-8 flex flex-wrap gap-3">
          <Link
            href="/partners"
            className="rounded-full bg-slate-950 px-4 py-3 text-sm font-bold text-white"
          >
            全部
          </Link>

          {categories.map((item) => (
            <Link
              key={item}
              href={`/partners?category=${encodeURIComponent(item)}`}
              className="rounded-full bg-white px-4 py-3 text-sm font-bold text-slate-700 shadow-sm ring-1 ring-slate-200"
            >
              {item}
            </Link>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {[
            {
              title: "周末一起探店吃饭",
              category: "饭搭子",
              city: "广州",
              desc: "找 1-2 位附近朋友，周末一起吃饭聊天。",
            },
            {
              title: "下班后一起运动",
              category: "运动搭子",
              city: "深圳",
              desc: "慢跑、羽毛球都可以，轻松一点。",
            },
            {
              title: "晚上自习搭子",
              category: "学习搭子",
              city: "上海",
              desc: "互相监督学习，适合备考和提升技能。",
            },
          ].map((item) => (
            <article
              key={item.title}
              className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200"
            >
              <div className="mb-3 flex flex-wrap gap-2 text-sm font-bold">
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">
                  {item.category}
                </span>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">
                  {item.city}
                </span>
              </div>

              <h2 className="text-2xl font-black">{item.title}</h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                {item.desc}
              </p>

              <Link
                href={`/partners?category=${encodeURIComponent(item.category)}`}
                className="mt-5 inline-flex rounded-2xl bg-emerald-500 px-5 py-3 text-sm font-bold text-white"
              >
                查看同类搭子
              </Link>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
