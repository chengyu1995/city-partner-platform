import { createHash, timingSafeEqual } from "node:crypto";

import { buildProjectDirectorTaskTreeDraft } from "../project-director-task-tree.ts";
import {
  buildAutonomousFactoryPlannedTasks,
  readAutonomousFactoryMode,
  type AutonomousFactoryRpcClient,
  type AutonomousFactoryIntakeContext,
} from "./control-plane.ts";

export const AUTONOMOUS_FACTORY_CANARY_TOKEN_ENV =
  "HERMES_AUTONOMOUS_FACTORY_CANARY_TOKEN";
export const AUTONOMOUS_FACTORY_CANARY_SUPABASE_SECRET_ENV =
  "HERMES_AUTONOMOUS_FACTORY_SUPABASE_SECRET_KEY";
export const PREVIEW_SHADOW_CANARY_ID = "preview-shadow-planning-canary-v1";
export const PREVIEW_SHADOW_CANARY_BRANCH = "codex/g2-autonomous-foundation";
export const PREVIEW_SHADOW_CANARY_READBACK_RPC =
  "hermes_v2_read_preview_shadow_canary_v1";

export type PreviewShadowCanaryFailureCode =
  | "AUTONOMOUS_FACTORY_CANARY_PREVIEW_ONLY"
  | "AUTONOMOUS_FACTORY_CANARY_MODE_INVALID"
  | "AUTONOMOUS_FACTORY_CANARY_SHADOW_REQUIRED"
  | "AUTONOMOUS_FACTORY_CANARY_TOKEN_MISSING"
  | "AUTONOMOUS_FACTORY_CANARY_BRANCH_MISMATCH"
  | "AUTONOMOUS_FACTORY_CANARY_COMMIT_INVALID";

export type PreviewShadowCanaryRuntime =
  | {
      ok: true;
      commit_sha: string;
    }
  | {
      ok: false;
      status: 403 | 503;
      failure_code: PreviewShadowCanaryFailureCode;
    };

export interface PreviewShadowCanaryTaskRow {
  id: string;
  parent_task_id: string | null;
  task_type: string;
  role: string;
  title: string;
  status: string;
  stage: string;
  risk_level: string;
  need_human_decision: boolean;
  dependency_task_ids: unknown;
  metadata: unknown;
}

export interface PreviewShadowCanaryRootRow {
  id: string;
  parent_task_id: string | null;
  task_type: string;
  role: string;
  status: string;
  stage: string;
  metadata: unknown;
}

export interface PreviewShadowCanaryDecisionRow {
  decision_type: string;
  decision_status: string;
  external_channel: string;
  metadata: unknown;
}

export interface PreviewShadowCanaryEventRow {
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  payload: unknown;
}

export interface PreviewShadowCanaryDatabaseConfig {
  url: string;
  secretKey: string;
}

export interface PreviewShadowCanaryReadback {
  scope_input_valid: true;
  root: PreviewShadowCanaryRootRow | null;
  tasks: PreviewShadowCanaryTaskRow[];
  decisions: PreviewShadowCanaryDecisionRow[];
  events: PreviewShadowCanaryEventRow[];
}

export type PreviewShadowCanaryReadbackResult =
  | { ok: true; snapshot: PreviewShadowCanaryReadback }
  | {
      ok: false;
      error_code: "AUTONOMOUS_FACTORY_CANARY_READBACK_FAILED";
      database_code: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRootRow(value: unknown): value is PreviewShadowCanaryRootRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    isNullableString(value.parent_task_id) &&
    typeof value.task_type === "string" &&
    typeof value.role === "string" &&
    typeof value.status === "string" &&
    typeof value.stage === "string" &&
    isRecord(value.metadata)
  );
}

function isTaskRow(value: unknown): value is PreviewShadowCanaryTaskRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    isNullableString(value.parent_task_id) &&
    typeof value.task_type === "string" &&
    typeof value.role === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    typeof value.stage === "string" &&
    typeof value.risk_level === "string" &&
    typeof value.need_human_decision === "boolean" &&
    Array.isArray(value.dependency_task_ids) &&
    value.dependency_task_ids.every((item) => typeof item === "string") &&
    isRecord(value.metadata)
  );
}

