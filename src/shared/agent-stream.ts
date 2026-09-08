import type { AgentActivity, AgentActivityItem } from "./types.js";
import { withoutToolLabels } from "./session.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function agentMessageContent(message: unknown, key: "text" | "thinking") {
  const parts = record(message)?.content;
  if (!Array.isArray(parts)) return "";
  const text = parts
    .map((part) => record(part)?.[key])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return key === "text" ? withoutToolLabels(text) : text;
}

export function agentResultText(value: unknown): string {
  if (typeof value === "string") return value;
  const result = record(value);
  const parts = result?.content;
  if (Array.isArray(parts)) {
    return parts
      .map((part) => record(part)?.text)
      .filter((text): text is string => typeof text === "string")
      .join("\n");
  }
  return result ? JSON.stringify(result) : "";
}

function inputText(value: unknown): string {
  if (typeof value === "string") return value;
  const args = record(value);
  for (const key of ["command", "path", "query", "pattern", "url"]) {
    if (typeof args?.[key] === "string") return args[key];
  }
  return value === undefined ? "" : JSON.stringify(value);
}

function failureText(message: unknown): string | undefined {
  const m = record(message);
  if (m?.stopReason !== "error") return undefined;
  const value = m.errorMessage;
  return typeof value === "string" && value.trim() ? value : "";
}

function updateItem(
  activity: AgentActivity,
  id: string,
  patch: Partial<AgentActivityItem>,
): AgentActivity {
  return {
    ...activity,
    items: activity.items.map((item) => item.id === id ? { ...item, ...patch } : item),
  };
}

/** Mirrors Pi TUI's message/tool lifecycle while keeping Electron events untyped. */
export function reduceAgentActivity(
  activity: AgentActivity | undefined,
  raw: unknown,
): AgentActivity | undefined {
  const event = record(raw);
  if (!event) return activity;
  const type = event?.type;
  const assistantEvent = ["message_start", "message_update", "message_end"].includes(String(type))
    && record(event.message)?.role === "assistant";
  const toolEvent = ["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(String(type));
  // A view may miss the start while a reused branch's new run is being
  // admitted. Cumulative progress must recover instead of being lost forever.
  if (!activity && (assistantEvent || toolEvent)) {
    activity = { startedAt: new Date().toISOString(), pass: 1, active: true, items: [], partial: true };
  }
  if (type === "agent_start") {
    if (!activity || !activity.active) {
      return {
        startedAt: new Date().toISOString(),
        pass: 1,
        active: true,
        items: [],
      };
    }
    return { ...activity, pass: activity.pass + 1 };
  }
  if (!activity) return undefined;
  if (type === "agent_settled") {
    return { ...activity, active: false, currentAssistantId: undefined };
  }

  const message = event.message;
  const role = record(message)?.role;
  if (type === "message_start" && role === "assistant") {
    const id = `assistant:${activity.pass}:${activity.items.length}`;
    return {
      ...activity,
      currentAssistantId: id,
      items: [...activity.items, {
        id,
        kind: "assistant",
        text: agentMessageContent(message, "text"),
        thinking: agentMessageContent(message, "thinking"),
        timestamp: new Date().toISOString(),
        status: "running",
        pass: activity.pass,
      }],
    };
  }
  if ((type === "message_update" || type === "message_end") && role === "assistant") {
    if (!activity.currentAssistantId) {
      activity = reduceAgentActivity(activity, { ...event, type: "message_start" })!;
    }
    const id = activity.currentAssistantId!;
    const failure = failureText(message);
    return {
      ...updateItem(activity, id, {
        text: agentMessageContent(message, "text"),
        thinking: agentMessageContent(message, "thinking"),
        status: type === "message_end" ? (failure === undefined ? "complete" : "error") : "running",
        ...(failure === undefined ? {} : { errorMessage: failure }),
      }),
      currentAssistantId: type === "message_end" ? undefined : id,
    };
  }

  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
  if (!toolCallId) return activity;
  const id = `tool:${toolCallId}`;
  if (type !== "tool_execution_start" && toolEvent && !activity.items.some(item => item.id === id)) {
    activity = reduceAgentActivity(activity, { ...event, type: "tool_execution_start" })!;
  }
  if (type === "tool_execution_start") {
    return {
      ...activity,
      items: [...activity.items.filter((item) => item.id !== id), {
        id,
        kind: "tool",
        title: typeof event.toolName === "string" ? event.toolName : "Tool",
        input: inputText(event.args),
        text: "",
        timestamp: new Date().toISOString(),
        status: "running",
        pass: activity.pass,
      }],
    };
  }
  if (type === "tool_execution_update") {
    return updateItem(activity, id, {
      text: agentResultText(event.partialResult),
      status: "running",
    });
  }
  if (type === "tool_execution_end") {
    return updateItem(activity, id, {
      text: agentResultText(event.result),
      status: event.isError === true ? "error" : "complete",
    });
  }
  return activity;
}
