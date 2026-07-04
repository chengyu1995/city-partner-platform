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
import {
  buildProjectDirectorConsoleAction,
  isProjectDirectorDispatchPaused,
  parseProjectDirectorConsoleCommand,
} from "@/lib/project-director-console";
import {
  buildBossApprovedReply,
  buildDispatchPlanChangeRecordedReply,
  buildProjectDirectorScopeUpdateRecord,
  buildProjectDirectorScopeUpdateReply,
  buildProjectDirectorReply,
  buildTaskTreeChangeRecordedReply,
  buildTaskTreeReviewReceivedReply,
  classifyProjectDirectorDemand,
  getAcceptanceFeedbackBody,
  getDemandBody,
  isAcceptanceFeedbackMessage,
  isApprovedExecutionReply,
  isBossApprovalReply,
  isDispatchBatchApprovalReply,
  isDispatchPlanChangeReply,
  isProjectDirectorDemand,
  isTaskTreeApprovalReply,
  isTaskTreeChangeReply,
  isTaskTreeReviewReply,
  isWebsiteProductDemand,
} from "@/lib/project-director-intake";
import {
  buildDispatchPlanChangeRecord,
  buildDispatchPlanDraftRecord,
  buildDispatchPlanSummary,
  buildProjectDirectorDispatchPlanDraft,
  buildReviewChangeRecord,
  type ProjectDirectorDispatchPlanDraft,
} from "@/lib/project-director-dispatch-plan";
import {
  buildBatch01DispatchedRecord,
  buildBatch01DispatchedReply,
  buildBatch01ProductPlanningJobs,
  buildApprovedAgentDispatchJobs,
  buildAcceptanceFeedbackDuplicateReply,
  buildAcceptanceFeedbackQueuedRecord,
  buildAcceptanceFeedbackQueuedReply,
  buildProjectDirectorPlanningRequestText,
  hasExistingAgentDispatchJobs,
  hasBatch01DispatchRecord,
  hasExistingBatch01Jobs,
  hasExistingPlanningJob,
  hasRecentAcceptanceFeedbackJob,
  insertApprovedAgentDispatchJobs,
  insertAcceptanceFeedbackJob,
  insertBatch01ProductPlanningJobs,
  insertProjectDirectorPlanningJob,
  PROJECT_DIRECTOR_DISPATCH_BATCH_RECORD_NAME,
} from "@/lib/project-director-job-builder";
import {
  buildProjectDirectorTaskTreeDraft,
  buildTaskTreeDraftRecord,
  buildTaskTreeDraftSummary,
  type ProjectDirectorTaskTreeDraft,
} from "@/lib/project-director-task-tree";
import { findRecentDuplicateFeishuJob, normalizeFeishuTaskText } from "@/lib/worker-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

async function saveDirectReply(
  supabase: SupabaseClient,
  convId: string,
  userText: string,
  reply: string,
  feishuMessageId: string
): Promise<void> {
  const { error } = await supabase.from("hermes_messages").insert([
    {
      conversation_id: convId,
      role: "user",
      content: userText,
      feishu_message_id: feishuMessageId,
    },
    {
      conversation_id: convId,
      role: "assistant",
      content: reply,
      feishu_message_id: null,
    },
  ]);
  if (error) throw new Error(`save direct reply failed: ${error.message}`);
}

async function findRecentProjectDirectorDemand(
  supabase: SupabaseClient,
  convId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("hermes_messages")
    .select("role, content, created_at")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) throw new Error(`load project director history failed: ${error.message}`);
  if (!data) return null;

  const history = data.reverse();
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role !== "assistant" || !message.content.includes("【项目总管确认】")) continue;

    for (let userIndex = index - 1; userIndex >= 0; userIndex--) {
      const candidate = history[userIndex];
      if (candidate.role === "user" && isProjectDirectorDemand(candidate.content)) {
        return getDemandBody(candidate.content);
      }
    }
  }

  return null;
}

