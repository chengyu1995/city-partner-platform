import type { ProjectDirectorTaskTreeDraft } from "../project-director-task-tree.ts";
import { getAutonomousFactoryAgent } from "./agent-registry.ts";

export const AUTONOMOUS_FACTORY_MODE_ENV = "HERMES_AUTONOMOUS_FACTORY_MODE";
export const AUTONOMOUS_FACTORY_MODE_DEFAULT = "disabled";

export type AutonomousFactoryMode = "disabled" | "shadow" | "authoritative";

export interface AutonomousFactoryRpcResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

export interface AutonomousFactoryRpcClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>
  ): PromiseLike<AutonomousFactoryRpcResult>;
}

export interface AutonomousFactoryIntakeContext {
  projectKey: string;
  projectName: string;
  conversationId: string;
  demandKind: string;
  eventId: string;
  messageId: string;
  chatId: string;
  userId: string;
}

export type AutonomousFactoryCaptureResult =
  | { status: "disabled"; mode: "disabled" }
  | {
      status: "captured";
      mode: "shadow" | "authoritative";
      project_id: string;
      root_task_id: string;
      duplicate: boolean;
      planned_tasks: number;
    }
  | {
      status: "shadow_failed";
      mode: "shadow";
      error_code: "AUTONOMOUS_FACTORY_CAPTURE_FAILED";
    };

interface RequirementRpcPayload {
  project_id?: unknown;
  task_id?: unknown;
  duplicate?: unknown;
}

function readRpcPayload(data: unknown): RequirementRpcPayload | null {
  const value = Array.isArray(data) ? data[0] : data;
  return value && typeof value === "object" ? (value as RequirementRpcPayload) : null;
}

function fail(
  mode: Exclude<AutonomousFactoryMode, "disabled">
): AutonomousFactoryCaptureResult {
  if (mode === "authoritative") throw new Error("AUTONOMOUS_FACTORY_CAPTURE_FAILED");
  return { status: "shadow_failed", mode, error_code: "AUTONOMOUS_FACTORY_CAPTURE_FAILED" };
}

export function readAutonomousFactoryMode(
  env: Record<string, string | undefined> = process.env
): AutonomousFactoryMode {
  const raw = env[AUTONOMOUS_FACTORY_MODE_ENV]?.trim().toLowerCase();
  if (!raw) return AUTONOMOUS_FACTORY_MODE_DEFAULT;
  if (raw === "disabled" || raw === "shadow" || raw === "authoritative") return raw;
  throw new Error("AUTONOMOUS_FACTORY_MODE_INVALID");
}

export async function captureAutonomousFactoryPlan(input: {
  client: AutonomousFactoryRpcClient;
  draft: ProjectDirectorTaskTreeDraft;
  context: AutonomousFactoryIntakeContext;
  mode?: AutonomousFactoryMode;
}): Promise<AutonomousFactoryCaptureResult> {
  const mode = input.mode ?? readAutonomousFactoryMode();
  if (mode === "disabled") return { status: "disabled", mode };

  const tasks = input.draft.child_tasks.map((task) => {
    const agent = getAutonomousFactoryAgent(task.agent_role);
    return {
      task_key: task.task_key,
      title: task.title,
      agent_role: task.agent_role,
      planning_agent: agent.planning_agent,
      runtime_executor: agent.runtime_executor,
      capabilities: agent.capabilities,
      human_gate: agent.human_gate,
      task_type: task.task_type,
      stage: task.stage,
      phase: task.phase,
      dependency_keys: task.dependency_keys,
      allowed_files: task.allowed_files,
      forbidden_files: task.forbidden_files,
      acceptance_criteria: task.acceptance_criteria,
      risk_level: task.risk_level,
      can_auto_execute: task.can_auto_execute,
      requires_boss_approval: task.requires_boss_approval,
      execution_mode: task.execution_mode,
    };
  });

  const capture = await input.client.rpc("hermes_v2_capture_requirement_plan_v1", {
    p_project_key: input.context.projectKey,
    p_project_name: input.context.projectName,
    p_source: "feishu_event",
    p_source_external_id: input.context.eventId,
    p_title: input.draft.project.title,
    p_request_text: input.draft.original_demand,
    p_feishu_event_id: input.context.eventId,
    p_feishu_message_id: input.context.messageId,
    p_feishu_chat_id: input.context.chatId,
    p_feishu_user_id: input.context.userId,
    p_metadata: {
      conversation_id: input.context.conversationId,
      demand_kind: input.context.demandKind,
      boss_request_id: input.draft.boss_request_id,
      plan_id: input.draft.plan_id,
      task_tree_id: input.draft.task_tree_id,
      capture_mode: mode,
    },
    p_plan_id: input.draft.plan_id,
    p_plan: {
      boss_request_id: input.draft.boss_request_id,
      task_tree_id: input.draft.task_tree_id,
      project: input.draft.project,
      requires_boss_approval: input.draft.requires_boss_approval,
      execution_mode: input.draft.execution_mode,
    },
    p_tasks: tasks,
  });
  if (capture.error) return fail(mode);

  const capturePayload = readRpcPayload(capture.data);
  const projectId = capturePayload?.project_id;
  const rootTaskId = capturePayload?.task_id;
  if (typeof projectId !== "string" || typeof rootTaskId !== "string") return fail(mode);

  return {
    status: "captured",
    mode,
    project_id: projectId,
    root_task_id: rootTaskId,
    duplicate: capturePayload?.duplicate === true,
    planned_tasks: tasks.length,
  };
}
