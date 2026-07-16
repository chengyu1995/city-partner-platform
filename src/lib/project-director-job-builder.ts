import type { SupabaseClient } from "@supabase/supabase-js";
import { createHermesJobs } from "@/lib/worker-jobs";
import type {
  ProjectDirectorDispatchPlanDraft,
  ProjectDirectorDispatchTask,
} from "@/lib/project-director-dispatch-plan";

type JobRecord = Record<string, unknown>;

interface SupabaseWriteError {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
}

export interface DispatchJobBuildResult {
  projectTitle: string;
  tasks: ProjectDirectorDispatchTask[];
  requestTexts: string[];
}

export interface DispatchJobInsertResult {
  insertedCount: number;
  skippedColumns: string[];
}

export const HERMES_JOBS_TABLE = "hermes_jobs";

export const HERMES_JOB_CONTEXT_PAYLOAD_FIELDS = [
  "project_domain",
  "task_mode",
  "read_only_mode",
  "allowed_scope",
  "forbidden_scope",
  "original_request_text",
  "approved_batch",
  "route",
] as const;

export interface ProjectDirectorPlanningJobInput {
  originalDemand: string;
  taskTreeId: string;
  requestText: string;
  feishuMessageId: string;
  feishuEventId: string;
  feishuChatId: string;
  feishuUserId: string;
}

export interface AcceptanceFeedbackJobInput {
  feedbackText: string;
  rawMessageText: string;
  feishuMessageId: string;
  feishuEventId: string;
  feishuChatId: string;
  feishuUserId: string;
}

export const PROJECT_DIRECTOR_DISPATCH_BATCH_RECORD_NAME = "project_director_dispatch_batch";
export const PROJECT_DIRECTOR_DISPATCH_BATCH_RECORD_MARKER =
  "PROJECT_DIRECTOR_DISPATCH_BATCH_RECORD";
export const PROJECT_DIRECTOR_BATCH_01 = "BATCH-01";
export const PROJECT_DIRECTOR_BATCH_12 = "BATCH-12";
export const PROJECT_DIRECTOR_BATCH_15 = "BATCH-15";
export const PROJECT_DIRECTOR_ACCEPTANCE_FEEDBACK_JOB_TYPE = "acceptance_feedback";
export const PROJECT_DIRECTOR_PLANNING_JOB_TYPE = "project_director_planning";
export const PROJECT_DIRECTOR_AGENT_DISPATCH_JOB_TYPE = "agent_dispatch";

const ALLOWED_BATCH_01_ROLES = new Set(["product_manager", "project_director"]);
const ALLOWED_OUTPUT_PREFIXES = ["docs/product/", "docs/upgrade/"];
const DEFAULT_BATCH_01_OUTPUTS: Record<string, string[]> = {
  "PRODUCT-01-01": ["docs/product/prd.md"],
  "PRODUCT-01-02": ["docs/product/page-list.md"],
  "PRODUCT-01-03": ["docs/product/user-flow.md"],
  "PRODUCT-01-04": ["docs/product/acceptance-criteria.md"],
};

function isMissingColumnError(error: SupabaseWriteError | null): boolean {
  const message = error?.message ?? "";
  return error?.code === "PGRST204" || /column .* does not exist/i.test(message);
}

function extractMissingColumn(error: SupabaseWriteError | null): string | null {
  const message = error?.message ?? "";
  const quoted = message.match(/'([^']+)' column/);
  if (quoted) return quoted[1];
  const plain = message.match(/column "([^"]+)"/i);
  return plain ? plain[1] : null;
}

function cleanLines(values: string[]): string {
  if (values.length === 0) return "- 无";
  return values.map((value) => `- ${value}`).join("\n");
}

function escapeContextValue(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, "\\n").trim();
}

function buildHermesWorkerContextLines(context: Record<string, unknown>): string[] {
  return [
    "HERMES_WORKER_CONTEXT:",
    ...HERMES_JOB_CONTEXT_PAYLOAD_FIELDS
      .filter((field) => {
        const value = context[field];
        return value !== undefined && value !== null && String(value).trim() !== "";
      })
      .map((field) => `${field}=${escapeContextValue(context[field])}`),
  ];
}

