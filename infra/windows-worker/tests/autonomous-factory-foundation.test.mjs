import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureAutonomousFactoryPlan,
  readAutonomousFactoryMode,
} from "../../../src/lib/autonomous-factory/control-plane.ts";
import {
  AUTONOMOUS_FACTORY_AGENT_REGISTRY,
  getAutonomousFactoryAgent,
} from "../../../src/lib/autonomous-factory/agent-registry.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function fixtureDraft() {
  return {
    boss_request_id: "boss-request-1",
    plan_id: "plan-1",
    original_demand: "Build a small website",
    director_understanding: "Build and verify a website",
    execution_tasks: [],
    requires_boss_approval: true,
    current_status: "waiting_boss_approval",
    project_goal: "Ship a reviewed website",
    task_tree_id: "task-tree-1",
    execution_mode: "planning_only",
    root_task: {
      task_key: "root",
      title: "Website requirement",
      agent_role: "project_director",
      task_type: "product_planning",
      acceptance_criteria: ["Plan is complete"],
    },
    child_tasks: [
      {
        task_code: "product-plan",
        task_key: "product-plan",
        task_title: "Define the MVP",
        title: "Define the MVP",
        role: "product_manager",
        agent_role: "product_manager",
        task_type: "product_planning",
        stage: "planning",
        phase: "planning",
        input: ["Boss requirement"],
        output_files: ["docs/product/brief.md"],
        allowed_files: ["docs/product/brief.md"],
        forbidden_files: [".env"],
        acceptance_criteria: ["MVP boundaries are explicit"],
        dependency_task_codes: [],
        dependency_keys: [],
        risk_level: "low",
        estimated_minutes: 30,
        can_auto_execute: true,
        requires_boss_approval: false,
        execution_mode: "planning_only",
      },
      {
        task_code: "frontend-build",
        task_key: "frontend-build",
        task_title: "Implement the approved UI",
        title: "Implement the approved UI",
        role: "frontend_developer",
        agent_role: "frontend_developer",
        task_type: "frontend_development",
        stage: "implementation",
        phase: "implementation",
        input: ["Approved MVP"],
        output_files: ["src/app/page.tsx"],
        allowed_files: ["src/app/page.tsx"],
        forbidden_files: [".env"],
        acceptance_criteria: ["UI passes validation"],
        dependency_task_codes: ["product-plan"],
        dependency_keys: ["product-plan"],
        risk_level: "low",
        estimated_minutes: 60,
        can_auto_execute: true,
        requires_boss_approval: false,
        execution_mode: "planning_only",
      },
    ],
    project: {
      title: "Website MVP",
      goal: "Ship a reviewed website",
      demand_category: "product_planning",
      mvp_scope: ["Home page"],
      out_of_scope: ["Payments"],
      estimated_stages: ["planning", "implementation"],
    },
    stages: [],
  };
}

function fixtureContext() {
  return {
    projectKey: "city-partner-platform",
    projectName: "City Partner Platform",
    conversationId: "conversation-1",
    demandKind: "website_product_request",
    eventId: "event-1",
    messageId: "message-1",
    chatId: "chat-1",
    userId: "user-1",
  };
}

test("autonomous factory mode is disabled by default and rejects invalid values", () => {
  assert.equal(readAutonomousFactoryMode({}), "disabled");
  assert.equal(readAutonomousFactoryMode({ HERMES_AUTONOMOUS_FACTORY_MODE: " SHADOW " }), "shadow");
  assert.equal(
    readAutonomousFactoryMode({ HERMES_AUTONOMOUS_FACTORY_MODE: "authoritative" }),
    "authoritative"
  );
  assert.throws(
    () => readAutonomousFactoryMode({ HERMES_AUTONOMOUS_FACTORY_MODE: "enabled" }),
    /AUTONOMOUS_FACTORY_MODE_INVALID/
  );
});

