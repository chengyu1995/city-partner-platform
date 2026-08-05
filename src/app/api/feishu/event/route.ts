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
import { after, NextResponse, NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { decryptFeishuEvent } from "@/lib/feishu-crypto";
import { createCanonicalHermesPlanningProvider, runAgent, AgentMessage } from "@/lib/hermes-agent";
import {
  canonicalHermesAllowsDirectWorkerBypass,
  runApprovedRequestThroughCanonicalHermes,
  scheduleApprovedRequestThroughHermesShadow,
} from "@/lib/project-director-hermes-delegation";
import { isHermesCanonicalOrchestrationEnabled } from "@/lib/hermes/orchestration-adapter";
import { buildLegacyShadowPlan } from "@/lib/hermes/shadow-runtime";
import {
  OpenClawShadowCapabilityGateway,
  RegistryCapabilityGateway,
} from "@/lib/openclaw/capability-gateway";
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
  canonicalCreateJob,
  canonicalPersistenceRuntimeEnabled,
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
  return /direct\s+create\s+Worker\s+task|create\s+Worker\s+task|direct\s+dispatch\s+to\s+Worker/i.test(normalized) ||
    /(?:\u8bf7\s*)?\u76f4\u63a5\s*\u521b\u5efa\s*Worker\s*\u4efb\u52a1|(?:\u8bf7\s*)?\u521b\u5efa\s*Worker\s*\u4efb\u52a1|\u7acb\u5373\s*\u521b\u5efa\s*Worker\s*\u4efb\u52a1|(?:\u8bf7\s*)?\u7acb\u5373\s*\u6392\u961f\s*Worker\s*\u4efb\u52a1|\u76f4\u63a5\s*\u5206\u53d1\s*\u7ed9\s*Worker/i.test(normalized) ||
    /(?:\u65e0\u9700\s*\u518d\u6b21\s*\u89c4\u5212|\u65e0\u9700\s*\u518d\u6b21\s*\u5ba1\u6279|\u65e0\u9700\s*\u518d\u6b21\s*\u6279\u51c6)[\s\S]*(?:Worker|\bBATCH-)/i.test(normalized);
}

function isExplicitCanonicalMaintenanceDirectWorker(text: string): boolean {
  return /canonical_direct_worker_maintenance\s*[:=]\s*true/i.test(text) &&
    /maintenance|diagnostic|debug|repair/i.test(text);
}

function approvedHermesMode(text: string): "manager_read_only" | "worker_read_only" | "write_allowed" | null {
  const value = parseDirectRequestedMode(text, extractPrimaryRouteBatchCode(text));
  if (!value) return null;
  if (value === "manager_read_only") return "manager_read_only";
  if (value === "write_allowed" || value === "automation_system_write_allowed") return "write_allowed";
  if (value === "worker_read_only" || value === "read_only" || value === "automation_system_worker_read_only") {
    return "worker_read_only";
  }
  return null;
}

function parseDirectRequestedMode(text: string, batchCode: string | null): string | null {
  const normalized = normalizeFeishuTaskText(text);
  const explicit = normalized.match(
    /(?:execution_mode|requested_mode|final_mode|task_mode|\u6267\u884c\u6a21\u5f0f)\s*[:\uFF1A=]\s*(manager_read_only|worker_read_only|read_only|write_allowed|automation_system_write_allowed|automation_system_worker_read_only)\b/i
  );
  if (explicit) return explicit[1].toLowerCase();
  if (batchCode && /\bBATCH-GM-MODE-SMOKE-MANAGER(?:-[A-Z0-9]+)*\b/i.test(batchCode)) return "manager_read_only";
  if (batchCode && /\bBATCH-GM-MODE-SMOKE-WORKER(?:-[A-Z0-9]+)*\b/i.test(batchCode)) return "worker_read_only";
  if (batchCode && /\bBATCH-GM-MODE-SMOKE-WRITE(?:-[A-Z0-9]+)*\b/i.test(batchCode)) return "write_allowed";
  return null;
}