function isDecisionRow(value: unknown): value is PreviewShadowCanaryDecisionRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.decision_type === "string" &&
    typeof value.decision_status === "string" &&
    typeof value.external_channel === "string" &&
    isRecord(value.metadata)
  );
}

function isEventRow(value: unknown): value is PreviewShadowCanaryEventRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.event_type === "string" &&
    isNullableString(value.from_status) &&
    isNullableString(value.to_status) &&
    isRecord(value.payload)
  );
}

function parsePreviewShadowCanaryReadback(data: unknown): PreviewShadowCanaryReadback | null {
  const value = Array.isArray(data) && data.length === 1 ? data[0] : data;
  if (!isRecord(value) || value.scope_input_valid !== true) return null;
  if (value.root !== null && !isRootRow(value.root)) return null;
  if (!Array.isArray(value.tasks) || !value.tasks.every(isTaskRow)) return null;
  if (!Array.isArray(value.decisions) || !value.decisions.every(isDecisionRow)) return null;
  if (!Array.isArray(value.events) || !value.events.every(isEventRow)) return null;
  return value as unknown as PreviewShadowCanaryReadback;
}

function safeDatabaseCode(error: unknown): string {
  if (!isRecord(error) || typeof error.code !== "string") return "unknown";
  return /^[a-z0-9_]{1,32}$/i.test(error.code) ? error.code : "unknown";
}

export async function readPreviewShadowCanarySnapshot(input: {
  client: AutonomousFactoryRpcClient;
  sourceExternalId: string;
}): Promise<PreviewShadowCanaryReadbackResult> {
  try {
    const result = await input.client.rpc(PREVIEW_SHADOW_CANARY_READBACK_RPC, {
      p_source_external_id: input.sourceExternalId,
    });
    if (result.error) {
      return {
        ok: false,
        error_code: "AUTONOMOUS_FACTORY_CANARY_READBACK_FAILED",
        database_code: safeDatabaseCode(result.error),
      };
    }
    const snapshot = parsePreviewShadowCanaryReadback(result.data);
    if (!snapshot) {
      return {
        ok: false,
        error_code: "AUTONOMOUS_FACTORY_CANARY_READBACK_FAILED",
        database_code: "invalid_payload",
      };
    }
    return { ok: true, snapshot };
  } catch {
    return {
      ok: false,
      error_code: "AUTONOMOUS_FACTORY_CANARY_READBACK_FAILED",
      database_code: "unknown",
    };
  }
}

export function readPreviewShadowCanaryRuntime(
  env: Record<string, string | undefined> = process.env
): PreviewShadowCanaryRuntime {
  if (env.VERCEL_ENV !== "preview") {
    return {
      ok: false,
      status: 403,
      failure_code: "AUTONOMOUS_FACTORY_CANARY_PREVIEW_ONLY",
    };
  }

  let mode: ReturnType<typeof readAutonomousFactoryMode>;
  try {
    mode = readAutonomousFactoryMode(env);
  } catch {
    return {
      ok: false,
      status: 503,
      failure_code: "AUTONOMOUS_FACTORY_CANARY_MODE_INVALID",
    };
  }
  if (mode !== "shadow") {
    return {
      ok: false,
      status: 503,
      failure_code: "AUTONOMOUS_FACTORY_CANARY_SHADOW_REQUIRED",
    };
  }

  const token = env[AUTONOMOUS_FACTORY_CANARY_TOKEN_ENV] ?? "";
  if (token.length < 32) {
    return {
      ok: false,
      status: 503,
      failure_code: "AUTONOMOUS_FACTORY_CANARY_TOKEN_MISSING",
    };
  }

  if (env.VERCEL_GIT_COMMIT_REF !== PREVIEW_SHADOW_CANARY_BRANCH) {
    return {
      ok: false,
      status: 403,
      failure_code: "AUTONOMOUS_FACTORY_CANARY_BRANCH_MISMATCH",
    };
  }

  const commitSha = env.VERCEL_GIT_COMMIT_SHA ?? "";
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    return {
      ok: false,
      status: 503,
      failure_code: "AUTONOMOUS_FACTORY_CANARY_COMMIT_INVALID",
    };
  }

  return { ok: true, commit_sha: commitSha.toLowerCase() };
}