function withHermesWorkerContext(requestText: string, context: Record<string, unknown>): string {
  if (/^\s*HERMES_WORKER_CONTEXT\s*:/im.test(requestText)) return requestText;
  return [...buildHermesWorkerContextLines(context), "", requestText].join("\n");
}

function buildContextPayload(
  basePayload: Record<string, unknown>,
  context: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...basePayload,
    ...context,
    hermes_worker_context: context,
  };
}

function buildDocsWriteContext(
  originalRequestText: string,
  approvedBatch: string,
  allowedScope: string
): Record<string, unknown> {
  return {
    project_domain: "automation_architecture",
    task_mode: "docs_write_allowed",
    read_only_mode: false,
    allowed_scope: allowedScope,
    forbidden_scope: "src/app/**, src/lib/db/**, src/types/db.ts, .env, database, worker, tencent-cloud",
    original_request_text: originalRequestText,
    approved_batch: approvedBatch,
    route: "project_director_dispatch",
  };
}

function buildAgentDispatchContext(
  task: ProjectDirectorDispatchTask,
  requestText: string
): Record<string, unknown> {
  return {
    project_domain: "automation_system",
    task_mode: "automation_system_write_allowed",
    read_only_mode: false,
    allowed_scope: task.allowed_files.join(", "),
    forbidden_scope: task.forbidden_files.join(", "),
    original_request_text: requestText,
    approved_batch: task.dispatch_batch,
    route: "project_director_approved_execution",
  };
}

