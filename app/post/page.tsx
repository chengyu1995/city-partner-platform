"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import {
  createLocalPostDraft,
  saveLocalPostDraft,
  type LocalPostDraft,
  type LocalPostDraftInput,
} from "@/lib/local-drafts";

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

type DraftErrors = Partial<Record<keyof Pick<LocalPostDraftInput, "city" | "category" | "title" | "description">, string>>;

function getFormValue(formData: FormData, key: keyof LocalPostDraftInput) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function validateDraft(draft: LocalPostDraftInput) {
  const errors: DraftErrors = {};

  if (!draft.city) errors.city = "请填写城市。";
  if (!draft.category) errors.category = "请选择搭子分类。";
  if (!draft.title) errors.title = "请填写标题。";
  if (!draft.description) errors.description = "请填写详细说明。";

  return errors;
}

export default function PostPage() {
  const [draft, setDraft] = useState<LocalPostDraft | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saveState, setSaveState] = useState<"idle" | "saved" | "unavailable">("idle");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const nextInput: LocalPostDraftInput = {
      city: getFormValue(formData, "city"),
      category: getFormValue(formData, "category"),
      title: getFormValue(formData, "title"),
      activityTime: getFormValue(formData, "activityTime"),
      expectedPeople: getFormValue(formData, "expectedPeople"),
      description: getFormValue(formData, "description"),
      contactNote: getFormValue(formData, "contactNote"),
    };
    const nextErrors = validateDraft(nextInput);

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const nextDraft = createLocalPostDraft(nextInput);
    const saved = saveLocalPostDraft(nextDraft);

    setDraft(nextDraft);
    setSaveState(saved ? "saved" : "unavailable");
  }

  const hasErrors = Object.keys(errors).length > 0;

  return (
    <main className="min-h-screen bg-[#f8faf7] px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-5xl">
        <header className="mb-8 flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/" className="text-xl font-black tracking-tight">
            同城搭子
          </Link>

          <nav className="flex flex-wrap items-center gap-3 text-sm font-bold text-slate-600">
            <Link
              href="/"
              className="inline-flex min-h-11 items-center rounded-full bg-white px-4 shadow-sm ring-1 ring-slate-200 hover:text-slate-950"
            >
              返回首页
            </Link>
            <Link
              href="/partners"
              className="inline-flex min-h-11 items-center rounded-full bg-white px-4 shadow-sm ring-1 ring-slate-200 hover:text-slate-950"
            >
              返回找搭子
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
              写清楚城市、时间、想找什么搭子和大概计划。当前是 MVP 前端演示，提交后会保存为本机草稿并生成预览。
            </p>

            <div className="mt-6 rounded-2xl bg-white/10 p-4 text-sm leading-6 text-slate-100">
              <p className="font-black">安全提示</p>
              <ul className="mt-3 space-y-2">
                <li>线下见面选择公共场所。</li>
                <li>不提前转账。</li>
                <li>不泄露身份证、银行卡、住址等隐私。</li>
              </ul>
            </div>
          </aside>

          <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:p-6">
            <div className="mb-6">
              <h2 className="text-2xl font-black">填写搭子需求</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                当前页面只做本地草稿反馈，不会写入 Supabase，也不会创建执行任务。
              </p>
            </div>

            <form className="grid gap-4" onSubmit={handleSubmit} noValidate>
              {hasErrors ? (
                <div
                  className="rounded-2xl bg-red-50 p-4 text-sm leading-6 text-red-700 ring-1 ring-red-100"
                  role="alert"
                >
                  <p className="font-black">请先补全必填信息</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {Object.values(errors).map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">城市</span>
                <input
                  name="city"
                  className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-base outline-none focus:border-emerald-400 focus:bg-white"
                  placeholder="例如：广州、深圳、上海"
                  aria-invalid={Boolean(errors.city)}
                />
                {errors.city ? <span className="text-sm text-red-600">{errors.city}</span> : null}
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">搭子分类</span>
                <select
                  name="category"
                  className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-base outline-none focus:border-emerald-400 focus:bg-white"
                  defaultValue=""
                  aria-invalid={Boolean(errors.category)}
                >
                  <option value="" disabled>
                    请选择分类
                  </option>
                  {categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
                {errors.category ? <span className="text-sm text-red-600">{errors.category}</span> : null}
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">标题</span>
                <input
                  name="title"
                  className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-base outline-none focus:border-emerald-400 focus:bg-white"
                  placeholder="例如：周末一起探店吃饭"
                  aria-invalid={Boolean(errors.title)}
                />
                {errors.title ? <span className="text-sm text-red-600">{errors.title}</span> : null}
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">活动时间</span>
                  <input
                    name="activityTime"
                    className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-base outline-none focus:border-emerald-400 focus:bg-white"
                    placeholder="例如：本周六晚上"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-bold text-slate-700">期望人数</span>
                  <input
                    name="expectedPeople"
                    className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-base outline-none focus:border-emerald-400 focus:bg-white"
                    placeholder="例如：2-4 人"
                  />
                </label>
              </div>

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">详细说明</span>
                <textarea
                  name="description"
                  className="min-h-32 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base outline-none focus:border-emerald-400 focus:bg-white"
                  placeholder="写清楚活动内容、集合地点、注意事项等。"
                  aria-invalid={Boolean(errors.description)}
                />
                {errors.description ? <span className="text-sm text-red-600">{errors.description}</span> : null}
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-bold text-slate-700">联系方式或备注</span>
                <input
                  name="contactNote"
                  className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-base outline-none focus:border-emerald-400 focus:bg-white"
                  placeholder="当前演示不建议填写真实隐私信息"
                />
              </label>

              <div className="rounded-2xl bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                这是本机草稿，仅用于 MVP 预览。正式审核和保存功能将在后续接入，刷新或换设备可能看不到该草稿。
              </div>

              <button
                type="submit"
                className="min-h-12 rounded-2xl bg-emerald-500 px-5 text-sm font-black text-white shadow-sm transition hover:bg-emerald-600"
              >
                {draft ? "继续保存本地草稿" : "生成本地草稿"}
              </button>

              {draft ? (
                <section
                  className="rounded-3xl bg-emerald-50 p-5 text-slate-900 ring-1 ring-emerald-100"
                  aria-live="polite"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-black text-emerald-700">
                        {saveState === "saved"
                          ? "本机草稿已保存，可去搭子列表查看待审核预览"
                          : "已生成页面内预览，但当前浏览器无法写入本地草稿"}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-emerald-900">
                        这不是正式发布。正式审核和保存功能将在后续接入，刷新或换设备可能看不到该草稿。
                      </p>
                    </div>
                    <Link
                      href="/partners"
                      className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-2xl bg-slate-950 px-5 text-sm font-black text-white hover:bg-slate-800"
                    >
                      去找搭子列表查看
                    </Link>
                  </div>

                  <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-emerald-100">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-black text-amber-800">
                        本地草稿
                      </span>
                      <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-black text-emerald-700">
                        待审核
                      </span>
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                        {draft.category}
                      </span>
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                        {draft.city}
                      </span>
                    </div>
                    <h3 className="mt-3 text-xl font-black">{draft.title}</h3>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                      {draft.description}
                    </p>
                    <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="font-bold text-slate-500">活动时间</dt>
                        <dd className="mt-1 font-semibold">{draft.activityTime || "未填写"}</dd>
                      </div>
                      <div>
                        <dt className="font-bold text-slate-500">期望人数</dt>
                        <dd className="mt-1 font-semibold">{draft.expectedPeople || "未填写"}</dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="font-bold text-slate-500">联系方式或备注</dt>
                        <dd className="mt-1 font-semibold">{draft.contactNote || "未填写"}</dd>
                      </div>
                    </dl>
                  </div>
                </section>
              ) : null}
            </form>
          </section>
        </div>
      </section>
    </main>
  );
}
