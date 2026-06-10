/**
 * 统一环境变量入口
 * - 缺失时立即抛错，比 "undefined 转 URL 报 TypeError" 友好得多
 * - AI 编码（Codex）能稳定识别这些字段，不会拼错
 */
function required(name: string, value: string | undefined): string {
  if (!value || value.length === 0) {
    throw new Error(
      `Missing required env var: ${name}\n` +
      `复制 .env.example 为 .env.local 并填入真实值后重启 dev server。`
    );
  }
  return value;
}

export const env = {
  // 前端可见（必须以 NEXT_PUBLIC_ 开头）
  NEXT_PUBLIC_SUPABASE_URL: required(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL
  ),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: required(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ),

  // 仅服务端可见（绝不暴露给浏览器）
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET ?? "",
} as const;