export function isPreviewShadowCanaryAuthorized(
  authorization: string | null,
  env: Record<string, string | undefined> = process.env
): boolean {
  const expectedToken = env[AUTONOMOUS_FACTORY_CANARY_TOKEN_ENV] ?? "";
  if (expectedToken.length < 32) return false;
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const candidate = authorization.slice(prefix.length);
  if (!candidate || candidate !== candidate.trim()) return false;
  return timingSafeEqual(digest(candidate), digest(expectedToken));
}

export function readPreviewShadowCanaryDatabaseConfig(
  env: Record<string, string | undefined> = process.env
): PreviewShadowCanaryDatabaseConfig | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const secretKey = env[AUTONOMOUS_FACTORY_CANARY_SUPABASE_SECRET_ENV]?.trim() ?? "";
  if (!url || secretKey.length < 32) return null;
  return { url, secretKey };
}

export function buildPreviewShadowCanary(commitSha: string) {
  const revision = commitSha.toLowerCase();
  const demand = [
    "Build a static preview-only planning sample for a fictional neighborhood book club.",
    `Candidate revision: ${revision}.`,
    "Do not deploy, send external messages, create worker jobs, or change production.",
  ].join(" ");
  const draft = buildProjectDirectorTaskTreeDraft(demand, "Preview shadow canary", "planning_only");
  const context: AutonomousFactoryIntakeContext = {
    projectKey: "city-partner-platform",
    projectName: "City Partner Platform",
    conversationId: PREVIEW_SHADOW_CANARY_ID,
    demandKind: "website_product_request",
    eventId: `${PREVIEW_SHADOW_CANARY_ID}:${revision}`,
    messageId: `${PREVIEW_SHADOW_CANARY_ID}:${revision}`,
    chatId: "synthetic-preview-only",
    userId: "synthetic-preview-canary",
  };

  return {
    canary_id: PREVIEW_SHADOW_CANARY_ID,
    draft,
    context,
    planned_tasks: buildAutonomousFactoryPlannedTasks(draft),
  };
}

