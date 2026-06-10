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
