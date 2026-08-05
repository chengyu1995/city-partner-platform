/**
 * Hermes Agent 循环
 * 多轮对话: LLM + 6 个 tool + 历史上下文
 * 
 * 工具:
 *   - query_bitable: 查 Bitable 表
 *   - create_requirement: 写《需求池》
 *   - decompose_task: 拆任务
 *   - search_bitable: 搜 Bitable
 *   - mark_decision: 老板决策中心
 *   - send_group_message: 推飞书群通知
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import type {
  HermesPlanDraft,
  HermesPlanningContext,
  HermesPlanningProvider,
  HermesPlanningRequest,
} from "./hermes/orchestration-adapter.ts";

/**
 * Hermes 总管系统提示词 (从 docs/HERMES_SYSTEM_PROMPT.md 读)
 * 单一来源: 改文档即生效, 不要硬编码.
 */
function loadSystemPrompt(): string {
  try {
    // 在 Vercel build 时, docs/ 不会被复制, 读 __dirname 走相对路径不可靠
    // 用 import.meta.url 拿当前文件位置 (Next 16 webpack 兼容)
    const candidates = [
      path.join(process.cwd(), "docs", "HERMES_SYSTEM_PROMPT.md"),
      path.join(process.cwd(), "..", "docs", "HERMES_SYSTEM_PROMPT.md"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const md = fs.readFileSync(p, "utf-8");
        // 去掉 markdown 包裹 ``` (如果存在) + 提取 ```...``` 代码块
        const m = md.match(/```\n([\s\S]*?)\n```/);
        if (m) return m[1];
        // 整文件当 prompt
        return md;
      }
    }
  } catch { /* ignore */ }
  // 兜底: 硬编码简版 (Vercel build 时如果读不到文档)
  return `你是 Hermes 总管的**只读** Agent: 接 LLM 拆任务的职能已下放给腾讯云 worker-api + 本地 Codex.
你的职责**只剩**:
1. 简单查 (Bitable / Supabase 读)
2. 推群 (FEISHU_BOT_WEBHOOK)
3. 老板决策 (mark_decision, 复杂问题变 A/B/C)
4. 创建需求 (create_requirement, **不**再拆任务, 整需求入队)

不**再**做: 调 Codex / 拆解任务 / 直接改代码 (全部由腾讯云 -> 本地 Codex worker 处理).`;
}

const SYSTEM_PROMPT = loadSystemPrompt();

export interface AgentMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface AgentToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AgentResponse {
  content: string;
  tool_calls: AgentToolCall[];
  finish_reason: "stop" | "tool_calls" | "length" | "error";
  error?: string;
}

// ============== LLM 调用 (MiniMax) ==============
async function callLLM(
  messages: AgentMessage[],
  tools: { type: "function"; function: { name: string; description: string; parameters: unknown } }[],
  signal?: AbortSignal
): Promise<AgentResponse> {
  const apiKey = process.env.MINIMAX_CN_API_KEY || process.env.HERMES_API_KEY;
  if (!apiKey) {
    return { content: "❌ LLM API key 缺失 (MINIMAX_CN_API_KEY)", tool_calls: [], finish_reason: "error" };
  }

  const body = {
    model: "MiniMax-Text-01",
    messages,
    tools,
    tool_choice: "auto",
    temperature: 0.3,
  };

  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const res = await fetch("https://api.minimax.chat/v1/text/chatcompletion_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: bytes,
    signal,
  });
  const raw = await res.text();
  let data: { choices?: { message: { content?: string; tool_calls?: AgentToolCall[] }; finish_reason?: string }[]; error?: { message: string } };
  try { data = JSON.parse(raw); }
  catch { return { content: `❌ LLM 返非 JSON: ${raw.slice(0, 200)}`, tool_calls: [], finish_reason: "error" }; }
  if (data.error) {
    return { content: `❌ LLM 错: ${data.error.message}`, tool_calls: [], finish_reason: "error" };
  }
  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content ?? "",
    tool_calls: msg?.tool_calls ?? [],
    finish_reason: (data.choices?.[0]?.finish_reason as AgentResponse["finish_reason"]) ?? "stop",
  };
}