function isAllowedProductPlanningTask(task: ProjectDirectorDispatchTask): boolean {
  if (task.dispatch_batch !== PROJECT_DIRECTOR_BATCH_01) return false;
  if (!ALLOWED_BATCH_01_ROLES.has(task.role)) return false;
  if (task.output_files.length === 0) return false;
  return task.output_files.every((file) =>
    ALLOWED_OUTPUT_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
}

function normalizeBatch01OutputFiles(
  task: ProjectDirectorDispatchTask
): ProjectDirectorDispatchTask {
  const outputFiles = DEFAULT_BATCH_01_OUTPUTS[task.task_code] ?? task.output_files;
  return { ...task, output_files: outputFiles };
}

function buildProductPlanningRequestText(
  projectTitle: string,
  task: ProjectDirectorDispatchTask
): string {
  return [
    "【项目总管分发任务】",
    `项目：${projectTitle}`,
    "批次：BATCH-01 产品规划",
    `任务编号：${task.task_code}`,
    `任务标题：${task.task_title}`,
    "执行角色：产品经理 product_manager",
    "任务目标：",
    task.task_title,
    "",
    "输入：",
    cleanLines(task.input),
    "",
    "输出文件：",
    cleanLines(task.output_files),
    "",
    "验收标准：",
    cleanLines(task.acceptance_criteria),
    "",
    "执行限制：",
    "1. 只允许创建或修改本任务输出文件。",
    "2. 只允许写 docs/product/ 下的产品文档。",
    "3. 不允许修改业务代码。",
    "4. 不允许修改 Worker。",
    "5. 不允许修改 API。",
    "6. 不允许修改 Vercel API。",
    "7. 不允许修改数据库 SQL。",
    "8. 不允许执行 SQL。",
    "9. 不允许连接 Supabase。",
    "10. 不允许部署。",
    "11. 不允许修改 .env。",
    "12. 不允许修改 .gitignore。",
    "",
    "完成后：",
    "1. 自查输出文件是否存在。",
    "2. 按验收标准逐条检查。",
    "3. 返回修改文件清单。",
    "4. 返回未解决问题。",
    "5. 等待项目总管验收。",
  ].join("\n");
}

function buildJobRow(
  projectTitle: string,
  task: ProjectDirectorDispatchTask,
  requestText: string
): JobRecord {
  const context = buildDocsWriteContext(
    requestText,
    PROJECT_DIRECTOR_BATCH_01,
    task.output_files.join(", ")
  );
  const contextualRequestText = withHermesWorkerContext(requestText, context);
  return {
    source: "project_director",
    job_type: "product_planning",
    job_id: task.task_code,
    title: task.task_title,
    description: contextualRequestText,
    priority: 10,
    acceptance: task.acceptance_criteria.join("\n"),
    branch: null,
    executor: "product_manager",
    repo: "city-partner-platform",
    prompt: contextualRequestText,
    request_text: contextualRequestText,
    status: "queued",
    plan_status: "approved",
    workflow_stage: "execution",
    claimed_by: null,
    claimed_at: null,
    started_at: null,
    parent_task_id: null,
    project_id: projectTitle,
    task_code: task.task_code,
    dispatch_batch: PROJECT_DIRECTOR_BATCH_01,
    payload: buildContextPayload({
      project_title: projectTitle,
      batch_code: PROJECT_DIRECTOR_BATCH_01,
      role: task.role,
      task_code: task.task_code,
      task_title: task.task_title,
      output_files: task.output_files,
      acceptance_criteria: task.acceptance_criteria,
    }, context),
  };
}

function buildProjectDirectorPlanningJobRow(input: ProjectDirectorPlanningJobInput): JobRecord {
  return {
    source: "project_director",
    job_type: PROJECT_DIRECTOR_PLANNING_JOB_TYPE,
    job_id: input.taskTreeId,
    title: `Project director planning: ${input.originalDemand.slice(0, 80)}`,
    description: input.requestText,
    priority: 20,
    acceptance: "Generate or record the project director task tree and wait for boss approval before execution.",
    branch: null,
    executor: "project_director",
    repo: "city-partner-platform",
    prompt: input.requestText,
    request_text: input.requestText,
    status: "queued",
    plan_status: "planning_only",
    workflow_stage: "planning",
    claimed_by: null,
    claimed_at: null,
    started_at: null,
    parent_task_id: null,
    project_id: "city-partner-platform",
    task_code: input.taskTreeId,
    dispatch_batch: PROJECT_DIRECTOR_BATCH_15,
    feishu_message_id: input.feishuMessageId || null,
    feishu_event_id: input.feishuEventId || null,
    feishu_chat_id: input.feishuChatId || null,
    feishu_user_id: input.feishuUserId || null,
    payload: {
      batch_code: PROJECT_DIRECTOR_BATCH_15,
      route: "project_director_planning",
      original_demand: input.originalDemand,
      task_tree_id: input.taskTreeId,
      execution_mode: "planning_only",
    },
  };
}

function buildAgentDispatchRequestText(
  projectTitle: string,
  task: ProjectDirectorDispatchTask
): string {
  return [
    "【项目总管 Agent 执行任务】",
    `项目：${projectTitle}`,
    `任务树批次：${task.dispatch_batch}`,
    `任务编号：${task.task_key}`,
    `执行角色：${task.agent_role}`,
    `任务类型：${task.task_type}`,
    `任务阶段：${task.stage}`,
    `任务标题：${task.task_title}`,
    "",
    "输入：",
    cleanLines(task.input),
    "",
    "依赖任务：",
    cleanLines(task.dependency_keys),
    "",
    "允许修改文件：",
    cleanLines(task.allowed_files),
    "",
    "禁止修改文件：",
    cleanLines(task.forbidden_files),
    "",
    "验收条件：",
    cleanLines(task.acceptance_criteria),
    "",
    "执行模式：approved_execution",
    "执行限制：",
    "1. 只允许修改 allowed_files 中列出的文件。",
    "2. 不允许修改业务冻结页面，除非本任务 allowed_files 明确列出且老板已批准。",
    "3. 不允许修改数据库结构、执行 SQL、修改 .env 或输出密钥。",
    "4. 不允许启动 dev server 或浏览器。",
    "5. 完成后只回报修改文件、验证结果、残余风险和是否需要老板继续验收。",
  ].join("\n");
}

function buildAgentDispatchJobRow(
  projectTitle: string,
  task: ProjectDirectorDispatchTask,
  requestText: string
): JobRecord {
  const context = buildAgentDispatchContext(task, requestText);
  const contextualRequestText = withHermesWorkerContext(requestText, context);
  return {
    source: "agent_dispatch",
    job_type: PROJECT_DIRECTOR_AGENT_DISPATCH_JOB_TYPE,
    job_id: task.task_key,
    title: task.task_title,
    description: contextualRequestText,
    priority: task.requires_boss_approval ? 30 : 15,
    acceptance: task.acceptance_criteria.join("\n"),
    branch: null,
    executor: task.agent_role,
    repo: "city-partner-platform",
    prompt: contextualRequestText,
    request_text: contextualRequestText,
    status: "queued",
    plan_status: "approved",
    workflow_stage: "execution",
    claimed_by: null,
    claimed_at: null,
    started_at: null,
    parent_task_id: null,
    project_id: projectTitle,
    task_code: task.task_key,
    dispatch_batch: task.dispatch_batch,
    payload: buildContextPayload({
      project_title: projectTitle,
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
    }, context),
  };
}

async function insertRowsWithMissingColumnFallback(
  supabase: SupabaseClient,
  rowsInput: JobRecord[],
  failureLabel: string
): Promise<DispatchJobInsertResult> {
  return createHermesJobs(supabase, rowsInput, failureLabel);
}

function buildAcceptanceFeedbackRequestText(input: AcceptanceFeedbackJobInput): string {
  const feedback =
    input.feedbackText.trim().replace(/\s+/g, " ") ||
    input.rawMessageText.trim().replace(/\s+/g, " ");
  return [
    "[Project Director Acceptance Feedback]",
    "Batch: BATCH-12",
    "Goal: diagnose the boss acceptance feedback, make the smallest safe fix, verify locally, and report the result.",
    "",
    "Acceptance feedback:",
    feedback,
    "",
    "Execution rules:",
    "1. Only modify files required to address this feedback.",
    "2. Do not modify .env, package.json, SQL, Supabase schema, Worker git automation, or production deployment settings.",
    "3. Do not send bulk Feishu messages.",
    "4. If the feedback requires product scope decisions, secrets, database schema changes, or production deployment, stop and report the blocker.",
    "5. Run focused verification plus lint/typecheck/build when feasible.",
    "6. Report changed files, verification result, residual risk, and whether boss acceptance is still needed.",
  ].join("\n");
}

function buildAcceptanceFeedbackJobRow(input: AcceptanceFeedbackJobInput): JobRecord {
  const feedback =
    input.feedbackText.trim().replace(/\s+/g, " ") ||
    input.rawMessageText.trim().replace(/\s+/g, " ");
  const requestText = buildAcceptanceFeedbackRequestText(input);
  const title = `BATCH-12 acceptance feedback: ${feedback.slice(0, 80)}`;

  return {
    source: "project_director",
    job_type: PROJECT_DIRECTOR_ACCEPTANCE_FEEDBACK_JOB_TYPE,
    job_id: `${PROJECT_DIRECTOR_BATCH_12}-${Date.now()}`,
    title,
    description: requestText,
    priority: 5,
    acceptance: "Address the acceptance feedback, verify the fix, and return the changed files plus validation result.",
    branch: null,
    executor: "local_codex",
    repo: "city-partner-platform",
    prompt: requestText,
    request_text: requestText,
    status: "queued",
    plan_status: "approved",
    workflow_stage: "execution",
    claimed_by: null,
    claimed_at: null,
    started_at: null,
    parent_task_id: null,
    project_id: "city-partner-platform",
    task_code: PROJECT_DIRECTOR_BATCH_12,
    dispatch_batch: PROJECT_DIRECTOR_BATCH_12,
    feishu_message_id: input.feishuMessageId || null,
    feishu_event_id: input.feishuEventId || null,
    feishu_chat_id: input.feishuChatId || null,
    feishu_user_id: input.feishuUserId || null,
    payload: {
      batch_code: PROJECT_DIRECTOR_BATCH_12,
      route: "project_director_acceptance_feedback",
      feedback_text: feedback,
      raw_message_text: input.rawMessageText,
      feishu_message_id: input.feishuMessageId,
      feishu_event_id: input.feishuEventId,
      feishu_chat_id: input.feishuChatId,
      feishu_user_id: input.feishuUserId,
    },
  };
}

export function buildBatch01ProductPlanningJobs(
  plan: ProjectDirectorDispatchPlanDraft
): DispatchJobBuildResult {
  const batch = plan.dispatch_plan.batches.find(
    (item) => item.batch_code === PROJECT_DIRECTOR_BATCH_01
  );
  const tasks = (batch?.tasks ?? [])
    .map(normalizeBatch01OutputFiles)
    .filter(isAllowedProductPlanningTask);
  const requestTexts = tasks.map((task) =>
    buildProductPlanningRequestText(plan.project.title, task)
  );

  return {
    projectTitle: plan.project.title,
    tasks,
    requestTexts,
  };
}

export function buildProjectDirectorPlanningRequestText(input: {
  originalDemand: string;
  taskTreeId: string;
  summary: string;
}): string {
  return [
    "【项目总管规划任务】",
    "执行角色：project_director",
    "执行模式：planning_only",
    `任务树编号：${input.taskTreeId}`,
    "",
    "老板原始需求：",
    input.originalDemand,
    "",
    "规划摘要：",
    input.summary,
    "",
    "执行限制：",
    "1. 本任务只记录规划，不创建具体 Agent 执行任务。",
    "2. 子任务必须等老板回复“批准执行”后才能入队。",
    "3. 不允许修改业务页面、数据库结构、.env 或生产环境。",
  ].join("\n");
}

export async function hasExistingPlanningJob(
  supabase: SupabaseClient,
  taskTreeId: string
): Promise<boolean> {
  const marker = `任务树编号：${taskTreeId}`;
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("id, request_text")
    .eq("source", "project_director")
    .in("status", ["queued", "pending", "running"])
    .ilike("request_text", `%${marker}%`)
    .limit(1)
    .maybeSingle();

  if (!error) return Boolean(data);
  if (!isMissingColumnError(error)) {
    throw new Error(`check project director planning job failed: ${error.message}`);
  }

  const fallback = await supabase
    .from("hermes_jobs")
    .select("id, job_id")
    .eq("source", "project_director")
    .in("status", ["queued", "pending", "running"])
    .eq("job_id", taskTreeId)
    .limit(1)
    .maybeSingle();

  if (fallback.error) {
    if (isMissingColumnError(fallback.error)) return false;
    throw new Error(`check project director planning job failed: ${fallback.error.message}`);
  }

  return Boolean(fallback.data);
}

export async function insertProjectDirectorPlanningJob(
  supabase: SupabaseClient,
  input: ProjectDirectorPlanningJobInput
): Promise<DispatchJobInsertResult> {
  return insertRowsWithMissingColumnFallback(
    supabase,
    [buildProjectDirectorPlanningJobRow(input)],
    "insert project director planning job failed"
  );
}

export function buildApprovedAgentDispatchJobs(
  plan: ProjectDirectorDispatchPlanDraft
): DispatchJobBuildResult {
  const tasks = plan.dispatch_plan.batches
    .flatMap((batch) => batch.tasks)
    .filter((task) => !task.requires_boss_approval || task.execution_mode === "approved_execution");
  const requestTexts = tasks.map((task) =>
    buildAgentDispatchRequestText(plan.project.title, task)
  );

  return {
    projectTitle: plan.project.title,
    tasks,
    requestTexts,
  };
}

export async function hasExistingAgentDispatchJobs(
  supabase: SupabaseClient,
  tasks: ProjectDirectorDispatchTask[]
): Promise<boolean> {
  for (const task of tasks) {
    const marker = `任务编号：${task.task_key}`;
    const { data, error } = await supabase
      .from("hermes_jobs")
      .select("id, request_text")
      .eq("source", "agent_dispatch")
      .in("status", ["queued", "pending", "running"])
      .ilike("request_text", `%${marker}%`)
      .limit(1)
      .maybeSingle();

    if (!error && data) return true;
    if (!error) continue;
    if (!isMissingColumnError(error)) {
      throw new Error(`check existing agent dispatch jobs failed: ${error.message}`);
    }

    const fallback = await supabase
      .from("hermes_jobs")
      .select("id, job_id")
      .eq("source", "agent_dispatch")
      .in("status", ["queued", "pending", "running"])
      .eq("job_id", task.task_key)
      .limit(1)
      .maybeSingle();

    if (fallback.error) {
      if (isMissingColumnError(fallback.error)) continue;
      throw new Error(`check existing agent dispatch jobs failed: ${fallback.error.message}`);
    }
    if (fallback.data) return true;
  }

  return false;
}

export async function insertApprovedAgentDispatchJobs(
  supabase: SupabaseClient,
  buildResult: DispatchJobBuildResult
): Promise<DispatchJobInsertResult> {
  const rows = buildResult.tasks.map((task, index) =>
    buildAgentDispatchJobRow(buildResult.projectTitle, task, buildResult.requestTexts[index])
  );

  return insertRowsWithMissingColumnFallback(
    supabase,
    rows,
    "insert approved agent dispatch jobs failed"
  );
}

export async function hasBatch01DispatchRecord(
  supabase: SupabaseClient,
  convId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("hermes_messages")
    .select("id, content")
    .eq("conversation_id", convId)
    .eq("role", "system")
    .eq("name", PROJECT_DIRECTOR_DISPATCH_BATCH_RECORD_NAME)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) throw new Error(`load dispatch record failed: ${error.message}`);
  return (data ?? []).some(
    (message) =>
      typeof message.content === "string" &&
      message.content.includes(PROJECT_DIRECTOR_DISPATCH_BATCH_RECORD_MARKER) &&
      message.content.includes("state: dispatched") &&
      message.content.includes(`batch_code: ${PROJECT_DIRECTOR_BATCH_01}`)
  );
}

