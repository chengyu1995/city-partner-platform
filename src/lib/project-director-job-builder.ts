import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ProjectDirectorDispatchPlanDraft,
  ProjectDirectorDispatchTask,
} from "@/lib/project-director-dispatch-plan";

type JobRecord = Record<string, unknown>;

interface SupabaseWriteError {
  message?: string;
  code?: string;
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
export const PROJECT_DIRECTOR_ACCEPTANCE_FEEDBACK_JOB_TYPE = "acceptance_feedback";

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
  return {
    source: "project_director",
    job_type: "product_planning",
    job_id: task.task_code,
    title: task.task_title,
    description: requestText,
    priority: 10,
    acceptance: task.acceptance_criteria.join("\n"),
    branch: null,
    executor: "product_manager",
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
    project_id: projectTitle,
    task_code: task.task_code,
    dispatch_batch: PROJECT_DIRECTOR_BATCH_01,
    payload: {
      project_title: projectTitle,
      batch_code: PROJECT_DIRECTOR_BATCH_01,
      role: task.role,
      task_code: task.task_code,
      task_title: task.task_title,
      output_files: task.output_files,
      acceptance_criteria: task.acceptance_criteria,
    },
  };
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
  let rows = buildResult.tasks.map((task, index) =>
    buildJobRow(buildResult.projectTitle, task, buildResult.requestTexts[index])
  );
  const skippedColumns: string[] = [];

  for (let attempt = 0; attempt < 16; attempt++) {
    const { error } = await supabase.from("hermes_jobs").insert(rows);
    if (!error) return { insertedCount: rows.length, skippedColumns };
    if (!isMissingColumnError(error)) throw new Error(`insert hermes_jobs failed: ${error.message}`);

    const missingColumn = extractMissingColumn(error);
    if (!missingColumn || !rows.some((row) => missingColumn in row)) {
      throw new Error(`insert hermes_jobs failed: ${error.message}`);
    }

    skippedColumns.push(missingColumn);
    rows = rows.map((row) => {
      const next = { ...row };
      delete next[missingColumn];
      return next;
    });
  }

  throw new Error("insert hermes_jobs failed: too many missing columns");
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
  let rows = [buildAcceptanceFeedbackJobRow(input)];
  const skippedColumns: string[] = [];

  for (let attempt = 0; attempt < 16; attempt++) {
    const { error } = await supabase.from("hermes_jobs").insert(rows);
    if (!error) return { insertedCount: rows.length, skippedColumns };
    if (!isMissingColumnError(error)) throw new Error(`insert acceptance feedback job failed: ${error.message}`);

    const missingColumn = extractMissingColumn(error);
    if (!missingColumn || !rows.some((row) => missingColumn in row)) {
      throw new Error(`insert acceptance feedback job failed: ${error.message}`);
    }

    skippedColumns.push(missingColumn);
    rows = rows.map((row) => {
      const next = { ...row };
      delete next[missingColumn];
      return next;
    });
  }

  throw new Error("insert acceptance feedback job failed: too many missing columns");
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
