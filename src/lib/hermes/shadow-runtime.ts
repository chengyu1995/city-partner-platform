import type { HermesExecutionPlan } from "./execution-plan.ts";
import {
  planApprovedRequest,
  type GMApprovedRequest,
  type HermesPlanningProvider,
} from "./orchestration-adapter.ts";
import {
  HERMES_CANONICAL_SHADOW_ENABLED_DEFAULT,
  HERMES_CANONICAL_SHADOW_ENV,
  resolveHermesShadowRuntimeConfig,
} from "./shadow-config.ts";
import type { AgentCapabilityGateway } from "../openclaw/capability-gateway.ts";

export { HERMES_CANONICAL_SHADOW_ENABLED_DEFAULT, HERMES_CANONICAL_SHADOW_ENV };

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

export interface HermesShadowArchitectureSignals {
  shadow_database_write: boolean;
  shadow_direct_worker_access: boolean;
  dual_authoritative_write: boolean;
  canonical_boundary_bypass: boolean;
}

export interface HermesShadowDifference {
  dimension:
    | "task_classification"
    | "agent_selection"
    | "execution_scope"
    | "acceptance"
    | "risk"
    | "architecture_conflict";
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
      reason: "shadow_planning_failed" | "shadow_timeout";
      error_code: "HERMES_SHADOW_PLANNING_FAILED" | "HERMES_SHADOW_TIMEOUT";
      shadow_error: "planning_failed" | "timeout";
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

export interface HermesShadowLaunchResult {
  scheduled: boolean;
  correlation_id: string;
  source_request_id: string;
  reason: "shadow_scheduled" | "shadow_disabled" | "canonical_authoritative_enabled" | "shadow_schedule_failed";
  authoritative_execution: false;
}

export type HermesShadowTaskScheduler = (task: () => Promise<void>) => void;

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

const SAFE_ARCHITECTURE_SIGNALS: HermesShadowArchitectureSignals = Object.freeze({
  shadow_database_write: false,
  shadow_direct_worker_access: false,
  dual_authoritative_write: false,
  canonical_boundary_bypass: false,
});

const SEVERITY_RANK: Record<HermesShadowDifferenceSeverity, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

const MAX_COMPLETED_OBSERVATIONS = 1_000;
const completedObservations = new Map<string, HermesShadowObservation>();

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

function rememberCompletedObservation(requestId: string, observation: HermesShadowObservation): void {
  completedObservations.set(requestId, observation);
  while (completedObservations.size > MAX_COMPLETED_OBSERVATIONS) {
    const oldest = completedObservations.keys().next().value;
    if (typeof oldest !== "string") break;
    completedObservations.delete(oldest);
  }
}

function architectureConflicts(signals: HermesShadowArchitectureSignals): string[] {
  return Object.entries(signals)
    .filter(([, active]) => active)
    .map(([name]) => name)
    .sort();
}

export function isHermesCanonicalShadowEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return resolveHermesShadowRuntimeConfig(env).shadow_enabled;
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
  plan: HermesExecutionPlan,
  architectureSignals: HermesShadowArchitectureSignals = SAFE_ARCHITECTURE_SIGNALS
): HermesShadowComparisonReport {
  const canonicalPlan = buildCanonicalShadowPlan(plan);
  const differences: HermesShadowDifference[] = [];
  addDifference(differences, "task_classification", "MEDIUM", legacyPlan.task_types, canonicalPlan.required_capabilities);
  addDifference(differences, "agent_selection", "MEDIUM", legacyPlan.selected_agents, canonicalPlan.selected_agents);
  addDifference(
    differences,
    "execution_scope",
    "MEDIUM",
    [...legacyPlan.execution_modes, ...legacyPlan.allowed_paths, ...legacyPlan.forbidden_paths],
    [...canonicalPlan.execution_intents, ...canonicalPlan.allowed_paths, ...canonicalPlan.forbidden_paths]
  );
  addDifference(differences, "acceptance", "LOW", legacyPlan.acceptance_criteria, canonicalPlan.acceptance_criteria);
  addDifference(differences, "risk", "MEDIUM", legacyPlan.risk_levels, canonicalPlan.risk_levels);
  const conflicts = architectureConflicts(architectureSignals);
  if (conflicts.length) {
    differences.push({
      dimension: "architecture_conflict",
      severity: "HIGH",
      legacy: ["authoritative_boundary_safe"],
      canonical: conflicts,
    });
  }

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
  const config = resolveHermesShadowRuntimeConfig(input.env ?? process.env);
  if (!config.shadow_enabled) {
    const reason = config.canonical_orchestration_enabled || config.configuration_conflict
      ? "canonical_authoritative_enabled"
      : "shadow_disabled";
    return { observed: false, reason, plan: null, report: null, safety: SHADOW_SAFETY_BOUNDARY };
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("HERMES_SHADOW_TIMEOUT"));
    }, config.shadow_timeout_ms);
  });

  try {
    const plan = await Promise.race([
      planApprovedRequest(input.request, input.planner, input.capability_gateway, { signal: controller.signal }),
      timeout,
    ]);
    return {
      observed: true,
      reason: "shadow_comparison_created",
      plan,
      report: compareLegacyAndCanonicalPlans(input.legacy_plan, plan),
      safety: SHADOW_SAFETY_BOUNDARY,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "HERMES_SHADOW_TIMEOUT";
    return {
      observed: false,
      reason: timedOut ? "shadow_timeout" : "shadow_planning_failed",
      error_code: timedOut ? "HERMES_SHADOW_TIMEOUT" : "HERMES_SHADOW_PLANNING_FAILED",
      shadow_error: timedOut ? "timeout" : "planning_failed",
      plan: null,
      report: null,
      safety: SHADOW_SAFETY_BOUNDARY,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function scheduleApprovedRequestInHermesShadow(input: {
  request: GMApprovedRequest;
  legacy_plan: LegacyShadowPlan;
  planner: HermesPlanningProvider;
  capability_gateway: AgentCapabilityGateway;
  scheduler: HermesShadowTaskScheduler;
  env?: Record<string, string | undefined>;
}): HermesShadowLaunchResult {
  const config = resolveHermesShadowRuntimeConfig(input.env ?? process.env);
  const correlationId = `hermes-shadow:${input.request.request_id}`;
  if (!config.shadow_enabled) {
    return {
      scheduled: false,
      correlation_id: correlationId,
      source_request_id: input.request.request_id,
      reason: config.canonical_orchestration_enabled || config.configuration_conflict
        ? "canonical_authoritative_enabled"
        : "shadow_disabled",
      authoritative_execution: false,
    };
  }

  try {
    input.scheduler(async () => {
      const observation = await observeApprovedRequestInHermesShadow(input);
      rememberCompletedObservation(input.request.request_id, observation);
    });
    return {
      scheduled: true,
      correlation_id: correlationId,
      source_request_id: input.request.request_id,
      reason: "shadow_scheduled",
      authoritative_execution: false,
    };
  } catch {
    return {
      scheduled: false,
      correlation_id: correlationId,
      source_request_id: input.request.request_id,
      reason: "shadow_schedule_failed",
      authoritative_execution: false,
    };
  }
}

export function getCompletedHermesShadowObservation(requestId: string): HermesShadowObservation | null {
  return completedObservations.get(requestId) ?? null;
}

export function clearHermesShadowObservationCacheForTests(): void {
  completedObservations.clear();
}
