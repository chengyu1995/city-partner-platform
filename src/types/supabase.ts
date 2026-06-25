/**
 * Supabase 数据库类型声明
 * - 后续可用 `supabase gen types typescript --project-id <id> > src/types/supabase.ts` 自动生成完整版本
 * - 现在先放基础结构，Codex 也能识别 "Database['public']['Tables']['xxx']" 这种访问模式
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      // 占位：等接入真实表后填入（或用 CLI 自动生成覆盖）
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}
