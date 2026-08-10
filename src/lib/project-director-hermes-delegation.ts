import {
  isHermesCanonicalOrchestrationEnabled,
  planApprovedRequest,
  createCanonicalJobsForPlan,
  type CanonicalJobCreator,
  type GMApprovedRequest,
  type HermesPlanningProvider,
} from "./hermes/orchestration-adapter.ts";
import type { AgentCapabilityGateway } from "./openclaw/capability-gateway.ts";
import type { HermesExecutionPlan } from "./hermes/execution-plan.ts";
import {
  requireAllowedCanonicalCanaryAdmission,
  type CanonicalCanaryAdmissionDecision,
} from "./hermes/canonical-canary-scope.ts";
import {
  scheduleApprovedRequestInHermesShadow,
  type HermesShadowLaunchResult,
  type HermesShadowTaskScheduler,
  type LegacyShadowPlan,
} from "./hermes/shadow-runtime.ts";

export type GMHermesDelegationResult =
  | { delegated: false; reason: "feature_disabled"; plan: null }
  | { delegated: false; reason: "canary_admission_denied"; plan: null }
  | { delegated: true; reason: "canonical_plan_created"; plan: HermesExecutionPlan };

export interface GMHermesRuntimeResult {
  delegated: true;
  reason: "canonical_jobs_created";
  plan: HermesExecutionPlan;
  jobs: unknown[];
}

export async function delegateApprovedRequestToHermes(
  request: GMApprovedRequest,
  planner: HermesPlanningProvider,
  capabilityGateway: AgentCapabilityGateway,
  env: Record<string, string | undefined> = process.env,
  canaryAdmission?: CanonicalCanaryAdmissionDecision
): Promise<GMHermesDelegationResult> {
  if (!isHermesCanonicalOrchestrationEnabled(env)) {
    return { delegated: false, reason: "feature_disabled", plan: null };
  }
  if (!canaryAdmission?.allowed) {
    return { delegated: false, reason: "canary_admission_denied", plan: null };
  }
  const plan = await planApprovedRequest(request, planner, capabilityGateway);
  return { delegated: true, reason: "canonical_plan_created", plan };
}

export async function runApprovedRequestThroughCanonicalHermes(
  request: GMApprovedRequest,
  planner: HermesPlanningProvider,
  capabilityGateway: AgentCapabilityGateway,
  canonicalCreateJob: CanonicalJobCreator,
  options: {
    env?: Record<string, string | undefined>;
    canonicalPersistenceReady: boolean;
    canaryAdmission: CanonicalCanaryAdmissionDecision;
  }
): Promise<GMHermesRuntimeResult | GMHermesDelegationResult> {
  const env = options.env ?? process.env;
  if (!isHermesCanonicalOrchestrationEnabled(env)) {
    return { delegated: false, reason: "feature_disabled", plan: null };
  }
  if (!options.canonicalPersistenceReady) {
    throw new Error("CANONICAL_PERSISTENCE_RUNTIME_REQUIRED");
  }
  const admission = requireAllowedCanonicalCanaryAdmission(options.canaryAdmission);

  const plan = await planApprovedRequest(request, planner, capabilityGateway);
  const jobs = await createCanonicalJobsForPlan(plan, canonicalCreateJob, admission);
  return { delegated: true, reason: "canonical_jobs_created", plan, jobs };
}

export function scheduleApprovedRequestThroughHermesShadow(
  request: GMApprovedRequest,
  legacyPlan: LegacyShadowPlan,
  planner: HermesPlanningProvider,
  capabilityGateway: AgentCapabilityGateway,
  scheduler: HermesShadowTaskScheduler,
  env: Record<string, string | undefined> = process.env
): HermesShadowLaunchResult {
  return scheduleApprovedRequestInHermesShadow({
    request,
    legacy_plan: legacyPlan,
    planner,
    capability_gateway: capabilityGateway,
    scheduler,
    env,
  });
}

export function canonicalHermesAllowsDirectWorkerBypass(input: {
  featureEnabled: boolean;
  explicitMaintenanceOperation: boolean;
}): boolean {
  return !input.featureEnabled || input.explicitMaintenanceOperation;
}