function readDirectWorkerContextField(text: string, fieldName: string): string | null {
  const pattern = new RegExp(`^\\s*${fieldName}\\s*[:\uFF1A=]\\s*(.+?)\\s*$`, "im");
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

function hasDirectWorkerContextField(text: string, fieldName: string): boolean {
  const pattern = new RegExp(`^\\s*${fieldName}\\s*[:\uFF1A=]`, "im");
  return pattern.test(text);
}

function readDirectWorkerBooleanField(text: string, fieldName: string): boolean | null {
  const value = readDirectWorkerContextField(text, fieldName);
  if (!value) return null;
  if (/^(true|yes|1)$/i.test(value)) return true;
  if (/^(false|no|0)$/i.test(value)) return false;
  return null;
}

function normalizeDirectWorkerWriteMode(mode: string | null): "write" | "read_only" | "manager_read_only" | null {
  const normalized = mode?.trim().toLowerCase() ?? null;
  if (!normalized || normalized === "not_provided") return null;
  if (normalized === "write_allowed" || normalized === "automation_system_write_allowed") return "write";
  if (
    normalized === "worker_read_only" ||
    normalized === "read_only" ||
    normalized === "automation_system_worker_read_only"
  ) {
    return "read_only";
  }
  if (normalized === "manager_read_only") return "manager_read_only";
  return null;
}

function resolveDirectWorkerReadOnlyContract(text: string) {
  const explicitApprovedBatch = readDirectWorkerContextField(text, "approved_batch");
  const batchCode = explicitApprovedBatch?.toUpperCase() ?? extractPrimaryRouteBatchCode(text);
  const requestedMode = readDirectWorkerContextField(text, "requested_mode") ?? parseDirectRequestedMode(text, batchCode);
  const explicitTaskMode = readDirectWorkerContextField(text, "task_mode");
  const finalMode = readDirectWorkerContextField(text, "final_mode") ?? explicitTaskMode ?? requestedMode;
  const taskMode = explicitTaskMode ?? finalMode;
  const readOnlyMode = readDirectWorkerBooleanField(text, "read_only_mode");
  const explicitProjectDomain = readDirectWorkerContextField(text, "project_domain");
  const projectDomain = explicitProjectDomain ??
    (batchCode && /^BATCH-GM-/i.test(batchCode) ? "automation_system" : classifyFeishuWorkerTaskDomain(text));
  const approvalRequired = readDirectWorkerBooleanField(text, "approval_required") ?? false;
  const allowedScopeText = readDirectWorkerContextField(text, "allowed_scope");
  const forbiddenScopeText = readDirectWorkerContextField(text, "forbidden_scope");
  const hasExactAllowedScope = hasDirectWorkerContextField(text, "exact_allowed_scope");
  const exactAllowedScope = extractExactAllowedScopePaths(text);
  const finalIntent = normalizeDirectWorkerWriteMode(finalMode);
  const taskIntent = normalizeDirectWorkerWriteMode(taskMode);
  const requestedIntent = normalizeDirectWorkerWriteMode(requestedMode);
  const readOnlyAllowedScope = "Worker read-only static inspection; no file writes; no git add/commit/push";
  const readOnlyForbiddenScope = "file writes, git add, git commit, git push, dev server, database, env, deploy";
  const missingFields: string[] = [];

  if (!batchCode) missingFields.push("approved_batch");
  if (!explicitProjectDomain) missingFields.push("project_domain");
  if (!taskMode) missingFields.push("task_mode");
  if (readOnlyMode === null) missingFields.push("read_only_mode");
  if (!forbiddenScopeText) missingFields.push("forbidden_scope");

  if (missingFields.length > 0) {
    return { ok: false, error: "DIRECT_WORKER_CONTEXT_MISSING", missingFields, batchCode, projectDomain, requestedMode, finalMode, taskMode, readOnlyMode: readOnlyMode ?? true, approvalRequired, allowedScope: allowedScopeText ?? readOnlyAllowedScope, forbiddenScope: forbiddenScopeText ?? readOnlyForbiddenScope };
  }

  if (requestedIntent === "manager_read_only" || finalIntent === "manager_read_only" || taskIntent === "manager_read_only") {
    return { ok: false, error: "DIRECT_MANAGER_READ_ONLY_REJECTED", missingFields, batchCode, projectDomain, requestedMode, finalMode: "manager_read_only", taskMode: "manager_read_only", readOnlyMode: true, approvalRequired: false, allowedScope: readOnlyAllowedScope, forbiddenScope: forbiddenScopeText ?? readOnlyForbiddenScope };
  }
  if (!finalIntent || !taskIntent || finalIntent !== taskIntent) {
    return { ok: false, error: "DIRECT_WORKER_MODE_UNSUPPORTED", missingFields, batchCode, projectDomain, requestedMode, finalMode, taskMode, readOnlyMode, approvalRequired, allowedScope: allowedScopeText ?? readOnlyAllowedScope, forbiddenScope: forbiddenScopeText ?? readOnlyForbiddenScope };
  }
  if (requestedIntent && requestedIntent !== finalIntent) {
    return { ok: false, error: "DIRECT_WORKER_MODE_CONFLICT", missingFields, batchCode, projectDomain, requestedMode, finalMode, taskMode, readOnlyMode, approvalRequired, allowedScope: allowedScopeText ?? readOnlyAllowedScope, forbiddenScope: forbiddenScopeText ?? readOnlyForbiddenScope };
  }
  if (finalIntent === "write") {
    const writeMissing = [
      !hasExactAllowedScope || exactAllowedScope.length === 0 ? "exact_allowed_scope" : null,
      !readDirectWorkerContextField(text, "task_goal") ? "task_goal" : null,
      !readDirectWorkerContextField(text, "required_output_fields") ? "required_output_fields" : null,
      !readDirectWorkerContextField(text, "acceptance_conditions") ? "acceptance_conditions" : null,
    ].filter((item): item is string => Boolean(item));
    if (readOnlyMode !== false) writeMissing.push("read_only_mode=false");
    if (writeMissing.length > 0) {
      return { ok: false, error: "DIRECT_WORKER_CONTEXT_MISSING", missingFields: writeMissing, batchCode, projectDomain, requestedMode, finalMode, taskMode, readOnlyMode, approvalRequired, allowedScope: allowedScopeText ?? readOnlyAllowedScope, forbiddenScope: forbiddenScopeText ?? readOnlyForbiddenScope };
    }

    return { ok: true, missingFields, batchCode, projectDomain, requestedMode: requestedMode ?? "not_provided", finalMode: finalMode === "write_allowed" ? "write_allowed" : "automation_system_write_allowed", taskMode: taskMode === "write_allowed" ? "automation_system_write_allowed" : taskMode, readOnlyMode: false, approvalRequired, allowedScope: allowedScopeText ?? exactAllowedScope, forbiddenScope: forbiddenScopeText ?? readOnlyForbiddenScope };
  }

  return { ok: true, missingFields, batchCode, projectDomain: "automation_system", requestedMode: requestedMode ?? "worker_read_only", finalMode: "worker_read_only", taskMode: "worker_read_only", readOnlyMode: true, approvalRequired: false, allowedScope: allowedScopeText ?? readOnlyAllowedScope, forbiddenScope: forbiddenScopeText ?? readOnlyForbiddenScope };
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
  "exact_allowed_scope",
  "exact_allowed_scope_count",
  "forbidden_scope",
  "forbidden_operations",
  "task_goal",
  "required_output_fields",
  "acceptance_conditions",
  "original_request_text",
  "original_request_text_base64",
  "approved_batch",
  "chat_id",
  "root_id",
  "message_id",
  "created_at",
  "consumed",
  "context_id",
];

function normalizeScopePathToken(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^[`'"\s]+|[`'"\s]+$/g, "")
    .replace(/[，,。；;:：、）)】\]]+$/g, "")
    .trim();
}

function uniqueScopePaths(paths: string[]): string[] {
  return Array.from(
    new Set(paths.map(normalizeScopePathToken).filter((item) => item.length > 0))
  ).sort();
}

