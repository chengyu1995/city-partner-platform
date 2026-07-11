/**
 * 搭子详情页
 */
import Link from "next/link";
import type { Metadata } from "next";
import { getPartnerPost } from "@/lib/db";
import { mockPartnerPosts } from "@/lib/mock-partners";
import { PARTNER_CATEGORIES } from "@/types/db";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { ReportButton } from "./ReportButton";
import { CopyButton } from "./CopyButton";
import { LocalDraftDetail } from "./LocalDraftDetail";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Props {
  params: Promise<{ id: string }>;
}

type DetailPost = {
  id: string;
  category: string;
  city: string;
  title: string;
  description: string;
  contact: string;
  host_name: string;
  starts_at: string | null;
  starts_at_label?: string;
  created_at: string;
};

function decodePartnerId(id: string) {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

async function getDetailPost(id: string): Promise<DetailPost | null> {
  const post = await getPartnerPost(id);
  if (post) return post;

  const mockPost = mockPartnerPosts.find((item) => item.id === id);
  if (!mockPost) return null;

  return {
    id: mockPost.id,
    category: mockPost.category,
    city: mockPost.city,
    title: mockPost.title,
    description: mockPost.description,
    contact: "联系方式暂不公开",
    host_name: mockPost.hostName,
    starts_at: null,
    starts_at_label: mockPost.startsAt,
    created_at: mockPost.createdAt,
  };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id: rawId } = await params;
  const id = decodePartnerId(rawId);
  const post = await getDetailPost(id);
  if (!post) return { title: "搭子详情 - 同城搭子" };
  const cat = PARTNER_CATEGORIES.find((c) => c.key === post.category);
  return {
    title: `${post.title} - ${post.city} ${cat?.key ?? ""}搭子 | 同城搭子`,
    description: `${post.description.slice(0, 100)}... 📍 ${post.city} ${cat?.emoji ?? ""} ${cat?.key ?? ""}搭子, 快来联系 ${post.host_name}!`,
    openGraph: {
      title: post.title,
      description: post.description.slice(0, 200),
      type: "article",
      locale: "zh_CN",
    },
  };
}

export default async function PartnerDetailPage({ params }: Props) {
  const { id: rawId } = await params;
  const id = decodePartnerId(rawId);
  const post = await getDetailPost(id);
  if (!post) return <LocalDraftDetail id={id} />;

  const meta = PARTNER_CATEGORIES.find((c) => c.key === post.category) ?? {
    emoji: "📌",
    color: "from-slate-500 to-slate-400",
  };
  const startsAtText = post.starts_at
    ? format(new Date(post.starts_at), "yyyy年M月d日 EEEE HH:mm", { locale: zhCN })
    : post.starts_at_label;

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
            {startsAtText ? <span>🕐 {startsAtText}</span> : null}
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
          <h2 className="text-sm font-bold text-slate-400">联系发起人</h2>
          <div className="mt-3 flex items-center justify-between">
            <div>
              <p className="text-lg font-bold text-slate-900">👤 {post.host_name}</p>
              <p className="mt-1 text-base text-violet-600">{post.contact}</p>
            </div>
            <CopyButton text={post.contact} />
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