export async function hasExistingBatch01Jobs(
  supabase: SupabaseClient,
  tasks: ProjectDirectorDispatchTask[]
): Promise<boolean> {
  for (const task of tasks) {
    const marker = `任务编号：${task.task_code}`;
    const { data, error } = await supabase
      .from("hermes_jobs")
      .select("id, request_text")
      .eq("source", "project_director")
      .in("status", ["queued", "pending", "running"])
      .ilike("request_text", `%${marker}%`)
      .limit(1)
      .maybeSingle();

    if (error) {
      if (isMissingColumnError(error)) {
        const fallback = await supabase
          .from("hermes_jobs")
          .select("id, job_id")
          .eq("source", "project_director")
          .in("status", ["queued", "pending", "running"])
          .eq("job_id", task.task_code)
          .limit(1)
          .maybeSingle();

        if (fallback.error) {
          if (isMissingColumnError(fallback.error)) return false;
          throw new Error(`check existing hermes_jobs failed: ${fallback.error.message}`);
        }
        if (fallback.data) return true;
        continue;
      }
      throw new Error(`check existing hermes_jobs failed: ${error.message}`);
    }
    if (data) return true;
  }
  return false;
}

export async function insertBatch01ProductPlanningJobs(
  supabase: SupabaseClient,
  buildResult: DispatchJobBuildResult
): Promise<DispatchJobInsertResult> {
  const rows = buildResult.tasks.map((task, index) =>
    buildJobRow(buildResult.projectTitle, task, buildResult.requestTexts[index])
  );
  return insertRowsWithMissingColumnFallback(supabase, rows, "insert hermes_jobs failed");
}

