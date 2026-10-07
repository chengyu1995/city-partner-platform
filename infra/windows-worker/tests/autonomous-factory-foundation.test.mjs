import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import {
  buildAutonomousFactoryPlannedTasks,
  captureAutonomousFactoryPlan,
  readAutonomousFactoryMode,
} from "../../../src/lib/autonomous-factory/control-plane.ts";
import {
  AUTONOMOUS_FACTORY_AGENT_REGISTRY,
  getAutonomousFactoryAgent,
} from "../../../src/lib/autonomous-factory/agent-registry.ts";
import {
  AUTONOMOUS_FACTORY_CANARY_SUPABASE_SECRET_ENV,
  AUTONOMOUS_FACTORY_CANARY_TOKEN_SHA256_ENV,
  PREVIEW_SHADOW_CANARY_BRANCH,
  buildPreviewShadowCanary,
  comparePreviewShadowCanary,
  createPreviewShadowCanaryApiKeyFetch,
  isPreviewShadowCanaryAuthorized,
  readPreviewShadowCanaryDatabaseConfig,
  readPreviewShadowCanaryRuntime,
  readPreviewShadowCanarySnapshot,
} from "../../../src/lib/autonomous-factory/preview-shadow-canary.ts";

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

test("preview shadow canary fails closed outside its exact runtime", () => {
  const tokenSha256 = "a".repeat(64);
  const commitSha = "a".repeat(40);
  const base = {
    VERCEL_ENV: "preview",
    HERMES_AUTONOMOUS_FACTORY_MODE: "shadow",
    [AUTONOMOUS_FACTORY_CANARY_TOKEN_SHA256_ENV]: tokenSha256,
    VERCEL_GIT_COMMIT_REF: PREVIEW_SHADOW_CANARY_BRANCH,
    VERCEL_GIT_COMMIT_SHA: commitSha,
  };

  assert.deepEqual(readPreviewShadowCanaryRuntime({ ...base, VERCEL_ENV: "production" }), {
    ok: false,
    status: 403,
    failure_code: "AUTONOMOUS_FACTORY_CANARY_PREVIEW_ONLY",
  });
  assert.deepEqual(
    readPreviewShadowCanaryRuntime({ ...base, HERMES_AUTONOMOUS_FACTORY_MODE: "disabled" }),
    {
      ok: false,
      status: 503,
      failure_code: "AUTONOMOUS_FACTORY_CANARY_SHADOW_REQUIRED",
    }
  );
  assert.deepEqual(
    readPreviewShadowCanaryRuntime({
      ...base,
      [AUTONOMOUS_FACTORY_CANARY_TOKEN_SHA256_ENV]: "not-a-sha256-digest",
    }),
    {
      ok: false,
      status: 503,
      failure_code: "AUTONOMOUS_FACTORY_CANARY_TOKEN_MISSING",
    }
  );
  assert.deepEqual(readPreviewShadowCanaryRuntime(base), {
    ok: true,
    commit_sha: commitSha,
  });
  assert.deepEqual(
    readPreviewShadowCanaryRuntime({ ...base, VERCEL_GIT_COMMIT_REF: "other-branch" }),
    {
      ok: false,
      status: 403,
      failure_code: "AUTONOMOUS_FACTORY_CANARY_BRANCH_MISMATCH",
    }
  );
});

