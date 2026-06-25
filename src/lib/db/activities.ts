/**
 * 活动数据访问层 —— 业务代码统一从这里读
 * 内部根据 IS_MOCK_MODE 自动走 mock / 真 Supabase
 *
 * Codex 写业务代码时只需要：
 *   import { listActivities, createActivity } from "@/lib/db/activities";
 *   const items = await listActivities();
 */
import { IS_MOCK_MODE, getSupabaseServer } from "@/lib/env";
import {
  listActivitiesMock,
  getActivityMock,
  createActivityMock,
} from "./mock";
import type { Activity, NewActivity, ActivityFormErrors } from "@/types/db";

/** 读：活动列表（按时间升序） */
export async function listActivities(): Promise<Activity[]> {
  if (IS_MOCK_MODE) return listActivitiesMock();

  const supabase = await getSupabaseServer();
  if (!supabase) return listActivitiesMock(); // 兜底

  const { data, error } = await supabase
    .from("activities")
    .select("*")
    .order("starts_at", { ascending: true });

  if (error) {
    console.error("[db] listActivities error:", error);
    return [];
  }
  return (data ?? []) as Activity[];
}

/** 读：单个活动 */
export async function getActivity(id: string): Promise<Activity | null> {
  if (IS_MOCK_MODE) return getActivityMock(id);

  const supabase = await getSupabaseServer();
  if (!supabase) return getActivityMock(id);

  const { data, error } = await supabase
    .from("activities")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[db] getActivity error:", error);
    return null;
  }
  return (data ?? null) as Activity | null;
}

/** 写：新建活动 */
export async function createActivity(input: NewActivity): Promise<Activity> {
  if (IS_MOCK_MODE) return createActivityMock(input);

  const supabase = await getSupabaseServer();
  if (!supabase) return createActivityMock(input);

  const { data, error } = await supabase
    .from("activities")
    .insert(input)
    .select()
    .single();

  if (error) {
    throw new Error(`[db] createActivity failed: ${error.message}`);
  }
  return data as Activity;
}

/** 客户端表单校验：返回错误对象，{} 表示通过 */
export function validateActivityInput(input: Partial<NewActivity>): ActivityFormErrors {
  const errors: ActivityFormErrors = {};
  if (!input.title || input.title.trim().length < 2) errors.title = "标题至少 2 个字";
  if (input.title && input.title.length > 80)        errors.title = "标题不能超过 80 字";
  if (!input.starts_at)                              errors.starts_at = "请选择开始时间";
  if (!input.location || input.location.trim() === "") errors.location = "请填写地点";
  if (input.capacity === undefined || input.capacity < 1) errors.capacity = "人数至少 1";
  if (input.capacity !== undefined && input.capacity > 1000) errors.capacity = "人数不能超过 1000";
  if (!input.host_name || input.host_name.trim() === "")   errors.host_name = "请填写发起人";
  return errors;
}
