/**
 * 环境变量入口 —— 安全 mock 模式
 *
 * 设计原则：
 * - 在本地开发初期 (Supabase 还没建) 也能跑起来，让 Codex 可以边写代码边 build
 * - 所有 env 缺失 → 走 mock 实现（用进程内 in-memory 假数据）
 * - 一旦填入真 key，env 验证通过，自动切到真 Supabase
 * - 客户端代码完全无感：始终 import @/lib/db
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const _URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const _ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
const _SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";

export const IS_MOCK_MODE = !_URL || !_ANON;

if (IS_MOCK_MODE && process.env.NODE_ENV !== "test") {
   
  console.warn(
    "[supabase] env vars 缺失，进入 MOCK 模式。\n" +
      "  复制 .env.example 为 .env.local 并填入 Supabase 后台真值后，\n" +
      "  重启 dev server 即可切到真实数据库。\n" +
      "  当前 mock 数据仅在进程内有效，重启后清空。"
  );
}

export const env = {
  NEXT_PUBLIC_SUPABASE_URL: _URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: _ANON,
  SUPABASE_SERVICE_ROLE_KEY: _SERVICE,
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET?.trim() ?? "",
} as const;

/** 浏览器端 supabase：mock 时返回 null，调用方用 IS_MOCK_MODE 走 mock 分支 */
export async function getSupabaseBrowser(): Promise<SupabaseClient | null> {
  if (IS_MOCK_MODE) return null;
  const { createBrowserClient } = await import("@supabase/ssr");
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/** 服务端 supabase：mock 时返回 null */
export async function getSupabaseServer(): Promise<SupabaseClient | null> {
  if (IS_MOCK_MODE) return null;
  const { createServerClient } = await import("@supabase/ssr");
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cs) => {
        try { cs.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); }
        catch { /* RSC 中 set cookies 抛错，忽略 */ }
      },
    },
  });
}

/** service-role：mock 时返回 null，需要 service key */
export async function getSupabaseService(): Promise<SupabaseClient | null> {
  if (IS_MOCK_MODE || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
