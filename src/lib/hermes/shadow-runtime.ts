import type { HermesExecutionPlan } from "./execution-plan.ts";
import {
  isHermesCanonicalOrchestrationEnabled,
  planApprovedRequest,
  type GMApprovedRequest,
  type HermesPlanningProvider,
} from "./orchestration-adapter.ts";
import type { AgentCapabilityGateway } from "../openclaw/capability-gateway.ts";

export const HERMES_CANONICAL_SHADOW_ENABLED_DEFAULT = false;
export const HERMES_CANONICAL_SHADOW_ENV = "HERMES_CANONICAL_SHADOW_ENABLED";

export type HermesShadowDifferenceSeverity = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export interface LegacyShadowTask {
  task_type: string;
  selected_agent: string;
  execution_mode: string;
  allowed_paths: string[];
  forbidden_paths: string[];
  acceptance_criteria: string[];
  risk_level: string;
}

export interface LegacyShadowPlan {
  request_id: string;
  task_types: string[];
  selected_agents: string[];
  execution_modes: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  acceptance_criteria: string[];
  risk_levels: string[];
}

export interface CanonicalShadowPlan {
  plan_id: string;
  required_capabilities: string[];
  selected_agents: string[];
  execution_intents: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  acceptance_criteria: string[];
  risk_levels: string[];
}

export interface HermesShadowDifference {
  dimension: "task_classification" | "agent_selection" | "execution_scope" | "acceptance" | "risk";
  severity: Exclude<HermesShadowDifferenceSeverity, "NONE">;
  legacy: string[];
  canonical: string[];
}

export interface HermesShadowComparisonReport {
  comparison_id: string;
  request_id: string;
  shadow_plan_id: string;
  source_request_id: string;
  legacy_path: "legacy_runtime";
  canonical_path: "hermes_canonical_shadow";
  legacy_plan: LegacyShadowPlan;
  canonical_plan: CanonicalShadowPlan;
  differences: HermesShadowDifference[];
  difference_count: number;
  severity: HermesShadowDifferenceSeverity;
  recommendation: string;
}

export interface HermesShadowSafetyBoundary {
  projection_only: true;
  authoritative_execution: false;
  real_job_created: false;
  attempt_created: false;
  lease_created: false;
  terminal_created: false;
  direct_worker_access: false;
  database_write: false;
  state_machine_created: false;
}

export type HermesShadowObservation =
  | {
      observed: false;
      reason: "shadow_disabled" | "canonical_authoritative_enabled";
      plan: null;
      report: null;
      safety: HermesShadowSafetyBoundary;
    }
  | {
      observed: false;
      reason: "shadow_planning_failed";
      error_code: "HERMES_SHADOW_PLANNING_FAILED";
      plan: null;
      report: null;
      safety: HermesShadowSafetyBoundary;
    }
  | {
      observed: true;
      reason: "shadow_comparison_created";
      plan: HermesExecutionPlan;
      report: HermesShadowComparisonReport;
      safety: HermesShadowSafetyBoundary;
    };

const SHADOW_SAFETY_BOUNDARY: HermesShadowSafetyBoundary = Object.freeze({
  projection_only: true,
  authoritative_execution: false,
  real_job_created: false,
  attempt_created: false,
  lease_created: false,
  terminal_created: false,
  direct_worker_access: false,
  database_write: false,
  state_machine_created: false,
});

const SEVERITY_RANK: Record<HermesShadowDifferenceSeverity, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

function normalizeValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function valuesMatch(left: string[], right: string[]): boolean {
  return JSON.stringify(normalizeValues(left)) === JSON.stringify(normalizeValues(right));
}

function inferCanonicalRisk(plan: HermesExecutionPlan): string[] {
  return normalizeValues(plan.subtasks.map((subtask) => {
    if (subtask.deployment_required) return "critical";
    if (subtask.git_push_required) return "high";
    if (subtask.git_commit_required || subtask.required_capabilities.includes("code_edit")) return "medium";
    return "low";
  }));
}

function highestSeverity(differences: HermesShadowDifference[]): HermesShadowDifferenceSeverity {
  return differences.reduce<HermesShadowDifferenceSeverity>(
    (current, difference) => SEVERITY_RANK[difference.severity] > SEVERITY_RANK[current]
      ? difference.severity
      : current,
    "NONE"
  );
}

function addDifference(
  differences: HermesShadowDifference[],
  dimension: HermesShadowDifference["dimension"],
  severity: HermesShadowDifference["severity"],
  legacy: string[],
  canonical: string[]
): void {
  if (valuesMatch(legacy, canonical)) return;
  differences.push({
    dimension,
    severity,
    legacy: normalizeValues(legacy),
    canonical: normalizeValues(canonical),
  });
}

export function isHermesCanonicalShadowEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[HERMES_CANONICAL_SHADOW_ENV]?.trim().toLowerCase() === "true";
}

