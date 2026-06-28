/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 飞书事件订阅 webhook
 * POST /api/feishu/event
 * 
 * 流程:
 *  1. 飞书 POST 加 events 数组 (加密 or 公开)
 *  2. URL 验证 (challenge) → 直接回 challenge
 *  3. 解密 event payload
 *  4. 过滤 im.message.receive_v1 (新消息)
 *  5. 私聊优先 (p2p) → 入 conversation + 调 agent
 *  6. 群聊 (group) → 仅 @Hermes 才处理
 *  7. 回复飞书 (im/v1/messages)
 */
import { NextResponse, NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { decryptFeishuEvent } from "@/lib/feishu-crypto";
import { runAgent, AgentMessage } from "@/lib/hermes-agent";
import { findRecentDuplicateFeishuJob, normalizeFeishuTaskText } from "@/lib/worker-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface FeishuEvent {
  schema: "2.0";
  header: {
    event_type: string;
    app_id: string;
    tenant_key: string;
    event_id: string;
    create_time: string;
  };
  event: {
    sender: { sender_id: { open_id: string; user_id: string; union_id: string } };
    message: {
      message_id: string;
      chat_id: string;
      chat_type: "p2p" | "group" | string;
      message_type: "text" | string;
      content: string; // JSON 字符串: {"text": "..."}
    };
  };
}

function sb(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function isDuplicateReceiptError(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

function errorToText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeLogText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/(token|secret|password|key)["':=\s]+[^"',\s}]+/gi, "$1=[redacted]");
}

async function markReceiptCompleted(supabase: SupabaseClient, eventId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("feishu_event_receipts")
    .update({ status: "completed", completed_at: now, updated_at: now })
    .eq("event_id", eventId);
  if (error) throw new Error(`complete feishu receipt failed: ${error.message}`);
}

async function markReceiptFailed(
  supabase: SupabaseClient,
  eventId: string,
  errorText: string
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("feishu_event_receipts")
    .update({ status: "failed", error_text: errorText, updated_at: now })
    .eq("event_id", eventId);
  if (error) console.error("[feishu-event] receipt fail update failed:", error);
}

async function getOrCreateConversation(
  supabase: SupabaseClient,
  userId: string,
  chatId: string,
  chatType: string
): Promise<string> {
  // 简化: 每个 (user_id + chat_type) 1 个 active conversation
  const { data: existing } = await supabase
    .from("hermes_conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("chat_type", chatType)
    .eq("is_active", true)
    .order("last_msg_at", { ascending: false })
    .limit(1)
    .single();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from("hermes_conversations")
    .insert({ user_id: userId, chat_id: chatId, chat_type: chatType })
    .select("id")
    .single();
  if (error) throw new Error(`create conv failed: ${error.message}`);
  return created.id;
}

async function loadHistory(
  supabase: SupabaseClient,
  convId: string,
  limit = 20
): Promise<AgentMessage[]> {
  const { data } = await supabase
    .from("hermes_messages")
    .select("role, content, tool_call_id, name")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (!data) return [];
  // 倒序变正序
  return data.reverse().map((m) => {
    const msg: AgentMessage = { role: m.role as AgentMessage["role"], content: m.content };
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    if (m.name) msg.name = m.name;
    return msg;
  });
}

async function sendFeishuMessage(
  accessToken: string,
  receiveId: string,
  receiveIdType: "open_id" | "chat_id",
  text: string
): Promise<void> {
  const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
  const body = {
    receive_id: receiveId,
    msg_type: "text",
    content: JSON.stringify({ text: text.slice(0, 4000) }), // 飞书单条 4096 字符
  };
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: new TextEncoder().encode(JSON.stringify(body)),
  });
}

async function getFeishuToken(): Promise<string> {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error("FEISHU_APP_ID/SECRET missing");
  const res = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: new TextEncoder().encode(JSON.stringify({ app_id: appId, app_secret: appSecret })),
    }
  );
  const data = (await res.json()) as { tenant_access_token?: string; code: number };
  if (data.code !== 0 || !data.tenant_access_token) throw new Error("feishu token fail");
  return data.tenant_access_token;
}

