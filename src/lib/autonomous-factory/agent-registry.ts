import {
  PROJECT_DIRECTOR_AGENT_DEFINITIONS,
  type ProjectDirectorAgentRole,
} from "../project-director-agents.ts";
import type {
  AgentCapability,
  CanonicalAgentId,
} from "../openclaw/capability-gateway.ts";

export interface AutonomousFactoryAgentDefinition {
  role: ProjectDirectorAgentRole;
  display_name: string;
  responsibility: string;
  planning_agent: CanonicalAgentId;
  runtime_executor: "codex_agent";
  capabilities: AgentCapability[];
  human_gate: "final_review" | "production_approval";
}

const ROLE_RUNTIME: Record<
  ProjectDirectorAgentRole,
  Pick<
    AutonomousFactoryAgentDefinition,
    "planning_agent" | "runtime_executor" | "capabilities" | "human_gate"
  >
> = {
  project_director: {
    planning_agent: "product_agent",
    runtime_executor: "codex_agent",
    capabilities: ["product_reasoning", "requirement_analysis"],
    human_gate: "final_review",
  },
  product_manager: {
    planning_agent: "product_agent",
    runtime_executor: "codex_agent",
    capabilities: ["product_reasoning", "requirement_analysis"],
    human_gate: "final_review",
  },
  ui_designer: {
    planning_agent: "documentation_agent",
    runtime_executor: "codex_agent",
    capabilities: ["documentation", "code_read"],
    human_gate: "final_review",
  },
  interaction_designer: {
    planning_agent: "product_agent",
    runtime_executor: "codex_agent",
    capabilities: ["product_reasoning", "requirement_analysis"],
    human_gate: "final_review",
  },
  frontend_developer: {
    planning_agent: "codex_agent",
    runtime_executor: "codex_agent",
    capabilities: ["code_read", "code_edit", "test", "refactor"],
    human_gate: "final_review",
  },
  backend_developer: {
    planning_agent: "codex_agent",
    runtime_executor: "codex_agent",
    capabilities: ["code_read", "code_edit", "test", "refactor"],
    human_gate: "final_review",
  },
  testing_engineer: {
    planning_agent: "test_agent",
    runtime_executor: "codex_agent",
    capabilities: ["test", "validation"],
    human_gate: "final_review",
  },
  operations_engineer: {
    planning_agent: "deployment_agent",
    runtime_executor: "codex_agent",
    capabilities: ["deployment", "health_check"],
    human_gate: "production_approval",
  },
};

export const AUTONOMOUS_FACTORY_AGENT_REGISTRY: readonly AutonomousFactoryAgentDefinition[] =
  PROJECT_DIRECTOR_AGENT_DEFINITIONS.map((definition) => ({
    role: definition.role,
    display_name: definition.display_name,
    responsibility: definition.responsibility,
    ...ROLE_RUNTIME[definition.role],
  }));

export function getAutonomousFactoryAgent(
  role: ProjectDirectorAgentRole
): AutonomousFactoryAgentDefinition {
  const definition = AUTONOMOUS_FACTORY_AGENT_REGISTRY.find((entry) => entry.role === role);
  if (!definition) throw new Error("AUTONOMOUS_FACTORY_AGENT_NOT_REGISTERED");
  return definition;
}
