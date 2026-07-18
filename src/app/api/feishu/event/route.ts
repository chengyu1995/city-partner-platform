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
  buildProjectDirectorPlanChangeRecord,
  buildProjectDirectorPlanChangeReply,
  buildProjectDirectorPlanningChoiceRecord,
  buildProjectDirectorPlanningChoiceReply,
  buildPlanningChoiceOriginalDemand,
  buildTaskTreeChangeRecordedReply,
  buildTaskTreeReviewReceivedReply,
  classifyProjectDirectorDemand as classifyBaseProjectDirectorDemand,
  isDirectWorkerTaskRequest,
  getAcceptanceFeedbackBody,
  getDemandBody,
  isAcceptanceFeedbackMessage,
  isApprovedExecutionReply as isBaseApprovedExecutionReply,
  isBossApprovalReply,
  isDispatchBatchApprovalReply,
  isDispatchPlanChangeReply,
  isPlanChangeReply,
  isProjectDirectorDemand,
  parseProjectDirectorPlanningChoice,
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
  hasExistingAgentDispatchJobs,
  hasBatch01DispatchRecord,
  hasExistingBatch01Jobs,
  hasRecentAcceptanceFeedbackJob,
  insertAcceptanceFeedbackJob,
  insertBatch01ProductPlanningJobs,
  PROJECT_DIRECTOR_DISPATCH_BATCH_RECORD_NAME,
  type DispatchJobBuildResult,
} from "@/lib/project-director-job-builder";
import {
  buildProjectDirectorTaskTreeDraft,
  buildTaskTreeDraftRecord,
  buildTaskTreeDraftSummary,
  type ProjectDirectorTaskTreeDraft,
} from "@/lib/project-director-task-tree";
import {
  createHermesJob,
  createHermesJobs,
  buildWorkerJobPayloadContract,
  findRecentDuplicateFeishuJob,
  normalizeFeishuTaskText,
} from "@/lib/worker-jobs";

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

function readHermesInsertError(errorText: string): Record<string, any> | null {
  const jsonStart = errorText.indexOf("{");
  if (jsonStart < 0) return null;

  try {
    const parsed = JSON.parse(errorText.slice(jsonStart));
    return parsed?.stage === "hermes_jobs_insert" ? parsed : null;
  } catch {
    return null;
  }
}

function buildHermesInsertFailureReply(errorText: string, sourceText: string): string | null {
  const error = readHermesInsertError(errorText);
  if (!error) return null;

  const batchCode = extractRelevantRouteBatchText(sourceText).match(ROUTE_BATCH_CODE_PATTERN)?.[0] ?? "unknown";
  return [
    "已识别批准批次，但创建 hermes_jobs 失败。",
    `批准批次：${batchCode}`,
    "错误阶段：hermes_jobs_insert",
    `HTTP status：${error.http_status ?? "unknown"}`,
    `错误代码：${error.code ?? "unknown"}`,
    `错误信息：${error.message ?? "unknown"}`,
    `details：${error.details ?? "none"}`,
    `hint：${error.hint ?? "none"}`,
    "任务尚未创建。",
  ].join("\n");
}

function sanitizeLogText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/(token|secret|password|key)["':=\s]+[^"',\s}]+/gi, "$1=[redacted]");
}

const ROUTE_BATCH_CODE_PATTERN = /\bBATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/gi;
const ROUTE_BATCH_RELEVANT_LINE_PATTERN =
  /标题|title|修复目标|目标|批准|approved|approval|执行批次|当前批次/i;