test("disabled mode performs no database calls", async () => {
  let calls = 0;
  const result = await captureAutonomousFactoryPlan({
    client: {
      async rpc() {
        calls += 1;
        return { data: null, error: null };
      },
    },
    draft: fixtureDraft(),
    context: fixtureContext(),
    mode: "disabled",
  });

  assert.deepEqual(result, { status: "disabled", mode: "disabled" });
  assert.equal(calls, 0);
});

test("shadow mode captures requirement and complete plan in one RPC transaction", async () => {
  const calls = [];
  const result = await captureAutonomousFactoryPlan({
    client: {
      async rpc(functionName, args) {
        calls.push({ functionName, args });
        return {
          data: { project_id: "project-1", task_id: "root-task-1", duplicate: false },
          error: null,
        };
      },
    },
    draft: fixtureDraft(),
    context: fixtureContext(),
    mode: "shadow",
  });

  assert.deepEqual(result, {
    status: "captured",
    mode: "shadow",
    project_id: "project-1",
    root_task_id: "root-task-1",
    duplicate: false,
    planned_tasks: 2,
  });
  assert.deepEqual(calls.map((call) => call.functionName), ["hermes_v2_capture_requirement_plan_v1"]);
  assert.equal(calls[0].args.p_source_external_id, "event-1");
  assert.equal(calls[0].args.p_tasks.length, 2);
  assert.deepEqual(calls[0].args.p_tasks[1].dependency_keys, ["product-plan"]);
  assert.equal(calls[0].args.p_tasks[1].runtime_executor, "codex_agent");
});

test("shadow failures are fixed safe results without database details", async () => {
  const secretDetail = "postgres secret message body token=private";
  const result = await captureAutonomousFactoryPlan({
    client: {
      async rpc() {
        return { data: null, error: { code: "PGRST500", message: secretDetail } };
      },
    },
    draft: fixtureDraft(),
    context: fixtureContext(),
    mode: "shadow",
  });

  assert.deepEqual(result, {
    status: "shadow_failed",
    mode: "shadow",
    error_code: "AUTONOMOUS_FACTORY_CAPTURE_FAILED",
  });
  assert.doesNotMatch(JSON.stringify(result), /postgres|secret|private|message body/i);
});

test("authoritative failure stops processing with a fixed safe error", async () => {
  await assert.rejects(
    captureAutonomousFactoryPlan({
      client: {
        async rpc() {
          return { data: null, error: { code: "XX000", message: "sensitive detail" } };
        },
      },
      draft: fixtureDraft(),
      context: fixtureContext(),
      mode: "authoritative",
    }),
    (error) => error instanceof Error && error.message === "AUTONOMOUS_FACTORY_CAPTURE_FAILED"
  );
});

test("transaction failures are never reported as captured", async () => {
  const result = await captureAutonomousFactoryPlan({
    client: {
      async rpc() {
        return { data: null, error: { code: "23505", message: "detail" } };
      },
    },
    draft: fixtureDraft(),
    context: fixtureContext(),
    mode: "shadow",
  });

  assert.deepEqual(result, {
    status: "shadow_failed",
    mode: "shadow",
    error_code: "AUTONOMOUS_FACTORY_CAPTURE_FAILED",
  });
});

test("all project director roles have one real Codex runtime executor", () => {
  assert.equal(AUTONOMOUS_FACTORY_AGENT_REGISTRY.length, 8);
  assert.equal(new Set(AUTONOMOUS_FACTORY_AGENT_REGISTRY.map((agent) => agent.role)).size, 8);
  for (const agent of AUTONOMOUS_FACTORY_AGENT_REGISTRY) {
    assert.equal(agent.runtime_executor, "codex_agent");
    assert.ok(agent.capabilities.length > 0);
  }
  assert.equal(getAutonomousFactoryAgent("operations_engineer").human_gate, "production_approval");
  assert.equal(getAutonomousFactoryAgent("frontend_developer").human_gate, "final_review");
});

