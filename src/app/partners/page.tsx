import Link from "next/link";

const CATEGORIES = ["旅游搭子", "K 歌搭子", "学习搭子", "摩友搭子", "钓友搭子"] as const;
const CITIES = ["广州", "深圳", "杭州", "上海", "北京", "成都"] as const;

type PartnerCategory = (typeof CATEGORIES)[number];

type PartnerPost = {
  id: string;
  title: string;
  city: string;
  category: PartnerCategory;
  activeText: string;
  description: string;
  hostName: string;
  slots: string;
};

type PartnersPageProps = {
  searchParams: Promise<{
    city?: string | string[];
    category?: string | string[];
  }>;
};

const MOCK_PARTNERS: PartnerPost[] = [
  {
    id: "guangzhou-weekend-travel",
    title: "周末广州老城区 Citywalk，找 2 位拍照搭子",
    city: "广州",
    category: "旅游搭子",
    activeText: "本周六 14:00",
    description: "路线从东山口到永庆坊，节奏轻松，想边走边拍照，晚饭可一起 AA。",
    hostName: "阿宁",
    slots: "还差 2 人",
  },
  {
    id: "guangzhou-karaoke-night",
    title: "天河周五 K 歌局，粤语歌和流行歌都可",
    city: "广州",
    category: "K 歌搭子",
    activeText: "周五 20:00",
    description: "已有 3 人，想再找 2-3 位一起唱，接受新手，费用 AA。",
    hostName: "小宇",
    slots: "还差 3 人",
  },
  {
    id: "shenzhen-study-sunday",
    title: "南山咖啡店自习 3 小时，互相监督不摸鱼",
    city: "深圳",
    category: "学习搭子",
    activeText: "周日 10:00",
    description: "适合备考、读书、写代码，安静为主，中途可以一起吃午饭。",
    hostName: "Mia",
    slots: "还差 1 人",
  },
  {
    id: "hangzhou-motorcycle-route",
    title: "杭州周边短途骑行，新手友好不压弯",
    city: "杭州",
    category: "摩友搭子",
    activeText: "48 小时内活跃",
    description: "计划走临安方向，白天出发傍晚返回，安全骑行，拒绝危险驾驶。",
    hostName: "川野",
    slots: "还差 2 人",
  },
  {
    id: "shanghai-fishing-morning",
    title: "浦东清晨路亚，找同频钓友交流装备",
    city: "上海",
    category: "钓友搭子",
    activeText: "明早 06:30",
    description: "自带装备，地点公开水域，主要交流经验，不做商业组织。",
    hostName: "老周",
    slots: "还差 1 人",
  },
  {
    id: "beijing-travel-museum",
    title: "北京看展搭子，先逛美术馆再喝咖啡",
    city: "北京",
    category: "旅游搭子",
    activeText: "本周日 15:00",
    description: "想找对展览感兴趣的朋友一起看展，行程半天，不赶时间。",
    hostName: "青柠",
    slots: "还差 2 人",
  },
];

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeCategory(value: string | undefined): PartnerCategory | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  const directMatch = CATEGORIES.find((category) => category === trimmed);
  if (directMatch) return directMatch;

  return CATEGORIES.find((category) => category.replace("搭子", "").replace(" ", "") === trimmed.replace(" ", ""));
}

function partnersHref(next: { city?: string; category?: string }) {
  const params = new URLSearchParams();
  if (next.city) params.set("city", next.city);
  if (next.category) params.set("category", next.category);
  const query = params.toString();
  return query ? `/partners?${query}` : "/partners";
}

function categoryHref(category: PartnerCategory) {
  return partnersHref({ category });
}

function cityHref(city: string) {
  return partnersHref({ city });
}

