import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const {
  completeHermesHistoryWindow,
  hermesHistoryCandidateLimit,
  readHermesHistoryLimit,
  restoreHermesHistoryRows,
} = await import("../../../src/lib/hermes-history.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function readRouteSource() {
  return readFileSync(join(root, "src/app/api/feishu/event/route.ts"), "utf8");
}

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assistantToolCall(id, name = "query_bitable") {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: "{}",
    },
  };
}

function assistantWithToolCalls(ids) {
  return {
    role: "assistant",
    content: "",
    tool_calls: ids.map((id) => assistantToolCall(id)),
  };
}

function toolResult(id, name = "query_bitable") {
  return {
    role: "tool",
    content: `result:${id}`,
    tool_call_id: id,
    name,
  };
}

test("same created_at rows restore by message_seq order", () => {
  const sameCreatedAt = "2026-08-26T12:00:00.000Z";
  const rowsNewestFirst = [
    { role: "assistant", content: "a2", created_at: sameCreatedAt, message_seq: 4 },
    { role: "user", content: "u2", created_at: sameCreatedAt, message_seq: 3 },
    { role: "assistant", content: "a1", created_at: sameCreatedAt, message_seq: 2 },
    { role: "user", content: "u1", created_at: sameCreatedAt, message_seq: 1 },
  ];

  assert.deepEqual(
    restoreHermesHistoryRows(rowsNewestFirst, 20).map((message) => message.content),
    ["u1", "a1", "u2", "a2"]
  );
});

test("window boundary excludes a tool chain instead of returning a partial group", () => {
  const window = completeHermesHistoryWindow(
    [
      { role: "user", content: "older" },
      assistantWithToolCalls(["call-1", "call-2"]),
      toolResult("call-1"),
      toolResult("call-2"),
      { role: "user", content: "latest" },
    ],
    3
  );

  assert.deepEqual(window, [{ role: "user", content: "latest" }]);
});

test("assistant with multiple tool calls is retained as one complete group", () => {
  const window = completeHermesHistoryWindow(
    [
      { role: "user", content: "older" },
      assistantWithToolCalls(["call-1", "call-2"]),
      toolResult("call-1"),
      toolResult("call-2"),
    ],
    3
  );

  assert.equal(window.length, 3);
  assert.equal(window[0].role, "assistant");
  assert.deepEqual(window.slice(1).map((message) => message.tool_call_id), ["call-1", "call-2"]);
});

test("assistant with missing tool results is excluded", () => {
  const window = completeHermesHistoryWindow(
    [
      { role: "user", content: "older" },
      assistantWithToolCalls(["call-1", "call-2"]),
      toolResult("call-1"),
      { role: "assistant", content: "final" },
    ],
    20
  );

  assert.deepEqual(window, [
    { role: "user", content: "older" },
    { role: "assistant", content: "final" },
  ]);
});

test("orphan tool messages are excluded", () => {
  const window = completeHermesHistoryWindow(
    [
      { role: "user", content: "u1" },
      toolResult("orphan-1"),
      { role: "assistant", content: "a1" },
      toolResult("orphan-2"),
      { role: "user", content: "u2" },
    ],
    20
  );

  assert.deepEqual(
    window.map((message) => message.role),
    ["user", "assistant", "user"]
  );
  assert.deepEqual(
    window.map((message) => message.content),
    ["u1", "a1", "u2"]
  );
});

test("ordinary long conversations keep the latest chronological suffix", () => {
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `m${index + 1}`,
  }));

  assert.deepEqual(
    completeHermesHistoryWindow(messages, 4).map((message) => message.content),
    ["m3", "m4", "m5", "m6"]
  );
});

test("default and configured history windows affect final and candidate limits", () => {
  assert.equal(readHermesHistoryLimit(undefined), 20);
  assert.equal(readHermesHistoryLimit("7"), 7);
  assert.equal(readHermesHistoryLimit("999"), 200);
  assert.equal(readHermesHistoryLimit("abc"), 20);
  assert.equal(hermesHistoryCandidateLimit(20), 100);
  assert.equal(hermesHistoryCandidateLimit(50), 200);
  assert.equal(hermesHistoryCandidateLimit(999), 800);
});

