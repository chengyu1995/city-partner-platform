import type { HermesRequestedMode } from "../hermes/execution-plan.ts";

export const OPENCLAW_CAPABILITY_GATEWAY_ENABLED_DEFAULT = false;
export const OPENCLAW_CAPABILITY_GATEWAY_ENV = "OPENCLAW_CAPABILITY_GATEWAY_ENABLED";

export type AgentCapability =
  | "code_read"
  | "code_edit"
  | "test"
  | "refactor"
  | "code_review"
  | "log_analysis"
  | "diagnosis"
  | "validation"
  | "documentation"
  | "product_reasoning"
  | "requirement_analysis"
  | "research"
  | "synthesis"
  | "deployment"
  | "health_check";

export type CanonicalAgentId =
  | "codex_agent"
  | "code_review_agent"
  | "bug_triage_agent"
  | "test_agent"
  | "documentation_agent"
  | "product_agent"
  | "research_agent"
  | "deployment_agent";

export interface AgentCapabilityDefinition {
  agent: CanonicalAgentId;
  provider: string;
  model: string | null;
  capabilities: AgentCapability[];
}

export interface CapabilityResolutionRequest {
  required_capabilities: string[];
  execution_intent: string;
  requested_mode: HermesRequestedMode;
}

export interface CapabilityResolution {
  selected_agent: CanonicalAgentId;
  provider: string;
  model: string | null;
  capabilities: AgentCapability[];
  confidence: number;
  reason: string;
}

export interface AgentCapabilityGateway {
  resolveAgentCapabilities(request: CapabilityResolutionRequest): Promise<CapabilityResolution>;
}

export const AGENT_CAPABILITY_REGISTRY: readonly AgentCapabilityDefinition[] = [
  { agent: "codex_agent", provider: "openai", model: "codex", capabilities: ["code_read", "code_edit", "test", "refactor"] },
  { agent: "code_review_agent", provider: "registry", model: null, capabilities: ["code_read", "code_review"] },
  { agent: "bug_triage_agent", provider: "registry", model: null, capabilities: ["code_read", "log_analysis", "diagnosis"] },
  { agent: "test_agent", provider: "registry", model: null, capabilities: ["test", "validation"] },
  { agent: "documentation_agent", provider: "registry", model: null, capabilities: ["documentation", "code_read"] },
  { agent: "product_agent", provider: "registry", model: null, capabilities: ["product_reasoning", "requirement_analysis"] },
  { agent: "research_agent", provider: "registry", model: null, capabilities: ["research", "synthesis"] },
  { agent: "deployment_agent", provider: "registry", model: null, capabilities: ["deployment", "health_check"] },
] as const;

const KNOWN_CAPABILITIES = new Set(AGENT_CAPABILITY_REGISTRY.flatMap((entry) => entry.capabilities));

export function isOpenClawCapabilityGatewayEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[OPENCLAW_CAPABILITY_GATEWAY_ENV]?.trim().toLowerCase() === "true";
}

function normalizeCapabilities(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function resolveAgentCapabilities(request: CapabilityResolutionRequest): CapabilityResolution {
  const required = normalizeCapabilities(request.required_capabilities);
  if (!required.length) throw new Error("AGENT_CAPABILITIES_REQUIRED");
  const unknown = required.filter((capability) => !KNOWN_CAPABILITIES.has(capability as AgentCapability));
  if (unknown.length) throw new Error(`UNKNOWN_AGENT_CAPABILITY:${unknown.join(",")}`);
  if (required.includes("deployment") && request.requested_mode !== "write_allowed") {
    throw new Error("DEPLOYMENT_CAPABILITY_MODE_FORBIDDEN");
  }

  const candidates = AGENT_CAPABILITY_REGISTRY
    .filter((entry) => required.every((capability) => entry.capabilities.includes(capability as AgentCapability)))
    .sort((left, right) => left.capabilities.length - right.capabilities.length);
  const selected = candidates[0];
  if (!selected) throw new Error(`NO_AGENT_FOR_CAPABILITIES:${required.join(",")}`);

  return {
    selected_agent: selected.agent,
    provider: selected.provider,
    model: selected.model,
    capabilities: [...selected.capabilities],
    confidence: 1,
    reason: `deterministic_registry_match:${required.join("+")}:${request.execution_intent}`,
  };
}

export class RegistryCapabilityGateway implements AgentCapabilityGateway {
  async resolveAgentCapabilities(request: CapabilityResolutionRequest): Promise<CapabilityResolution> {
    return resolveAgentCapabilities(request);
  }
}

export class DisabledOpenClawCliGateway implements AgentCapabilityGateway {
  async resolveAgentCapabilities(): Promise<CapabilityResolution> {
    throw new Error("OPENCLAW_CAPABILITY_GATEWAY_DISABLED");
  }
}
