import {
  isHermesCanonicalOrchestrationEnabled,
  planApprovedRequest,
  type GMApprovedRequest,
  type HermesPlanningProvider,
} from "./hermes/orchestration-adapter.ts";
import type { AgentCapabilityGateway } from "./openclaw/capability-gateway.ts";
import type { HermesExecutionPlan } from "./hermes/execution-plan.ts";

export type GMHermesDelegationResult =
  | { delegated: false; reason: "feature_disabled"; plan: null }
  | { delegated: true; reason: "canonical_plan_created"; plan: HermesExecutionPlan };

export async function delegateApprovedRequestToHermes(
  request: GMApprovedRequest,
  planner: HermesPlanningProvider,
  capabilityGateway: AgentCapabilityGateway,
  env: Record<string, string | undefined> = process.env
): Promise<GMHermesDelegationResult> {
  if (!isHermesCanonicalOrchestrationEnabled(env)) {
    return { delegated: false, reason: "feature_disabled", plan: null };
  }
  const plan = await planApprovedRequest(request, planner, capabilityGateway);
  return { delegated: true, reason: "canonical_plan_created", plan };
}