test("preview shadow canary requires a bearer token matching its configured digest", () => {
  const token = "canary-token-" + "x".repeat(32);
  const tokenSha256 = createHash("sha256").update(token, "utf8").digest("hex");
  const env = { [AUTONOMOUS_FACTORY_CANARY_TOKEN_SHA256_ENV]: tokenSha256 };
  assert.equal(isPreviewShadowCanaryAuthorized(`Bearer ${token}`, env), true);
  assert.equal(isPreviewShadowCanaryAuthorized(`Bearer ${token} `, env), false);
  assert.equal(isPreviewShadowCanaryAuthorized("Bearer wrong", env), false);
  assert.equal(isPreviewShadowCanaryAuthorized(null, env), false);
  assert.equal(isPreviewShadowCanaryAuthorized(`Bearer ${token}`, {}), false);
  assert.equal(
    isPreviewShadowCanaryAuthorized(`Bearer ${token}`, {
      HERMES_AUTONOMOUS_FACTORY_CANARY_TOKEN: token,
    }),
    false
  );
  assert.equal(
    isPreviewShadowCanaryAuthorized(`Bearer ${token}`, {
      [AUTONOMOUS_FACTORY_CANARY_TOKEN_SHA256_ENV]: "not-a-sha256-digest",
    }),
    false
  );
});

test("preview shadow canary only accepts its dedicated Supabase secret", () => {
  const secretKey = "sb_secret_" + "s".repeat(40);
  const productionKey = "legacy-production-" + "p".repeat(32);
  const url = "https://example.supabase.co";

  assert.deepEqual(
    readPreviewShadowCanaryDatabaseConfig({
      NEXT_PUBLIC_SUPABASE_URL: ` ${url} `,
      [AUTONOMOUS_FACTORY_CANARY_SUPABASE_SECRET_ENV]: ` ${secretKey} `,
      SUPABASE_SERVICE_ROLE_KEY: productionKey,
    }),
    { url, secretKey }
  );
  assert.equal(
    readPreviewShadowCanaryDatabaseConfig({
      NEXT_PUBLIC_SUPABASE_URL: url,
      SUPABASE_SERVICE_ROLE_KEY: productionKey,
    }),
    null
  );
  assert.equal(
    readPreviewShadowCanaryDatabaseConfig({
      [AUTONOMOUS_FACTORY_CANARY_SUPABASE_SECRET_ENV]: secretKey,
    }),
    null
  );
  assert.equal(
    readPreviewShadowCanaryDatabaseConfig({
      NEXT_PUBLIC_SUPABASE_URL: url,
      [AUTONOMOUS_FACTORY_CANARY_SUPABASE_SECRET_ENV]:
        "sb_publishable_" + "p".repeat(40),
    }),
    null
  );
  assert.equal(
    readPreviewShadowCanaryDatabaseConfig({
      NEXT_PUBLIC_SUPABASE_URL: url,
      [AUTONOMOUS_FACTORY_CANARY_SUPABASE_SECRET_ENV]: productionKey,
    }),
    null
  );
});

