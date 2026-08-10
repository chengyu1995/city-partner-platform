import { randomUUID } from "node:crypto";
import {
  normalizeExecutionPlan,
  validateExecutionPlan,
  validatePlanningStateBoundary,
  type HermesApprovalContext,
  type HermesExecutionPlan,
  type HermesExecutionSubtask,
  type HermesRequestedMode,
} from "./execution-plan.ts";
import {
  RegistryCapabilityGateway,
  type AgentCapabilityGateway,
} from "../openclaw/capability-gateway.ts";
import {
  HERMES_CANONICAL_ORCHESTRATION_ENV,
  resolveHermesCanonicalCutoverConfig,
} from "./cutover-control.ts";
import type { CanonicalCanaryAdmissionEvidence } from "./canonical-canary-scope.ts";

export const HERMES_CANONICAL_ORCHESTRATION_ENABLED_DEFAULT = false;
export { HERMES_CANONICAL_ORCHESTRATION_ENV };

export interface GMApprovedRequest {
  request_id: string;
  original_request_text: string;
  project_domain: string;
  requested_mode: HermesRequestedMode;
  approval_context: HermesApprovalContext;
  objective: string;
}

export interface HermesPlanningRequest extends GMApprovedRequest {
  planning_contract: "hermes_execution_plan_v1";
  permission_ceiling: HermesRequestedMode;
}

export type HermesPlanDraftSubtask = Omit<HermesExecutionSubtask, "recommended_agent"> & {
  recommended_agent?: string;
};

export interface HermesPlanDraft {
  requested_mode?: HermesRequestedMode;
  objective: string;
  aggregation_policy?: "all_required" | "best_effort";
  subtasks: HermesPlanDraftSubtask[];
  [key: string]: unknown;
}

export interface HermesPlanningProvider {
  plan(request: HermesPlanningRequest, context?: HermesPlanningContext): Promise<HermesPlanDraft>;
}

export interface HermesPlanningContext {
  signal?: AbortSignal;
}

export interface CanonicalJobCommand {
  source: "hermes_canonical_orchestration";
  title: string;
  request_text: string;
  project_domain: string;
  requested_mode: HermesRequestedMode;
  payload: {
    canonical_runtime: true;
    plan_schema_version: string;
    plan_id: string;
    plan_revision: number;
    plan_hash: string;
    original_request_text: string;
    project_domain: string;
    requested_mode: HermesRequestedMode;
    plan_objective: string;
    aggregation_policy: "all_required" | "best_effort";
    subtask_id: string;
    subtask_title: string;
    objective: string;
    dependencies: string[];
    recommended_agent: string;
    required_capabilities: string[];
    execution_intent: string;
    allowed_paths: string[];
    forbidden_paths: string[];
    acceptance_criteria: string[];
    validation_requirements: string[];
    git_commit_required: boolean;
    git_push_required: boolean;
    deployment_required: boolean;
    approval_context: HermesApprovalContext;
    canonical_canary_admission: CanonicalCanaryAdmissionEvidence;
  };
}

export type CanonicalJobCreator = (command: CanonicalJobCommand) => Promise<unknown>;

export function isHermesCanonicalOrchestrationEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return resolveHermesCanonicalCutoverConfig(env).canonical_enabled;
}

export function toHermesPlanningRequest(request: GMApprovedRequest): HermesPlanningRequest {
  return {
    ...request,
    approval_context: { ...request.approval_context },
    planning_contract: "hermes_execution_plan_v1",
    permission_ceiling: request.requested_mode,
  };
}