test("formal migration creates the control plane, memory, RLS, and service-only RPCs", () => {
  const sql = readFileSync(
    join(root, "supabase/migrations/202610050002_hermes_v2_autonomous_factory.sql"),
    "utf8"
  );
  const tables = [
    "projects",
    "tasks",
    "agents",
    "task_checkpoints",
    "human_decisions",
    "deployments",
    "task_events",
    "feishu_sync_outbox",
    "artifacts",
    "reviews",
    "project_memory",
  ];
  for (const table of tables) {
    assert.match(sql, new RegExp(`create table if not exists hermes_v2_${table}\\b`, "i"));
    assert.match(sql, new RegExp(`'hermes_v2_${table}'`, "i"));
  }
  assert.match(sql, /default_base_branch text not null default 'develop'/i);
  assert.doesNotMatch(sql, /default_base_branch text not null default 'master'/i);
  assert.match(sql, /create unique index if not exists idx_hermes_v2_tasks_source_external_id_unique/i);
  assert.match(sql, /canonical_hermes_job_id uuid references hermes_jobs\(id\) on delete restrict/i);
  assert.doesNotMatch(sql, /create table if not exists hermes_v2_task_attempts/i);
  assert.doesNotMatch(sql, /\b(claim_token|lease_expires_at|claimed_by)\b/i);
  assert.match(sql, /create or replace function public\.hermes_v2_create_requirement_v1/i);
  assert.match(sql, /create or replace function public\.hermes_v2_store_plan_v1/i);
  assert.match(sql, /create or replace function public\.hermes_v2_capture_requirement_plan_v1/i);
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, public/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
  assert.match(sql, /^begin;[\s\S]*commit;\s*$/im);
  assert.doesNotMatch(sql, /\b(drop|truncate|delete from)\b/i);
});

test("Feishu receipt migration matches the live route contract and is RLS protected", () => {
  const sql = readFileSync(
    join(root, "supabase/migrations/202610050001_feishu_event_receipts.sql"),
    "utf8"
  );
  for (const column of [
    "event_id",
    "message_id",
    "event_type",
    "chat_id",
    "sender_open_id",
    "status",
    "error_text",
    "completed_at",
    "created_at",
    "updated_at",
  ]) {
    assert.match(sql, new RegExp(`\\b${column}\\b`, "i"));
  }
  assert.match(sql, /event_id text primary key/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /^begin;[\s\S]*commit;\s*$/im);
  assert.doesNotMatch(sql, /\b(drop|truncate|delete from)\b/i);
});

test("Feishu demand intake invokes the control plane before legacy history persistence", () => {
  const route = readFileSync(join(root, "src/app/api/feishu/event/route.ts"), "utf8");
  const demandBlockStart = route.indexOf(
    'if (demandKind === "website_product_request" || demandKind === "system_upgrade_request")'
  );
  const captureIndex = route.indexOf("captureAutonomousFactoryPlan({", demandBlockStart);
  const legacySaveIndex = route.indexOf("await savePlanningTaskTreeReply(", demandBlockStart);
  assert.notEqual(demandBlockStart, -1);
  assert.ok(captureIndex > demandBlockStart);
  assert.ok(legacySaveIndex > captureIndex);
  assert.match(route.slice(demandBlockStart, legacySaveIndex), /readAutonomousFactoryMode\(\)/);
  assert.match(route.slice(demandBlockStart, legacySaveIndex), /shadow_failed/);
});

test("Feishu failure receipts store fixed safe codes instead of exception details", () => {
  const route = readFileSync(join(root, "src/app/api/feishu/event/route.ts"), "utf8");
  assert.match(route, /function safeFeishuProcessingErrorCode\(error: unknown\)/);
  assert.match(route, /markReceiptFailed\(supabase, eventId, processingErrorCode\)/);
  assert.doesNotMatch(route, /markReceiptFailed\(supabase, eventId, processingErrorText\)/);
  assert.match(route, /return "FEISHU_EVENT_PROCESSING_FAILED"/);
});
