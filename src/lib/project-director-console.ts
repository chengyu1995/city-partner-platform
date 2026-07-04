import type { SupabaseClient } from "@supabase/supabase-js";

type ConsoleCommand =
  | "help"
  | "status"
  | "pause_agents"
  | "resume_agents"
  | "approve_execution";

export interface ProjectDirectorConsoleAction {
  command: ConsoleCommand;
  reply: string;
  record: string;
}

const COMMAND_PREFIXES = ["总管", "项目总管", "老板控制台", "/pd", "/director"];

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
  text: string
): Promise<ProjectDirectorConsoleAction | null> {
  const command = parseProjectDirectorConsoleCommand(text);
  if (!command) return null;

  if (command === "help") {
    return {
      command,
      reply: [
        "[项目总管控制台]",
        "可用命令：",
        "- 总管状态：查看项目总管和多 Agent 队列",
        "- 总管 批准执行：批准最近任务树进入 Agent 执行",
        "- 总管 暂停：暂停新的 Agent 分发",
        "- 总管 恢复：恢复新的 Agent 分发",
        "",
        "高风险事项仍需单独确认：生产部署、环境变量、数据库结构、删除数据、依赖变更。",
      ].join("\n"),
      record: "PROJECT_DIRECTOR_CONSOLE\ncommand: help\nstate: replied",
    };
  }

  if (command === "status") {
    const counts = await loadQueueCounts(supabase);
    return {
      command,
      reply: [
        "[项目总管状态]",
        "队列统计：",
        formatCounts(counts),
        "",
        "控制命令：总管 批准执行 / 总管 暂停 / 总管 恢复",
      ].join("\n"),
      record: [
        "PROJECT_DIRECTOR_CONSOLE",
        "command: status",
        "state: replied",
        `counts: ${JSON.stringify(counts)}`,
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
