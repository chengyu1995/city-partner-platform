import Link from "next/link";

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

export default function PostPage() {
  return (
    <main className="min-h-screen bg-[#f8faf7] px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-5xl">
        <header className="mb-8 flex items-center justify-between gap-4 border-b border-slate-200 pb-5">
          <Link href="/" className="text-xl font-black tracking-tight">
            同城搭子
          </Link>

          <nav className="flex items-center gap-3 text-sm font-bold text-slate-600">
            <Link href="/" className="hover:text-slate-950">
              首页
            </Link>
            <Link href="/partners" className="hover:text-slate-950">
              找搭子
            </Link>
          </nav>
        </header>

        <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <aside className="rounded-3xl bg-slate-950 p-6 text-white shadow-sm">
            <p className="text-sm font-black uppercase tracking-[0.25em] text-emerald-300">
              Publish
            </p>

            <h1 className="mt-4 text-4xl font-black leading-tight tracking-tight sm:text-5xl">
              发布一个同城搭子需求
            </h1>

            <p className="mt-4 text-sm leading-7 text-slate-200">
              写清楚城市、时间、想找什么搭子和大概计划。当前是 MVP 前端演示，提交后不会真正保存。
            </p>

            <div className="mt-6 rounded-2xl bg-white/10 p-4 text-sm leading-6 text-slate-100">
              <p className="font-black">安全提醒</p>
              <ul className="mt-3 space-y-2">
                <li>不要提前转账。</li>
                <li>首次见面选择公共场所。</li>
                <li>不要泄露身份证、银行卡、家庭住址等隐私。</li>
              </ul>
            </div>
          </aside>

          <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:p-6">
            <div className="mb-6">
              <h2 className="text-2xl font-black">填写搭子需求</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                当前页面只做前端展示，不会写入 Supabase，也不会创建执行任务。
              </p>
            </div>

            <form className="grid gap-4">
              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">城市</span>
                <input
                  className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-emerald-400 focus:bg-white"
                  placeholder="例如：广州、深圳、上海"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">搭子分类</span>
                <select className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-emerald-400 focus:bg-white">
                  {categories.map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </select>
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">标题</span>
                <input
                  className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-emerald-400 focus:bg-white"
                  placeholder="例如：周末一起探店吃饭"
                />
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">活动时间</span>
                  <input
                    className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-emerald-400 focus:bg-white"
                    placeholder="例如：本周六晚上"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">期望人数</span>
                  <input
                    className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-emerald-400 focus:bg-white"
                    placeholder="例如：2-4 人"
                  />
                </label>
              </div>

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">详细说明</span>
                <textarea
                  className="min-h-32 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-emerald-400 focus:bg-white"
                  placeholder="写清楚活动内容、集合地点、注意事项等。"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">联系方式或备注</span>
                <input
                  className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-emerald-400 focus:bg-white"
                  placeholder="当前演示不建议填写真实隐私信息"
                />
              </label>

              <div className="rounded-2xl bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                当前为 MVP 前端演示。点击按钮只表示生成发布预览，正式保存功能将在后续接入。
              </div>

              <button
                type="button"
                className="min-h-12 rounded-2xl bg-emerald-500 px-5 text-sm font-black text-white shadow-sm transition hover:bg-emerald-600"
              >
                已生成发布预览，下一步接入真实保存
              </button>

              <Link
                href="/partners"
                className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-slate-950 px-5 text-sm font-black text-white transition hover:bg-slate-800"
              >
                返回找搭子
              </Link>
            </form>
          </section>
        </div>
      </section>
    </main>
  );
}