function parseCanonicalPlanningDraft(content: string): HermesPlanDraft {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced);
  } catch {
    throw new Error("HERMES_PLANNER_INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("HERMES_PLANNER_INVALID_RESPONSE");
  }
  const draft = parsed as HermesPlanDraft;
  if (!Array.isArray(draft.subtasks) || draft.subtasks.length === 0) {
    throw new Error("HERMES_PLANNER_SUBTASKS_REQUIRED");
  }
  return draft;
}

export function createCanonicalHermesPlanningProvider(): HermesPlanningProvider {
  return {
    async plan(request: HermesPlanningRequest, context?: HermesPlanningContext): Promise<HermesPlanDraft> {
      const response = await callLLM(
        [
          {
            role: "system",
            content: [
              "You are the Hermes planning provider.",
              "Return one JSON object only. Do not call tools or write databases.",
              "Produce objective, aggregation_policy, and subtasks.",
              "Each subtask requires: subtask_id, title, objective, dependencies,",
              "required_capabilities, execution_intent, allowed_paths, forbidden_paths,",
              "acceptance_criteria, validation_requirements, git_commit_required,",
              "git_push_required, deployment_required.",
              "Never include job, attempt, lease, claim, retry, or terminal state fields.",
              `The immutable permission ceiling is ${request.permission_ceiling}.`,
            ].join("\n"),
          },
          { role: "user", content: JSON.stringify(request) },
        ],
        [],
        context?.signal
      );
      if (response.finish_reason === "error") {
        throw new Error(`HERMES_PLANNER_FAILED:${response.content}`);
      }
      return parseCanonicalPlanningDraft(response.content);
    },
  };
}

