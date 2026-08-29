import {
  restoreAgentMessage,
  type AgentMessage,
  type AgentMessageHistoryRow,
} from "./hermes-agent.ts";

export const HERMES_HISTORY_DEFAULT_LIMIT = 20;
export const HERMES_HISTORY_MIN_LIMIT = 1;
export const HERMES_HISTORY_MAX_LIMIT = 200;
export const HERMES_HISTORY_MIN_CANDIDATES = 100;
export const HERMES_HISTORY_MAX_CANDIDATES = 1000;

export interface HermesHistoryRow extends AgentMessageHistoryRow {
  message_seq?: number | string | null;
  created_at?: string | null;
}

export function normalizeHermesHistoryLimit(value: number): number {
  if (!Number.isFinite(value)) return HERMES_HISTORY_DEFAULT_LIMIT;
  return Math.min(
    HERMES_HISTORY_MAX_LIMIT,
    Math.max(HERMES_HISTORY_MIN_LIMIT, Math.floor(value))
  );
}

export function readHermesHistoryLimit(rawValue = process.env.HERMES_HISTORY_LIMIT): number {
  if (rawValue == null || rawValue.trim() === "") return HERMES_HISTORY_DEFAULT_LIMIT;
  if (!/^\d+$/.test(rawValue.trim())) return HERMES_HISTORY_DEFAULT_LIMIT;
  return normalizeHermesHistoryLimit(Number(rawValue));
}

export function hermesHistoryCandidateLimit(historyLimit: number): number {
  const normalizedLimit = normalizeHermesHistoryLimit(historyLimit);
  return Math.min(
    HERMES_HISTORY_MAX_CANDIDATES,
    Math.max(HERMES_HISTORY_MIN_CANDIDATES, normalizedLimit * 4)
  );
}

export function restoreHermesHistoryRows(
  rowsNewestFirst: HermesHistoryRow[],
  historyLimit: number
): AgentMessage[] {
  const chronologicalMessages = [...rowsNewestFirst].reverse().map(restoreAgentMessage);
  return completeHermesHistoryWindow(chronologicalMessages, historyLimit);
}

export function completeHermesHistoryWindow(
  messages: AgentMessage[],
  historyLimit: number
): AgentMessage[] {
  const groups = buildCompleteMessageGroups(messages);
  const limit = normalizeHermesHistoryLimit(historyLimit);
  const selectedGroups: AgentMessage[][] = [];
  let selectedMessageCount = 0;

  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (selectedGroups.length === 0 && group.length > limit) {
      selectedGroups.unshift(group);
      break;
    }
    if (selectedMessageCount + group.length > limit) break;

    selectedGroups.unshift(group);
    selectedMessageCount += group.length;
  }

  return selectedGroups.flat();
}

function buildCompleteMessageGroups(messages: AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (message.role === "tool") {
      index++;
      continue;
    }

    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
      const expectedToolCallIds = new Set(message.tool_calls.map((toolCall) => toolCall.id));
      const seenToolCallIds = new Set<string>();
      const group: AgentMessage[] = [message];
      let toolIndex = index + 1;

      while (toolIndex < messages.length && messages[toolIndex].role === "tool") {
        const toolMessage = messages[toolIndex];
        const toolCallId = toolMessage.tool_call_id;
        if (
          !toolCallId ||
          !expectedToolCallIds.has(toolCallId) ||
          seenToolCallIds.has(toolCallId)
        ) {
          break;
        }

        seenToolCallIds.add(toolCallId);
        group.push(toolMessage);
        toolIndex++;

        if (seenToolCallIds.size === expectedToolCallIds.size) break;
      }

      if (seenToolCallIds.size === expectedToolCallIds.size) {
        groups.push(group);
        index = toolIndex;
      } else {
        index++;
      }
      continue;
    }

    groups.push([message]);
    index++;
  }

  return groups;
}
