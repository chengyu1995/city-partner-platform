/**
 * 搭子需求数据访问层 —— 业务代码统一从这里读
 * 内部根据 IS_MOCK_MODE 自动走 mock / 真 Supabase
 */
import { IS_MOCK_MODE, getSupabaseServer } from "@/lib/env";
import {
  listPartnerPostsMock,
  getPartnerPostMock,
  createPartnerPostMock,
} from "./mock";
import type {
  PartnerPost,
  NewPartnerPost,
  PartnerCategory,
  PartnerPostFormErrors,
} from "@/types/db";

/** 读：搭子需求列表（按创建时间倒序） */
export async function listPartnerPosts(opts?: {
  category?: PartnerCategory;
  city?: string;
}): Promise<PartnerPost[]> {
  if (IS_MOCK_MODE) return listPartnerPostsMock(opts);

  const supabase = await getSupabaseServer();
  if (!supabase) return listPartnerPostsMock(opts);

  let q = supabase
    .from("partner_posts")
    .select("*")
    .eq("status", "approved")
    .order("created_at", { ascending: false });
  if (opts?.category) q = q.eq("category", opts.category);
  if (opts?.city) q = q.ilike("city", `%${opts.city}%`);

  const { data, error } = await q;
  if (error) {
    console.error("[db] listPartnerPosts error:", error);
    return [];
  }
  return (data ?? []) as PartnerPost[];
}

/** 读：单个搭子需求 */
export async function getPartnerPost(id: string): Promise<PartnerPost | null> {
  if (IS_MOCK_MODE) return getPartnerPostMock(id);

  const supabase = await getSupabaseServer();
  if (!supabase) return getPartnerPostMock(id);

  const { data, error } = await supabase
    .from("partner_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[db] getPartnerPost error:", error);
    return null;
  }
  return (data ?? null) as PartnerPost | null;
}

/** 写：新建搭子需求 */
export async function createPartnerPost(input: NewPartnerPost): Promise<PartnerPost> {
  if (IS_MOCK_MODE) return createPartnerPostMock(input);

  const supabase = await getSupabaseServer();
  if (!supabase) return createPartnerPostMock(input);

  const { data, error } = await supabase
    .from("partner_posts")
    .insert(input)
    .select()
    .single();

  if (error) {
    throw new Error(`[db] createPartnerPost failed: ${error.message}`);
  }
  return data as PartnerPost;
}

/** 表单校验 */
export function validatePartnerPostInput(input: Partial<NewPartnerPost>): PartnerPostFormErrors {
  const errors: PartnerPostFormErrors = {};
  if (!input.category) errors.category = "请选择分类";
  if (!input.city || input.city.trim().length < 1) errors.city = "请填写城市";
  if (input.city && input.city.length > 20) errors.city = "城市名不能超过 20 字";
  if (!input.title || input.title.trim().length < 2) errors.title = "标题至少 2 个字";
  if (input.title && input.title.length > 80) errors.title = "标题不能超过 80 字";
  if (!input.description || input.description.trim().length < 5) errors.description = "描述至少 5 个字";
  if (input.description && input.description.length > 500) errors.description = "描述不能超过 500 字";
  if (!input.contact || input.contact.trim() === "") errors.contact = "请填写联系方式";
  if (!input.host_name || input.host_name.trim() === "") errors.host_name = "请填写你的昵称";
  return errors;
}
