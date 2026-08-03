import { createHash } from "node:crypto";

export const HERMES_EXECUTION_PLAN_SCHEMA_VERSION = "1.0";

export type HermesRequestedMode = "manager_read_only" | "worker_read_only" | "write_allowed";
export type HermesAggregationPolicy = "all_required" | "best_effort";

export interface HermesApprovalContext {
  approved_by?: string;
  approved_at?: string;
  approval_id?: string;
  deployment_approved?: boolean;
  [key: string]: unknown;
}

export interface HermesExecutionSubtask {
  subtask_id: string;
  title: string;
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
}

export interface HermesExecutionPlan {
  schema_version: typeof HERMES_EXECUTION_PLAN_SCHEMA_VERSION;
  plan_id: string;
  plan_revision: number;
  plan_hash: string;
  original_request_text: string;
  project_domain: string;
  requested_mode: HermesRequestedMode;
  approval_context: HermesApprovalContext;
  objective: string;
  aggregation_policy: HermesAggregationPolicy;
  subtasks: HermesExecutionSubtask[];
}

export interface HermesExecutionPlanValidation {
  ok: boolean;
  errors: string[];
}

const FORBIDDEN_EXECUTION_STATE_FIELDS = new Set([
  "job_state",
  "status",
  "claimed_by",
  "claim_state",
  "attempt",
  "attempt_id",
  "attempt_state",
  "lease",
  "lease_id",
  "lease_state",
  "retry_state",
  "terminal_state",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanString).filter(Boolean))];
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function hasForbiddenExecutionState(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value).filter((key) => FORBIDDEN_EXECUTION_STATE_FIELDS.has(key));
}

