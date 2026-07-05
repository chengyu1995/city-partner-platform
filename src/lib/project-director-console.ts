import type { SupabaseClient } from "@supabase/supabase-js";

type ConsoleCommand =
  | "help"
  | "status"
  | "view_plan"
  | "pause_agents"
  | "resume_agents"
  | "approve_execution";

export interface ProjectDirectorConsoleAction {
  command: ConsoleCommand;
  reply: string;
  record: string;
}

const COMMAND_PREFIXES = ["总管", "项目总管", "老板控制台", "新需求", "/pd", "/director"];

function normalizeConsoleText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function stripCommandPrefix(text: string): string {
  const normalized = normalizeConsoleText(text);
  for (const prefix of COMMAND_PREFIXES) {
    if (normalized === prefix) return "帮助";
    if (normalized.startsWith(`${prefix} `)) return normalized.slice(prefix.length).trim();
    if (normalized.startsWith(`${prefix}：`)) return normalized.slice(prefix.length + 1).trim();
    if (normalized.startsWith(`${prefix}:`)) return normalized.slice(prefix.length + 1).trim();
  }
  return normalized;
}

export function parseProjectDirectorConsoleCommand(text: string): ConsoleCommand | null {
  const body = stripCommandPrefix(text);
  if (/^(帮助|命令|控制台|菜单|help)$/i.test(body)) return "help";
  if (/^(状态|总览|进度|任务状态|队列|queue|status)$/i.test(body)) return "status";
  if (/^(查看计划|计划|当前计划|任务树|分发计划|plan)$/i.test(body)) return "view_plan";
  if (/^(暂停|暂停Agent|暂停 Agents|停止分发|暂停分发|pause)$/i.test(body)) return "pause_agents";
  if (/^(恢复|继续|恢复Agent|恢复 Agents|继续分发|resume)$/i.test(body)) return "resume_agents";
  if (/^(批准执行|同意执行|开始执行|approve)$/i.test(body)) return "approve_execution";
  return null;
}

export function isProjectDirectorConsoleCommand(text: string): boolean {
  return parseProjectDirectorConsoleCommand(text) !== null;
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return "- none";
  return entries.map(([status, count]) => `- ${status}: ${count}`).join("\n");
}

function readLineValue(content: string, key: string): string {
  const line = content.split(/\r?\n/).find((item) => item.startsWith(`${key}: `));
  return line ? line.slice(key.length + 2).trim() : "";
}

function oneLine(value: unknown, fallback = "none"): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return fallback;
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