export async function hasRecentAcceptanceFeedbackJob(
  supabase: SupabaseClient,
  feedbackText: string,
  now = Date.now()
): Promise<boolean> {
  const normalized = feedbackText.trim().replace(/\s+/g, " ");
  if (!normalized) return false;

  const createdAfter = new Date(now - 30 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("id, payload, request_text, created_at")
    .eq("source", "project_director")
    .in("status", ["queued", "pending", "running"])
    .gte("created_at", createdAfter)
    .contains("payload", {
      batch_code: PROJECT_DIRECTOR_BATCH_12,
      feedback_text: normalized,
    })
    .limit(1)
    .maybeSingle();

  if (!error) return Boolean(data);
  if (!isMissingColumnError(error)) {
    throw new Error(`check acceptance feedback job failed: ${error.message}`);
  }

  const fallback = await supabase
    .from("hermes_jobs")
    .select("id, request_text, created_at")
    .eq("source", "project_director")
    .in("status", ["queued", "pending", "running"])
    .gte("created_at", createdAfter)
    .ilike("request_text", `%${normalized.slice(0, 120)}%`)
    .limit(1)
    .maybeSingle();

  if (fallback.error) {
    if (isMissingColumnError(fallback.error)) return false;
    throw new Error(`check acceptance feedback job failed: ${fallback.error.message}`);
  }
  return Boolean(fallback.data);
}

export async function insertAcceptanceFeedbackJob(
  supabase: SupabaseClient,
  input: AcceptanceFeedbackJobInput
): Promise<DispatchJobInsertResult> {
  return insertRowsWithMissingColumnFallback(
    supabase,
    [buildAcceptanceFeedbackJobRow(input)],
    "insert acceptance feedback job failed"
  );
}

export function buildAcceptanceFeedbackQueuedReply(insertedCount: number): string {
  return [
    "【项目总管：验收反馈已入队】",
    `已创建 ${insertedCount} 个 BATCH-12 修复任务。`,
    "",
    "我会让 Worker 先诊断反馈、执行最小范围修复并验证。",
    "完成后会回报修改文件、验证结果和是否仍需老板验收。",
  ].join("\n");
}

export function buildAcceptanceFeedbackDuplicateReply(): string {
  return "【项目总管】检测到相同验收反馈已在处理中，本次不会重复入队。";
}

export function buildAcceptanceFeedbackQueuedRecord(
  input: AcceptanceFeedbackJobInput,
  skippedColumns: string[]
): string {
  return [
    "PROJECT_DIRECTOR_ACCEPTANCE_FEEDBACK_QUEUED",
    "state: queued",
    `batch_code: ${PROJECT_DIRECTOR_BATCH_12}`,
    `feedback: ${input.feedbackText.trim() || input.rawMessageText.trim()}`,
    `feishu_message_id: ${input.feishuMessageId || "none"}`,
    `skipped_hermes_jobs_columns: ${skippedColumns.join(", ") || "none"}`,
    "note: boss acceptance feedback was routed directly to project director worker queue.",
  ].join("\n");
}

export function buildBatch01DispatchedReply(taskCount: number): string {
  return [
    "【项目总管：第 1 批已分发】",
    "已分发：",
    `第 1 批：产品规划`,
    `任务数量： ${taskCount} 个`,
    "",
    "本批执行角色：",
    "产品经理",
    "",
    "预计产物：",
    "1. docs/product/prd.md",
    "2. docs/product/page-list.md",
    "3. docs/product/user-flow.md",
    "4. docs/product/acceptance-criteria.md",
    "",
    "说明：",
    "本批只做产品规划文档，不开发代码、不改数据库、不部署。",
    "",
    "下一步：",
    "Worker 将领取这些任务并执行。完成后我会汇总结果给你验收。",
  ].join("\n");
}

export function buildBatch01DispatchedRecord(
  plan: ProjectDirectorDispatchPlanDraft,
  tasks: ProjectDirectorDispatchTask[],
  skippedColumns: string[]
): string {
  return [
    PROJECT_DIRECTOR_DISPATCH_BATCH_RECORD_MARKER,
    "state: dispatched",
    `batch_code: ${PROJECT_DIRECTOR_BATCH_01}`,
    `project: ${plan.project.title}`,
    `task_count: ${tasks.length}`,
    `task_codes: ${tasks.map((task) => task.task_code).join(", ")}`,
    `skipped_hermes_jobs_columns: ${skippedColumns.join(", ") || "none"}`,
    "note: only BATCH-01 product planning document tasks were inserted into hermes_jobs.",
  ].join("\n");
}
