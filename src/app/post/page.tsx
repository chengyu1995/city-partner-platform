"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import {
  createLocalPostDraft,
  saveLocalPostDraft,
  type LocalPostDraft,
  type LocalPostDraftInput,
  type LocalPostDraftStatus,
} from "@/lib/local-drafts";

const cities = ["惠州", "广州", "深圳", "上海"];
const categories = ["饭搭子", "运动搭子", "学习搭子", "出游搭子", "K 歌搭子", "摩友搭子", "钓友搭子"];
const contactTypes = ["微信", "手机号", "其他方式"];

type RequiredDraftField =
  | "city"
  | "category"
  | "title"
  | "startsAt"
  | "location"
  | "capacity"
  | "description"
  | "hostName"
  | "contactType"
  | "contactValue";

type DraftErrors = Partial<Record<RequiredDraftField, string>>;

const requiredMessages: Record<RequiredDraftField, string> = {
  city: "请填写或选择城市",
  category: "请选择搭子分类",
  title: "请用一句话说明你想找什么搭子",
  startsAt: "请填写活动时间",
  location: "请填写集合地点或活动地点",
  capacity: "请填写期望人数",
  description: "请补充活动内容和要求",
  hostName: "请填写一个用于展示的称呼",
  contactType: "请选择联系方式类型",
  contactValue: "请填写联系方式",
};

function getFormValue(formData: FormData, key: keyof LocalPostDraftInput) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function validateDraft(draft: LocalPostDraftInput) {
  const errors: DraftErrors = {};
  const requiredFields = Object.keys(requiredMessages) as RequiredDraftField[];

  for (const field of requiredFields) {
    if (!draft[field]) errors[field] = requiredMessages[field];
  }

  return errors;
}

function readDraftInput(formData: FormData): LocalPostDraftInput {
  return {
    city: getFormValue(formData, "city"),
    category: getFormValue(formData, "category"),
    title: getFormValue(formData, "title"),
    startsAt: getFormValue(formData, "startsAt"),
    endsAt: getFormValue(formData, "endsAt"),
    location: getFormValue(formData, "location"),
    capacity: getFormValue(formData, "capacity"),
    description: getFormValue(formData, "description"),
    targetPeople: getFormValue(formData, "targetPeople"),
    budgetNote: getFormValue(formData, "budgetNote"),
    notes: getFormValue(formData, "notes"),
    hostName: getFormValue(formData, "hostName"),
    contactType: getFormValue(formData, "contactType"),
    contactValue: getFormValue(formData, "contactValue"),
  };
}

function fieldClass(hasError?: boolean) {
  return `min-h-12 rounded-2xl border bg-slate-50 px-4 text-base outline-none focus:bg-white ${
    hasError ? "border-red-300 focus:border-red-400" : "border-slate-200 focus:border-emerald-400"
  }`;
}

