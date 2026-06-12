/**
 * 临时诊断路由: 看 Vercel 上 env vars 实际值
 * 上线后可删
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    env: {
      NEXT_PUBLIC_SUPABASE_URL_set: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      NEXT_PUBLIC_SUPABASE_URL_value: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
      NEXT_PUBLIC_SUPABASE_ANON_KEY_set: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      NEXT_PUBLIC_SUPABASE_ANON_KEY_prefix:
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.slice(0, 8) ?? null,
      NEXT_PUBLIC_SUPABASE_ANON_KEY_length:
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.length ?? 0,
      SUPABASE_SERVICE_ROLE_KEY_set: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      SUPABASE_SERVICE_ROLE_KEY_prefix:
        process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0, 8) ?? null,
      SUPABASE_SERVICE_ROLE_KEY_length:
        process.env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0,
    },
    node_env: process.env.NODE_ENV,
    vercel_env: process.env.VERCEL_ENV,
  });
}
