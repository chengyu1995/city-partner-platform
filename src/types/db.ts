/**
 * 业务模型类型 —— 不依赖 Supabase CLI 自动生成
 * 当你在 Supabase 后台建好表后，把字段类型同步到这里即可
 */

export interface Activity {
  id: string;
  title: string;
  starts_at: string;            // ISO 8601 timestamptz
  location: string;
  capacity: number;
  host_name: string;
  created_at: string;
}

export type NewActivity = Omit<Activity, "id" | "created_at">;

/** 用于表单校验的错误对象 */
export type ActivityFormErrors = Partial<Record<keyof NewActivity, string>>;

/* ============================================================
 * 搭子需求发布 (partner_posts)
 * ========================================================== */

export type PartnerCategory = "旅游" | "K歌" | "学习" | "摩友" | "钓友";

export const PARTNER_CATEGORIES: { key: PartnerCategory; emoji: string; color: string }[] = [
  { key: "旅游", emoji: "✈️", color: "from-blue-500 to-cyan-400" },
  { key: "K歌", emoji: "🎤", color: "from-pink-500 to-rose-400" },
  { key: "学习", emoji: "📚", color: "from-amber-500 to-orange-400" },
  { key: "摩友", emoji: "🏍️", color: "from-violet-500 to-purple-400" },
  { key: "钓友", emoji: "🎣", color: "from-emerald-500 to-teal-400" },
];

export interface PartnerPost {
  id: string;
  category: PartnerCategory;
  city: string;
  title: string;
  description: string;
  contact: string;
  host_name: string;
  starts_at: string | null;     // ISO 8601 timestamptz
  created_at: string;
  status: "pending" | "approved" | "rejected";
}

export type NewPartnerPost = Omit<PartnerPost, "id" | "created_at">;

export type PartnerPostFormErrors = Partial<Record<keyof NewPartnerPost, string>>;