const ROUTE_BATCH_FORBIDDEN_FRAGMENT_PATTERN = /禁止范围|禁止修改|不得|不允许|forbidden|不执行/i;
const ROUTE_BATCH_FORBIDDEN_SECTION_HEADING_PATTERN =
  /^\s*(?:[-*#>\d.、\s]*)?(?:【)?(?:禁止范围|禁止修改|forbidden)(?:】)?\s*[:：]?\s*$/i;
const ROUTE_BATCH_FORBIDDEN_SECTION_EXIT_PATTERN =
  /标题|title|修复目标|(^|\s)目标\s*[:：]|批准|approved|approval|执行批次|当前执行批次/i;

function isAutomationSystemRepairDemand(text: string): boolean {
  const normalized = normalizeFeishuTaskText(text);
  return (
    /Worker|Codex|Hermes|飞书|项目总管|总管|自动化|路由|上报|NO_FIX_APPLIED|git_commit_sha|attempt_id/i.test(
      normalized
    ) && /修复|新增|更新|补齐|建立|修改|失败|failed|fix|repair|route/i.test(normalized)
  );
}

function classifyFeishuWorkerTaskDomain(text: string): string {
  const normalized = normalizeFeishuTaskText(text);
  const batchCode = extractPrimaryRouteBatchCode(normalized);

  if (batchCode && /^BATCH-GM-/i.test(batchCode)) return "automation_system";

  if (/文档整理|整理文档|归档|governance[_ -]?docs/i.test(normalized)) return "governance_docs";
  if (isAutomationSystemRepairDemand(normalized) || /automation[_ -]?system/i.test(normalized)) {
    return "automation_system";
  }
  if (/测试审核|测试|审核|验收|复测|qa[_ -]?review|QA review|test review/i.test(normalized)) {
    return "qa_review";
  }
  if (/运营|运维|发布|部署|上线|监控|operations?|ops|release|deploy/i.test(normalized)) {
    return "operations";
  }

  return "direct_worker_task";
}


function extractPrimaryRouteBatchCode(text: string): string | null {
  const normalized = normalizeFeishuTaskText(text);
  const explicit = normalized.match(/\b(BATCH-[A-Z0-9]+(?:-[A-Z0-9]+)*)\b/i);
  return explicit ? explicit[1].toUpperCase() : null;
}

function isExplicitDirectWorkerCreateCommand(text: string): boolean {
  const normalized = normalizeFeishuTaskText(text);
  return /direct\s+create\s+Worker\s+task|create\s+Worker\s+task|Worker\s+task/i.test(normalized) ||
    /(?:\u8bf7\s*)?\u76f4\u63a5\s*\u521b\u5efa\s*Worker\s*\u4efb\u52a1|\u7acb\u5373\s*\u521b\u5efa\s*Worker\s*\u4efb\u52a1|(?:\u8bf7\s*)?\u7acb\u5373\s*\u6392\u961f\s*Worker\s*\u4efb\u52a1/i.test(normalized);
}

function parseDirectRequestedMode(text: string, batchCode: string | null): string | null {
  const normalized = normalizeFeishuTaskText(text);
  const explicit = normalized.match(
    /(?:execution_mode|requested_mode|final_mode|task_mode|\u6267\u884c\u6a21\u5f0f)\s*[:\uFF1A=]\s*(manager_read_only|worker_read_only|write_allowed)\b/i
  );
  if (explicit) return explicit[1].toLowerCase();
  if (batchCode && /\bBATCH-GM-MODE-SMOKE-MANAGER(?:-[A-Z0-9]+)*\b/i.test(batchCode)) return "manager_read_only";
  if (batchCode && /\bBATCH-GM-MODE-SMOKE-WORKER(?:-[A-Z0-9]+)*\b/i.test(batchCode)) return "worker_read_only";
  if (batchCode && /\bBATCH-GM-MODE-SMOKE-WRITE(?:-[A-Z0-9]+)*\b/i.test(batchCode)) return "write_allowed";
  return null;
}

function resolveDirectWorkerReadOnlyContract(text: string) {
  const batchCode = extractPrimaryRouteBatchCode(text);
  const requestedMode = parseDirectRequestedMode(text, batchCode);
  const projectDomain = batchCode && /^BATCH-GM-/i.test(batchCode) ? "automation_system" : classifyFeishuWorkerTaskDomain(text);
  const readOnlyAllowedScope = "Worker read-only static inspection; no file writes; no git add/commit/push";
  const readOnlyForbiddenScope = "file writes, git add, git commit, git push, dev server, database, env, deploy";

  if (!batchCode || !/^BATCH-GM-/i.test(batchCode)) {
    return { ok: false, error: "DIRECT_WORKER_BATCH_MISSING", batchCode, projectDomain, requestedMode, finalMode: requestedMode, taskMode: requestedMode, readOnlyMode: true, approvalRequired: false, allowedScope: readOnlyAllowedScope, forbiddenScope: readOnlyForbiddenScope };
  }
  if (requestedMode === "manager_read_only") {
    return { ok: false, error: "DIRECT_MANAGER_READ_ONLY_REJECTED", batchCode, projectDomain, requestedMode, finalMode: "manager_read_only", taskMode: "manager_read_only", readOnlyMode: true, approvalRequired: false, allowedScope: readOnlyAllowedScope, forbiddenScope: readOnlyForbiddenScope };
  }
  if (requestedMode === "write_allowed") {
    return { ok: false, error: "DIRECT_WRITE_ALLOWED_REQUIRES_APPROVAL", batchCode, projectDomain, requestedMode, finalMode: "write_allowed", taskMode: "automation_system_write_allowed", readOnlyMode: false, approvalRequired: true, allowedScope: "automation system allowed_scope from approved request only", forbiddenScope: readOnlyForbiddenScope };
  }
  if (requestedMode !== "worker_read_only") {
    return { ok: false, error: "DIRECT_WORKER_MODE_UNSUPPORTED", batchCode, projectDomain, requestedMode, finalMode: requestedMode, taskMode: requestedMode, readOnlyMode: true, approvalRequired: false, allowedScope: readOnlyAllowedScope, forbiddenScope: readOnlyForbiddenScope };
  }

  return { ok: true, batchCode, projectDomain: "automation_system", requestedMode: "worker_read_only", finalMode: "worker_read_only", taskMode: "worker_read_only", readOnlyMode: true, approvalRequired: false, allowedScope: readOnlyAllowedScope, forbiddenScope: readOnlyForbiddenScope };
}

function classifyProjectDirectorDemand(
  text: string
): ReturnType<typeof classifyBaseProjectDirectorDemand> {
  if (isAutomationSystemRepairDemand(text)) {
    return "system_upgrade_request";
  }

  return classifyBaseProjectDirectorDemand(text);
}

function isApprovedRepairReply(text: string): boolean {
  return /总管\s*批准修复|批准修复/i.test(normalizeFeishuTaskText(text));
}

function isApprovedBatchExecutionReply(text: string): boolean {
  const normalized = normalizeFeishuTaskText(text);
  if (!normalized.match(ROUTE_BATCH_CODE_PATTERN)) return false;

  return (
    /(?:总管\s*)?批准执行\s*[:：\s]/i.test(normalized) ||
    /(?:仅批准|只批准)\s*BATCH-/i.test(normalized) ||
    /approved\s+execution\s+only\s+BATCH-/i.test(normalized)
  );
}

function isApprovedExecutionReply(text: string): boolean {
  const normalized = normalizeFeishuTaskText(text);
  return (
    isBaseApprovedExecutionReply(normalized) ||
    /^(总管\s*)?批准执行$/i.test(normalized) ||
    isApprovedBatchExecutionReply(normalized) ||
    isApprovedRepairReply(normalized)
  );
}

function extractApprovedBatchCode(text: string): string | null {
  if (!isApprovedRepairReply(text) && !isApprovedBatchExecutionReply(text)) return null;
  const match = extractRelevantRouteBatchText(normalizeFeishuTaskText(text)).match(
    ROUTE_BATCH_CODE_PATTERN
  );
  return match?.[0] ?? null;
}

function extractApprovedRepairBatchCode(text: string): string | null {
  return extractApprovedBatchCode(text);
}

function stripForbiddenRouteBatchFragments(line: string): string {
  return line.split(ROUTE_BATCH_FORBIDDEN_FRAGMENT_PATTERN)[0].trim();
}

function extractRelevantRouteBatchText(text: string): string {
  const lines = text.split(/\r?\n/);
  const chunks: string[] = [];
  let inForbiddenSection = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (!line) {
      inForbiddenSection = false;
      continue;
    }

    const isRelevantLine =
      (index === 0 && /^新需求[:：]/.test(line)) ||
      ROUTE_BATCH_RELEVANT_LINE_PATTERN.test(line);

    if (ROUTE_BATCH_FORBIDDEN_SECTION_HEADING_PATTERN.test(line) && !isRelevantLine) {
      inForbiddenSection = true;
      continue;
    }

    if (inForbiddenSection) {
      if (!ROUTE_BATCH_FORBIDDEN_SECTION_EXIT_PATTERN.test(line)) {
        continue;
      }
      inForbiddenSection = false;
    }

    if (isRelevantLine) {
      inForbiddenSection = false;
      const cleanedLine = stripForbiddenRouteBatchFragments(line);
      if (cleanedLine) {
        chunks.push(cleanedLine);
      }
    }
  }

  return chunks.join("\n");
}

function dispatchTaskMatchesBatch(
  task: DispatchJobBuildResult["tasks"][number],
  batchCode: string
): boolean {
  const values = [
    task.task_code,
    task.task_key,
    task.dispatch_batch,
    task.task_title,
    ...(Array.isArray(task.input) ? task.input : []),
  ];

  return values.some((value) => String(value ?? "").includes(batchCode));
}

function filterApprovedRepairBuildResult(
  buildResult: DispatchJobBuildResult,
  batchCode: string | null
): DispatchJobBuildResult {
  if (!batchCode) return buildResult;

  const indexes = buildResult.tasks
    .map((task, index) => (dispatchTaskMatchesBatch(task, batchCode) ? index : -1))
    .filter((index) => index >= 0);

  return {
    ...buildResult,
    tasks: indexes.map((index) => buildResult.tasks[index]),
    requestTexts: indexes.map((index) => buildResult.requestTexts[index]),
  };
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
  feishuMessageId: string
): Promise<void> {
  const planningInsertNote = [
    "planning_job: not_inserted_before_boss_approval",
    `boss_request_id: ${draft.boss_request_id}`,
    `plan_id: ${draft.plan_id}`,
    `original_demand: ${originalDemand}`,
    "note: BATCH-17 keeps planning in hermes_messages only until 总管 批准执行.",
  ].join("\n");

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

function attachProjectDirectorDispatchMetadata(
  buildResult: {
    requestTexts: string[];
    tasks: Array<{ task_key?: string; task_code?: string }>;
  },
  input: {
    bossRequestId: string;
    planId: string;
    originalDemand: string;
  }
): void {
  buildResult.requestTexts = buildResult.requestTexts.map((requestText, index) => {
    const taskKey =
      buildResult.tasks[index]?.task_key ?? buildResult.tasks[index]?.task_code ?? `task-${index + 1}`;
    return [
      "[Project Director Dispatch Metadata]",
      `boss_request_id: ${input.bossRequestId}`,
      `plan_id: ${input.planId}`,
      `task_key: ${taskKey}`,
      "attempt_id: assigned_on_worker_claim",
      "attempt_contract: Worker must echo the attempt_id returned by /api/worker/next in heartbeat/progress/report; mismatched attempt_id is rejected.",
      `original_demand: ${input.originalDemand}`,
      "",
      requestText,
    ].join("\n");
  });
}

function buildDirectWorkerTaskText(text: string): string {
  return normalizeFeishuTaskText(
    text
      .replace(/请\s*直接\s*创建\s*Worker\s*任务[：:，,。.]?/gi, "")
      .replace(/直接\s*创建\s*Worker\s*任务[：:，,。.]?/gi, "")
      .replace(/立即\s*创建\s*Worker\s*任务[：:，,。.]?/gi, "")
      .replace(/请\s*立即\s*排队\s*Worker\s*任务[：:，,。.]?/gi, "")
      .replace(/请直接创建\s*Worker\s*任务[：:，,。.]?/gi, "")
      .replace(/直接创建\s*Worker\s*任务[：:，,。.]?/gi, "")
      .replace(/直接进入\s*Worker\s*创建流程[：:，,。.]?/gi, "")
      .replace(/跳过\s*A\/B\s*询问[：:，,。.]?/gi, "")
  );
}

function escapeWorkerContextValue(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, "\\n").trim();
}

const DIRECT_WORKER_CONTEXT_REQUIRED_FIELDS = [
  "project_domain",
  "requested_mode",
  "final_mode",
  "task_mode",
  "read_only_mode",
  "approval_required",
  "allowed_scope",
  "forbidden_scope",
  "original_request_text",
  "approved_batch",
];

function withHermesWorkerContext(requestText: string, context: Record<string, unknown>): string {
  const orderedKeys = Array.from(new Set([...DIRECT_WORKER_CONTEXT_REQUIRED_FIELDS, ...Object.keys(context)]));
  const contextLines = orderedKeys
    .filter((key) => context[key] !== null && context[key] !== undefined && context[key] !== "")
    .map((key) => `${key}: ${escapeWorkerContextValue(context[key])}`);

  return [
    requestText.trim(),
    "",
    "HERMES_WORKER_CONTEXT:",
    ...contextLines,
  ].join("\n");
}

async function insertDirectWorkerTask(
  supabase: SupabaseClient,
  input: {
    requestText: string;
    rawText: string;
    feishuMessageId: string;
    feishuEventId: string;
    feishuChatId: string;
    feishuUserId: string;
  }
): Promise<{ jobId: string | null }> {
  const modeContract = resolveDirectWorkerReadOnlyContract(input.rawText);
  const taskDomain = modeContract.projectDomain;
  const contractPayload = buildWorkerJobPayloadContract({
    requestText: input.requestText,
    originalRequestText: input.rawText,
    projectDomain: taskDomain,
    taskMode: modeContract.taskMode,
    readOnlyMode: modeContract.readOnlyMode,
    allowedScope: modeContract.allowedScope,
    forbiddenScope: modeContract.forbiddenScope,
    approvedBatch: modeContract.batchCode,
    route: "direct_worker_create",
    workerStage: "queued",
    workflowStage: "queued",
    finalReportStatus: "pending",
    effectiveFinalStatus: "pending",
    changedFiles: [],
    pushed: false,
    deployStatus: null,
  });
  const directWorkerPayload = {
    ...contractPayload,
    requested_mode: modeContract.requestedMode,
    final_mode: modeContract.finalMode,
    approval_required: modeContract.approvalRequired,
  };
  const contextualRequestText = withHermesWorkerContext(input.requestText, directWorkerPayload);
  const row = {
    source: "direct_worker_create",
    job_type: taskDomain,
    title: `Direct Worker task: ${input.requestText.slice(0, 80)}`,
    description: contextualRequestText,
    prompt: contextualRequestText,
    request_text: contextualRequestText,
    status: "queued",
    priority: 10,
    source_message_id: input.feishuMessageId,
    source_chat_id: input.feishuChatId,
    source_event_id: input.feishuEventId,
    feishu_message_id: input.feishuMessageId,
    feishu_event_id: input.feishuEventId,
    feishu_chat_id: input.feishuChatId,
    feishu_user_id: input.feishuUserId,
    payload: {
      ...directWorkerPayload,
      task_domain: taskDomain,
      route: "direct_worker_create",
      raw_message: input.rawText,
      skip_planning_choice: true,
    },
  };
  const insertResult = await createHermesJob(
    supabase,
    row,
    "insert direct worker task failed"
  );
  return { jobId: insertResult.jobIds[0] ?? null };
}

function readTaskScopeItems(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function inferApprovedTaskMode(task: Record<string, any>): string | null {
  const allowedFiles = readTaskScopeItems(task.allowed_files);
  if (allowedFiles.length === 0) return null;

  const normalized = allowedFiles.map((file) => file.replace(/\\/g, "/"));
  if (
    normalized.some((file) =>
      file === "infra/windows-worker" ||
      file.startsWith("infra/windows-worker/") ||
      file === "src/lib/worker-jobs.ts" ||
      file.startsWith("src/app/api/feishu/") ||
      file === "src/app/api/feishu/event/route.ts" ||
      file === "src/lib/project-director-console.ts" ||
      file.startsWith("work/tencent-cloud/")
    )
  ) {
    return "automation_system_write_allowed";
  }
  if (
    normalized.some((file) =>
      file === "src/app" ||
      file.startsWith("src/app/") ||
      file === "app" ||
      file.startsWith("app/") ||
      file === "docs/NEXT_TASK_CARD.md" ||
      file === "docs/projects/city-partner-website.md"
    )
  ) {
    return "product_write_allowed";
  }
  if (normalized.every((file) => file === "docs" || file.startsWith("docs/"))) {
    return "docs_write_allowed";
  }

  return null;
}

function projectDomainForTaskMode(taskMode: string | null): string | null {
  if (taskMode === "automation_system_write_allowed") return "automation_system";
  if (taskMode === "product_write_allowed") return "city_partner_product";
  if (taskMode === "docs_write_allowed") return "governance_docs";
  return null;
}

async function insertApprovedAgentDispatchJobsWithContract(
  supabase: SupabaseClient,
  buildResult: DispatchJobBuildResult,
  feishuContext?: {
    messageId: string;
    eventId: string;
    chatId: string;
    userId: string;
  }
): Promise<{ insertedCount: number; skippedColumns: string[] }> {
  const rows = buildResult.tasks.map((task: any, index) => {
    const requestText = buildResult.requestTexts[index] ?? "";
    const taskMode = inferApprovedTaskMode(task);
    const contractPayload = buildWorkerJobPayloadContract({
      requestText,
      originalRequestText: requestText,
      projectDomain: projectDomainForTaskMode(taskMode),
      taskMode,
      readOnlyMode: taskMode ? false : null,
      allowedScope: task.allowed_files,
      forbiddenScope: task.forbidden_files,
      route: "approved_execution",
      approvedBatch: task.dispatch_batch,
      workerStage: "execution",
      workflowStage: "execution",
      finalReportStatus: "pending",
      effectiveFinalStatus: "pending",
      changedFiles: [],
      pushed: false,
      deployStatus: null,
    });

    return {
      source: "project_director_approval",
      job_type: "agent_dispatch",
      job_id: task.task_key,
      title: task.task_title,
      description: requestText,
      priority: task.requires_boss_approval ? 30 : 15,
      acceptance: readTaskScopeItems(task.acceptance_criteria).join("\n"),
      branch: null,
      executor: task.agent_role,
      repo: "city-partner-platform",
      prompt: requestText,
      request_text: requestText,
      status: "queued",
      plan_status: "approved",
      workflow_stage: "execution",
      source_message_id: feishuContext?.messageId ?? null,
      source_chat_id: feishuContext?.chatId ?? null,
      source_event_id: feishuContext?.eventId ?? null,
      feishu_message_id: feishuContext?.messageId ?? null,
      feishu_event_id: feishuContext?.eventId ?? null,
      feishu_chat_id: feishuContext?.chatId ?? null,
      feishu_user_id: feishuContext?.userId ?? null,
      claimed_by: null,
      claimed_at: null,
      started_at: null,
      parent_task_id: null,
      project_id: buildResult.projectTitle,
      task_code: task.task_key,
      dispatch_batch: task.dispatch_batch,
      payload: {
        ...contractPayload,
        project_title: buildResult.projectTitle,
        batch_code: task.dispatch_batch,
        role: task.agent_role,
        task_type: task.task_type,
        task_key: task.task_key,
        task_title: task.task_title,
        dependency_keys: task.dependency_keys,
        allowed_files: task.allowed_files,
        forbidden_files: task.forbidden_files,
        acceptance_criteria: task.acceptance_criteria,
        requires_boss_approval: task.requires_boss_approval,
        execution_mode: "approved_execution",
      },
    };
  });

  return createHermesJobs(
    supabase,
    rows,
    "insert approved agent dispatch jobs failed"
  );
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
        const action = await buildProjectDirectorConsoleAction(supabase, text, convId);
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
        text =
          isApprovedRepairReply(text) || isApprovedBatchExecutionReply(text)
            ? text
            : "总管 批准执行";
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

      if (isDirectWorkerTaskRequest(text) || isExplicitDirectWorkerCreateCommand(text)) {
        const requestText = buildDirectWorkerTaskText(text) || normalizeFeishuTaskText(text);
        const modeContract = resolveDirectWorkerReadOnlyContract(text);
        const token = await getFeishuToken();

        if (!modeContract.ok) {
          const reply = [
            "PROJECT_DIRECTOR_DIRECT_WORKER_TASK_REJECTED",
            `error_code: ${modeContract.error}`,
            `batch: ${modeContract.batchCode ?? "missing"}`,
            `project_domain=${modeContract.projectDomain}`,
            `requested_mode=${modeContract.requestedMode ?? "not_provided"}`,
            `final_mode=${modeContract.finalMode ?? "not_provided"}`,
            `task_mode=${modeContract.taskMode ?? "not_provided"}`,
            `read_only_mode=${modeContract.readOnlyMode ? "true" : "false"}`,
            `approval_required=${modeContract.approvalRequired ? "true" : "false"}`,
            "worker_created=false",
            "manager_read_only does not create Worker; write_allowed requires exact approval.",
          ].join("\n");
          await saveSystemRecordedReply(
            supabase,
            convId,
            text,
            reply,
            [
              "PROJECT_DIRECTOR_DIRECT_WORKER_TASK_REJECTED",
              `state: ${modeContract.error}`,
              `batch: ${modeContract.batchCode ?? "missing"}`,
              `requested_mode: ${modeContract.requestedMode ?? "not_provided"}`,
            ].join("\n"),
            "project_director_direct_worker_task_rejected",
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
            direct_worker_task: true,
            state: "rejected",
            hermes_jobs_created: false,
            error: modeContract.error,
          });
        }

        const duplicateCheck = await findRecentDuplicateFeishuJob(supabase, requestText);

        if (duplicateCheck.error) {
          console.error(
            "[feishu-event] direct worker duplicate check skipped:",
            sanitizeLogText(duplicateCheck.error.message ?? "unknown error")
          );
        } else if (duplicateCheck.duplicate) {
          const existingJobNo = duplicateCheck.duplicate.job_id ?? duplicateCheck.duplicate.id;
          const reply = [
            "PROJECT_DIRECTOR_DIRECT_WORKER_TASK_DUPLICATE",
            `existing_job_id: ${existingJobNo}`,
            `batch: ${modeContract.batchCode}`,
            `current_status: ${(duplicateCheck.duplicate as any).status ?? "unknown"}`,
            "created_duplicate=false",
          ].join("\n");
          await saveSystemRecordedReply(
            supabase,
            convId,
            text,
            reply,
            [
              "PROJECT_DIRECTOR_DIRECT_WORKER_TASK_DUPLICATE",
              "state: duplicate_skipped",
              `approved_batch: ${modeContract.batchCode}`,
              `request_text: ${requestText}`,
              "skip_planning_choice: true",
              "note: direct Worker task requests are handled before A/B choice parsing.",
            ].join("\n"),
            "project_director_direct_worker_task_duplicate",
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
            direct_worker_task: true,
            state: "duplicate_skipped",
            hermes_jobs_created: false,
            existing_job_id: duplicateCheck.duplicate.id,
            existing_job_no: duplicateCheck.duplicate.job_id ?? null,
          });
        }

        const insertResult = await insertDirectWorkerTask(supabase, {
          requestText,
          rawText: text,
          feishuMessageId: ev.message.message_id,
          feishuEventId: eventId,
          feishuChatId: ev.message.chat_id,
          feishuUserId: userId,
        });
        const reply = [
          "PROJECT_DIRECTOR_WORKER_READ_ONLY_TASK_CREATED",
          `job_id: ${insertResult.jobId ?? "pending"}`,
          `batch: ${modeContract.batchCode}`,
          "status: queued",
          "task_mode: worker_read_only",
          "read_only_mode: true",
          "codex_sandbox: read-only",
        ].join("\n");
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          [
            "PROJECT_DIRECTOR_DIRECT_WORKER_TASK_CREATED",
            "state: queued",
            "task_mode: worker_read_only",
            "read_only_mode: true",
            `approved_batch: ${modeContract.batchCode}`,
            `job_id: ${insertResult.jobId ?? "pending"}`,
            `request_text: ${requestText}`,
            "skip_planning_choice: true",
            "hermes_jobs_created: yes",
          ].join("\n"),
          "project_director_direct_worker_task",
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
          direct_worker_task: true,
          state: "queued",
          hermes_jobs_created: true,
          job_id: insertResult.jobId,
        });
      }

      if (isPlanChangeReply(text)) {
        const reply = buildProjectDirectorPlanChangeReply(text);
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          buildProjectDirectorPlanChangeRecord(text),
          "project_director_plan_change",
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
          state: "plan_change_recorded",
          execution_mode: "planning_only",
        });
      }

      const planningChoice = parseProjectDirectorPlanningChoice(text);
      if (planningChoice) {
        const pendingDemand = await findPendingProjectDirectorConfirmation(supabase, convId);
        const recentDemand = pendingDemand
          ? null
          : await findRecentProjectDirectorDemand(supabase, convId);
        const originalDemand = buildPlanningChoiceOriginalDemand(
          planningChoice,
          pendingDemand || recentDemand
        );
        const draft = buildProjectDirectorTaskTreeDraft(originalDemand, text, "planning_only");
        const reply = buildProjectDirectorPlanningChoiceReply(planningChoice, originalDemand);
        const draftRecord = [
          buildTaskTreeDraftRecord(originalDemand, text, draft, reply),
          buildProjectDirectorPlanningChoiceRecord({
            choice: planningChoice,
            originalDemand,
            bossReply: text,
            planId: draft.plan_id,
          }),
        ].join("\n");
        await savePlanningTaskTreeReply(
          supabase,
          convId,
          originalDemand,
          text,
          reply,
          draftRecord,
          draft,
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
          state: "planning_choice_recorded",
          choice: planningChoice,
          execution_mode: "planning_only",
          hermes_jobs_created: false,
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
      const approvedBatchCode = extractApprovedRepairBatchCode(text);
      const buildResult = filterApprovedRepairBuildResult(
        buildApprovedAgentDispatchJobs(dispatchPlan),
        approvedBatchCode
      );
      if (approvedBatchCode && buildResult.tasks.length === 0) {
        const reply = `未找到可执行的 ${approvedBatchCode} 最小执行任务，本次不会分发其他批次。`;
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          [
            "PROJECT_DIRECTOR_APPROVED_BATCH_BLOCKED",
            "state: approved_batch_missing",
            `batch_code: ${approvedBatchCode}`,
            "reason: boss approved a specific batch, but the current task tree has no matching task.",
          ].join("\n"),
          "project_director_approved_repair_blocked",
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
          state: "approved_repair_batch_missing",
          batch_code: approvedBatchCode,
        });
      }
      const dispatchedTaskKeys = new Set(buildResult.tasks.map((task) => task.task_key));
      const dispatchedBatches = dispatchPlan.dispatch_plan.batches
        .map((batch) => ({
          ...batch,
          tasks: batch.tasks.filter((task) => dispatchedTaskKeys.has(task.task_key)),
        }))
        .filter((batch) => batch.tasks.length > 0);
      attachProjectDirectorDispatchMetadata(buildResult, {
        bossRequestId: approvedTree.boss_request_id,
        planId: approvedTree.plan_id,
        originalDemand: recentDraft.originalDemand,
      });
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

      const insertResult = await insertApprovedAgentDispatchJobsWithContract(supabase, buildResult, {
        messageId: ev.message.message_id,
        eventId,
        chatId: ev.message.chat_id,
        userId,
      });
      const reply = [
        `[Project Director Dispatch] boss_request_id=${approvedTree.boss_request_id}`,
        `[Project Director Dispatch] plan_id=${approvedTree.plan_id}`,
        "【项目总管：已批准执行】",
        `已创建 ${insertResult.insertedCount} 个 Agent 执行任务。`,
        "",
        "执行顺序：",
        ...dispatchedBatches
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
          `boss_request_id: ${approvedTree.boss_request_id}`,
          `plan_id: ${approvedTree.plan_id}`,
          `original_demand: ${recentDraft.originalDemand}`,
          `approved_batch_filter: ${approvedBatchCode || "none"}`,
          `repair_batch_filter: ${approvedBatchCode || "none"}`,
          "attempt_id_contract: assigned_on_worker_claim_and_required_on_report",
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
      const processingErrorText = errorToText(e);
      console.error("[feishu-event] processing failed:", sanitizeLogText(processingErrorText));
      try {
        await markReceiptFailed(supabase, eventId, processingErrorText);
      } catch (receiptFailError) {
        console.error(
          "[feishu-event] receipt fail update failed:",
          sanitizeLogText(errorToText(receiptFailError))
        );
      }
      const hermesInsertFailureReply = buildHermesInsertFailureReply(processingErrorText, text);
      if (hermesInsertFailureReply) {
        try {
          const token = await getFeishuToken();
          await sendFeishuMessage(
            token,
            ev.message.chat_id,
            ev.message.chat_type === "p2p" ? "open_id" : "chat_id",
            hermesInsertFailureReply
          );
        } catch (sendError) {
          console.error(
            "[feishu-event] hermes insert failure reply failed:",
            sanitizeLogText(errorToText(sendError))
          );
        }
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