export default async function PartnersPage({ searchParams }: PartnersPageProps) {
  const params = await searchParams;
  const selectedCity = firstValue(params.city)?.trim();
  const selectedCategory = normalizeCategory(firstValue(params.category));

  const filteredPartners = MOCK_PARTNERS.filter((partner) => {
    const cityMatched = selectedCity ? partner.city === selectedCity : true;
    const categoryMatched = selectedCategory ? partner.category === selectedCategory : true;
    return cityMatched && categoryMatched;
  });

  return (
    <main className="min-h-screen bg-[#f8faf7] text-slate-900">
      <section className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200/80 sm:p-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <Link href="/" className="text-sm font-bold text-emerald-700 hover:text-emerald-800">
                同城搭子
              </Link>
              <h1 className="mt-3 text-3xl font-black leading-tight tracking-normal text-slate-950 sm:text-4xl">
                找同城搭子
              </h1>
              <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
                按城市和兴趣快速筛选旅游、K 歌、学习、骑行、钓鱼搭子，先从轻量浏览开始。
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {selectedCity && (
                <span className="inline-flex min-h-10 items-center rounded-full bg-emerald-50 px-4 text-sm font-bold text-emerald-700 ring-1 ring-emerald-100">
                  城市：{selectedCity}
                </span>
              )}
              {selectedCategory && (
                <span className="inline-flex min-h-10 items-center rounded-full bg-sky-50 px-4 text-sm font-bold text-sky-700 ring-1 ring-sky-100">
                  分类：{selectedCategory}
                </span>
              )}
              {(selectedCity || selectedCategory) && (
                <Link
                  href="/partners"
                  className="inline-flex min-h-10 items-center rounded-full bg-slate-100 px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-200"
                >
                  清除筛选
                </Link>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-4 sm:px-6 lg:px-8">
        <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
          <form action="/partners" method="get" className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200/80">
            <p className="text-sm font-bold text-emerald-700">搜索 / 筛选</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <label className="block">
                <span className="text-sm font-semibold text-slate-700">城市</span>
                <input
                  name="city"
                  defaultValue={selectedCity ?? ""}
                  placeholder="例如：广州"
                  className="mt-2 min-h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-base outline-none transition focus:border-emerald-300 focus:bg-white focus:ring-4 focus:ring-emerald-100"
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-slate-700">分类</span>
                <select
                  name="category"
                  defaultValue={selectedCategory ?? ""}
                  className="mt-2 min-h-12 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 text-base outline-none transition focus:border-emerald-300 focus:bg-white focus:ring-4 focus:ring-emerald-100"
                >
                  <option value="">全部分类</option>
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="min-h-12 self-end rounded-2xl bg-slate-950 px-6 text-base font-bold text-white transition hover:bg-slate-800"
              >
                筛选
              </button>
            </div>
          </form>

          <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200/80">
            <p className="text-sm font-bold text-emerald-700">城市筛选入口</p>
            <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
              <Link
                href="/partners"
                className={`inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-sm font-bold transition ${
                  selectedCity ? "bg-slate-100 text-slate-700 hover:bg-slate-200" : "bg-slate-950 text-white"
                }`}
              >
                全部城市
              </Link>
              {CITIES.map((city) => (
                <Link
                  key={city}
                  href={cityHref(city)}
                  className={`inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-sm font-bold transition ${
                    selectedCity === city
                      ? "bg-emerald-500 text-white"
                      : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                  }`}
                >
                  {city}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200/80">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-bold text-emerald-700">分类筛选入口</p>
              <h2 className="mt-1 text-2xl font-black text-slate-950">按兴趣找搭子</h2>
            </div>
            <span className="hidden rounded-full bg-slate-100 px-4 py-2 text-sm font-bold text-slate-600 sm:inline-flex">
              {filteredPartners.length} 条结果
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Link
              href="/partners"
              className={`min-h-14 rounded-2xl px-4 py-3 text-center text-sm font-black transition ${
                selectedCategory
                  ? "bg-slate-50 text-slate-700 ring-1 ring-slate-100 hover:bg-white hover:shadow-sm"
                  : "bg-slate-950 text-white shadow-md"
              }`}
            >
              全部分类
            </Link>
            {CATEGORIES.map((category) => (
              <Link
                key={category}
                href={categoryHref(category)}
                className={`min-h-14 rounded-2xl px-4 py-3 text-center text-sm font-black transition ${
                  selectedCategory === category
                    ? "bg-slate-950 text-white shadow-md"
                    : "bg-slate-50 text-slate-700 ring-1 ring-slate-100 hover:bg-white hover:shadow-sm"
                }`}
              >
                {category}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-4 sm:px-6 lg:px-8">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-bold text-emerald-700">搭子卡片列表</p>
            <h2 className="mt-1 text-2xl font-black text-slate-950">正在找人的搭子需求</h2>
          </div>
          <span className="rounded-full bg-white px-4 py-2 text-sm font-bold text-slate-600 shadow-sm ring-1 ring-slate-200/80">
            {filteredPartners.length} 条
          </span>
        </div>

        {filteredPartners.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2">
            {filteredPartners.map((partner) => (
              <article
                key={partner.id}
                className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200/80 transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                  <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700">{partner.city}</span>
                  <span className="rounded-full bg-sky-50 px-3 py-1 text-sky-700">{partner.category}</span>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">{partner.activeText}</span>
                </div>
                <h3 className="mt-4 text-xl font-black leading-7 text-slate-950">{partner.title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">{partner.description}</p>
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                  <div>
                    <p className="text-sm font-bold text-slate-900">发起人：{partner.hostName}</p>
                    <p className="mt-1 text-sm text-slate-500">{partner.slots}</p>
                  </div>
                  <Link
                    href={partnersHref({ city: partner.city, category: partner.category })}
                    className="inline-flex min-h-11 items-center justify-center rounded-2xl bg-emerald-500 px-5 text-sm font-bold text-white transition hover:bg-emerald-600"
                  >
                    想一起
                  </Link>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="rounded-3xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200/80">
            <p className="text-2xl font-black text-slate-950">暂时没有符合条件的搭子</p>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-500">
              可以换一个城市或分类看看。后续接入发布页和真实数据后，这里会展示更多同城需求。
            </p>
            <Link
              href="/partners"
              className="mt-5 inline-flex min-h-11 items-center rounded-2xl bg-slate-950 px-5 text-sm font-bold text-white transition hover:bg-slate-800"
            >
              查看全部搭子
            </Link>
          </div>
        )}
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-12 pt-4 sm:px-6 lg:px-8">
        <div className="rounded-3xl bg-slate-950 p-5 text-white shadow-sm sm:p-6">
          <p className="text-sm font-bold text-emerald-300">安全提示</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {["线下见面注意安全", "不提前转账", "首次见面建议选择公共场所"].map((tip) => (
              <div key={tip} className="rounded-2xl bg-white/10 p-4 text-sm font-bold leading-6 ring-1 ring-white/10">
                {tip}
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
