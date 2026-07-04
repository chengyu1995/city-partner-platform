import Link from "next/link";

const categories = [
  { name: "饭搭子", desc: "约饭、探店、周末小聚", href: "/partners?category=饭搭子" },
  { name: "运动搭子", desc: "跑步、羽毛球、健身", href: "/partners?category=运动搭子" },
  { name: "学习搭子", desc: "自习、考证、技能提升", href: "/partners?category=学习搭子" },
  { name: "出游搭子", desc: "周边游、拍照、Citywalk", href: "/partners?category=出游搭子" },
  { name: "K歌搭子", desc: "唱歌、音乐、聚会", href: "/partners?category=K歌搭子" },
  { name: "旅游搭子", desc: "旅行计划、结伴出发", href: "/partners?category=旅游搭子" },
  { name: "摩友搭子", desc: "骑行、路线、周末出发", href: "/partners?category=摩友搭子" },
  { name: "钓友搭子", desc: "钓点、装备、约钓", href: "/partners?category=钓友搭子" },
];

const previewPosts = [
  { title: "周末一起探店吃饭", city: "广州", category: "饭搭子", desc: "找 1-2 位附近朋友，周末一起吃饭聊天。" },
  { title: "下班后一起运动", city: "深圳", category: "运动搭子", desc: "慢跑、羽毛球都可以，轻松一点。" },
  { title: "晚上自习搭子", city: "上海", category: "学习搭子", desc: "互相监督学习，适合备考和提升技能。" },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f8faf7] px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-6xl">
        <header className="mb-10 flex items-center justify-between border-b border-slate-200 pb-5">
          <Link href="/" className="text-xl font-black tracking-tight">
            同城搭子
          </Link>

          <nav className="flex items-center gap-4 text-sm font-bold text-slate-600">
            <Link href="/partners" className="hover:text-slate-950">
              找搭子
            </Link>
            <Link href="/post" className="rounded-full bg-slate-950 px-4 py-2 text-white hover:bg-slate-800">
              发布需求
            </Link>
          </nav>
        </header>

        <section className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.25em] text-emerald-600">
              City Partner
            </p>

            <h1 className="mt-4 max-w-3xl text-5xl font-black leading-tight tracking-tight sm:text-6xl lg:text-7xl">
              找到今天就能见面的同城搭子
            </h1>

            <p className="mt-5 max-w-2xl text-base leading-8 text-slate-600">
              找旅游、K 歌、学习、摩友、钓友、饭搭子。先看同城需求，再决定要不要联系。
            </p>

            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                href="/partners"
                className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-black text-white shadow-sm hover:bg-emerald-600"
              >
                找搭子
              </Link>

              <Link
                href="/post"
                className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-slate-950 px-6 text-sm font-black text-white shadow-sm hover:bg-slate-800"
              >
                发布需求
              </Link>
            </div>
          </div>

          <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-bold text-slate-500">今日新增</p>
            <p className="mt-4 text-6xl font-black">86</p>
            <p className="mt-3 text-sm text-slate-600">个同城邀约正在等待回应</p>
          </div>
        </section>

        <section className="mt-14">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <p className="text-sm font-black text-emerald-600">分类入口</p>
              <h2 className="mt-2 text-3xl font-black">按想做的事找搭子</h2>
            </div>
            <Link href="/partners" className="hidden text-sm font-black text-slate-700 hover:text-slate-950 sm:block">
              查看全部
            </Link>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {categories.map((category) => (
              <Link
                key={category.name}
                href={category.href}
                className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <h3 className="text-xl font-black">{category.name}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">{category.desc}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="mt-14">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <p className="text-sm font-black text-emerald-600">推荐搭子</p>
              <h2 className="mt-2 text-3xl font-black">附近正在发起的邀约</h2>
            </div>
            <Link href="/partners" className="hidden text-sm font-black text-slate-700 hover:text-slate-950 sm:block">
              浏览推荐
            </Link>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {previewPosts.map((post) => (
              <article key={post.title} className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
                <div className="flex flex-wrap gap-2 text-xs font-bold text-slate-500">
                  <span>{post.city}</span>
                  <span>{post.category}</span>
                </div>
                <h3 className="mt-3 text-xl font-black">{post.title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">{post.desc}</p>
                <Link
                  href={`/partners?city=${encodeURIComponent(post.city)}&category=${encodeURIComponent(post.category)}`}
                  className="mt-5 inline-flex min-h-11 items-center rounded-2xl bg-slate-950 px-5 text-sm font-black text-white hover:bg-slate-800"
                >
                  查看同类搭子
                </Link>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-14 rounded-3xl bg-slate-950 p-6 text-white">
          <h2 className="text-2xl font-black">安全提示</h2>
          <ul className="mt-4 grid gap-3 text-sm leading-6 text-slate-200 md:grid-cols-3">
            <li>线下见面建议选择公共场所。</li>
            <li>不要提前转账，不要轻信陌生人借钱。</li>
            <li>首次见面把行程告知朋友或家人。</li>
          </ul>
        </section>
      </section>
    </main>
  );
}