export async function planApprovedRequest(
  approvedRequest: GMApprovedRequest,
  planner: HermesPlanningProvider,
  capabilityGateway: AgentCapabilityGateway = new RegistryCapabilityGateway(),
  context?: HermesPlanningContext
): Promise<HermesExecutionPlan> {
  const planningRequest = toHermesPlanningRequest(approvedRequest);
  const draft = await planner.plan(planningRequest, context);
  const planningBoundary = validatePlanningStateBoundary(draft);
  if (!planningBoundary.ok) throw new Error(planningBoundary.errors.join(";"));
  if (draft.requested_mode && draft.requested_mode !== approvedRequest.requested_mode) {
    throw new Error("REQUESTED_MODE_ESCALATION");
  }

  const subtasks: HermesExecutionSubtask[] = [];
  for (const subtask of draft.subtasks) {
    const resolution = await capabilityGateway.resolveAgentCapabilities({
      required_capabilities: subtask.required_capabilities,
      execution_intent: subtask.execution_intent,
      requested_mode: approvedRequest.requested_mode,
    });
    subtasks.push({ ...subtask, recommended_agent: resolution.selected_agent });
  }

  const planId = `${approvedRequest.request_id}:${randomUUID()}`;
  const plan = normalizeExecutionPlan(
    {
      schema_version: "1.0",
      plan_id: planId,
      plan_revision: 1,
      original_request_text: approvedRequest.original_request_text,
      project_domain: approvedRequest.project_domain,
      requested_mode: approvedRequest.requested_mode,
      approval_context: { ...approvedRequest.approval_context },
      objective: draft.objective || approvedRequest.objective,
      aggregation_policy: draft.aggregation_policy ?? "all_required",
      subtasks,
    },
    approvedRequest.requested_mode
  );
  const validation = validateExecutionPlan(plan, approvedRequest.requested_mode);
  if (!validation.ok) throw new Error(validation.errors.join(";"));
  return plan;
}

export function buildCanonicalJobCommands(
  plan: HermesExecutionPlan,
  admission: CanonicalCanaryAdmissionEvidence
): CanonicalJobCommand[] {
  const validation = validateExecutionPlan(plan, plan.requested_mode);
  if (!validation.ok) throw new Error(validation.errors.join(";"));
  if (plan.subtasks.length !== 1) throw new Error("CANONICAL_CANARY_SINGLE_JOB_REQUIRED");
  return plan.subtasks.map((subtask) => ({
    source: "hermes_canonical_orchestration",
    title: subtask.title.trim(),
    request_text: `${subtask.title}\n\n${subtask.objective}\n\nOriginal request:\n${plan.original_request_text}`,
    project_domain: plan.project_domain,
    requested_mode: plan.requested_mode,
    payload: {
      canonical_runtime: true,
      plan_schema_version: plan.schema_version,
      plan_id: plan.plan_id,
      plan_revision: plan.plan_revision,
      plan_hash: plan.plan_hash,
      original_request_text: plan.original_request_text,
      project_domain: plan.project_domain,
      requested_mode: plan.requested_mode,
      plan_objective: plan.objective,
      aggregation_policy: plan.aggregation_policy,
      subtask_id: subtask.subtask_id,
      subtask_title: subtask.title,
      objective: subtask.objective,
      dependencies: [...subtask.dependencies],
      recommended_agent: subtask.recommended_agent,
      required_capabilities: [...subtask.required_capabilities],
      execution_intent: subtask.execution_intent,
      allowed_paths: [...subtask.allowed_paths],
      forbidden_paths: [...subtask.forbidden_paths],
      acceptance_criteria: [...subtask.acceptance_criteria],
      validation_requirements: [...subtask.validation_requirements],
      git_commit_required: subtask.git_commit_required,
      git_push_required: subtask.git_push_required,
      deployment_required: subtask.deployment_required,
      approval_context: { ...plan.approval_context },
      canonical_canary_admission: { ...admission },
    },
  }));
}

export async function createCanonicalJobsForPlan(
  plan: HermesExecutionPlan,
  canonicalCreateJob: CanonicalJobCreator,
  admission: CanonicalCanaryAdmissionEvidence
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const command of buildCanonicalJobCommands(plan, admission)) {
    results.push(await canonicalCreateJob(command));
  }
  return results;
}
