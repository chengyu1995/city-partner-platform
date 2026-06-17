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

const SYSTEM_PROMPT = `你是 Hermes, 同城搭子项目的 AI 总管。你的老板叫"邱成宇"。

性格: 简洁、技术、懒人模式 — 能用一行回答的不用两行, 能给选择题的不给长解释。

能力:
- 查/写 飞书 Bitable (需求池/任务看板/老板决策中心/上线记录 等 8 张表)
- 拆任务 (LLM 把需求拆成 1-10 个子任务)
- 推飞书群通知
- 老板决策 (把复杂问题变成 A/B/C 选择题)

当用户说:
- "记一下" / "新需求" / "我想做 X" → 调 create_requirement
- "看一下" / "有什么" / "查 X" → 调 query_bitable
- "拆任务" / "拆 X" → 调 decompose_task
- "决定 X" / "选 A" / "老板说 A" → 调 mark_decision

工具返回后用自然语言 + 关键信息回复 (如 ID、状态、URL)。

不要:
- 啰嗦 (1 段话能说完的别分段)
- 用 markdown 表格 (老板手机看)
- 重复用户的话

老板回复格式偏好:
- 一句话讲清结果
- 附上 ID / 链接
- 必要时给下一步选项`;

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
  tools: { type: "function"; function: { name: string; description: string; parameters: unknown } }[]
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