// ============== Supabase ==============
function sb(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ============== Tool 实现 ==============

async function toolQueryBitable(args: { table: string; filter?: string; limit?: number }): Promise<string> {
  const supabase = sb();
  if (!supabase) return "❌ Supabase 缺失";
  // TODO: 真实 Bitable API (v1.bitable.appTableRecord.list)
  return `🚧 query_bitable 暂用 Supabase ${args.table} (待 Bitable 集成). limit=${args.limit ?? 10}`;
}

async function toolCreateRequirement(args: { title: string; description: string; priority?: string }): Promise<string> {
  const supabase = sb();
  if (!supabase) return "❌ Supabase 缺失";
  // TODO: 写 Bitable 需求池
  const { data, error } = await supabase
    .from("hermes_queue")
    .insert({
      raw: { title: args.title, description: args.description, priority: args.priority ?? "P1" },
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return `❌ 写失败: ${error.message}`;
  return `✅ 需求已记, queue_id=${data.id}. 5 分钟内 cron 拆解, 完成后推飞书群.`;
}

async function toolDecomposeTask(args: { queue_id: string }): Promise<string> {
  return `🚧 decompose_task 触发 cron 拆解 (queue_id=${args.queue_id}). 通常 5 分钟内完成.`;
}

async function toolSearchBitable(args: { query: string }): Promise<string> {
  return `🚧 search_bitable: "${args.query}" 暂用 Supabase 全文搜索 (待 Bitable 集成).`;
}

async function toolMarkDecision(args: { question: string; options: { A: string; B: string; C?: string }; recommendation?: string }): Promise<string> {
  const supabase = sb();
  if (!supabase) return "❌ Supabase 缺失";
  // TODO: 写 Bitable 老板决策中心
  const { data, error } = await supabase
    .from("hermes_queue")
    .insert({
      raw: { type: "decision", question: args.question, options: args.options, recommendation: args.recommendation },
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return `❌ 写失败: ${error.message}`;
  return `✅ 决策已记, queue_id=${data.id}. 5 分钟内推飞书群.`;
}

async function toolSendGroupMessage(args: { text: string }): Promise<string> {
  const hook = process.env.FEISHU_BOT_WEBHOOK;
  if (!hook) return "❌ FEISHU_BOT_WEBHOOK 缺失";
  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ msg_type: "text", content: { text: args.text } }),
    });
    return res.ok ? `✅ 已推飞书群` : `❌ 推群失败: HTTP ${res.status}`;
  } catch (e) {
    return `❌ 推群错: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ============== Tool 定义 ==============
const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "query_bitable",
      description: "查飞书 Bitable 表 (需求池/任务看板/老板决策中心 等)",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "表名: 需求池/任务看板/老板决策中心/..." },
          filter: { type: "string", description: "可选过滤条件" },
          limit: { type: "number", description: "最多返回条数, 默认 10" },
        },
        required: ["table"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_requirement",
      description: "创建一条需求到《需求池》, 会自动拆任务",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: ["P0", "P1", "P2"] },
        },
        required: ["title", "description"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "decompose_task",
      description: "手动触发某 queue 的拆解",
      parameters: {
        type: "object",
        properties: { queue_id: { type: "string" } },
        required: ["queue_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_bitable",
      description: "全文搜 Bitable",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mark_decision",
      description: "创建一条老板决策到《老板决策中心》, 会推飞书群等你回 A/B/C",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "object",
            properties: {
              A: { type: "string" },
              B: { type: "string" },
              C: { type: "string" },
            },
            required: ["A", "B"],
          },
          recommendation: { type: "string", enum: ["A", "B", "C"] },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_group_message",
      description: "推一条消息到飞书群",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
];

// ============== Tool dispatch ==============
async function dispatchTool(name: string, rawArgs: string): Promise<string> {
  let args: Record<string, unknown>;
  try { args = JSON.parse(rawArgs); }
  catch { return `❌ tool args 不是 JSON: ${rawArgs}`; }
  switch (name) {
    case "query_bitable": return toolQueryBitable(args as never);
    case "create_requirement": return toolCreateRequirement(args as never);
    case "decompose_task": return toolDecomposeTask(args as never);
    case "search_bitable": return toolSearchBitable(args as never);
    case "mark_decision": return toolMarkDecision(args as never);
    case "send_group_message": return toolSendGroupMessage(args as never);
    default: return `❌ 未知 tool: ${name}`;
  }
}

// ============== Agent 主循环 ==============
export async function runAgent(
  userMessage: string,
  history: AgentMessage[] = []
): Promise<{ reply: string; newMessages: AgentMessage[] }> {
  const messages: AgentMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userMessage },
  ];

  const newMessages: AgentMessage[] = [{ role: "user", content: userMessage }];
  const MAX_TURNS = 5;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await callLLM(messages, TOOLS);
    if (resp.finish_reason === "error") {
      return { reply: resp.content, newMessages };
    }

    // assistant message
    const assistantMsg: AgentMessage = {
      role: "assistant",
      content: resp.content,
    };
    if (resp.tool_calls.length > 0) {
      (assistantMsg as AgentMessage & { tool_calls?: AgentToolCall[] }).tool_calls = resp.tool_calls;
    }
    newMessages.push(assistantMsg);
    messages.push(assistantMsg);

    if (resp.tool_calls.length === 0) {
      // no more tool calls, done
      return { reply: resp.content, newMessages };
    }

    // execute tools
    for (const tc of resp.tool_calls) {
      const result = await dispatchTool(tc.function.name, tc.function.arguments);
      const toolMsg: AgentMessage = {
        role: "tool",
        content: result,
        tool_call_id: tc.id,
        name: tc.function.name,
      };
      newMessages.push(toolMsg);
      messages.push(toolMsg);
    }
  }

  return { reply: "⚠️ agent 达到最大轮次, 自动结束", newMessages };
}