test("preview shadow canary sends its Supabase secret as apikey only", async () => {
  const secretKey = "sb_secret_" + "s".repeat(40);
  const requests = [];
  const apiKeyOnlyFetch = createPreviewShadowCanaryApiKeyFetch(
    secretKey,
    async (input, init) => {
      requests.push({ input: String(input), headers: new Headers(init?.headers) });
      return new Response(
        JSON.stringify({
          scope_input_valid: true,
          root: null,
          tasks: [],
          decisions: [],
          events: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  );
  const client = createClient("https://example.supabase.co", secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: apiKeyOnlyFetch },
  });

  const result = await client.rpc("hermes_v2_read_preview_shadow_canary_v1", {
    p_source_external_id: `preview-shadow-planning-canary-v1:${"d".repeat(40)}`,
  });

  assert.equal(result.error, null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.get("apikey"), secretKey);
  assert.equal(requests[0].headers.has("authorization"), false);
  assert.match(requests[0].input, /\/rest\/v1\/rpc\/hermes_v2_read_preview_shadow_canary_v1$/);
});

test("preview shadow canary readback uses one scoped RPC and fails closed", async () => {
  const sourceExternalId = `preview-shadow-planning-canary-v1:${"d".repeat(40)}`;
  const calls = [];
  const success = await readPreviewShadowCanarySnapshot({
    client: {
      async rpc(functionName, args) {
        calls.push({ functionName, args });
        return {
          data: {
            scope_input_valid: true,
            root: null,
            tasks: [],
            decisions: [],
            events: [],
          },
          error: null,
        };
      },
    },
    sourceExternalId,
  });
  assert.equal(success.ok, true);
  assert.deepEqual(calls, [
    {
      functionName: "hermes_v2_read_preview_shadow_canary_v1",
      args: { p_source_external_id: sourceExternalId },
    },
  ]);

  const databaseFailure = await readPreviewShadowCanarySnapshot({
    client: {
      async rpc() {
        return {
          data: null,
          error: { code: "42501", message: "postgres secret message body token=private" },
        };
      },
    },
    sourceExternalId,
  });
  assert.deepEqual(databaseFailure, {
    ok: false,
    error_code: "AUTONOMOUS_FACTORY_CANARY_READBACK_FAILED",
    database_code: "42501",
  });
  assert.doesNotMatch(JSON.stringify(databaseFailure), /postgres|secret|message body|private/i);

  const unsafeCode = await readPreviewShadowCanarySnapshot({
    client: {
      async rpc() {
        return { data: null, error: { code: "token=private database detail" } };
      },
    },
    sourceExternalId,
  });
  assert.equal(unsafeCode.ok, false);
  assert.equal(unsafeCode.database_code, "unknown");

  const malformed = await readPreviewShadowCanarySnapshot({
    client: {
      async rpc() {
        return { data: { scope_input_valid: true, tasks: "not-an-array" }, error: null };
      },
    },
    sourceExternalId,
  });
  assert.deepEqual(malformed, {
    ok: false,
    error_code: "AUTONOMOUS_FACTORY_CANARY_READBACK_FAILED",
    database_code: "invalid_payload",
  });
});

test("preview shadow canary builds one deterministic non-sensitive planning fixture", () => {
  const commitSha = "b".repeat(40);
  const first = buildPreviewShadowCanary(commitSha);
  const second = buildPreviewShadowCanary(commitSha.toUpperCase());

  assert.deepEqual(first, second);
  assert.equal(first.context.eventId, `preview-shadow-planning-canary-v1:${commitSha}`);
  assert.equal(first.draft.execution_mode, "planning_only");
  assert.equal(first.draft.current_status, "waiting_boss_approval");
  assert.ok(first.planned_tasks.length > 0);
  assert.deepEqual(first.planned_tasks, buildAutonomousFactoryPlannedTasks(first.draft));
  assert.doesNotMatch(JSON.stringify(first), /open_id|chat_[0-9]|password|secret|token=/i);
});

test("preview shadow canary compares the persisted V2 plan with the V1 draft", () => {
  const canary = buildPreviewShadowCanary("c".repeat(40));
  const rootTaskId = "root-task-id";
  const taskIds = new Map(
    canary.planned_tasks.map((task, index) => [task.task_key, `task-id-${index + 1}`])
  );
  const tasks = canary.planned_tasks.map((task) => ({
    id: taskIds.get(task.task_key),
    parent_task_id: rootTaskId,
    task_type: task.task_type,
    role: task.agent_role,
    title: task.title,
    status: "draft",
    stage: task.stage,
    risk_level: task.risk_level,
    need_human_decision: task.requires_boss_approval,
    dependency_task_ids: task.dependency_keys.map((key) => taskIds.get(key)),
    metadata: task,
  }));
  const input = {
    rootTaskId,
    canary,
    root: {
      id: rootTaskId,
      parent_task_id: null,
      task_type: "requirement",
      role: "project_director",
      status: "awaiting_human",
      stage: "intake",
      metadata: {
        capture_mode: "shadow",
        plan_id: canary.draft.plan_id,
        plan: {
          boss_request_id: canary.draft.boss_request_id,
          task_tree_id: canary.draft.task_tree_id,
          project: canary.draft.project,
          requires_boss_approval: canary.draft.requires_boss_approval,
          execution_mode: canary.draft.execution_mode,
        },
      },
    },
    tasks,
    decisions: [
      {
        decision_type: "approval",
        decision_status: "waiting",
        external_channel: "feishu",
        metadata: { plan_id: canary.draft.plan_id },
      },
    ],
    events: [
      { event_type: "task.created", from_status: null, to_status: "awaiting_human", payload: {} },
      {
        event_type: "task.progressed",
        from_status: "awaiting_human",
        to_status: "awaiting_human",
        payload: {
          plan_id: canary.draft.plan_id,
          task_count: canary.planned_tasks.length,
        },
      },
    ],
  };

  assert.deepEqual(comparePreviewShadowCanary(input), {
    matches: true,
    expected_task_count: canary.planned_tasks.length,
    persisted_task_count: canary.planned_tasks.length,
    mismatch_codes: [],
  });

  const partial = comparePreviewShadowCanary({ ...input, tasks: tasks.slice(1) });
  assert.equal(partial.matches, false);
  assert.ok(partial.mismatch_codes.includes("TASK_COUNT_MISMATCH"));
});

test("preview shadow canary route cannot send Feishu messages or create worker jobs", () => {
  const route = readFileSync(
    join(root, "src/app/api/internal/autonomous-factory/shadow-canary/route.ts"),
    "utf8"
  );
  const appRoute = readFileSync(
    join(root, "app/api/internal/autonomous-factory/shadow-canary/route.ts"),
    "utf8"
  );
  assert.match(route, /readPreviewShadowCanaryRuntime\(\)/);
  assert.match(route, /isPreviewShadowCanaryAuthorized/);
  assert.match(route, /readPreviewShadowCanaryDatabaseConfig\(\)/);
  assert.match(route, /createPreviewShadowCanaryApiKeyFetch\(databaseConfig\.secretKey\)/);
  assert.match(route, /captureAutonomousFactoryPlan/);
  assert.match(route, /readPreviewShadowCanarySnapshot/);
  assert.match(route, /comparePreviewShadowCanary/);
  const preflightIndex = route.indexOf(
    "const preflight = await readPreviewShadowCanarySnapshot"
  );
  const captureIndex = route.indexOf(
    "const capture = await captureAutonomousFactoryPlan"
  );
  const readbackIndex = route.indexOf(
    "const readback = await readPreviewShadowCanarySnapshot"
  );
  assert.ok(preflightIndex >= 0);
  assert.ok(preflightIndex < captureIndex);
  assert.ok(captureIndex < readbackIndex);
  assert.match(route, /readback preflight failed[\s\S]*code: preflight\.database_code/);
  assert.match(
    route.slice(preflightIndex, captureIndex),
    /AUTONOMOUS_FACTORY_CANARY_READBACK_FAILED|preflight\.error_code/
  );
  assert.doesNotMatch(route, /getSupabaseService|SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(route, /sendFeishuMessage|getFeishuToken|hermes_messages|hermes_jobs|canonicalCreateJob/);
  assert.doesNotMatch(route, /\.from\(["']hermes_v2_/);
  assert.doesNotMatch(route, /req\.json\(|req\.text\(|req\.arrayBuffer\(/);
  assert.match(appRoute, /export \{ POST \} from/);
  assert.match(appRoute, /src\/app\/api\/internal\/autonomous-factory\/shadow-canary\/route/);
});

test("canary readback migration exposes one scoped service-role-only read function", () => {
  const sql = readFileSync(
    join(root, "supabase/migrations/202610070001_hermes_v2_canary_readback.sql"),
    "utf8"
  );
  const referencedTables = new Set(
    [...sql.matchAll(/(?:from|join)\s+public\.(hermes_v2_\w+)/gi)].map((match) => match[1])
  );

  assert.match(sql, /^begin;[\s\S]*commit;\s*$/im);
  assert.match(
    sql,
    /create function public\.hermes_v2_read_preview_shadow_canary_v1\(\s*p_source_external_id text\s*\)/i
  );
  assert.match(sql, /returns jsonb\s+language sql\s+stable\s+security definer\s+set search_path = pg_catalog/i);
  assert.match(sql, /\^preview-shadow-planning-canary-v1:\[0-9a-f\]\{40\}\$/i);
  assert.equal([...sql.matchAll(/create\s+(?:or replace\s+)?function/gi)].length, 1);
  assert.deepEqual(
    referencedTables,
    new Set(["hermes_v2_tasks", "hermes_v2_human_decisions", "hermes_v2_task_events"])
  );
  for (const field of [
    "scope_input_valid",
    "parent_task_id",
    "dependency_task_ids",
    "need_human_decision",
    "decision_status",
    "external_channel",
    "event_type",
  ]) {
    assert.match(sql, new RegExp(`'${field}'`, "i"));
  }
  assert.match(sql, /revoke all on function public\.hermes_v2_read_preview_shadow_canary_v1\(text\)\s+from public/i);
  assert.match(sql, /revoke all on function public\.hermes_v2_read_preview_shadow_canary_v1\(text\)\s+from anon/i);
  assert.match(sql, /revoke all on function public\.hermes_v2_read_preview_shadow_canary_v1\(text\)\s+from authenticated/i);
  assert.match(sql, /revoke all on function public\.hermes_v2_read_preview_shadow_canary_v1\(text\)\s+from authenticator/i);
  assert.match(sql, /grant execute on function public\.hermes_v2_read_preview_shadow_canary_v1\(text\)\s+to service_role/i);
  assert.deepEqual(
    [...sql.matchAll(/grant\s+execute[\s\S]*?\s+to\s+(\w+)\s*;/gi)].map((match) => match[1]),
    ["service_role"]
  );
  assert.match(sql, /alter function public\.hermes_v2_read_preview_shadow_canary_v1\(text\)\s+owner to postgres/i);
  assert.doesNotMatch(sql, /\b(?:create|alter|drop)\s+table\b/i);
  assert.doesNotMatch(sql, /grant\s+select\s+on/i);
  assert.doesNotMatch(sql, /\b(insert\s+into|update\s+public\.|delete\s+from|truncate|merge\s+into)\b/i);
  assert.doesNotMatch(sql, /\b(request_text|feishu_event_id|feishu_message_id|feishu_chat_id|feishu_user_id|external_message_id|decision_text)\b/i);
});

test("writer RPC ACL migration grants execute only to service_role", () => {
  const sql = readFileSync(
    join(root, "supabase/migrations/202610070002_hermes_v2_rpc_acl_hardening.sql"),
    "utf8"
  );
  const functionNames = [
    "hermes_v2_create_requirement_v1",
    "hermes_v2_store_plan_v1",
    "hermes_v2_capture_requirement_plan_v1",
  ];

  assert.match(sql, /^begin;[\s\S]*commit;\s*$/im);
  for (const functionName of functionNames) {
    assert.match(sql, new RegExp(`public\\.${functionName}\\(`, "i"));
    for (const role of ["public", "anon", "authenticated", "authenticator", "service_role"]) {
      assert.match(
        sql,
        new RegExp(`revoke all on function public\\.${functionName}\\([\\s\\S]*?\\)\\s+from ${role}\\s*;`, "i")
      );
    }
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${functionName}\\([\\s\\S]*?\\)\\s+to service_role\\s*;`, "i")
    );
  }
  assert.match(sql, /pg_catalog\.has_function_privilege/i);
  assert.match(sql, /pg_catalog\.aclexplode/i);
  assert.match(sql, /notify pgrst, 'reload schema'/i);
  assert.doesNotMatch(sql, /create\s+or\s+replace\s+function/i);
  assert.doesNotMatch(sql, /\b(?:create|alter|drop)\s+table\b/i);
  assert.doesNotMatch(sql, /\b(insert\s+into|update\s+public\.|delete\s+from|truncate|merge\s+into)\b/i);
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
  assert.match(sql, /create unique index if not exists uq_hermes_v2_task_events_idempotency_key/i);
  assert.match(sql, /canonical_hermes_job_id uuid references hermes_jobs\(id\) on delete restrict/i);
  assert.doesNotMatch(sql, /create table if not exists hermes_v2_task_attempts/i);
  assert.doesNotMatch(sql, /\b(claim_token|lease_expires_at|claimed_by)\b/i);
  assert.doesNotMatch(sql, /^\s*(drop|truncate|delete)\b/im);
  assert.match(sql, /add column if not exists canonical_hermes_job_id uuid/i);
  assert.match(sql, /set canonical_hermes_job_id = t\.legacy_hermes_job_id/i);
  assert.match(sql, /legacy v2 execution history retained for audit only/i);
  assert.match(sql, /alter column default_base_branch set default 'develop'/i);
  assert.match(sql, /where default_base_branch in \('main', 'master', 'dev', 'staging'\)/i);
  assert.match(sql, /add column if not exists planning_agent text/i);
  assert.match(sql, /add column if not exists runtime_executor text default 'codex_agent'/i);
  assert.match(sql, /add column if not exists enabled boolean default true/i);
  assert.match(sql, /'task\.progressed'/i);
  assert.match(sql, /create or replace function public\.hermes_v2_create_requirement_v1/i);
  assert.match(sql, /create or replace function public\.hermes_v2_store_plan_v1/i);
  assert.match(sql, /create or replace function public\.hermes_v2_capture_requirement_plan_v1/i);
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, public/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
  assert.match(sql, /^begin;[\s\S]*commit;\s*$/im);
  assert.doesNotMatch(sql, /\b(drop|truncate|delete from)\b/i);
});

test("constraint parity migration upgrades only the three legacy checks", () => {
  const sql = readFileSync(
    join(root, "supabase/migrations/202610050003_hermes_v2_constraint_parity.sql"),
    "utf8"
  );
  const expectedTables = new Set([
    "hermes_v2_tasks",
    "hermes_v2_task_events",
    "hermes_v2_feishu_sync_outbox",
  ]);
  const alteredTables = new Set(
    [...sql.matchAll(/alter table\s+public\.(\w+)/gi)].map((match) => match[1])
  );

  assert.match(sql, /^begin;[\s\S]*commit;\s*$/im);
  assert.deepEqual(alteredTables, expectedTables);
  assert.equal([...sql.matchAll(/drop constraint if exists/gi)].length, 3);
  assert.equal([...sql.matchAll(/\)\) not valid;/gi)].length, 3);
  assert.equal([...sql.matchAll(/validate constraint/gi)].length, 3);

  assert.match(sql, /drop constraint if exists hermes_v2_tasks_status_check/i);
  assert.match(sql, /drop constraint if exists hermes_v2_task_events_type_check/i);
  assert.match(sql, /drop constraint if exists hermes_v2_feishu_sync_outbox_sync_type_check/i);

  for (const value of ["'ready'", "'dispatched'", "'approved'", "'rejected'"]) {
    assert.ok(sql.includes(value), `missing task status ${value}`);
  }
  for (const value of [
    "'task.plan_stored'",
    "'task.dispatched'",
    "'task.reviewed'",
    "'canonical_job.observed'",
    "'memory.updated'",
  ]) {
    assert.ok(sql.includes(value), `missing task event ${value}`);
  }
  assert.match(sql, /'review_packet'/i);

  assert.doesNotMatch(sql, /\bdrop\s+(table|column|schema|database)\b/i);
  assert.doesNotMatch(sql, /^\s*(insert|update|delete|truncate)\b/im);
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
