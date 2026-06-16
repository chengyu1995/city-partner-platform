/**
 * 飞书自动化 1.5: 拆解结果回调
 * 飞书 Bitable ← 写入拆解出的子任务
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
 */
function parseBitableAppToken(raw: string): string {
  const v = raw.trim();
  const m = v.match(/\/base\/([A-Za-z0-9]+)/);
  return m ? m[1] : v;
}

/**
 * 从 Vercel env 取 table_id, 兼容 URL 形式
 */
function parseBitableTableId(raw: string): string {
  const v = raw.trim();
  const m = v.match(/[?&]table=([A-Za-z0-9]+)/);
  return m ? m[1] : v;
}

/**
 * 获取飞书 tenant_access_token (Vercel 进程内缓存 2h)
 */
let cachedToken: { token: string; expiresAt: number } | null = null;
async function getFeishuAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.token;

  const appId = getEnv("FEISHU_APP_ID");
  const appSecret = getEnv("FEISHU_APP_SECRET");
  if (!appId || !appSecret) {
    throw new Error("missing FEISHU_APP_ID or FEISHU_APP_SECRET env");
  }
  const body = JSON.stringify({ app_id: appId, app_secret: appSecret });
  const bytes = new TextEncoder().encode(body);
  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: bytes,
    }
  );
  const data = (await res.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`feishu token failed: code=${data.code} msg=${data.msg}`);
  }
  cachedToken = {
    token: data.tenant_access_token,
    expiresAt: now + Math.max(60_000, (data.expire ?? 7200) * 1000 - 60_000),
  };
  return cachedToken.token;
}

/**
 * 列出 Bitable 真实字段名 + 类型 (用于排查字段不匹配)
 */
async function listBitableFields(
  accessToken: string,
  appToken: string,
  tableId: string
): Promise<{ items: { field_name: string; type: number }[]; listErr: string }> {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const raw = await res.text();
  console.log(`[DEBUG_Bitable] fields list status=${res.status} body=${raw.slice(0, 500)}`);
  try {
    const data = JSON.parse(raw) as {
      code?: number;
      msg?: string;
      data?: { items?: { field_name: string; type: number }[] };
    };
    if (data.code !== 0) {
      return { items: [], listErr: `code=${data.code} msg=${data.msg}` };
    }
    return { items: data.data?.items ?? [], listErr: "ok" };
  } catch {
    return { items: [], listErr: `non-json: ${raw.slice(0, 100)}` };
  }
}

/**
 * 向飞书 Bitable 写入单条任务记录
 * 返回: { record, realFields, listErr }
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
  const appToken = parseBitableAppToken(rawAppToken);
  const tableId = parseBitableTableId(rawTableId);

  // 1) 列出真实字段 (debug + 自动调整)
  const { items: realFieldItems, listErr } = await listBitableFields(accessToken, appToken, tableId);
  const realFields = realFieldItems.map((f) => `${f.field_name}(type=${f.type})`).join(", ");

  // 2) 构造 fields: 优先用 Bitable 真实字段名, 找不到再用代码默认
  const realNameSet = new Set(realFieldItems.map((f) => f.field_name));
  const fields: Record<string, unknown> = {};
  if (realNameSet.has("任务标题")) fields["任务标题"] = task.title;
  if (realNameSet.has("状态")) fields["状态"] = task.status ?? "待执行";
  if (realNameSet.has("执行者")) fields["执行者"] = task.assignee ?? "";
  // A 列默认 "文本" 飞书不允许删, 传空字符串兜底
  if (realNameSet.has("文本")) fields["文本"] = "";
  // 兜底: 如果 Bitable 没找到任何代码预期字段, 用代码硬编码名尝试 (兼容性)
  if (Object.keys(fields).length === 0) {
    fields["任务标题"] = task.title;
    fields["状态"] = task.status ?? "待执行";
    fields["执行者"] = task.assignee ?? "";
    fields["文本"] = "";
  }

  // 3) 写入
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;
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
  const raw = await res.text();
  let data: { code: number; msg: string; data?: unknown };
  try { data = JSON.parse(raw); }
  catch { throw new Error(`bitable non-JSON: ${raw.slice(0, 200)}`); }
  if (data.code !== 0) {
    throw new Error(`bitable insert failed: code=${data.code} msg=${data.msg} task=${task.title} fields=${JSON.stringify(fields)}`);
  }
  return { record: data.data, realFields, listErr };
}

export async function POST(req: NextRequest) {
  try {
    // 鉴权
    const expected = getEnv("FEISHU_API_TOKEN");
    if (expected) {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${expected}`) {
        return NextResponse.json({ code: 401, message: "unauthorized" }, { status: 401 });
      }
    }

    // 修乱码: arrayBuffer + TextDecoder utf-8
    const buf = await req.arrayBuffer();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const rawText = decoder.decode(buf);

    let body: { tasks?: unknown; parentTaskId?: string };
    try { body = JSON.parse(rawText); }
    catch {
      return NextResponse.json(
        { code: 400, message: "invalid JSON", raw_head: rawText.slice(0, 200) },
        { status: 400 }
      );
    }

    const tasks = body.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return NextResponse.json({ code: 400, message: "tasks must be non-empty array" }, { status: 400 });
    }

    // 串行写
    const accessToken = await getFeishuAccessToken();
    const results: unknown[] = [];
    let firstRealFields = "";
    let firstListErr = "";
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
        results.push({ ok: true, title: task.title, data: r.record });
        if (!firstRealFields) firstRealFields = r.realFields;
        if (!firstListErr) firstListErr = r.listErr;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        results.push({ ok: false, title: task.title, error: errMsg });
        if (!firstRealFields) firstRealFields = "(unknown - addTaskRecord threw before list)";
        if (!firstListErr) firstListErr = "(skipped)";
      }
    }

    return NextResponse.json({
      code: 0,
      message: "tasks processed",
      data: {
        count: results.length,
        results,
        debug: {
          realFields: firstRealFields,
          listErr: firstListErr,
        },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[decompose-callback]", msg);
    return NextResponse.json({ code: 500, message: msg }, { status: 500 });
  }
}

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
