/**
 * Supabase 本地连通性测试
 * - 服务端组件，直接读 .env.local 里的 URL/anon key
 * - 调用一个真实 Supabase 表（这里用一个永远不会创建的空表名做 health check）
 * - 真实配置后如果返回 404/PGRST116 = 端点通了，缺表正常
 * - 如果返回 network error 或 env error = 配置有问题
 */
import { getServerSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function TestSupabasePage() {
  let status: "ok" | "env-missing" | "network-error" | "unknown" = "ok";
  let detail = "";
  let url = "";
  let keyPrefix = "";

  try {
    const supabase = await getServerSupabase();
    // 探活：试一个不可能存在的表
    const { error } = await supabase.from("_health_check_probe").select("*").limit(1);
    if (error) {
      // PGRST116 = relation does not exist = 端点通了,缺表(预期)
      if (error.code === "PGRST116" || /does not exist/i.test(error.message)) {
        status = "ok";
        detail = `Supabase 端点可达 ✅ (缺 _health_check_probe 表是预期)`;
      } else {
        status = "unknown";
        detail = `Supabase 报错: ${error.code} - ${error.message}`;
      }
    } else {
      status = "ok";
      detail = "Supabase 端点可达 ✅";
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Missing required env var/.test(msg)) {
      status = "env-missing";
      detail = msg;
    } else {
      status = "network-error";
      detail = msg;
    }
  }

  // 显示 env 状态（不显示真实 key）
  const env = await import("@/lib/env");
  url = env.env.NEXT_PUBLIC_SUPABASE_URL;
  keyPrefix = env.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.slice(0, 8) + "...";

  return (
    <main className="container py-10 space-y-4">
      <h1 className="text-3xl font-bold">Supabase 本地连通性测试</h1>
      <div className="rounded-md border p-4 space-y-2 text-sm">
        <p><span className="font-mono text-muted-foreground">NEXT_PUBLIC_SUPABASE_URL</span>: {url}</p>
        <p><span className="font-mono text-muted-foreground">NEXT_PUBLIC_SUPABASE_ANON_KEY</span>: {keyPrefix}</p>
        <p><span className="font-mono text-muted-foreground">SUPABASE_SERVICE_ROLE_KEY</span>: {env.env.SUPABASE_SERVICE_ROLE_KEY ? env.env.SUPABASE_SERVICE_ROLE_KEY.slice(0, 8) + "..." : "<未配置>"}</p>
      </div>
      <div
        className={
          "rounded-md border p-4 " +
          (status === "ok"
            ? "border-green-500 bg-green-50 dark:bg-green-950"
            : status === "env-missing"
            ? "border-yellow-500 bg-yellow-50 dark:bg-yellow-950"
            : "border-red-500 bg-red-50 dark:bg-red-950")
        }
      >
        <p className="font-semibold mb-1">状态: {status}</p>
        <p className="text-sm">{detail}</p>
      </div>
      <div className="rounded-md border p-4 text-sm space-y-2">
        <p className="font-semibold">含义说明：</p>
        <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
          <li><code>ok</code> = URL 和 anon key 都正确，端点可达 ✅</li>
          <li><code>env-missing</code> = .env.local 没配或变量名拼错</li>
          <li><code>network-error</code> = URL 错了、Supabase 项目不存在、或网络问题</li>
        </ul>
      </div>
    </main>
  );
}