test("loadHistory fails closed on Supabase error without exposing details", () => {
  const routeSource = readRouteSource();
  const loadHistoryBlock = sourceBetween(
    routeSource,
    "async function loadHistory",
    "async function saveDirectReply"
  );
  const errorBranch = sourceBetween(loadHistoryBlock, "if (error)", "if (!data) return [];");

  assert.match(loadHistoryBlock, /const \{ data, error \} = await supabase/);
  assert.match(errorBranch, /throw new Error\("HERMES_HISTORY_LOAD_FAILED"\)/);
  assert.match(errorBranch, /code: typeof error\.code === "string" \? error\.code : "unknown"/);
  assert.doesNotMatch(errorBranch, /return \[\]/);
  assert.doesNotMatch(errorBranch, /error\.(?:message|details|hint)/);
  assert.doesNotMatch(errorBranch, /relation "hermes_messages" does not exist|boss private message/i);
});

test("loadHistory successful empty result remains a valid empty history", () => {
  const routeSource = readRouteSource();
  const loadHistoryBlock = sourceBetween(
    routeSource,
    "async function loadHistory",
    "async function saveDirectReply"
  );

  assert.ok(loadHistoryBlock.indexOf("if (error)") < loadHistoryBlock.indexOf("if (!data) return [];"));
  assert.match(loadHistoryBlock, /if \(!data\) return \[\];/);
  assert.match(loadHistoryBlock, /return restoreHermesHistoryRows\(data, historyLimit\);/);
});

test("loadHistory failure prevents runAgent and history writes by control flow", () => {
  const routeSource = readRouteSource();
  const historyCall = routeSource.indexOf("const history = await loadHistory(supabase, convId);");
  const runAgentCall = routeSource.indexOf("const { reply, newMessages } = await runAgent(text, history);");
  const historyInsert = routeSource.indexOf('await supabase.from("hermes_messages").insert(', runAgentCall);
  const betweenHistoryAndAgent = routeSource.slice(historyCall, runAgentCall);

  assert.notEqual(historyCall, -1);
  assert.notEqual(runAgentCall, -1);
  assert.notEqual(historyInsert, -1);
  assert.ok(historyCall < runAgentCall);
  assert.ok(runAgentCall < historyInsert);
  assert.doesNotMatch(betweenHistoryAndAgent, /\.catch\(|try\s*\{/);
});

test("project director JSON-in-content queries remain independent of loadHistory", () => {
  const routeSource = readRouteSource();
  const loadHistoryBlock = sourceBetween(
    routeSource,
    "async function loadHistory",
    "async function saveDirectReply"
  );
  const taskTreeBlock = sourceBetween(
    routeSource,
    "async function findRecentTaskTreeDraft",
    "async function findRecentCanonicalApprovalContext"
  );
  const dispatchPlanBlock = sourceBetween(
    routeSource,
    "async function findRecentDispatchPlanDraft",
    "async function saveTaskTreeDraftReply"
  );

  assert.match(loadHistoryBlock, /\.order\("message_seq", \{ ascending: false, nullsFirst: false \}\)/);
  assert.doesNotMatch(loadHistoryBlock, /\.order\("created_at"/);
  assert.match(taskTreeBlock, /\.eq\("name", "project_director_task_tree_draft"\)/);
  assert.match(taskTreeBlock, /extractJsonAfterMarker\(message\.content, "json:"\)/);
  assert.match(dispatchPlanBlock, /\.eq\("name", "project_director_dispatch_plan_draft"\)/);
  assert.match(
    dispatchPlanBlock,
    /extractJsonBetweenMarkers\(message\.content, "dispatch_plan_json:", "summary:"\)/
  );
});