async function findPendingProjectDirectorConfirmation(
  supabase: SupabaseClient,
  convId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("hermes_messages")
    .select("role, content, name, created_at")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: false })
    .limit(40);

  if (error) throw new Error(`load project director pending confirmation failed: ${error.message}`);
  if (!data) return null;

  const history = data.reverse();
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    const content = typeof message.content === "string" ? message.content : "";
    const name = typeof message.name === "string" ? message.name : "";

    if (
      content.includes("PROJECT_DIRECTOR_TASK_TREE_DRAFT") ||
      content.includes("PROJECT_DIRECTOR_DISPATCH_PLAN_DRAFT") ||
      content.includes("PROJECT_DIRECTOR_DISPATCH_BATCH_RECORD")
    ) {
      return null;
    }

    if (name === "project_director_scope_update" && content.includes("state: waiting_boss_reply")) {
      return extractLineValue(content, "original_demand") || null;
    }

    if (message.role === "assistant" && content.includes("【项目总管确认】")) {
      for (let userIndex = index - 1; userIndex >= 0; userIndex--) {
        const candidate = history[userIndex];
        if (candidate.role === "user" && isProjectDirectorDemand(candidate.content)) {
          return getDemandBody(candidate.content);
        }
      }
      return null;
    }
  }

  return null;
}

function extractLineValue(content: string, key: string): string {
  const line = content.split(/\r?\n/).find((item) => item.startsWith(`${key}: `));
  return line ? line.slice(key.length + 2).trim() : "";
}

function extractJsonAfterMarker(content: string, marker: string): string | null {
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) return null;
  const jsonText = content.slice(markerIndex + marker.length).trim();
  return jsonText || null;
}

function extractJsonBetweenMarkers(
  content: string,
  startMarker: string,
  endMarker: string
): string | null {
  const startIndex = content.indexOf(startMarker);
  if (startIndex < 0) return null;
  const jsonStart = startIndex + startMarker.length;
  const endIndex = content.indexOf(endMarker, jsonStart);
  const jsonText = (endIndex < 0 ? content.slice(jsonStart) : content.slice(jsonStart, endIndex)).trim();
  return jsonText || null;
}

async function findRecentTaskTreeDraft(
  supabase: SupabaseClient,
  convId: string
): Promise<{
  originalDemand: string;
  bossConfirmation: string;
  draft: ProjectDirectorTaskTreeDraft;
} | null> {
  const { data, error } = await supabase
    .from("hermes_messages")
    .select("role, content, name, created_at")
    .eq("conversation_id", convId)
    .eq("name", "project_director_task_tree_draft")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) throw new Error(`load task tree draft failed: ${error.message}`);
  if (!data) return null;

  for (const message of data) {
    if (
      message.role !== "system" ||
      !message.content.includes("PROJECT_DIRECTOR_TASK_TREE_DRAFT") ||
      (!message.content.includes("state: waiting_task_tree_review") &&
        !message.content.includes("state: waiting_execution_approval"))
    ) {
      continue;
    }

    const jsonText = extractJsonAfterMarker(message.content, "json:");
    if (!jsonText) continue;

    try {
      return {
        originalDemand: extractLineValue(message.content, "original_demand"),
        bossConfirmation: extractLineValue(message.content, "boss_confirmation"),
        draft: JSON.parse(jsonText) as ProjectDirectorTaskTreeDraft,
      };
    } catch (parseError) {
      console.error("[feishu-event] task tree draft parse failed:", sanitizeLogText(errorToText(parseError)));
    }
  }

  return null;
}

async function findRecentDispatchPlanDraft(
  supabase: SupabaseClient,
  convId: string
): Promise<ProjectDirectorDispatchPlanDraft | null> {
  const { data, error } = await supabase
    .from("hermes_messages")
    .select("role, content, name, created_at")
    .eq("conversation_id", convId)
    .eq("name", "project_director_dispatch_plan_draft")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) throw new Error(`load dispatch plan draft failed: ${error.message}`);
  if (!data) return null;

  for (const message of data) {
    if (
      message.role !== "system" ||
      !message.content.includes("PROJECT_DIRECTOR_DISPATCH_PLAN_DRAFT") ||
      !message.content.includes("state: waiting_dispatch_approval")
    ) {
      continue;
    }

    const jsonText = extractJsonBetweenMarkers(message.content, "dispatch_plan_json:", "summary:");
    if (!jsonText) continue;

    try {
      return JSON.parse(jsonText) as ProjectDirectorDispatchPlanDraft;
    } catch (parseError) {
      console.error("[feishu-event] dispatch plan draft parse failed:", sanitizeLogText(errorToText(parseError)));
    }
  }

  return null;
}

