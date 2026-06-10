/**
 * Supabase 统一入口
 * - 浏览器端：用 createBrowserClient（自动同步 cookies）
 * - 服务端组件 / Server Actions：用 getServerSupabase()（同步 cookies）
 * - 服务端 API 路由（需要 service role 权限）：用 getServiceSupabase()
 * - 不要在客户端代码里 import service-role 那个（service role key 暴露 = 数据库裸奔）
 */
import { createBrowserClient, createServerClient as createSSRServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/types/supabase";
import { env } from "@/lib/env";

/** 浏览器端：用于 "use client" 组件 */
export function createClient() {
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

/** 服务端：用于 Server Components / Server Actions / Route Handlers */
export async function getServerSupabase() {
  const cookieStore = await cookies();
  return createSSRServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Component 里 set cookies 会抛错，忽略即可
            // (cookies 必须在 Server Action 或 Route Handler 里 set)
          }
        },
      },
    }
  );
}

/**
 * 服务端 service-role 客户端：仅 API 路由 / Server Action 里用
 * 绕过 RLS，拥有对数据库的完全权限。
 *
 * ⚠️ 绝不能 import 到任何客户端组件，否则 anon key 被替换成 service role key,
 *    整个数据库裸奔。
 */
export async function getServiceSupabase() {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY 未配置，无法创建 service-role 客户端"
    );
  }
  const { createClient: createRawClient } = await import("@supabase/supabase-js");
  return createRawClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
}