export async function POST(req: NextRequest) {
  try {
    // 1. 飞书 URL 验证 (challenge) - 可能加密 or 公开
    const bodyText = await req.text();
    let body: any;
    try { body = JSON.parse(bodyText); }
    catch { return NextResponse.json({ code: 400, msg: "invalid json" }, { status: 400 }); }

    // URL 验证 (encrypt key + verification token)
    const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || "";
    const FEISHU_VERIFICATION_TOKEN = process.env.FEISHU_VERIFICATION_TOKEN || "";

    // 飞书 v2.0 事件加密方式: 整个 payload 是 { encrypt: "..." }, URL 验证也走加密
    let payload: any;
    if (body.encrypt && FEISHU_ENCRYPT_KEY) {
      const decrypted = decryptFeishuEvent(body.encrypt, FEISHU_ENCRYPT_KEY);
      try { payload = JSON.parse(decrypted); }
      catch { return NextResponse.json({ code: 400, msg: "decrypt fail" }, { status: 400 }); }
    } else {
      payload = body;
    }

    // 验证 token (如果飞书后台配了)
    if (FEISHU_VERIFICATION_TOKEN && payload.token && payload.token !== FEISHU_VERIFICATION_TOKEN) {
      return NextResponse.json({ code: 401, msg: "invalid token" }, { status: 401 });
    }

    // 2. URL 验证请求
    if (payload.type === "url_verification" || payload.challenge) {
      return NextResponse.json({ challenge: payload.challenge });
    }

    // 兼容飞书新版/旧版事件类型
    const eventType =
      payload?.header?.event_type ||
      payload?.event?.header?.event_type ||
      payload?.event_type ||
      payload?.type ||
      "";

    // 兼容: event 可能在 payload.event 也可能在 payload 本身
    const ev: any = payload.event ?? payload;

    // 仅处理 im.message.receive_v1
    if (eventType !== "im.message.receive_v1") {
      return NextResponse.json({ code: 0 });
    }

    // 安全读 message
    const message = ev?.message;
    if (!message) {
      return NextResponse.json({ code: 0 });
    }
    const rawContent = message.content || "{}";
    let text = "";
    try { text = JSON.parse(rawContent).text ?? ""; }
    catch { text = ""; }

    if (message.chat_type === "group") {
      // 简化: 群里必须包含 "@Hermes" 或 "@_user_1" (bot mention)
      if (!text.includes("Hermes") && !text.match(/@\S+/)) {
        return NextResponse.json({ code: 0 });
      }
      // 去掉 @ 提及
      text = text.replace(/@\S+\s*/g, "").trim();
    }

    if (!text) return NextResponse.json({ code: 0 });

    // 6. 持久化 + 调 Agent
    const supabase = sb();
    if (!supabase) {
      // 兜底: 直接返回错误消息给用户
      await sendFeishuMessage(
        await getFeishuToken(),
        ev.message.chat_id,
        ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
        "❌ Supabase 未配置, 请联系管理员"
      );
      return NextResponse.json({ code: 0 });
    }

    const userId = ev.sender.sender_id.open_id;
    const eventId =
      payload?.header?.event_id ||
      payload?.event?.header?.event_id ||
      ev?.header?.event_id ||
      "";
    const { error: receiptError } = await supabase.from("feishu_event_receipts").insert({
      event_id: eventId,
      message_id: ev.message.message_id,
      event_type: eventType,
      chat_id: ev.message.chat_id,
      sender_open_id: userId,
      status: "processing",
    });

    if (isDuplicateReceiptError(receiptError)) {
      return NextResponse.json({ code: 0, duplicate: true });
    }
    if (receiptError) {
      throw new Error(`create feishu receipt failed: ${receiptError.message}`);
    }
    try {
      try {
        const duplicateCheck = await findRecentDuplicateFeishuJob(supabase, text);
        if (duplicateCheck.error) {
          console.error(
            "[feishu-event] duplicate job check skipped:",
            sanitizeLogText(duplicateCheck.error.message ?? "unknown error")
          );
          text = duplicateCheck.normalizedText;
        } else if (duplicateCheck.duplicate) {
          const existingJobNo = duplicateCheck.duplicate.job_id ?? duplicateCheck.duplicate.id;
          console.log(`[feishu-event] duplicate task skipped: existing_job=${existingJobNo}`);
          try {
            const token = await getFeishuToken();
            await sendFeishuMessage(
              token,
              ev.message.chat_id,
              ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
              `检测到重复任务，已跳过入队。已有任务编号：${existingJobNo}`
            );
          } catch (replyError) {
            console.error("[feishu-event] duplicate reply failed:", sanitizeLogText(errorToText(replyError)));
          }
          try {
            await markReceiptCompleted(supabase, eventId);
          } catch (receiptCompleteError) {
            console.error(
              "[feishu-event] duplicate receipt complete failed:",
              sanitizeLogText(errorToText(receiptCompleteError))
            );
          }
          return NextResponse.json({
            code: 0,
            duplicate_task: true,
            existing_job_id: duplicateCheck.duplicate.id,
            existing_job_no: duplicateCheck.duplicate.job_id ?? null,
          });
        } else {
          text = duplicateCheck.normalizedText;
        }
      } catch (duplicateCheckError) {
        console.error("[feishu-event] duplicate job check failed:", sanitizeLogText(errorToText(duplicateCheckError)));
        text = normalizeFeishuTaskText(text);
      }

      const convId = await getOrCreateConversation(
      supabase,
      userId,
      ev.message.chat_id,
      ev.message.chat_type
    );

    // 7. 加载历史
    const history = await loadHistory(supabase, convId);

    // 8. 调 Agent
    const { reply, newMessages } = await runAgent(text, history);

    // 9. 存 user + assistant 消息
    await supabase.from("hermes_messages").insert(
      newMessages.map((m) => ({
        conversation_id: convId,
        role: m.role,
        content: m.content,
        tool_call_id: m.tool_call_id ?? null,
        // tool_calls 字段 (jsonb) 暂不存
        feishu_message_id: m.role === "user" ? ev.message.message_id : null,
      }))
    );

    // 10. 回复飞书
    const token = await getFeishuToken();
    await sendFeishuMessage(
      token,
      ev.message.chat_id,
      ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
      reply || "✅"
    );

      await markReceiptCompleted(supabase, eventId);
    } catch (e) {
      console.error("[feishu-event] processing failed:", sanitizeLogText(errorToText(e)));
      try {
        await markReceiptFailed(supabase, eventId, errorToText(e));
      } catch (receiptFailError) {
        console.error(
          "[feishu-event] receipt fail update failed:",
          sanitizeLogText(errorToText(receiptFailError))
        );
      }
      return NextResponse.json({ code: 0, processing_error: true });
    }

    return NextResponse.json({ code: 0 });
  } catch (e) {
    console.error("[feishu-event]", sanitizeLogText(errorToText(e)));
    return NextResponse.json({ code: 0, callback_error: true });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, route: "feishu-event" });
}