async function saveTaskTreeDraftReply(
  supabase: SupabaseClient,
  convId: string,
  bossConfirmation: string,
  reply: string,
  draftRecord: string,
  feishuMessageId: string
): Promise<void> {
  const { error } = await supabase.from("hermes_messages").insert([
    {
      conversation_id: convId,
      role: "user",
      content: bossConfirmation,
      feishu_message_id: feishuMessageId,
      tool_call_id: null,
      name: null,
    },
    {
      conversation_id: convId,
      role: "assistant",
      content: reply,
      feishu_message_id: null,
      tool_call_id: null,
      name: null,
    },
    {
      conversation_id: convId,
      role: "system",
      content: draftRecord,
      feishu_message_id: null,
      tool_call_id: null,
      name: "project_director_task_tree_draft",
    },
  ]);
  if (error) throw new Error(`save task tree draft failed: ${error.message}`);
}

async function savePlanningTaskTreeReply(
  supabase: SupabaseClient,
  convId: string,
  originalDemand: string,
  userText: string,
  reply: string,
  draftRecord: string,
  draft: ProjectDirectorTaskTreeDraft,
  feishuMessageId: string,
  feishuEventId: string,
  feishuChatId: string,
  feishuUserId: string
): Promise<void> {
  const planningRequestText = buildProjectDirectorPlanningRequestText({
    originalDemand,
    taskTreeId: draft.task_tree_id,
    summary: reply,
  });
  let planningInsertNote = "planning_job: skipped_duplicate";

  const alreadyQueued = await hasExistingPlanningJob(supabase, draft.task_tree_id);
  if (!alreadyQueued) {
    const insertResult = await insertProjectDirectorPlanningJob(supabase, {
      originalDemand,
      taskTreeId: draft.task_tree_id,
      requestText: planningRequestText,
      feishuMessageId,
      feishuEventId,
      feishuChatId,
      feishuUserId,
    });
    planningInsertNote = [
      `planning_job: inserted_${insertResult.insertedCount}`,
      `skipped_hermes_jobs_columns: ${insertResult.skippedColumns.join(", ") || "none"}`,
    ].join("\n");
  }

  await saveSystemRecordedReply(
    supabase,
    convId,
    userText,
    reply,
    [draftRecord, planningInsertNote].join("\n"),
    "project_director_task_tree_draft",
    feishuMessageId
  );
}