async function loadLatestSystemRecord(
  supabase: SupabaseClient,
  convId: string | undefined,
  marker: string
): Promise<string> {
  if (!convId) return "";
  const { data, error } = await supabase
    .from("hermes_messages")
    .select("content, created_at")
    .eq("conversation_id", convId)
    .eq("role", "system")
    .ilike("content", `%${marker}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data || typeof data.content !== "string") return "";
  return data.content;
}

async function loadLatestJobSummary(
  supabase: SupabaseClient,
  statuses: string[]
): Promise<string> {
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("job_id, title, status, claimed_by, updated_at, error_text, status_message, payload")
    .in("source", ["project_director", "agent_dispatch"])
    .in("status", statuses)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return "none";
  const payload =
    data.payload && typeof data.payload === "object" ? (data.payload as Record<string, unknown>) : {};
  return [
    `job=${oneLine(data.job_id)}`,
    `title=${oneLine(data.title)}`,
    `status=${oneLine(data.status)}`,
    `worker=${oneLine(data.claimed_by)}`,
    `updated=${oneLine(data.updated_at)}`,
    `heartbeat=${oneLine(payload.heartbeat_at ?? payload.updated_at)}`,
    `message=${oneLine(data.status_message)}`,
    `error=${oneLine(data.error_text)}`,
  ].join("; ");
}

async function loadQueueCounts(supabase: SupabaseClient): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from("hermes_jobs")
    .select("status")
    .in("source", ["project_director", "agent_dispatch"]);

  if (error) {
    return { query_failed: 1 };
  }

  return (data ?? []).reduce<Record<string, number>>((acc, row) => {
    const status = typeof row.status === "string" ? row.status : "unknown";
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
}

export async function buildProjectDirectorConsoleAction(
  supabase: SupabaseClient,
  text: string,
  convId?: string
): Promise<ProjectDirectorConsoleAction | null> {
  const command = parseProjectDirectorConsoleCommand(text);
  if (!command) return null;

  if (command === "help") {
    return {
      command,
      reply: [
        "[项目总管控制台]",
        "可用命令：",
        "- 新需求：状态",
        "- 新需求：查看计划",
        "- 新需求：帮助",
        "- 新需求：我要做一个 xxx 功能",
        "- 新需求：修改计划：xxx",
        "- 总管 状态：查看项目总管和多 Agent 队列",
        "- 总管 批准执行：批准最近任务树进入 Agent 执行",
        "- 总管 暂停：暂停新的 Agent 分发",
        "- 总管 恢复：恢复新的 Agent 分发",
        "- 验收反馈：xxx 点不开",
        "- 验收反馈：xxx 不好看",
        "- 验收反馈：xxx 报错",
        "",
        "正式模式：普通网站需求先进入项目总管 planning，不直接进入 Codex。只有老板发送“总管 批准执行”后，才会分发 Worker/Codex。",
        "高风险事项仍需单独确认：生产部署、环境变量、数据库结构、删除数据、依赖变更、恢复 stash。",
      ].join("\n"),
      record: "PROJECT_DIRECTOR_CONSOLE\ncommand: help\nstate: replied",
    };
  }

  if (command === "status") {
    const counts = await loadQueueCounts(supabase);
    const paused = convId ? await isProjectDirectorDispatchPaused(supabase, convId) : false;
    const recentPlan = await loadLatestSystemRecord(
      supabase,
      convId,
      "PROJECT_DIRECTOR_TASK_TREE_DRAFT"
    );
    const recentDispatch = await loadLatestSystemRecord(
      supabase,
      convId,
      "PROJECT_DIRECTOR_APPROVED_EXECUTION_DISPATCHED"
    );
    const runningTask = await loadLatestJobSummary(supabase, ["running"]);
    const completedTask = await loadLatestJobSummary(supabase, ["succeeded"]);
    const failedTask = await loadLatestJobSummary(supabase, ["failed"]);
    const recentDemand =
      readLineValue(recentPlan, "original_demand") ||
      readLineValue(recentDispatch, "original_demand") ||
      "none";
    const recentPlanId =
      readLineValue(recentPlan, "plan_id") ||
      readLineValue(recentPlan, "task_tree_id") ||
      "none";
    return {
      command,
      reply: [
        "[Project Director Status]",
        `paused: ${paused ? "yes" : "no"}`,
        `recent_boss_request: ${oneLine(recentDemand)}`,
        `recent_plan: ${oneLine(recentPlanId)}`,
        `current_running_task: ${runningTask}`,
        `last_completed_task: ${completedTask}`,
        `last_failure: ${failedTask}`,
        "",
        "[项目总管状态]",
        "system_upgrade: BATCH-14..BATCH-19 completed",
        "mode: production_project_director_planning_first",
        "队列统计：",
        formatCounts(counts),
        "",
        "控制命令：新需求：查看计划 / 总管 批准执行 / 总管 暂停 / 总管 恢复",
      ].join("\n"),
      record: [
        "PROJECT_DIRECTOR_CONSOLE",
        "command: status",
        "state: replied",
        `agent_dispatch_paused: ${paused ? "true" : "false"}`,
        `recent_boss_request: ${recentDemand}`,
        `recent_plan: ${recentPlanId}`,
        `current_running_task: ${runningTask}`,
        `last_completed_task: ${completedTask}`,
        `last_failure: ${failedTask}`,
        `counts: ${JSON.stringify(counts)}`,
      ].join("\n"),
    };
  }

  if (command === "view_plan") {
    const recentPlan = await loadLatestSystemRecord(
      supabase,
      convId,
      "PROJECT_DIRECTOR_TASK_TREE_DRAFT"
    );
    const recentDispatchPlan = await loadLatestSystemRecord(
      supabase,
      convId,
      "PROJECT_DIRECTOR_DISPATCH_PLAN_DRAFT"
    );
    const recentDispatch = await loadLatestSystemRecord(
      supabase,
      convId,
      "PROJECT_DIRECTOR_APPROVED_EXECUTION_DISPATCHED"
    );
    const source = recentDispatchPlan || recentPlan || recentDispatch;
    const recentDemand = readLineValue(source, "original_demand") || "none";
    const recentPlanId =
      readLineValue(source, "plan_id") || readLineValue(source, "task_tree_id") || "none";
    const state = readLineValue(source, "state") || "none";
    const executionMode = readLineValue(source, "execution_mode") || "planning_only";

    return {
      command,
      reply: [
        "[Project Director Plan]",
        `recent_boss_request: ${oneLine(recentDemand)}`,
        `recent_plan: ${oneLine(recentPlanId)}`,
        `state: ${oneLine(state)}`,
        `execution_mode: ${oneLine(executionMode)}`,
        "",
        "规则：普通网站需求先进入 planning；老板发送“总管 批准执行”后才会分发 Worker/Codex。",
        "可继续发送：修改计划：xxx / 总管 批准执行 / 总管 暂停",
      ].join("\n"),
      record: [
        "PROJECT_DIRECTOR_CONSOLE",
        "command: view_plan",
        "state: replied",
        `recent_boss_request: ${recentDemand}`,
        `recent_plan: ${recentPlanId}`,
        `plan_state: ${state}`,
        `execution_mode: ${executionMode}`,
      ].join("\n"),
    };
  }

  if (command === "approve_execution") {
    return {
      command,
      reply: "已收到老板控制台命令：批准执行。将按现有任务树审批流程继续处理。",
      record: "PROJECT_DIRECTOR_CONSOLE\ncommand: approve_execution\nstate: delegate_to_approval_flow",
    };
  }

  const paused = command === "pause_agents";
  return {
    command,
    reply: paused
      ? "已记录：暂停新的 Agent 分发。当前运行中的 Worker 不会被强制中断。"
      : "已记录：恢复新的 Agent 分发。后续仍按任务树和审批边界执行。",
    record: [
      "PROJECT_DIRECTOR_CONSOLE",
      `command: ${command}`,
      `agent_dispatch_paused: ${paused ? "true" : "false"}`,
      "state: recorded",
    ].join("\n"),
  };
}

export async function isProjectDirectorDispatchPaused(
  supabase: SupabaseClient,
  convId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("hermes_messages")
    .select("content, created_at")
    .eq("conversation_id", convId)
    .eq("role", "system")
    .eq("name", "project_director_console")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) return false;

  for (const row of data ?? []) {
    const content = typeof row.content === "string" ? row.content : "";
    if (!content.includes("PROJECT_DIRECTOR_CONSOLE")) continue;
    if (content.includes("agent_dispatch_paused: false")) return false;
    if (content.includes("agent_dispatch_paused: true")) return true;
  }

  return false;
}