export default function PostPage() {
  const [draft, setDraft] = useState<LocalPostDraft | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saveState, setSaveState] = useState<"idle" | "saved" | "duplicate" | "unavailable">("idle");
  const [lastAction, setLastAction] = useState<LocalPostDraftStatus>("draft");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const intent = formData.get("intent") === "pending_review" ? "pending_review" : "draft";
    const nextInput = readDraftInput(formData);
    const nextErrors = validateDraft(nextInput);

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const nextDraft = createLocalPostDraft(nextInput, intent);
    const saveResult = saveLocalPostDraft(nextDraft);

    setDraft(saveResult.draft);
    setSaveState(saveResult.status);
    setLastAction(intent);
  }

  const hasErrors = Object.keys(errors).length > 0;
  const successTitle =
    lastAction === "pending_review"
      ? "已提交待审核"
      : saveState === "duplicate"
        ? "这条需求已经在本地草稿中"
        : "已保存为本地草稿";
  const successDescription =
    lastAction === "pending_review"
      ? "这条需求还不会直接公开，审核和联系方式展示策略会在后续批次确认。"
      : "草稿只保存在当前设备或当前浏览环境，后续可以继续编辑。";

  return (
    <main className="min-h-screen bg-[#f7faf8] px-4 py-5 text-slate-950 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-5xl">
        <header className="mb-6 flex flex-col gap-4 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/" className="text-lg font-black tracking-tight sm:text-xl">
            同城搭子
          </Link>

          <nav className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-600">
            <Link href="/" className="inline-flex min-h-11 items-center rounded-full px-3 hover:text-slate-950">
              返回首页
            </Link>
            <Link
              href="/partners"
              className="inline-flex min-h-11 items-center rounded-full bg-white px-4 shadow-sm ring-1 ring-slate-200 hover:text-slate-950"
            >
              返回列表
            </Link>
          </nav>
        </header>

        <section className="mb-5 rounded-3xl bg-slate-950 p-5 text-white shadow-sm sm:p-7">
          <h1 className="text-3xl font-black leading-tight tracking-tight sm:text-5xl">发布搭子需求</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-200">
            先填写基础信息，MVP 第一阶段会保存为本地草稿或进入待审核。提交后不会立即公开，后续审核和联系方式展示策略需要单独确认。
          </p>
        </section>

        <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:p-6">
          <form className="grid gap-5" onSubmit={handleSubmit} noValidate>
            {hasErrors ? (
              <div className="rounded-2xl bg-red-50 p-4 text-sm leading-6 text-red-700 ring-1 ring-red-100" role="alert">
                <p className="font-black">还有必填信息没填</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {Object.values(errors).map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <fieldset className="grid gap-4">
              <legend className="text-lg font-black">基础归类</legend>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">城市</span>
                  <select name="city" className={fieldClass(Boolean(errors.city))} defaultValue="" aria-invalid={Boolean(errors.city)}>
                    <option value="" disabled>
                      选择或填写城市，例如惠州、广州、深圳、上海
                    </option>
                    {cities.map((city) => (
                      <option key={city} value={city}>
                        {city}
                      </option>
                    ))}
                  </select>
                  {errors.city ? <span className="text-sm text-red-600">{errors.city}</span> : null}
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">分类</span>
                  <select
                    name="category"
                    className={fieldClass(Boolean(errors.category))}
                    defaultValue=""
                    aria-invalid={Boolean(errors.category)}
                  >
                    <option value="" disabled>
                      选择你想找的搭子类型
                    </option>
                    {categories.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                  {errors.category ? <span className="text-sm text-red-600">{errors.category}</span> : null}
                </label>
              </div>
            </fieldset>

            <fieldset className="grid gap-4">
              <legend className="text-lg font-black">活动摘要</legend>

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">标题</span>
                <input
                  name="title"
                  className={fieldClass(Boolean(errors.title))}
                  placeholder="例如：周六下午找羽毛球搭子"
                  aria-invalid={Boolean(errors.title)}
                />
                {errors.title ? <span className="text-sm text-red-600">{errors.title}</span> : null}
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">时间</span>
                  <input
                    name="startsAt"
                    className={fieldClass(Boolean(errors.startsAt))}
                    placeholder="写清楚日期和大概时段"
                    aria-invalid={Boolean(errors.startsAt)}
                  />
                  {errors.startsAt ? <span className="text-sm text-red-600">{errors.startsAt}</span> : null}
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">结束时间</span>
                  <input name="endsAt" className={fieldClass()} placeholder="可选，例如周六 17:00" />
                </label>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">地点</span>
                  <input
                    name="location"
                    className={fieldClass(Boolean(errors.location))}
                    placeholder="例如商圈、地标、球馆或集合点"
                    aria-invalid={Boolean(errors.location)}
                  />
                  {errors.location ? <span className="text-sm text-red-600">{errors.location}</span> : null}
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">期望人数</span>
                  <input
                    name="capacity"
                    className={fieldClass(Boolean(errors.capacity))}
                    placeholder="包含自己在内的总人数"
                    aria-invalid={Boolean(errors.capacity)}
                  />
                  {errors.capacity ? <span className="text-sm text-red-600">{errors.capacity}</span> : null}
                </label>
              </div>
            </fieldset>

            <fieldset className="grid gap-4">
              <legend className="text-lg font-black">详细说明</legend>

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">需求说明</span>
                <textarea
                  name="description"
                  className={`min-h-32 rounded-2xl border bg-slate-50 px-4 py-3 text-base outline-none focus:bg-white ${
                    errors.description ? "border-red-300 focus:border-red-400" : "border-slate-200 focus:border-emerald-400"
                  }`}
                  placeholder="说清楚活动内容、节奏和希望对方了解的信息"
                  aria-invalid={Boolean(errors.description)}
                />
                {errors.description ? <span className="text-sm text-red-600">{errors.description}</span> : null}
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">适合人群</span>
                  <input name="targetPeople" className={fieldClass()} placeholder="可选，例如新手友好、同校同区等" />
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">预算说明</span>
                  <input name="budgetNote" className={fieldClass()} placeholder="可选，例如 AA、免费、预计人均" />
                </label>
              </div>

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">注意事项</span>
                <input name="notes" className={fieldClass()} placeholder="可选，例如装备、迟到、天气、路线风险" />
              </label>
            </fieldset>

            <fieldset className="grid gap-4">
              <legend className="text-lg font-black">联系信息</legend>

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">怎么称呼你</span>
                <input
                  name="hostName"
                  className={fieldClass(Boolean(errors.hostName))}
                  placeholder="用于草稿或审核展示"
                  aria-invalid={Boolean(errors.hostName)}
                />
                {errors.hostName ? <span className="text-sm text-red-600">{errors.hostName}</span> : null}
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">联系方式类型</span>
                  <select
                    name="contactType"
                    className={fieldClass(Boolean(errors.contactType))}
                    defaultValue=""
                    aria-invalid={Boolean(errors.contactType)}
                  >
                    <option value="" disabled>
                      微信、手机号或其他方式
                    </option>
                    {contactTypes.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                  {errors.contactType ? <span className="text-sm text-red-600">{errors.contactType}</span> : null}
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">联系方式</span>
                  <input
                    name="contactValue"
                    className={fieldClass(Boolean(errors.contactValue))}
                    placeholder="本阶段不直接设计公开策略"
                    aria-invalid={Boolean(errors.contactValue)}
                  />
                  {errors.contactValue ? <span className="text-sm text-red-600">{errors.contactValue}</span> : null}
                </label>
              </div>
            </fieldset>

            <div className="grid gap-3 rounded-2xl bg-amber-50 p-4 text-sm leading-6 text-amber-900">
              <p>请不要填写身份证号、银行卡号、密码等敏感信息。</p>
              <p>本地草稿只保存在当前设备或当前浏览环境，换设备可能看不到。</p>
              <p>提交待审核不代表已经公开，也不代表平台完成安全背书。</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <button
                type="submit"
                name="intent"
                value="pending_review"
                className="min-h-12 rounded-2xl bg-emerald-500 px-5 text-sm font-black text-white shadow-sm transition hover:bg-emerald-600"
              >
                提交待审核
              </button>
              <button
                type="submit"
                name="intent"
                value="draft"
                className="min-h-12 rounded-2xl bg-slate-950 px-5 text-sm font-black text-white shadow-sm transition hover:bg-slate-800"
              >
                保存草稿
              </button>
              <Link
                href="/partners"
                className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-white px-5 text-sm font-black text-slate-950 shadow-sm ring-1 ring-slate-200 hover:bg-slate-100"
              >
                返回列表
              </Link>
            </div>

            {draft ? (
              <section className="rounded-3xl bg-emerald-50 p-5 text-slate-900 ring-1 ring-emerald-100" aria-live="polite">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-xl font-black text-emerald-800">{successTitle}</h2>
                    <p className="mt-2 text-sm leading-6 text-emerald-900">
                      {saveState === "unavailable"
                        ? "已生成页面内预览，但当前浏览器无法写入本地草稿。"
                        : successDescription}
                    </p>
                  </div>
                  <Link
                    href="/partners"
                    className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-2xl bg-slate-950 px-5 text-sm font-black text-white hover:bg-slate-800"
                  >
                    返回列表
                  </Link>
                </div>

                <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-emerald-100">
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-black text-amber-800">
                      {draft.status === "draft" ? "草稿" : "待审核"}
                    </span>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                      暂不公开联系方式
                    </span>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                      {draft.city}
                    </span>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                      {draft.category}
                    </span>
                  </div>
                  <h3 className="mt-3 text-xl font-black">{draft.title}</h3>
                  <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="font-bold text-slate-500">时间</dt>
                      <dd className="mt-1 font-semibold">{draft.startsAt}</dd>
                    </div>
                    <div>
                      <dt className="font-bold text-slate-500">地点</dt>
                      <dd className="mt-1 font-semibold">{draft.location}</dd>
                    </div>
                    <div>
                      <dt className="font-bold text-slate-500">人数</dt>
                      <dd className="mt-1 font-semibold">{draft.capacity}</dd>
                    </div>
                    <div>
                      <dt className="font-bold text-slate-500">昵称</dt>
                      <dd className="mt-1 font-semibold">{draft.hostName}</dd>
                    </div>
                  </dl>
                  <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-slate-700">{draft.description}</p>
                </div>
              </section>
            ) : null}
          </form>
        </section>
      </section>
    </main>
  );
}