export function buildLegacyShadowPlan(requestId: string, tasks: LegacyShadowTask[]): LegacyShadowPlan {
  return {
    request_id: requestId,
    task_types: normalizeValues(tasks.map((task) => task.task_type)),
    selected_agents: normalizeValues(tasks.map((task) => task.selected_agent)),
    execution_modes: normalizeValues(tasks.map((task) => task.execution_mode)),
    allowed_paths: normalizeValues(tasks.flatMap((task) => task.allowed_paths)),
    forbidden_paths: normalizeValues(tasks.flatMap((task) => task.forbidden_paths)),
    acceptance_criteria: normalizeValues(tasks.flatMap((task) => task.acceptance_criteria)),
    risk_levels: normalizeValues(tasks.map((task) => task.risk_level)),
  };
}

export function buildCanonicalShadowPlan(plan: HermesExecutionPlan): CanonicalShadowPlan {
  return {
    plan_id: plan.plan_id,
    required_capabilities: normalizeValues(plan.subtasks.flatMap((subtask) => subtask.required_capabilities)),
    selected_agents: normalizeValues(plan.subtasks.map((subtask) => subtask.recommended_agent)),
    execution_intents: normalizeValues(plan.subtasks.map((subtask) => subtask.execution_intent)),
    allowed_paths: normalizeValues(plan.subtasks.flatMap((subtask) => subtask.allowed_paths)),
    forbidden_paths: normalizeValues(plan.subtasks.flatMap((subtask) => subtask.forbidden_paths)),
    acceptance_criteria: normalizeValues(plan.subtasks.flatMap((subtask) => subtask.acceptance_criteria)),
    risk_levels: inferCanonicalRisk(plan),
  };
}

export function compareLegacyAndCanonicalPlans(
  legacyPlan: LegacyShadowPlan,
  plan: HermesExecutionPlan
): HermesShadowComparisonReport {
  const canonicalPlan = buildCanonicalShadowPlan(plan);
  const differences: HermesShadowDifference[] = [];
  addDifference(differences, "task_classification", "MEDIUM", legacyPlan.task_types, canonicalPlan.required_capabilities);
  addDifference(differences, "agent_selection", "MEDIUM", legacyPlan.selected_agents, canonicalPlan.selected_agents);
  addDifference(
    differences,
    "execution_scope",
    "HIGH",
    [...legacyPlan.execution_modes, ...legacyPlan.allowed_paths, ...legacyPlan.forbidden_paths],
    [...canonicalPlan.execution_intents, ...canonicalPlan.allowed_paths, ...canonicalPlan.forbidden_paths]
  );
  addDifference(differences, "acceptance", "LOW", legacyPlan.acceptance_criteria, canonicalPlan.acceptance_criteria);
  addDifference(differences, "risk", "HIGH", legacyPlan.risk_levels, canonicalPlan.risk_levels);

  const severity = highestSeverity(differences);
  return {
    comparison_id: `shadow-comparison:${legacyPlan.request_id}:${plan.plan_hash.slice(0, 16)}`,
    request_id: legacyPlan.request_id,
    shadow_plan_id: plan.plan_id,
    source_request_id: legacyPlan.request_id,
    legacy_path: "legacy_runtime",
    canonical_path: "hermes_canonical_shadow",
    legacy_plan: legacyPlan,
    canonical_plan: canonicalPlan,
    differences,
    difference_count: differences.length,
    severity,
    recommendation: severity === "NONE"
      ? "No shadow differences detected. Continue bounded observation."
      : `Review ${differences.length} shadow difference(s) before any production cutover.`,
  };
}

export async function observeApprovedRequestInHermesShadow(input: {
  request: GMApprovedRequest;
  legacy_plan: LegacyShadowPlan;
  planner: HermesPlanningProvider;
  capability_gateway: AgentCapabilityGateway;
  env?: Record<string, string | undefined>;
}): Promise<HermesShadowObservation> {
  const env = input.env ?? process.env;
  if (!isHermesCanonicalShadowEnabled(env)) {
    return { observed: false, reason: "shadow_disabled", plan: null, report: null, safety: SHADOW_SAFETY_BOUNDARY };
  }
  if (isHermesCanonicalOrchestrationEnabled(env)) {
    return {
      observed: false,
      reason: "canonical_authoritative_enabled",
      plan: null,
      report: null,
      safety: SHADOW_SAFETY_BOUNDARY,
    };
  }

  try {
    const plan = await planApprovedRequest(input.request, input.planner, input.capability_gateway);
    return {
      observed: true,
      reason: "shadow_comparison_created",
      plan,
      report: compareLegacyAndCanonicalPlans(input.legacy_plan, plan),
      safety: SHADOW_SAFETY_BOUNDARY,
    };
  } catch {
    return {
      observed: false,
      reason: "shadow_planning_failed",
      error_code: "HERMES_SHADOW_PLANNING_FAILED",
      plan: null,
      report: null,
      safety: SHADOW_SAFETY_BOUNDARY,
    };
  }
}
