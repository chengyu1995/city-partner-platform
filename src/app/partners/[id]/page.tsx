/**
 * 搭子详情页
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPartnerPost } from "@/lib/db";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { ReportButton } from "./ReportButton";

const partnerCategoryMeta: Record<string, { label: string; emoji: string; color: string }> = {
  饭搭子: { label: "饭搭子", emoji: "🍜", color: "from-orange-500 to-amber-400" },
  运动搭子: { label: "运动搭子", emoji: "🏸", color: "from-emerald-500 to-teal-400" },
  学习搭子: { label: "学习搭子", emoji: "📚", color: "from-blue-500 to-cyan-400" },
  出游搭子: { label: "出游搭子", emoji: "🧳", color: "from-sky-500 to-indigo-400" },
  "K 歌搭子": { label: "K 歌搭子", emoji: "🎤", color: "from-pink-500 to-rose-400" },
  摩友搭子: { label: "摩友搭子", emoji: "🏍️", color: "from-violet-500 to-purple-400" },
  钓友搭子: { label: "钓友搭子", emoji: "🎣", color: "from-lime-500 to-emerald-400" },
};

const fallbackCategoryMeta = {
  label: "搭子需求",
  emoji: "📌",
  color: "from-slate-500 to-slate-400",
};

function getPartnerCategoryMeta(category: string) {
  return partnerCategoryMeta[category] ?? fallbackCategoryMeta;
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const post = await getPartnerPost(id);
  if (!post) return { title: "搭子详情 - 同城搭子" };
  const cat = getPartnerCategoryMeta(post.category);
  return {
    title: `${post.title} - ${post.city} ${cat.label} | 同城搭子`,
    description: `${post.description.slice(0, 100)}... ${post.city} ${cat.label}，当前阶段联系方式暂不公开。`,
    openGraph: {
      title: post.title,
      description: post.description.slice(0, 200),
      type: "article",
      locale: "zh_CN",
    },
  };
}

export default async function PartnerDetailPage({ params }: Props) {
  const { id } = await params;
  const post = await getPartnerPost(id);
  if (!post) notFound();

  const meta = getPartnerCategoryMeta(post.category);

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-amber-50">
      <div className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
        <Link href="/partners" className="mb-6 inline-flex items-center text-sm text-slate-500 hover:text-slate-700">
          ← 返回列表
        </Link>

        {/* 顶条 */}
        <div className={`overflow-hidden rounded-3xl bg-gradient-to-r ${meta.color} p-6 text-white shadow-xl`}>
          <div className="flex items-center gap-2 text-sm font-bold opacity-90">
            <span className="text-2xl">{meta.emoji}</span>
            <span>{post.category}</span>
          </div>
          <h1 className="mt-3 text-2xl font-extrabold sm:text-3xl">{post.title}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm opacity-90">
            <span>📍 {post.city}</span>
            {post.starts_at && (
              <span>🕐 {format(new Date(post.starts_at), "yyyy年M月d日 EEEE HH:mm", { locale: zhCN })}</span>
            )}
          </div>
        </div>

        {/* 内容 */}
        <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-bold text-slate-400">详情</h2>
          <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed text-slate-800">
            {post.description}
          </p>
        </div>

        {/* 联系方式 */}
        <div className="mt-4 rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-sm font-bold text-slate-400">联系信息</h2>
          <div className="mt-3">
            <div>
              <p className="text-lg font-bold text-slate-900">👤 {post.host_name}</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                暂不开放联系方式。联系方式展示策略不在本批实现，后续需要老板单独批准。
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6 text-center text-xs text-slate-400">
          发布于 {format(new Date(post.created_at), "yyyy-MM-dd HH:mm", { locale: zhCN })}
        </div>

        <div className="mt-4 flex justify-center">
          <ReportButton postId={post.id} />
        </div>
      </div>
    </div>
  );
}