export function validatePlanningStateBoundary(candidate: Record<string, unknown>): HermesExecutionPlanValidation {
  const errors = hasForbiddenExecutionState(candidate).map((field) => `EXECUTION_STATE_FORBIDDEN:${field}`);
  const subtasks = Array.isArray(candidate.subtasks) ? candidate.subtasks : [];
  for (const value of subtasks) {
    if (!isRecord(value)) continue;
    const subtaskId = cleanString(value.subtask_id) || "unknown";
    for (const field of hasForbiddenExecutionState(value)) {
      errors.push(`SUBTASK_EXECUTION_STATE_FORBIDDEN:${subtaskId}:${field}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function calculatePlanHash(plan: Omit<HermesExecutionPlan, "plan_hash"> | HermesExecutionPlan): string {
  const hashInput = { ...plan } as Record<string, unknown>;
  delete hashInput.plan_hash;
  return createHash("sha256").update(JSON.stringify(stableValue(hashInput)), "utf8").digest("hex");
}

export function normalizeExecutionPlan(
  candidate: Record<string, unknown>,
  approvedMode: HermesRequestedMode
): HermesExecutionPlan {
  const subtasks = Array.isArray(candidate.subtasks) ? candidate.subtasks : [];
  const normalized = {
    schema_version: HERMES_EXECUTION_PLAN_SCHEMA_VERSION,
    plan_id: cleanString(candidate.plan_id),
    plan_revision: Math.max(1, Math.trunc(Number(candidate.plan_revision) || 1)),
    original_request_text: cleanString(candidate.original_request_text),
    project_domain: cleanString(candidate.project_domain),
    requested_mode: approvedMode,
    approval_context: isRecord(candidate.approval_context) ? { ...candidate.approval_context } : {},
    objective: cleanString(candidate.objective),
    aggregation_policy: candidate.aggregation_policy === "best_effort" ? "best_effort" : "all_required",
    subtasks: subtasks.map((value) => {
      const subtask = isRecord(value) ? value : {};
      return {
        subtask_id: cleanString(subtask.subtask_id),
        title: cleanString(subtask.title),
        objective: cleanString(subtask.objective),
        dependencies: cleanStringList(subtask.dependencies),
        recommended_agent: cleanString(subtask.recommended_agent),
        required_capabilities: cleanStringList(subtask.required_capabilities),
        execution_intent: cleanString(subtask.execution_intent),
        allowed_paths: cleanStringList(subtask.allowed_paths),
        forbidden_paths: cleanStringList(subtask.forbidden_paths),
        acceptance_criteria: cleanStringList(subtask.acceptance_criteria),
        validation_requirements: cleanStringList(subtask.validation_requirements),
        git_commit_required: readBoolean(subtask.git_commit_required),
        git_push_required: readBoolean(subtask.git_push_required),
        deployment_required: readBoolean(subtask.deployment_required),
      };
    }),
  } satisfies Omit<HermesExecutionPlan, "plan_hash">;

  return { ...normalized, plan_hash: calculatePlanHash(normalized) };
}

function findDependencyCycle(subtasks: HermesExecutionSubtask[]): string[] | null {
  const byId = new Map(subtasks.map((subtask) => [subtask.subtask_id, subtask]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string, path: string[]): string[] | null {
    if (visiting.has(id)) return [...path, id];
    if (visited.has(id)) return null;
    visiting.add(id);
    const subtask = byId.get(id);
    for (const dependency of subtask?.dependencies ?? []) {
      const cycle = visit(dependency, [...path, id]);
      if (cycle) return cycle;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const subtask of subtasks) {
    const cycle = visit(subtask.subtask_id, []);
    if (cycle) return cycle;
  }
  return null;
}

export function validateExecutionPlan(
  plan: HermesExecutionPlan,
  approvedMode: HermesRequestedMode
): HermesExecutionPlanValidation {
  const errors: string[] = [];
  if (plan.schema_version !== HERMES_EXECUTION_PLAN_SCHEMA_VERSION) errors.push("UNSUPPORTED_SCHEMA_VERSION");
  if (!plan.plan_id) errors.push("PLAN_ID_REQUIRED");
  if (!Number.isInteger(plan.plan_revision) || plan.plan_revision < 1) errors.push("PLAN_REVISION_INVALID");
  if (!plan.original_request_text) errors.push("ORIGINAL_REQUEST_REQUIRED");
  if (!plan.project_domain) errors.push("PROJECT_DOMAIN_REQUIRED");
  if (!plan.objective) errors.push("OBJECTIVE_REQUIRED");
  if (!plan.subtasks.length) errors.push("SUBTASKS_REQUIRED");
  if (plan.requested_mode !== approvedMode) errors.push("REQUESTED_MODE_ESCALATION");
  if (plan.plan_hash !== calculatePlanHash(plan)) errors.push("PLAN_HASH_MISMATCH");

  const topLevelStateFields = hasForbiddenExecutionState(plan);
  if (topLevelStateFields.length) errors.push(`EXECUTION_STATE_FORBIDDEN:${topLevelStateFields.join(",")}`);

  const ids = new Set<string>();
  for (const subtask of plan.subtasks) {
    if (!subtask.subtask_id) errors.push("SUBTASK_ID_REQUIRED");
    if (ids.has(subtask.subtask_id)) errors.push(`DUPLICATE_SUBTASK_ID:${subtask.subtask_id}`);
    ids.add(subtask.subtask_id);
    if (!subtask.title || !subtask.objective) errors.push(`SUBTASK_CONTENT_REQUIRED:${subtask.subtask_id}`);
    if (!subtask.required_capabilities.length) errors.push(`SUBTASK_CAPABILITIES_REQUIRED:${subtask.subtask_id}`);
    const forbidden = hasForbiddenExecutionState(subtask);
    if (forbidden.length) errors.push(`SUBTASK_EXECUTION_STATE_FORBIDDEN:${subtask.subtask_id}:${forbidden.join(",")}`);
    if (approvedMode !== "write_allowed" && (subtask.git_commit_required || subtask.git_push_required || subtask.deployment_required)) {
      errors.push(`REQUESTED_MODE_ESCALATION:${subtask.subtask_id}`);
    }
    if (subtask.deployment_required && plan.approval_context.deployment_approved !== true) {
      errors.push(`DEPLOYMENT_APPROVAL_REQUIRED:${subtask.subtask_id}`);
    }
  }

  for (const subtask of plan.subtasks) {
    for (const dependency of subtask.dependencies) {
      if (!ids.has(dependency)) errors.push(`MISSING_DEPENDENCY:${subtask.subtask_id}:${dependency}`);
      if (dependency === subtask.subtask_id) errors.push(`CYCLIC_DEPENDENCY:${subtask.subtask_id}`);
    }
  }
  const cycle = findDependencyCycle(plan.subtasks);
  if (cycle) errors.push(`CYCLIC_DAG:${cycle.join("->")}`);

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}