const ROUTE_SCOPE_PATH_PATTERN = /\b(?:app|src|infra|docs|work)\/[A-Za-z0-9_./*[\]-]+/g;
const POSITIVE_SCOPE_BLOCK_HEADING_PATTERN =
  /^\s*(?:[-*#>\d.、)]\s*)?(?:唯一允许修改文件|只允许修改文件|仅允许修改文件|允许修改文件|唯一允许修改|只允许修改|仅允许修改|允许修改|exact_allowed_scope|allowed_scope|changed_files\s*必须严格等于)\s*[:：=]?\s*$/i;
const POSITIVE_SCOPE_INLINE_PATTERN =
  /(?:唯一允许修改文件|只允许修改文件|仅允许修改文件|允许修改文件|唯一允许修改|只允许修改|仅允许修改|允许修改|exact_allowed_scope|allowed_scope|changed_files\s*必须严格等于)\s*[:：=]\s*(.+)$/i;
const NEGATIVE_SCOPE_LABEL_PATTERN =
  /(?:禁止修改范围|禁止修改|不得修改|不允许修改|不要修改|排除范围|forbidden_scope|forbidden|prohibit|不得|不允许|禁止)/i;
const ORDINARY_SCOPE_SECTION_PATTERN =
  /^(?:故障|故障现象|根因|问题|历史|示例|验收|测试|完成后|输出|报告|当前|目标|修复要求|验证要求|禁止事项|硬性边界)\s*[:：]?/i;

function lineStartsPositiveScopeBlock(line: string): boolean {
  return (
    (POSITIVE_SCOPE_BLOCK_HEADING_PATTERN.test(line) || POSITIVE_SCOPE_INLINE_PATTERN.test(line)) &&
    !NEGATIVE_SCOPE_LABEL_PATTERN.test(line)
  );
}

function lineStartsNegativeScopeBlock(line: string): boolean {
  return NEGATIVE_SCOPE_LABEL_PATTERN.test(line);
}

function extractScopePathsFromFragment(value: string): string[] {
  return Array.from(value.matchAll(ROUTE_SCOPE_PATH_PATTERN)).map((match) => match[0]);
}

function stripScopeListPrefix(line: string): string {
  return line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "").trim();
}

function extractExactAllowedScopePaths(text: unknown): string[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const paths: string[] = [];
  let inAllowedBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      inAllowedBlock = false;
      continue;
    }

    if (lineStartsNegativeScopeBlock(line)) {
      inAllowedBlock = false;
      continue;
    }

    if (ORDINARY_SCOPE_SECTION_PATTERN.test(line) && !lineStartsPositiveScopeBlock(line)) {
      inAllowedBlock = false;
      continue;
    }

    const inlineMatch = line.match(POSITIVE_SCOPE_INLINE_PATTERN);
    if (POSITIVE_SCOPE_BLOCK_HEADING_PATTERN.test(line) && !inlineMatch) {
      inAllowedBlock = true;
      continue;
    }

    const source = inlineMatch?.[1] ?? (inAllowedBlock ? stripScopeListPrefix(line) : "");
    if (!source) continue;

    const linePaths = extractScopePathsFromFragment(source);
    if (linePaths.length === 0) {
      inAllowedBlock = false;
      continue;
    }
    for (const item of linePaths) {
      paths.push(item);
    }
  }

  return uniqueScopePaths(paths);
}

function extractForbiddenScopePaths(text: unknown): string[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const paths: string[] = [];
  let inForbiddenBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      inForbiddenBlock = false;
      continue;
    }

    if (lineStartsPositiveScopeBlock(line)) {
      inForbiddenBlock = false;
      continue;
    }

    const inlineMatch = line.match(
      /(?:禁止修改范围|禁止修改|不得修改|不允许修改|不要修改|排除范围|forbidden_scope|forbidden|prohibit)\s*[:：=]\s*(.+)$/i
    );
    if (lineStartsNegativeScopeBlock(line) && /[:：]?\s*$/.test(line) && !inlineMatch) {
      inForbiddenBlock = true;
      continue;
    }

    const source = inlineMatch?.[1] ?? (inForbiddenBlock ? stripScopeListPrefix(line) : "");
    if (!source) continue;

    const linePaths = extractScopePathsFromFragment(source);
    if (linePaths.length === 0) {
      inForbiddenBlock = false;
      continue;
    }
    paths.push(...linePaths);
  }

  return uniqueScopePaths(paths);
}

function normalizeScopeListItems(items: unknown[]): string[] {
  return uniqueScopePaths(
    items.flatMap((item) => extractScopePathsFromFragment(String(item ?? "")))
  );
}

function findScopeConflicts(allowed: string[], forbidden: string[]): string[] {
  const forbiddenSet = new Set(forbidden.map(normalizeScopePathToken));
  return uniqueScopePaths(allowed.filter((item) => forbiddenSet.has(normalizeScopePathToken(item))));
}

function assertNoScopeContractConflict(
  exactAllowedScope: string[],
  forbiddenScope: unknown[] | string
) {
  const forbiddenPaths = Array.isArray(forbiddenScope)
    ? normalizeScopeListItems(forbiddenScope)
    : extractForbiddenScopePaths(forbiddenScope);
  const conflicts = findScopeConflicts(exactAllowedScope, forbiddenPaths);
  if (conflicts.length > 0) {
    const error = new Error(
      `SCOPE_CONTRACT_CONFLICT: positive exact_allowed_scope conflicts with forbidden_scope: ${conflicts.join(", ")}`
    );
    (error as Error & { code?: string; stage?: string; conflicts?: string[] }).code =
      "SCOPE_CONTRACT_CONFLICT";
    (error as Error & { code?: string; stage?: string; conflicts?: string[] }).stage =
      "scope_contract_validation";
    (error as Error & { code?: string; stage?: string; conflicts?: string[] }).conflicts =
      conflicts;
    throw error;
  }
}

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
  const exactAllowedScope = extractExactAllowedScopePaths(input.rawText);
  assertNoScopeContractConflict(exactAllowedScope, input.rawText);
  const allowedScope = exactAllowedScope.length > 0 ? exactAllowedScope : modeContract.allowedScope;
  const exactAllowedScopeCount = readDirectWorkerContextField(input.rawText, "exact_allowed_scope_count");
  const forbiddenOperations = readDirectWorkerContextField(input.rawText, "forbidden_operations");
  const taskGoal = readDirectWorkerContextField(input.rawText, "task_goal");
  const requiredOutputFields = readDirectWorkerContextField(input.rawText, "required_output_fields");
  const acceptanceConditions = readDirectWorkerContextField(input.rawText, "acceptance_conditions");
  const contractPayload = buildWorkerJobPayloadContract({
    requestText: input.requestText,
    originalRequestText: input.rawText,
    projectDomain: taskDomain,
    taskMode: modeContract.taskMode,
    readOnlyMode: modeContract.readOnlyMode,
    allowedScope,
    exactAllowedScope,
    exactAllowedScopeCount,
    forbiddenOperations,
    forbiddenScope: modeContract.forbiddenScope,
    taskGoal,
    requiredOutputFields,
    acceptanceConditions,
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
    exact_allowed_scope: exactAllowedScope,
    exact_allowed_scope_count: contractPayload.exact_allowed_scope_count,
    task_goal: contractPayload.task_goal,
    required_output_fields: contractPayload.required_output_fields,
    acceptance_conditions: contractPayload.acceptance_conditions,
    forbidden_operations: contractPayload.forbidden_operations,
    forbidden_scope: contractPayload.forbidden_scope,
    original_request_text_base64: Buffer.from(input.rawText, "utf8").toString("base64"),
    approved_batch: modeContract.batchCode,
    chat_id: input.feishuChatId,
    root_id: input.feishuMessageId,
    message_id: input.feishuMessageId,
    created_at: new Date().toISOString(),
    consumed: false,
    context_id: `${modeContract.batchCode ?? "unknown"}:${input.feishuMessageId}`,
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

const SYSTEM_REPAIR_BATCH_PREFIX = "BATCH-ARCH-COMPLETE";
const SYSTEM_REPAIR_TASK_TYPE = "system_repair";
const SYSTEM_REPAIR_APPROVAL_CONTEXT_NAME = "project_director_repair_mode_approval_context";
const SYSTEM_REPAIR_SCOPE = [
  "src/app/api/feishu/event/route.ts",
  "src/lib/project-director-console.ts",
  "src/lib/worker-jobs.ts",
  "infra/windows-worker/local_worker.js",
  "infra/windows-worker/tests/git-safety.test.js",
  "infra/windows-worker/tests/worker-attempt-lifecycle.test.mjs",
  "infra/windows-worker/tests/worker-diagnostics-contract.test.mjs",
];

function isSystemRepairApprovalMode(input: {
  projectDomain: string | null;
  taskType: unknown;
  batchCode: unknown;
}): boolean {
  return (
    input.projectDomain === "automation_system" &&
    input.taskType === SYSTEM_REPAIR_TASK_TYPE &&
    typeof input.batchCode === "string" &&
    input.batchCode.startsWith(SYSTEM_REPAIR_BATCH_PREFIX)
  );
}

function resolveSystemRepairIntakeContext(text: string) {
  const normalized = normalizeFeishuTaskText(text);
  const parsedProjectDomain =
    readDirectWorkerContextField(text, "project_domain") ?? classifyFeishuWorkerTaskDomain(normalized);
  const parsedTaskType = readDirectWorkerContextField(text, "task_type");
  const parsedBatchCode = (
    readDirectWorkerContextField(text, "batch_code") ??
    readDirectWorkerContextField(text, "approved_batch") ??
    extractPrimaryRouteBatchCode(normalized) ??
    ""
  ).toUpperCase();
  const parsedRequestedMode =
    readDirectWorkerContextField(text, "requested_mode") ??
    parseDirectRequestedMode(normalized, parsedBatchCode || null);
  const parsedFinalMode =
    readDirectWorkerContextField(text, "final_mode") ??
    readDirectWorkerContextField(text, "task_mode") ??
    parsedRequestedMode;
  const parsedTaskMode = readDirectWorkerContextField(text, "task_mode") ?? parsedFinalMode;
  const explicitModeOrDomainPresent = Boolean(
    readDirectWorkerContextField(text, "project_domain") ||
    readDirectWorkerContextField(text, "task_type") ||
    readDirectWorkerContextField(text, "requested_mode") ||
    readDirectWorkerContextField(text, "final_mode") ||
    readDirectWorkerContextField(text, "task_mode")
  );
  const repairModeCandidate =
    parsedProjectDomain === "automation_system" &&
    parsedTaskType === SYSTEM_REPAIR_TASK_TYPE &&
    parsedBatchCode.startsWith(SYSTEM_REPAIR_BATCH_PREFIX);
  const writeAllowed =
    normalizeDirectWorkerWriteMode(parsedRequestedMode) === "write" ||
    normalizeDirectWorkerWriteMode(parsedFinalMode) === "write" ||
    normalizeDirectWorkerWriteMode(parsedTaskMode) === "write";
  const exactAllowedScope = extractExactAllowedScopePaths(text);

  if (!repairModeCandidate && !(explicitModeOrDomainPresent && parsedProjectDomain === "automation_system" && writeAllowed)) {
    return null;
  }

  if (repairModeCandidate) {
    try {
      assertNoScopeContractConflict(SYSTEM_REPAIR_SCOPE, text);
    } catch (error) {
      const scopedError = error as Error & { code?: string; stage?: string };
      return {
        ok: false,
        parsedProjectDomain,
        parsedTaskType,
        parsedBatchCode,
        parsedRequestedMode: parsedRequestedMode ?? "write_allowed",
        parsedFinalMode: parsedFinalMode ?? "write_allowed",
        parsedTaskMode: parsedTaskMode ?? "automation_system_write_allowed",
        repairModeCandidate,
        repairModeApplied: true,
        repairScope: SYSTEM_REPAIR_SCOPE,
        exactAllowedScope: SYSTEM_REPAIR_SCOPE,
        failureCode: scopedError.code ?? "SCOPE_CONTRACT_CONFLICT",
        failureStage: scopedError.stage ?? "scope_contract_validation",
        validationPath: "repair_mode_before_exact_scope_validation",
      };
    }

    return {
      ok: true,
      parsedProjectDomain,
      parsedTaskType,
      parsedBatchCode,
      parsedRequestedMode: parsedRequestedMode ?? "write_allowed",
      parsedFinalMode: parsedFinalMode ?? "write_allowed",
      parsedTaskMode: parsedTaskMode ?? "automation_system_write_allowed",
      repairModeCandidate,
      repairModeApplied: true,
      repairScope: SYSTEM_REPAIR_SCOPE,
      exactAllowedScope: SYSTEM_REPAIR_SCOPE,
      failureCode: null,
      failureStage: null,
      validationPath: "repair_mode_before_exact_scope_validation",
    };
  }

  if (writeAllowed && exactAllowedScope.length === 0) {
    return {
      ok: false,
      parsedProjectDomain,
      parsedTaskType: parsedTaskType ?? "not_provided",
      parsedBatchCode: parsedBatchCode || "missing",
      parsedRequestedMode: parsedRequestedMode ?? "not_provided",
      parsedFinalMode: parsedFinalMode ?? "not_provided",
      parsedTaskMode: parsedTaskMode ?? "not_provided",
      repairModeCandidate,
      repairModeApplied: false,
      repairScope: [],
      exactAllowedScope,
      failureCode: parsedTaskType === SYSTEM_REPAIR_TASK_TYPE ? "REPAIR_MODE_NOT_MATCHED" : "EXACT_SCOPE_PARSE_FAILED",
      failureStage: "approval_context_validation",
      validationPath: "normal_write_allowed_exact_scope_validation",
    };
  }

  return null;
}

function isSystemRepairContextSaveOnlyRequest(text: string): boolean {
  const normalized = normalizeFeishuTaskText(text);
  return (
    /classification[-_\s]?only|analysis[-_\s]?only|advice[-_\s]?only|context[-_\s]?save[-_\s]?only/i.test(normalized) ||
    /(?:\u4ec5|\u53ea)\s*(?:\u5206\u7c7b|\u5206\u6790|\u7ed9\u51fa\u5206\u53d1\u5efa\u8bae|\u4fdd\u5b58\s*approval\s*context|\u4fdd\u5b58\u4e0a\u4e0b\u6587)/i.test(normalized)
  );
}

function hasSystemRepairExecutionIntent(
  text: string,
  context: NonNullable<ReturnType<typeof resolveSystemRepairIntakeContext>>
): boolean {
  if (!context.ok || !context.repairModeApplied) return false;
  if (normalizeDirectWorkerWriteMode(context.parsedTaskMode) !== "write") return false;
  if (normalizeDirectWorkerWriteMode(context.parsedFinalMode) !== "write") return false;
  if (normalizeDirectWorkerWriteMode(context.parsedRequestedMode) === "manager_read_only") return false;
  if (isSystemRepairContextSaveOnlyRequest(text)) return false;
  if (readDirectWorkerBooleanField(text, "direct_worker_create") === true) return true;
  if (isExplicitDirectWorkerCreateCommand(text)) return true;
  if (isApprovedExecutionReply(text)) return true;

  const normalized = normalizeFeishuTaskText(text);
  return (
    /\bexecute\s+BATCH-ARCH-COMPLETE-/i.test(normalized) ||
    /\u65b0\u9700\u6c42[\s\S]{0,100}\u6267\u884c[\s\S]{0,100}\bBATCH-ARCH-COMPLETE-/i.test(normalized) ||
    /(?:\u603b\u7ba1\s*)?\u6279\u51c6\u6267\u884c[\s\S]{0,100}\bBATCH-ARCH-COMPLETE-/i.test(normalized) ||
    /(?:\u4ec5|\u53ea)\u6279\u51c6[\s\S]{0,100}\bBATCH-ARCH-COMPLETE-/i.test(normalized)
  );
}

function buildSystemRepairIntakeRecord(
  inputText: string,
  context: NonNullable<ReturnType<typeof resolveSystemRepairIntakeContext>>,
  feishuMessageId: string
): string {
  const originalRequestTextBase64 = Buffer.from(inputText, "utf8").toString("base64");
  return [
    context.ok ? "PROJECT_GENERAL_MANAGER_INTAKE_REPAIR_MODE_CONTEXT_SAVED" : "PROJECT_GENERAL_MANAGER_INTAKE_BLOCKED",
    `parsed_project_domain=${context.parsedProjectDomain}`,
    `parsed_task_type=${context.parsedTaskType}`,
    `parsed_batch_code=${context.parsedBatchCode}`,
    `parsed_requested_mode=${context.parsedRequestedMode}`,
    `repair_mode_candidate=${context.repairModeCandidate ? "true" : "false"}`,
    `repair_mode_applied=${context.repairModeApplied ? "true" : "false"}`,
    `repair_mode=${context.repairModeApplied ? "true" : "false"}`,
    `repair_scope=${context.repairScope.join(", ")}`,
    `repair_scope_count=${context.repairScope.length}`,
    `allowed_scope=${context.exactAllowedScope.join(", ")}`,
    `exact_allowed_scope=${context.exactAllowedScope.join(", ")}`,
    `exact_allowed_scope_count=${context.exactAllowedScope.length}`,
    `approval_context_saved=${context.ok ? "true" : "false"}`,
    "approval_context_readback_required=true",
    `validation_path=${context.validationPath}`,
    `failure_code=${context.failureCode ?? "null"}`,
    `failure_stage=${context.failureStage ?? "null"}`,
    `project_domain=${context.parsedProjectDomain}`,
    `task_type=${context.repairModeApplied ? SYSTEM_REPAIR_TASK_TYPE : context.parsedTaskType}`,
    `batch_code=${context.parsedBatchCode}`,
    `approved_batch=${context.parsedBatchCode}`,
    `requested_mode=${context.parsedRequestedMode}`,
    `final_mode=${context.parsedFinalMode}`,
    `task_mode=${context.parsedTaskMode}`,
    "read_only_mode=false",
    "repair_mode=true",
    "verification_only=false",
    "worker_only=false",
    "allow_no_change_success=false",
    "execution_intent=apply_code_changes",
    "code_changes_required=true",
    "codex_required=true",
    "git_commit_required=true",
    "git_push_required=true",
    "approval_required=true",
    `forbidden_scope=${readDirectWorkerContextField(inputText, "forbidden_scope") ?? "src/app product pages for non-product modes, database, env, secrets, deploy"}`,
    `task_goal=${readDirectWorkerContextField(inputText, "task_goal") ?? `Execute approved automation system repair batch ${context.parsedBatchCode}.`}`,
    `required_output_fields=${readDirectWorkerContextField(inputText, "required_output_fields") ?? "null"}`,
    `acceptance_conditions=${readDirectWorkerContextField(inputText, "acceptance_conditions") ?? "null"}`,
    "context_source=project_director_gm_intake_repair_mode",
    `context_id=${context.parsedBatchCode}:${feishuMessageId}`,
    "execution_policy_source=current_approval_context",
    `execution_policy_batch_code=${context.parsedBatchCode}`,
    `execution_policy_context_id=${context.parsedBatchCode}:${feishuMessageId}`,
    "execution_policy_inherited=false",
    "execution_policy_inheritance_rejected_reason=null",
    "consumed=false",
    `original_request_text_base64=${originalRequestTextBase64}`,
    "original_request_text_preserved=true",
    `original_request_text=${inputText}`,
    "worker_created=false",
    "next_stage_allowed=false",
  ].join("\n");
}

function buildSystemRepairIntakeReply(
  context: NonNullable<ReturnType<typeof resolveSystemRepairIntakeContext>>
): string {
  return [
    context.ok ? "PROJECT_GENERAL_MANAGER_REPAIR_MODE_CONTEXT_SAVED" : "PROJECT_GENERAL_MANAGER_INTAKE_BLOCKED",
    `parsed_project_domain=${context.parsedProjectDomain}`,
    `parsed_task_type=${context.parsedTaskType}`,
    `parsed_batch_code=${context.parsedBatchCode}`,
    `parsed_requested_mode=${context.parsedRequestedMode}`,
    `repair_mode_candidate=${context.repairModeCandidate ? "true" : "false"}`,
    `repair_mode_applied=${context.repairModeApplied ? "true" : "false"}`,
    `repair_scope_count=${context.repairScope.length}`,
    `exact_allowed_scope_count=${context.exactAllowedScope.length}`,
    `approval_context_saved=${context.ok ? "true" : "false"}`,
    `validation_path=${context.validationPath}`,
    `failure_code=${context.failureCode ?? "null"}`,
    `failure_stage=${context.failureStage ?? "null"}`,
    "worker_created=false",
    "next_stage_allowed=false",
  ].join("\n");
}

function buildSystemRepairWorkerCreatedReply(
  context: NonNullable<ReturnType<typeof resolveSystemRepairIntakeContext>>,
  input: { jobId: string | null; existingWorker?: boolean }
): string {
  return [
    input.existingWorker
      ? "PROJECT_GENERAL_MANAGER_REPAIR_MODE_WORKER_TASK_DUPLICATE"
      : "PROJECT_GENERAL_MANAGER_REPAIR_MODE_WORKER_TASK_CREATED",
    "state: queued",
    "repair_mode_applied=true",
    "approval_context_saved=true",
    "approval_context_readback_verified=true",
    `approved_batch: ${context.parsedBatchCode}`,
    `worker_task_id: ${input.jobId ?? "pending"}`,
    `job_id: ${input.jobId ?? "pending"}`,
    `existing_worker=${input.existingWorker ? "true" : "false"}`,
    `worker_created=${input.existingWorker ? "false" : "true"}`,
    `next_stage_allowed=${input.existingWorker ? "false" : "true"}`,
    "skip_planning_choice: true",
    "failure_code=null",
    "failure_stage=null",
  ].join("\n");
}

async function saveSystemRepairApprovalContextRecord(
  supabase: SupabaseClient,
  convId: string,
  systemRecord: string,
  context: NonNullable<ReturnType<typeof resolveSystemRepairIntakeContext>>
): Promise<{ id: string | null; content: string }> {
  const { error } = await supabase.from("hermes_messages").insert([
    {
      conversation_id: convId,
      role: "system",
      content: systemRecord,
      feishu_message_id: null,
      tool_call_id: null,
      name: SYSTEM_REPAIR_APPROVAL_CONTEXT_NAME,
    },
  ]);
  if (error) {
    const saveError = new Error(`approval context persistence write failed: ${error.message}`);
    (saveError as Error & { code?: string; stage?: string }).code = "APPROVAL_CONTEXT_PERSISTENCE_FAILED";
    (saveError as Error & { code?: string; stage?: string }).stage = "approval_context_persistence_write";
    throw saveError;
  }

  const { data, error: readbackError } = await supabase
    .from("hermes_messages")
    .select("id, content, name, created_at")
    .eq("conversation_id", convId)
    .eq("name", SYSTEM_REPAIR_APPROVAL_CONTEXT_NAME)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const readbackContent = (data as { content?: string | null } | null)?.content ?? null;
  if (readbackError || !readbackContent) {
    const saveError = new Error(
      `approval context readback failed: ${readbackError?.message ?? "record not found"}`
    );
    (saveError as Error & { code?: string; stage?: string }).code = "APPROVAL_CONTEXT_READBACK_FAILED";
    (saveError as Error & { code?: string; stage?: string }).stage = "approval_context_readback";
    throw saveError;
  }

  assertSystemRepairApprovalContextReadback(readbackContent, context);
  return { id: (data as { id?: string | null }).id ?? null, content: readbackContent };
}

function normalizeApprovalReadbackValue(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? null;
  return normalized || null;
}

function readApprovalContextField(content: string, fieldName: string): string | null {
  return readDirectWorkerContextField(content, fieldName);
}

function throwApprovalContextMismatch(
  code: string,
  stage: string,
  message: string
): never {
  const error = new Error(message);
  (error as Error & { code?: string; stage?: string }).code = code;
  (error as Error & { code?: string; stage?: string }).stage = stage;
  throw error;
}

function assertSystemRepairApprovalContextReadback(
  readbackContent: string,
  context: NonNullable<ReturnType<typeof resolveSystemRepairIntakeContext>>
): void {
  const expectedBatch = context.parsedBatchCode.toUpperCase();
  const approvedBatch = readApprovalContextField(readbackContent, "approved_batch")?.toUpperCase() ?? null;
  const batchCode = readApprovalContextField(readbackContent, "batch_code")?.toUpperCase() ?? null;

  if (approvedBatch !== expectedBatch || batchCode !== expectedBatch) {
    throwApprovalContextMismatch(
      "APPROVAL_CONTEXT_BATCH_MISMATCH",
      "approval_context_readback",
      `approval context batch mismatch: expected ${expectedBatch}, read approved_batch=${approvedBatch ?? "missing"}, batch_code=${batchCode ?? "missing"}`
    );
  }

  const expectedFields: Array<[string, string]> = [
    ["project_domain", "automation_system"],
    ["task_type", SYSTEM_REPAIR_TASK_TYPE],
    ["requested_mode", "write_allowed"],
    ["final_mode", "write_allowed"],
    ["task_mode", "automation_system_write_allowed"],
    ["read_only_mode", "false"],
    ["repair_mode", "true"],
    ["verification_only", "false"],
    ["worker_only", "false"],
    ["allow_no_change_success", "false"],
    ["execution_intent", "apply_code_changes"],
    ["code_changes_required", "true"],
    ["codex_required", "true"],
    ["git_commit_required", "true"],
    ["git_push_required", "true"],
    ["approval_required", "true"],
  ];

  const mismatchedField = expectedFields.find(([fieldName, expectedValue]) => {
    const actualValue = normalizeApprovalReadbackValue(readApprovalContextField(readbackContent, fieldName));
    return actualValue !== expectedValue;
  });

  if (mismatchedField) {
    const [fieldName, expectedValue] = mismatchedField;
    throwApprovalContextMismatch(
      "APPROVAL_CONTEXT_POLICY_MISMATCH",
      "approval_context_readback",
      `approval context field mismatch: ${fieldName} expected ${expectedValue}, read ${readApprovalContextField(readbackContent, fieldName) ?? "missing"}`
    );
  }
}

async function saveUserAssistantRepairModeReply(
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
  ]);
  if (error) throw new Error(`save repair mode worker reply failed: ${error.message}`);
}

async function findActiveSystemRepairWorkerJobByBatch(
  supabase: SupabaseClient,
  batchCode: string
): Promise<{ data: { id: string; job_id?: string | null; status?: string | null } | null; error: { message?: string } | null }> {
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("id, job_id, status")
    .eq("dispatch_batch", batchCode)
    .in("status", ["queued", "pending", "claimed", "running", "in_progress"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return { data: data as { id: string; job_id?: string | null; status?: string | null } | null, error };
}

async function insertSystemRepairWorkerTask(
  supabase: SupabaseClient,
  input: {
    requestText: string;
    rawText: string;
    context: NonNullable<ReturnType<typeof resolveSystemRepairIntakeContext>>;
    approvalContextReadback: string;
    feishuMessageId: string;
    feishuEventId: string;
    feishuChatId: string;
    feishuUserId: string;
  }
): Promise<{ jobId: string | null }> {
  assertSystemRepairApprovalContextReadback(input.approvalContextReadback, input.context);
  const taskGoal =
    readDirectWorkerContextField(input.approvalContextReadback, "task_goal") ??
    readDirectWorkerContextField(input.rawText, "task_goal") ??
    `Execute approved automation system repair batch ${input.context.parsedBatchCode}.`;
  const requiredOutputFields =
    readDirectWorkerContextField(input.approvalContextReadback, "required_output_fields") ??
    readDirectWorkerContextField(input.rawText, "required_output_fields");
  const acceptanceConditions =
    readDirectWorkerContextField(input.approvalContextReadback, "acceptance_conditions") ??
    readDirectWorkerContextField(input.rawText, "acceptance_conditions");
  const forbiddenOperations =
    readDirectWorkerContextField(input.approvalContextReadback, "forbidden_operations") ??
    readDirectWorkerContextField(input.rawText, "forbidden_operations");
  const forbiddenScope =
    readDirectWorkerContextField(input.approvalContextReadback, "forbidden_scope") ??
    readDirectWorkerContextField(input.rawText, "forbidden_scope") ??
    input.rawText;
  assertNoScopeContractConflict(input.context.exactAllowedScope, forbiddenScope);

  const contractPayload = buildWorkerJobPayloadContract({
    requestText: input.requestText,
    originalRequestText: input.rawText,
    projectDomain: "automation_system",
    taskType: SYSTEM_REPAIR_TASK_TYPE,
    requestedMode: "write_allowed",
    finalMode: "write_allowed",
    taskMode: "automation_system_write_allowed",
    readOnlyMode: false,
    repairMode: true,
    repairScope: input.context.repairScope,
    verificationOnly: false,
    workerOnly: false,
    allowNoChangeSuccess: false,
    executionIntent: "apply_code_changes",
    codeChangesRequired: true,
    codexRequired: true,
    gitCommitRequired: true,
    gitPushRequired: true,
    approvalRequired: true,
    allowedScope: input.context.exactAllowedScope,
    exactAllowedScope: input.context.exactAllowedScope,
    exactAllowedScopeCount: input.context.exactAllowedScope.length,
    forbiddenOperations,
    forbiddenScope,
    taskGoal,
    requiredOutputFields,
    acceptanceConditions,
    approvedBatch: input.context.parsedBatchCode,
    route: "repair_mode_direct_worker_create",
    workerStage: "queued",
    workflowStage: "execution",
    finalReportStatus: "pending",
    effectiveFinalStatus: "pending",
    changedFiles: [],
    pushed: false,
    deployStatus: null,
  });
  const repairWorkerPayload = {
    ...contractPayload,
    requested_mode: input.context.parsedRequestedMode,
    final_mode: "write_allowed",
    task_mode: "automation_system_write_allowed",
    read_only_mode: false,
    verification_only: false,
    worker_only: false,
    allow_no_change_success: false,
    execution_intent: "apply_code_changes",
    code_changes_required: true,
    codex_required: true,
    git_commit_required: true,
    git_push_required: true,
    approval_required: true,
    approval_satisfied: true,
    approval_context_readback_verified: true,
    repair_mode: true,
    repair_scope: input.context.repairScope,
    allowed_scope: input.context.exactAllowedScope,
    exact_allowed_scope: input.context.exactAllowedScope,
    exact_allowed_scope_count: input.context.exactAllowedScope.length,
    original_request_text_base64: Buffer.from(input.rawText, "utf8").toString("base64"),
    approved_batch: input.context.parsedBatchCode,
    batch_code: input.context.parsedBatchCode,
    context_source: "project_director_gm_intake_repair_mode",
    chat_id: input.feishuChatId,
    root_id: input.feishuMessageId,
    message_id: input.feishuMessageId,
    created_at: new Date().toISOString(),
    consumed: false,
    context_id: `${input.context.parsedBatchCode}:${input.feishuMessageId}`,
    execution_policy_source: "current_approval_context",
    execution_policy_batch_code: input.context.parsedBatchCode,
    execution_policy_context_id: `${input.context.parsedBatchCode}:${input.feishuMessageId}`,
    execution_policy_inherited: false,
    execution_policy_inheritance_rejected_reason: null,
    skip_planning_choice: true,
  };
  const contextualRequestText = withHermesWorkerContext(input.requestText, repairWorkerPayload);
  const row = {
    source: "feishu",
    job_type: "agent_dispatch",
    title: `System repair Worker task: ${input.context.parsedBatchCode}`,
    description: contextualRequestText,
    prompt: contextualRequestText,
    request_text: contextualRequestText,
    status: "queued",
    priority: 10,
    plan_status: "approved",
    workflow_stage: "execution",
    source_message_id: input.feishuMessageId,
    source_chat_id: input.feishuChatId,
    source_event_id: input.feishuEventId,
    feishu_message_id: input.feishuMessageId,
    feishu_event_id: input.feishuEventId,
    feishu_chat_id: input.feishuChatId,
    feishu_user_id: input.feishuUserId,
    repo: "city-partner-platform",
    dispatch_batch: input.context.parsedBatchCode,
    task_code: input.context.parsedBatchCode,
    payload: {
      ...repairWorkerPayload,
      route: "repair_mode_direct_worker_create",
      raw_message: input.rawText,
    },
  };
  const insertResult = await createHermesJob(
    supabase,
    row,
    "insert system repair worker task failed"
  );
  return { jobId: insertResult.jobIds[0] ?? null };
}

function isWriteAllowedApprovalText(text: string): boolean {
  return /(?:requested_mode|final_mode|执行模式)\s*[:：=]\s*write_allowed\b|task_mode\s*[:=]\s*automation_system_write_allowed\b/i.test(
    normalizeFeishuTaskText(text)
  );
}

function assertApprovedWriteRequestHasExactScope(
  requestText: string,
  taskMode: string | null,
  exactAllowedScope: string[],
  options: { repairMode?: boolean } = {}
) {
  if (
    !options.repairMode &&
    taskMode === "automation_system_write_allowed" &&
    isWriteAllowedApprovalText(requestText) &&
    exactAllowedScope.length === 0
  ) {
    const error = new Error(
      "ORIGINAL_BATCH_CONTEXT_MISSING: write_allowed approval is missing boss-approved exact_allowed_scope; refusing generic automation scope fallback."
    );
    (error as Error & { code?: string; stage?: string }).code = "ORIGINAL_BATCH_CONTEXT_MISSING";
    (error as Error & { code?: string; stage?: string }).stage = "approval_context_exact_scope_validation";
    throw error;
  }
}

function assertApprovedWriteRequestModeMatches(
  requestText: string,
  taskMode: string | null,
  readOnlyMode: boolean | null
) {
  if (
    isWriteAllowedApprovalText(requestText) &&
    (taskMode !== "automation_system_write_allowed" || readOnlyMode !== false)
  ) {
    const error = new Error(
      "APPROVAL_CONTEXT_MODE_MISMATCH: write_allowed approval was downgraded before Worker creation."
    );
    (error as Error & { code?: string; stage?: string }).code = "APPROVAL_CONTEXT_MODE_MISMATCH";
    (error as Error & { code?: string; stage?: string }).stage = "approval_context_mode_validation";
    throw error;
  }
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
    const projectDomain = projectDomainForTaskMode(taskMode);
    const taskType = readDirectWorkerContextField(requestText, "task_type") ?? task.task_type;
    const repairMode = isSystemRepairApprovalMode({
      projectDomain,
      taskType,
      batchCode: task.dispatch_batch,
    });
    const exactAllowedScope = extractExactAllowedScopePaths(requestText);
    const effectiveExactAllowedScope = repairMode ? SYSTEM_REPAIR_SCOPE : exactAllowedScope;
    const readOnlyMode = taskMode ? false : null;
    assertApprovedWriteRequestModeMatches(requestText, taskMode, readOnlyMode);
    assertApprovedWriteRequestHasExactScope(requestText, taskMode, effectiveExactAllowedScope, {
      repairMode,
    });
    if (repairMode) {
      assertNoScopeContractConflict(effectiveExactAllowedScope, task.forbidden_files);
    } else {
      assertNoScopeContractConflict(exactAllowedScope, task.forbidden_files);
    }
    const allowedScope =
      effectiveExactAllowedScope.length > 0 ? effectiveExactAllowedScope : task.allowed_files;
    const contractPayload = buildWorkerJobPayloadContract({
      requestText,
      originalRequestText: requestText,
      projectDomain,
      taskType: repairMode ? SYSTEM_REPAIR_TASK_TYPE : taskType,
      taskMode,
      readOnlyMode,
      repairMode,
      repairScope: repairMode ? SYSTEM_REPAIR_SCOPE : null,
      allowedScope,
      exactAllowedScope: effectiveExactAllowedScope,
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
        requested_mode: isWriteAllowedApprovalText(requestText) ? "write_allowed" : null,
        final_mode: taskMode === "automation_system_write_allowed" ? "write_allowed" : taskMode,
        approval_required: task.requires_boss_approval ?? true,
        original_request_text_base64: Buffer.from(requestText, "utf8").toString("base64"),
        chat_id: feishuContext?.chatId ?? null,
        root_id: feishuContext?.messageId ?? null,
        message_id: feishuContext?.messageId ?? null,
        created_at: new Date().toISOString(),
        consumed: false,
        context_id: `${task.dispatch_batch ?? "unknown"}:${feishuContext?.messageId ?? task.task_key}`,
        project_title: buildResult.projectTitle,
        batch_code: task.dispatch_batch,
        role: task.agent_role,
        task_type: repairMode ? SYSTEM_REPAIR_TASK_TYPE : taskType,
        repair_mode: repairMode,
        repair_scope: repairMode ? SYSTEM_REPAIR_SCOPE : null,
        task_key: task.task_key,
        task_title: task.task_title,
        dependency_keys: task.dependency_keys,
        allowed_files: allowedScope,
        exact_allowed_scope: effectiveExactAllowedScope,
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

      const directWorkerSystemRepairIntakeContext = resolveSystemRepairIntakeContext(text);
      const shouldUseSystemRepairWorkerFlow =
        directWorkerSystemRepairIntakeContext?.ok === true &&
        hasSystemRepairExecutionIntent(text, directWorkerSystemRepairIntakeContext);

      if (
        (isDirectWorkerTaskRequest(text) || isExplicitDirectWorkerCreateCommand(text)) &&
        !shouldUseSystemRepairWorkerFlow &&
        canonicalHermesAllowsDirectWorkerBypass({
          featureEnabled: isHermesCanonicalOrchestrationEnabled(),
          explicitMaintenanceOperation: isExplicitCanonicalMaintenanceDirectWorker(text),
        })
      ) {
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
            `missing_fields=${modeContract.missingFields?.length ? modeContract.missingFields.join(",") : "none"}`,
            "worker_created=false",
            "direct Worker create requires complete approved context and exact scope for write tasks.",
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
              `missing_fields: ${modeContract.missingFields?.length ? modeContract.missingFields.join(",") : "none"}`,
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
          "PROJECT_DIRECTOR_DIRECT_WORKER_TASK_CREATED",
          "state: queued",
          "worker_created=true",
          "hermes_jobs_created: yes",
          `approved_batch: ${modeContract.batchCode}`,
          `job_id: ${insertResult.jobId ?? "pending"}`,
          "skip_planning_choice: true",
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

      const systemRepairIntakeContext =
        directWorkerSystemRepairIntakeContext ?? resolveSystemRepairIntakeContext(text);
      if (systemRepairIntakeContext) {
        if (
          systemRepairIntakeContext.ok &&
          hasSystemRepairExecutionIntent(text, systemRepairIntakeContext)
        ) {
          const token = await getFeishuToken();
          const requestText = buildDirectWorkerTaskText(text) || normalizeFeishuTaskText(text);
          const systemRecord = buildSystemRepairIntakeRecord(
            text,
            systemRepairIntakeContext,
            ev.message.message_id
          );

          let approvalContextReadback: { id: string | null; content: string };
          try {
            approvalContextReadback = await saveSystemRepairApprovalContextRecord(
              supabase,
              convId,
              systemRecord,
              systemRepairIntakeContext
            );
          } catch (error) {
            const typedError = error as Error & { code?: string; stage?: string };
            const reply = [
              "PROJECT_GENERAL_MANAGER_REPAIR_MODE_WORKER_TASK_BLOCKED",
              "state: approval_context_not_verified",
              "repair_mode_applied=true",
              "approval_context_saved=false",
              "approval_context_readback_verified=false",
              `approved_batch: ${systemRepairIntakeContext.parsedBatchCode}`,
              "worker_created=false",
              "next_stage_allowed=false",
              `failure_code=${typedError.code ?? "APPROVAL_CONTEXT_PERSISTENCE_FAILED"}`,
              `failure_stage=${typedError.stage ?? "approval_context_persistence_write"}`,
            ].join("\n");
            await saveUserAssistantRepairModeReply(
              supabase,
              convId,
              text,
              reply,
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
              state: "repair_mode_worker_blocked",
              approval_context_saved: false,
              approval_context_readback_verified: false,
              worker_created: false,
              next_stage_allowed: false,
              failure_code: typedError.code ?? "APPROVAL_CONTEXT_PERSISTENCE_FAILED",
              failure_stage: typedError.stage ?? "approval_context_persistence_write",
            });
          }

          const existingWorker = await findActiveSystemRepairWorkerJobByBatch(
            supabase,
            systemRepairIntakeContext.parsedBatchCode
          );
          if (existingWorker.error) {
            const reply = [
              "PROJECT_GENERAL_MANAGER_REPAIR_MODE_WORKER_TASK_BLOCKED",
              "state: duplicate_check_failed",
              "repair_mode_applied=true",
              "approval_context_saved=true",
              "approval_context_readback_verified=true",
              `approved_batch: ${systemRepairIntakeContext.parsedBatchCode}`,
              "worker_created=false",
              "next_stage_allowed=false",
              "failure_code=DUPLICATE_WORKER_CHECK_FAILED",
              "failure_stage=worker_duplicate_guard",
            ].join("\n");
            await saveUserAssistantRepairModeReply(
              supabase,
              convId,
              text,
              reply,
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
              state: "repair_mode_worker_blocked",
              approval_context_saved: true,
              approval_context_readback_verified: true,
              worker_created: false,
              next_stage_allowed: false,
              failure_code: "DUPLICATE_WORKER_CHECK_FAILED",
              failure_stage: "worker_duplicate_guard",
            });
          }

          if (existingWorker.data) {
            const existingJobId = existingWorker.data.job_id ?? existingWorker.data.id;
            const reply = buildSystemRepairWorkerCreatedReply(systemRepairIntakeContext, {
              jobId: existingJobId,
              existingWorker: true,
            });
            await saveUserAssistantRepairModeReply(
              supabase,
              convId,
              text,
              reply,
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
              state: "repair_mode_worker_duplicate_skipped",
              approval_context_saved: true,
              approval_context_readback_verified: true,
              worker_created: false,
              next_stage_allowed: false,
              existing_worker: true,
              worker_task_id: existingJobId,
              job_id: existingJobId,
              failure_code: null,
              failure_stage: null,
            });
          }

          try {
            const insertResult = await insertSystemRepairWorkerTask(supabase, {
              requestText,
              rawText: text,
              context: systemRepairIntakeContext,
              approvalContextReadback: approvalContextReadback.content,
              feishuMessageId: ev.message.message_id,
              feishuEventId: eventId,
              feishuChatId: ev.message.chat_id,
              feishuUserId: userId,
            });
            const reply = buildSystemRepairWorkerCreatedReply(systemRepairIntakeContext, {
              jobId: insertResult.jobId,
            });
            await saveUserAssistantRepairModeReply(
              supabase,
              convId,
              text,
              reply,
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
              state: "repair_mode_worker_queued",
              repair_mode_applied: true,
              approval_context_saved: true,
              approval_context_readback_verified: true,
              worker_created: true,
              next_stage_allowed: true,
              worker_task_id: insertResult.jobId,
              job_id: insertResult.jobId,
              failure_code: null,
              failure_stage: null,
            });
          } catch (error) {
            const typedError = error as Error & { code?: string; stage?: string };
            const reply = [
              "PROJECT_GENERAL_MANAGER_REPAIR_MODE_WORKER_TASK_BLOCKED",
              "state: worker_create_failed",
              "repair_mode_applied=true",
              "approval_context_saved=true",
              "approval_context_readback_verified=true",
              `approved_batch: ${systemRepairIntakeContext.parsedBatchCode}`,
              "worker_created=false",
              "next_stage_allowed=false",
              `failure_code=${typedError.code ?? "WORKER_CREATE_FAILED"}`,
              `failure_stage=${typedError.stage ?? "worker_create"}`,
            ].join("\n");
            await saveUserAssistantRepairModeReply(
              supabase,
              convId,
              text,
              reply,
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
              state: "repair_mode_worker_create_failed",
              approval_context_saved: true,
              approval_context_readback_verified: true,
              worker_created: false,
              next_stage_allowed: false,
              failure_code: typedError.code ?? "WORKER_CREATE_FAILED",
              failure_stage: typedError.stage ?? "worker_create",
            });
          }
        }

        const reply = buildSystemRepairIntakeReply(systemRepairIntakeContext);
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          buildSystemRepairIntakeRecord(text, systemRepairIntakeContext, ev.message.message_id),
          systemRepairIntakeContext.ok
            ? "project_director_repair_mode_approval_context"
            : "project_director_repair_mode_intake_blocked",
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
          state: systemRepairIntakeContext.ok ? "repair_mode_context_saved" : "intake_blocked",
          parsed_project_domain: systemRepairIntakeContext.parsedProjectDomain,
          parsed_task_type: systemRepairIntakeContext.parsedTaskType,
          parsed_batch_code: systemRepairIntakeContext.parsedBatchCode,
          parsed_requested_mode: systemRepairIntakeContext.parsedRequestedMode,
          repair_mode_candidate: systemRepairIntakeContext.repairModeCandidate,
          repair_mode_applied: systemRepairIntakeContext.repairModeApplied,
          repair_scope_count: systemRepairIntakeContext.repairScope.length,
          exact_allowed_scope_count: systemRepairIntakeContext.exactAllowedScope.length,
          approval_context_saved: systemRepairIntakeContext.ok,
          validation_path: systemRepairIntakeContext.validationPath,
          failure_code: systemRepairIntakeContext.failureCode,
          failure_stage: systemRepairIntakeContext.failureStage,
          worker_created: false,
          next_stage_allowed: false,
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

      if (isHermesCanonicalOrchestrationEnabled()) {
        const requestedMode = approvedHermesMode(`${recentDraft.originalDemand}\n${text}`);
        if (!requestedMode) throw new Error("HERMES_APPROVED_REQUEST_MODE_REQUIRED");
        const result = await runApprovedRequestThroughCanonicalHermes(
          {
            request_id: ev.message.message_id,
            original_request_text: recentDraft.originalDemand,
            project_domain: classifyFeishuWorkerTaskDomain(recentDraft.originalDemand),
            requested_mode: requestedMode,
            approval_context: {
              approved_by: userId,
              approved_at: new Date().toISOString(),
              approval_id: ev.message.message_id,
              feishu_chat_id: ev.message.chat_id,
              feishu_event_id: eventId,
            },
            objective: recentDraft.originalDemand,
          },
          createCanonicalHermesPlanningProvider(),
          new RegistryCapabilityGateway(),
          async (command) => canonicalCreateJob(supabase, {
            source: command.source,
            request_text: command.request_text,
            project_domain: command.project_domain,
            requested_mode: command.requested_mode,
            plan_id: command.payload.plan_id,
            subtask_id: command.payload.subtask_id,
            payload: command.payload,
            status: "queued",
          }),
          { canonicalPersistenceReady: canonicalPersistenceRuntimeEnabled() }
        );
        if (!result.delegated || result.reason !== "canonical_jobs_created") {
          throw new Error("HERMES_CANONICAL_DELEGATION_NOT_APPLIED");
        }
        const reply = [
          "PROJECT_DIRECTOR_HERMES_CANONICAL_DISPATCHED",
          `plan_id: ${result.plan.plan_id}`,
          `canonical_jobs_created: ${result.jobs.length}`,
          `requested_mode: ${result.plan.requested_mode}`,
        ].join("\n");
        await saveSystemRecordedReply(
          supabase,
          convId,
          text,
          reply,
          reply,
          "project_director_hermes_canonical_dispatch",
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
          state: "hermes_canonical_dispatched",
          plan_id: result.plan.plan_id,
          inserted_jobs: result.jobs.length,
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
      const shadowRequestedMode = approvedHermesMode(`${recentDraft.originalDemand}\n${text}`)
        ?? "manager_read_only";
      const shadowLaunch = scheduleApprovedRequestThroughHermesShadow(
        {
          request_id: ev.message.message_id,
          original_request_text: recentDraft.originalDemand,
          project_domain: classifyFeishuWorkerTaskDomain(recentDraft.originalDemand),
          requested_mode: shadowRequestedMode,
          approval_context: {
            approved_by: userId,
            approved_at: new Date().toISOString(),
            approval_id: ev.message.message_id,
            feishu_chat_id: ev.message.chat_id,
            feishu_event_id: eventId,
          },
          objective: recentDraft.originalDemand,
        },
        buildLegacyShadowPlan(
          ev.message.message_id,
          buildResult.tasks.map((task) => ({
            task_type: task.task_type,
            selected_agent: task.agent_role,
            execution_mode: task.execution_mode,
            allowed_paths: task.allowed_files,
            forbidden_paths: task.forbidden_files,
            acceptance_criteria: task.acceptance_criteria,
            risk_level: task.risk_level,
          }))
        ),
        createCanonicalHermesPlanningProvider(),
        new OpenClawShadowCapabilityGateway(),
        (task) => after(task)
      );
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
          `hermes_shadow_correlation: ${JSON.stringify(shadowLaunch)}`,
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
        approval_context_saved: true,
        worker_created: insertResult.insertedCount > 0,
        next_stage_allowed: insertResult.insertedCount > 0,
        inserted_jobs: insertResult.insertedCount,
        hermes_shadow: shadowLaunch,
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

    if (isHermesCanonicalOrchestrationEnabled()) {
      const reply = "PROJECT_DIRECTOR_HERMES_APPROVAL_REQUIRED: canonical orchestration does not use the legacy Hermes tool queue.";
      await saveSystemRecordedReply(
        supabase,
        convId,
        text,
        reply,
        reply,
        "project_director_hermes_canonical_approval_required",
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
      return NextResponse.json({ code: 0, state: "hermes_canonical_approval_required" });
    }

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