async function saveSystemRecordedReply(
  supabase: SupabaseClient,
  convId: string,
  userText: string,
  reply: string,
  systemRecord: string,
  systemName: string,
  feishuMessageId: string
): Promise<void> {
  const { error } = await supabase.from("hermes_messages").insert([
    {
      conversation_id: convId,
      role: "user",
      content: userText,
      feishu_message_id: feishuMessageId,
      tool_call_id: null,
      name: null,
    },
    {
      conversation_id: convId,
      role: "assistant",
      content: reply,
      feishu_message_id: null,
      tool_call_id: null,
      name: null,
    },
    {
      conversation_id: convId,
      role: "system",
      content: systemRecord,
      feishu_message_id: null,
      tool_call_id: null,
      name: systemName,
    },
  ]);
  if (error) throw new Error(`save project director record failed: ${error.message}`);
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
    // 1. 飞书 URL 验证 (challenge) - 明文 challenge 必须最快返回。
    const bodyText = await req.text();
    let body: any;
    try { body = JSON.parse(bodyText); }
    catch { return NextResponse.json({ code: 400, msg: "invalid json" }, { status: 400 }); }

    if (body?.type === "url_verification" && typeof body.challenge === "string") {
      return NextResponse.json({ challenge: body.challenge });
    }

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
      const convId = await getOrCreateConversation(
        supabase,
        userId,
        ev.message.chat_id,
        ev.message.chat_type
      );

      const consoleCommand = parseProjectDirectorConsoleCommand(text);
      if (consoleCommand && consoleCommand !== "approve_execution") {
        const action = await buildProjectDirectorConsoleAction(supabase, text);
        if (action) {
          await saveSystemRecordedReply(
            supabase,
            convId,
            text,
            action.reply,
            action.record,
            "project_director_console",
            ev.message.message_id
          );
          const token = await getFeishuToken();
          await sendFeishuMessage(
            token,
            ev.message.chat_id,
            ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
            action.reply
          );
          await markReceiptCompleted(supabase, eventId);
          return NextResponse.json({
            code: 0,
            project_director_console: true,
            command: action.command,
          });
        }
      }
      if (consoleCommand === "approve_execution") {
        text = "批准执行";
      }

      if (isAcceptanceFeedbackMessage(text)) {
        const feedbackText = getAcceptanceFeedbackBody(text);
        const alreadyQueued = await hasRecentAcceptanceFeedbackJob(supabase, feedbackText);
        const token = await getFeishuToken();

        if (alreadyQueued) {
          const reply = buildAcceptanceFeedbackDuplicateReply();
          await saveSystemRecordedReply(
            supabase,
            convId,
            text,
            reply,
            [
              "PROJECT_DIRECTOR_ACCEPTANCE_FEEDBACK_DUPLICATE",
              "state: duplicate_skipped",
              "batch_code: BATCH-12",
              `feedback: ${feedbackText}`,
              "note: a recent queued/running acceptance feedback job already exists.",
            ].join("\n"),
            "project_director_acceptance_feedback_duplicate",
            ev.message.message_id
          );
          await sendFeishuMessage(
            token,
            ev.message.chat_id,
            ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
            reply
          );
          await markReceiptCompleted(supabase, eventId);
          return NextResponse.json({
            code: 0,
            project_director_intake: true,
            state: "acceptance_feedback_duplicate_skipped",
          });
        }

        const jobInput = {
          feedbackText,
          rawMessageText: text,
          feishuMessageId: ev.message.message_id,
          feishuEventId: eventId,
          feishuChatId: ev.message.chat_id,
          feishuUserId: userId,
        };
        const insertResult = await insertAcceptanceFeedbackJob(supabase, jobInput);
        const reply = buildAcceptanceFeedbackQueuedReply(insertResult.insertedCount);
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          buildAcceptanceFeedbackQueuedRecord(jobInput, insertResult.skippedColumns),
          "project_director_acceptance_feedback",
          ev.message.message_id
        );
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_intake: true,
          state: "acceptance_feedback_queued",
          dispatched_batch: "BATCH-12",
          inserted_jobs: insertResult.insertedCount,
        });
      }

      const demandKind = classifyProjectDirectorDemand(text);
      if (demandKind === "website_product_request" || demandKind === "system_upgrade_request") {
        const originalDemand = getDemandBody(text);
        const draft = buildProjectDirectorTaskTreeDraft(originalDemand, "规划阶段", "planning_only");
        const reply = buildTaskTreeDraftSummary(draft);
        const draftRecord = buildTaskTreeDraftRecord(originalDemand, "规划阶段", draft, reply);
        await savePlanningTaskTreeReply(
          supabase,
          convId,
          originalDemand,
          text,
          reply,
          draftRecord,
          draft,
          ev.message.message_id,
          eventId,
          ev.message.chat_id,
          userId
        );
        const token = await getFeishuToken();
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_intake: true,
          demand_type: demandKind,
          state: "waiting_execution_approval",
          execution_mode: "planning_only",
        });
      }

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

    // 7. 项目总管确认 / 任务树草案 / 待分发清单流程。这里只写 hermes_messages，不写 hermes_jobs。
    if (isDispatchPlanChangeReply(text)) {
      const reply = buildDispatchPlanChangeRecordedReply();
      await saveSystemRecordedReply(
        supabase,
        convId,
        text,
        reply,
        buildDispatchPlanChangeRecord(text),
        "project_director_dispatch_plan_change",
        ev.message.message_id
      );
      const token = await getFeishuToken();
      await sendFeishuMessage(
        token,
        ev.message.chat_id,
        ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
        reply
      );
      await markReceiptCompleted(supabase, eventId);
      return NextResponse.json({
        code: 0,
        project_director_intake: true,
        state: "dispatch_plan_change_requested",
      });
    }

    if (isApprovedExecutionReply(text)) {
      const token = await getFeishuToken();
      const dispatchPaused = await isProjectDirectorDispatchPaused(supabase, convId);
      if (dispatchPaused) {
        const reply = "项目总管当前处于暂停分发状态。请先在飞书发送：总管 恢复，然后再发送：总管 批准执行。";
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          [
            "PROJECT_DIRECTOR_APPROVED_EXECUTION_BLOCKED",
            "state: paused_by_boss_console",
            "reason: agent dispatch is paused by project director console.",
          ].join("\n"),
          "project_director_approved_execution_blocked",
          ev.message.message_id
        );
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_console: true,
          state: "approved_execution_blocked_paused",
        });
      }
      const recentDraft = await findRecentTaskTreeDraft(supabase, convId);
      if (!recentDraft) {
        const reply = "未找到可执行的任务树计划，请先发送新需求并完成项目总管规划。";
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          [
            "PROJECT_DIRECTOR_APPROVED_EXECUTION_BLOCKED",
            "state: waiting_task_tree_missing",
            "reason: no recent project director task tree draft was found.",
          ].join("\n"),
          "project_director_approved_execution_blocked",
          ev.message.message_id
        );
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_intake: true,
          state: "waiting_task_tree_missing",
        });
      }

      const approvedTree = buildProjectDirectorTaskTreeDraft(
        recentDraft.originalDemand,
        text,
        "approved_execution"
      );
      const dispatchPlan = buildProjectDirectorDispatchPlanDraft(approvedTree, "approved_execution");
      const buildResult = buildApprovedAgentDispatchJobs(dispatchPlan);
      const alreadyDispatched = await hasExistingAgentDispatchJobs(supabase, buildResult.tasks);
      if (alreadyDispatched) {
        const reply = "该任务树的 Agent 执行任务已经分发过，本次不会重复创建。";
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          [
            "PROJECT_DIRECTOR_APPROVED_EXECUTION_DUPLICATE",
            "state: duplicate_dispatch_skipped",
            `task_tree_id: ${approvedTree.task_tree_id}`,
          ].join("\n"),
          "project_director_approved_execution_duplicate",
          ev.message.message_id
        );
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_intake: true,
          state: "approved_execution_duplicate_skipped",
        });
      }

      const insertResult = await insertApprovedAgentDispatchJobs(supabase, buildResult);
      const reply = [
        "【项目总管：已批准执行】",
        `已创建 ${insertResult.insertedCount} 个 Agent 执行任务。`,
        "",
        "执行顺序：",
        ...dispatchPlan.dispatch_plan.batches
          .filter((batch) => batch.tasks.length > 0)
          .map((batch, index) => `${index + 1}. ${batch.title}：${batch.tasks.length} 个任务`),
        "",
        "说明：具体任务已写入 Worker 兼容队列，子任务内容存放在 hermes_jobs.request_text。",
        "完成后项目总管会汇总修改文件、验证结果和是否仍需老板验收。",
      ].join("\n");
      const summary = buildDispatchPlanSummary(dispatchPlan);
      const record = buildDispatchPlanDraftRecord(
        recentDraft.originalDemand,
        text,
        approvedTree,
        dispatchPlan,
        summary
      );
      await saveSystemRecordedReply(
        supabase,
        convId,
        text,
        reply,
        [
          record,
          "PROJECT_DIRECTOR_APPROVED_EXECUTION_DISPATCHED",
          `inserted_jobs: ${insertResult.insertedCount}`,
          `skipped_hermes_jobs_columns: ${insertResult.skippedColumns.join(", ") || "none"}`,
        ].join("\n"),
        "project_director_approved_execution",
        ev.message.message_id
      );
      await sendFeishuMessage(
        token,
        ev.message.chat_id,
        ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
        reply
      );
      await markReceiptCompleted(supabase, eventId);
      return NextResponse.json({
        code: 0,
        project_director_intake: true,
        state: "approved_execution_dispatched",
        inserted_jobs: insertResult.insertedCount,
      });
    }

    if (isDispatchBatchApprovalReply(text)) {
      const token = await getFeishuToken();
      const alreadyDispatched = await hasBatch01DispatchRecord(supabase, convId);
      if (alreadyDispatched) {
        const reply = "第 1 批产品规划任务已经分发过，不会重复创建。";
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          [
            "PROJECT_DIRECTOR_DISPATCH_BATCH_DUPLICATE",
            "state: duplicate_dispatch_skipped",
            "batch_code: BATCH-01",
            "note: existing dispatched record found in hermes_messages.",
          ].join("\n"),
          "project_director_dispatch_batch_duplicate",
          ev.message.message_id
        );
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_intake: true,
          state: "dispatch_batch_duplicate_skipped",
        });
      }

      const dispatchPlan = await findRecentDispatchPlanDraft(supabase, convId);
      if (!dispatchPlan) {
        const reply = "未找到待分发清单，请先完成任务树审核。";
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          [
            "PROJECT_DIRECTOR_DISPATCH_BATCH_BLOCKED",
            "state: waiting_dispatch_plan_missing",
            "batch_code: BATCH-01",
            "reason: no recent waiting_dispatch_approval dispatch plan was found.",
          ].join("\n"),
          "project_director_dispatch_batch_blocked",
          ev.message.message_id
        );
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_intake: true,
          state: "waiting_dispatch_plan_missing",
        });
      }

      const buildResult = buildBatch01ProductPlanningJobs(dispatchPlan);
      if (buildResult.tasks.length === 0) {
        const reply = "第 1 批产品规划任务为空，无法分发。";
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          [
            "PROJECT_DIRECTOR_DISPATCH_BATCH_BLOCKED",
            "state: batch_01_empty",
            "batch_code: BATCH-01",
            "reason: no allowed product planning document task was found.",
          ].join("\n"),
          "project_director_dispatch_batch_blocked",
          ev.message.message_id
        );
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_intake: true,
          state: "batch_01_empty",
        });
      }

      const existingJobs = await hasExistingBatch01Jobs(supabase, buildResult.tasks);
      if (existingJobs) {
        const reply = "第 1 批产品规划任务已经分发过，不会重复创建。";
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          [
            "PROJECT_DIRECTOR_DISPATCH_BATCH_DUPLICATE",
            "state: duplicate_dispatch_skipped",
            "batch_code: BATCH-01",
            "note: existing queued/running project_director hermes_jobs row found.",
          ].join("\n"),
          "project_director_dispatch_batch_duplicate",
          ev.message.message_id
        );
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_intake: true,
          state: "dispatch_batch_duplicate_skipped",
        });
      }

      try {
        const insertResult = await insertBatch01ProductPlanningJobs(supabase, buildResult);
        const reply = buildBatch01DispatchedReply(insertResult.insertedCount);
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          buildBatch01DispatchedRecord(dispatchPlan, buildResult.tasks, insertResult.skippedColumns),
          PROJECT_DIRECTOR_DISPATCH_BATCH_RECORD_NAME,
          ev.message.message_id
        );
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_intake: true,
          state: "waiting_review",
          dispatched_batch: "BATCH-01",
          inserted_jobs: insertResult.insertedCount,
        });
      } catch (dispatchError) {
        const errorSummary = sanitizeLogText(errorToText(dispatchError)).slice(0, 300);
        const reply = `第 1 批产品规划任务分发失败：${errorSummary}`;
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          [
            "PROJECT_DIRECTOR_DISPATCH_BATCH_FAILED",
            "state: dispatch_failed",
            "batch_code: BATCH-01",
            `error: ${errorSummary}`,
          ].join("\n"),
          "project_director_dispatch_batch_failed",
          ev.message.message_id
        );
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_intake: true,
          state: "dispatch_failed",
        });
      }
    }

    if (isTaskTreeReviewReply(text)) {
      if (isTaskTreeChangeReply(text)) {
        const reply = buildTaskTreeChangeRecordedReply();
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          buildReviewChangeRecord(text),
          "project_director_task_tree_review_change",
          ev.message.message_id
        );
        const token = await getFeishuToken();
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_intake: true,
          state: "task_tree_change_requested",
        });
      }

      if (isTaskTreeApprovalReply(text)) {
        const recentDraft = await findRecentTaskTreeDraft(supabase, convId);
        if (recentDraft) {
          const dispatchPlan = buildProjectDirectorDispatchPlanDraft(recentDraft.draft);
          const reply = buildDispatchPlanSummary(dispatchPlan);
          const record = buildDispatchPlanDraftRecord(
            recentDraft.originalDemand,
            text,
            recentDraft.draft,
            dispatchPlan,
            reply
          );
          await saveSystemRecordedReply(
            supabase,
            convId,
            text,
            reply,
            record,
            "project_director_dispatch_plan_draft",
            ev.message.message_id
          );
          const token = await getFeishuToken();
          await sendFeishuMessage(
            token,
            ev.message.chat_id,
            ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
            reply
          );
          await markReceiptCompleted(supabase, eventId);
          return NextResponse.json({
            code: 0,
            project_director_intake: true,
            state: "waiting_dispatch_approval",
            dispatch_plan_draft: true,
          });
        }
      }

      const reply = buildTaskTreeReviewReceivedReply();
      await saveDirectReply(supabase, convId, text, reply, ev.message.message_id);
      const token = await getFeishuToken();
      await sendFeishuMessage(
        token,
        ev.message.chat_id,
        ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
        reply
      );
      await markReceiptCompleted(supabase, eventId);
      return NextResponse.json({
        code: 0,
        project_director_intake: true,
        state: "task_tree_review_received_without_recent_draft",
      });
    }

    if (isWebsiteProductDemand(text)) {
      const reply = buildProjectDirectorReply(text);
      await saveDirectReply(supabase, convId, text, reply, ev.message.message_id);
      const token = await getFeishuToken();
      await sendFeishuMessage(
        token,
        ev.message.chat_id,
        ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
        reply
      );
      await markReceiptCompleted(supabase, eventId);
      return NextResponse.json({
        code: 0,
        project_director_intake: true,
        state: "waiting_boss_reply",
      });
    }

    if (isBossApprovalReply(text)) {
      const originalDemand = await findRecentProjectDirectorDemand(supabase, convId);
      if (originalDemand) {
        const draft = buildProjectDirectorTaskTreeDraft(originalDemand, text);
        const reply = buildTaskTreeDraftSummary(draft);
        const draftRecord = buildTaskTreeDraftRecord(originalDemand, text, draft, reply);
        await saveTaskTreeDraftReply(
          supabase,
          convId,
          text,
          reply,
          draftRecord,
          ev.message.message_id
        );
        const token = await getFeishuToken();
        await sendFeishuMessage(
          token,
          ev.message.chat_id,
          ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
          reply
        );
        await markReceiptCompleted(supabase, eventId);
        return NextResponse.json({
          code: 0,
          project_director_intake: true,
          state: "waiting_task_tree_review",
          task_tree_draft: true,
        });
      }

      const reply = buildBossApprovedReply();
      await saveDirectReply(supabase, convId, text, reply, ev.message.message_id);
      const token = await getFeishuToken();
      await sendFeishuMessage(
        token,
        ev.message.chat_id,
        ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
        reply
      );
      await markReceiptCompleted(supabase, eventId);
      return NextResponse.json({
        code: 0,
        project_director_intake: true,
        state: "boss_approved_without_recent_project_director_context",
      });
    }

    const pendingProjectDirectorDemand = await findPendingProjectDirectorConfirmation(supabase, convId);
    if (pendingProjectDirectorDemand) {
      const reply = buildProjectDirectorScopeUpdateReply(text);
      await saveSystemRecordedReply(
        supabase,
        convId,
        text,
        reply,
        buildProjectDirectorScopeUpdateRecord(pendingProjectDirectorDemand, text),
        "project_director_scope_update",
        ev.message.message_id
      );
      const token = await getFeishuToken();
      await sendFeishuMessage(
        token,
        ev.message.chat_id,
        ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
        reply
      );
      await markReceiptCompleted(supabase, eventId);
      return NextResponse.json({
        code: 0,
        project_director_intake: true,
        state: "waiting_boss_reply",
        scope_update_recorded: true,
      });
    }

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
