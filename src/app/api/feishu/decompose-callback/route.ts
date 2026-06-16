/**
 * 飞书自动化 1.5: 拆解结果回调
 * 飞书《任务看板》Bitable ← 写入拆解出的子任务
 *
 * 触发: hermes_decompose_runner.py 拆解完成后回调
 * Body: { tasks: [{title, status?, assignee?}], parentTaskId }
 * 鉴权: 用 FEISHU_API_TOKEN 简单 Bearer 校验 (GitHub Secret 配的同值)
 */
import { NextResponse, NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 必填 env 校验 (不抛, 改返回 500 + 友好提示)
function getEnv(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

/**
 * 从 Vercel env 取 app_token, 兼容 URL 形式
 * 接受:
 *   - 纯 token: "Ops1buCiWaJPqqshzdpc3A90n4b"
 *   - URL: "https://rcn961k35z7m.feishu.cn/base/Ops1bu...n4b?table=tblXXX"
 *   - 路径: "/base/Ops1bu...n4b"
 */
function parseBitableAppToken(raw: string): string {
  const v = raw.trim();
  // 提取 base/ 后面那串
  const m = v.match(/\/base\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  return v;
}

/**
 * 从 Vercel env 取 table_id, 兼容 URL 形式
 * 接受:
 *   - 纯 ID: "tbl2TFCHgCpm6Gxr"
 *   - URL: "https://...?table=tbl2TFCHgCpm6Gxr&view=..."
 */
function parseBitableTableId(raw: string): string {
  const v = raw.trim();
  // 提取 table= 后面那串
  const m = v.match(/[?&]table=([A-Za-z0-9]+)/);
  if (m) return m[1];
  return v;
}

/**
 * 缓存 tenant_access_token (2 小时, 飞书官方有效期 2h)
 */
let _tokenCache: { token: string; expiresAt: number } | null = null;

async function getFeishuAccessToken(): Promise<string> {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) {
    return _tokenCache.token;
  }
  const appId = getEnv("FEISHU_APP_ID");
  const appSecret = getEnv("FEISHU_APP_SECRET");
  if (!appId || !appSecret) {
    throw new Error("missing FEISHU_APP_ID or FEISHU_APP_SECRET env");
  }
  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }
  );
  const data = (await res.json()) as { code: number; msg: string; tenant_access_token?: string; expire?: number };
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`feishu token failed: code=${data.code} msg=${data.msg}`);
  }
  _tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  };
  return data.tenant_access_token;
}

/**
 * 写一条任务到 Bitable
 */
async function addTaskRecord(
  accessToken: string,
  task: { title: string; status?: string; assignee?: string; parentTaskId?: string }
) {
  const rawAppToken = getEnv("BITABLE_APP_TOKEN");
  const rawTableId = getEnv("BITABLE_TABLE_ID");
  if (!rawAppToken || !rawTableId) {
    throw new Error("missing BITABLE_APP_TOKEN or BITABLE_TABLE_ID env");
  }
  // 兼容 URL 形式 (用户可能直接粘整个 Bitable URL)
  const appToken = parseBitableAppToken(rawAppToken);
  const tableId = parseBitableTableId(rawTableId);
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;

  // 字段映射区: 必须和 Bitable 表字段名一字不差
  // 兜底: A 列默认 "文本" 列飞书不允许删, 传空字符串避免 1254045
  const fields: Record<string, unknown> = {
    "文本": "",
    "任务标题": task.title,
    "状态": task.status ?? "待执行",
    "执行者": task.assignee ?? "",
  };
  };

  // 用 ArrayBuffer + 显式 utf-8, 避免乱码 (跟 /api/feishu/requirement 同样修法)
  const body = JSON.stringify({ fields });
  const bytes = new TextEncoder().encode(body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: bytes,
  });
  const data = (await res.json()) as { code: number; msg: string; data?: unknown };
  if (data.code !== 0) {
    throw new Error(`bitable insert failed: code=${data.code} msg=${data.msg} task=${task.title}`);
  }
  return data.data;
}

export async function POST(req: NextRequest) {
  try {
    // 鉴权 (可选): 防止别人乱调
    const expected = getEnv("FEISHU_API_TOKEN");
    if (expected) {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${expected}`) {
        return NextResponse.json({ code: 401, message: "unauthorized" }, { status: 401 });
      }
    }

    // 修乱码: arrayBuffer + TextDecoder utf-8 (跟 /api/feishu/requirement 同样)
    const buf = await req.arrayBuffer();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const rawText = decoder.decode(buf);

    let body: { tasks?: unknown; parentTaskId?: string };
    try {
      body = JSON.parse(rawText);
    } catch {
      return NextResponse.json(
        { code: 400, message: "invalid JSON", raw_head: rawText.slice(0, 200) },
        { status: 400 }
      );
    }

    const tasks = body.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return NextResponse.json(
        { code: 400, message: "tasks must be non-empty array" },
        { status: 400 }
      );
    }

    // 串行写 (避免飞书限流)
      const accessToken = await getFeishuAccessToken();
      const results: unknown[] = [];
      for (const t of tasks) {
        const task = t as { title: string; status?: string; assignee?: string };
        if (!task.title) continue;
        try {
          const r = await addTaskRecord(accessToken, {
            title: task.title,
            status: task.status,
            assignee: task.assignee,
            parentTaskId: body.parentTaskId,
          });
          results.push({ ok: true, title: task.title, data: r });
        } catch (e) {
          // Bitable 失败不阻塞主流程
          results.push({ ok: false, title: task.title, error: e instanceof Error ? e.message : String(e) });
        }
      }

    return NextResponse.json({
      code: 0,
      message: "tasks synced to Bitable",
      data: { count: results.length, results },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[decompose-callback]", msg);
    return NextResponse.json({ code: 500, message: msg }, { status: 500 });
  }
}

/** GET: 健康检查 + 显示 env 状态 (不暴露值) */
export async function GET() {
  return NextResponse.json({
    ok: true,
    env: {
      FEISHU_APP_ID: getEnv("FEISHU_APP_ID") ? "set" : "missing",
      FEISHU_APP_SECRET: getEnv("FEISHU_APP_SECRET") ? "set" : "missing",
      BITABLE_APP_TOKEN: getEnv("BITABLE_APP_TOKEN") ? "set" : "missing",
      BITABLE_TABLE_ID: getEnv("BITABLE_TABLE_ID") ? "set" : "missing",
      FEISHU_API_TOKEN: getEnv("FEISHU_API_TOKEN") ? "set" : "missing (auth disabled)",
    },
  });
}