export function comparePreviewShadowCanary(input: {
  rootTaskId: string;
  canary: ReturnType<typeof buildPreviewShadowCanary>;
  root: PreviewShadowCanaryRootRow | null;
  tasks: PreviewShadowCanaryTaskRow[];
  decisions: PreviewShadowCanaryDecisionRow[];
  events: PreviewShadowCanaryEventRow[];
}) {
  const mismatches: string[] = [];
  const expectedTasks = input.canary.planned_tasks;
  const rootMetadata = recordValue(input.root?.metadata);

  if (!input.root) mismatches.push("ROOT_MISSING");
  else {
    if (input.root.id !== input.rootTaskId) mismatches.push("ROOT_ID_MISMATCH");
    if (input.root.parent_task_id !== null) mismatches.push("ROOT_PARENT_MISMATCH");
    if (input.root.task_type !== "requirement") mismatches.push("ROOT_TYPE_MISMATCH");
    if (input.root.role !== "project_director") mismatches.push("ROOT_ROLE_MISMATCH");
    if (input.root.status !== "awaiting_human") mismatches.push("ROOT_STATUS_MISMATCH");
    if (input.root.stage !== "intake") mismatches.push("ROOT_STAGE_MISMATCH");
    if (rootMetadata.capture_mode !== "shadow") mismatches.push("ROOT_MODE_MISMATCH");
    if (rootMetadata.plan_id !== input.canary.draft.plan_id) mismatches.push("ROOT_PLAN_MISMATCH");
    const storedPlan = recordValue(rootMetadata.plan);
    if (storedPlan.boss_request_id !== input.canary.draft.boss_request_id) {
      mismatches.push("ROOT_BOSS_REQUEST_MISMATCH");
    }
    if (storedPlan.task_tree_id !== input.canary.draft.task_tree_id) {
      mismatches.push("ROOT_TASK_TREE_MISMATCH");
    }
    if (!equalJson(storedPlan.project, input.canary.draft.project)) {
      mismatches.push("ROOT_PROJECT_PLAN_MISMATCH");
    }
    if (storedPlan.requires_boss_approval !== input.canary.draft.requires_boss_approval) {
      mismatches.push("ROOT_APPROVAL_POLICY_MISMATCH");
    }
    if (storedPlan.execution_mode !== input.canary.draft.execution_mode) {
      mismatches.push("ROOT_EXECUTION_MODE_MISMATCH");
    }
  }

  if (input.tasks.length !== expectedTasks.length) mismatches.push("TASK_COUNT_MISMATCH");

  const actualByKey = new Map<string, PreviewShadowCanaryTaskRow>();
  const keyById = new Map<string, string>();
  for (const task of input.tasks) {
    const taskKey = recordValue(task.metadata).task_key;
    if (typeof taskKey !== "string" || actualByKey.has(taskKey)) {
      mismatches.push("TASK_KEY_INVALID");
      continue;
    }
    actualByKey.set(taskKey, task);
    keyById.set(task.id, taskKey);
  }

  for (const expected of expectedTasks) {
    const actual = actualByKey.get(expected.task_key);
    if (!actual) {
      mismatches.push(`TASK_MISSING:${expected.task_key}`);
      continue;
    }
    const metadata = recordValue(actual.metadata);
    if (actual.parent_task_id !== input.rootTaskId) mismatches.push(`TASK_PARENT:${expected.task_key}`);
    if (actual.task_type !== expected.task_type) mismatches.push(`TASK_TYPE:${expected.task_key}`);
    if (actual.role !== expected.agent_role) mismatches.push(`TASK_ROLE:${expected.task_key}`);
    if (actual.title !== expected.title) mismatches.push(`TASK_TITLE:${expected.task_key}`);
    if (actual.status !== "draft") mismatches.push(`TASK_STATUS:${expected.task_key}`);
    if (actual.stage !== expected.stage) mismatches.push(`TASK_STAGE:${expected.task_key}`);
    if (actual.risk_level !== expected.risk_level) mismatches.push(`TASK_RISK:${expected.task_key}`);
    if (actual.need_human_decision !== expected.requires_boss_approval) {
      mismatches.push(`TASK_GATE:${expected.task_key}`);
    }
    for (const field of [
      "task_key",
      "title",
      "agent_role",
      "planning_agent",
      "runtime_executor",
      "human_gate",
      "task_type",
      "stage",
      "phase",
      "risk_level",
      "can_auto_execute",
      "requires_boss_approval",
      "execution_mode",
    ] as const) {
      if (metadata[field] !== expected[field]) mismatches.push(`TASK_METADATA:${expected.task_key}:${field}`);
    }
    for (const field of [
      "capabilities",
      "allowed_files",
      "forbidden_files",
      "acceptance_criteria",
      "dependency_keys",
    ] as const) {
      if (!equalJson(metadata[field], expected[field])) {
        mismatches.push(`TASK_METADATA:${expected.task_key}:${field}`);
      }
    }
    const actualDependencies = stringArray(actual.dependency_task_ids)
      .map((id) => keyById.get(id) ?? "UNKNOWN")
      .sort();
    const expectedDependencies = [...expected.dependency_keys].sort();
    if (!equalJson(actualDependencies, expectedDependencies)) {
      mismatches.push(`TASK_DEPENDENCIES:${expected.task_key}`);
    }
  }

  const waitingApprovals = input.decisions.filter((decision) => {
    const metadata = recordValue(decision.metadata);
    return (
      decision.decision_type === "approval" &&
      decision.decision_status === "waiting" &&
      decision.external_channel === "feishu" &&
      metadata.plan_id === input.canary.draft.plan_id
    );
  });
  if (waitingApprovals.length !== 1) mismatches.push("APPROVAL_GATE_MISMATCH");

  const createdEvents = input.events.filter(
    (event) =>
      event.event_type === "task.created" &&
      event.from_status === null &&
      event.to_status === "awaiting_human"
  );
  if (createdEvents.length !== 1) mismatches.push("CREATED_EVENT_MISMATCH");
  const progressedEvents = input.events.filter((event) => {
    const payload = recordValue(event.payload);
    return (
      event.event_type === "task.progressed" &&
      event.from_status === "awaiting_human" &&
      event.to_status === "awaiting_human" &&
      payload.plan_id === input.canary.draft.plan_id &&
      payload.task_count === expectedTasks.length
    );
  });
  if (progressedEvents.length !== 1) mismatches.push("PROGRESSED_EVENT_MISMATCH");
  if (input.events.length !== 2) mismatches.push("EVENT_COUNT_MISMATCH");

  return {
    matches: mismatches.length === 0,
    expected_task_count: expectedTasks.length,
    persisted_task_count: input.tasks.length,
    mismatch_codes: mismatches,
  };
}
