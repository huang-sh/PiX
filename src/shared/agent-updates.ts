import type { DesktopEvent } from "./types.js";
import { agentMessageContent, agentResultText } from "./agent-stream.js";

type Payload = Record<string, any>;
type TextPatch = { offset: number; value: string };
type Progress = { revision: number; text: string; thinking: string };
type ProgressPatch = { revision: number; baseRevision?: number; text: TextPatch; thinking: TextPatch };

export function agentProgressKey(p: Payload) {
  return JSON.stringify([p.graphId ?? null, p.branchId ?? null, p.runId ?? null,
    p.type?.startsWith("tool_execution_") ? p.toolCallId : null]);
}

export function isAgentProgress(event: DesktopEvent) {
  const p = event.payload as Payload;
  return event.type === "agent" && (p?.type === "tool_execution_update"
    || (p?.type === "message_update" && p.message?.role === "assistant"));
}

// Only active message/tool baselines survive; run restarts cannot reuse old text.
export function pruneAgentProgress<T>(event: DesktopEvent, cache: Map<string, T>) {
  if (event.type !== "agent") return;
  const p = event.payload as Payload;
  if (["agent_start", "agent_settled"].includes(p?.type)) {
    const scopeLength = p.type === "agent_start" ? 2 : 3;
    const scope = JSON.parse(agentProgressKey(p)).slice(0, scopeLength);
    for (const key of cache.keys()) {
      if (JSON.parse(key).slice(0, scopeLength).every((value: unknown, i: number) => value === scope[i])) cache.delete(key);
    }
  } else if (["message_start", "message_end", "tool_execution_start", "tool_execution_end"].includes(p?.type)) {
    if (!p.type.startsWith("message_") || p.message?.role === "assistant") cache.delete(agentProgressKey(p));
  }
}

function textPatch(before: string, after: string): TextPatch {
  const offset = after.startsWith(before) ? before.length : 0;
  return { offset, value: after.slice(offset) };
}

// Each IPC/WebSocket subscriber owns its baseline. A new/resynced subscriber
// gets full text first; subsequent updates carry only appended text (or a reset).
export function agentEventEncoder() {
  const cache = new Map<string, Progress>();
  return (event: DesktopEvent): DesktopEvent => {
    if (event.type === "sessions") cache.clear();
    pruneAgentProgress(event, cache);
    if (!isAgentProgress(event)) return event;
    const p = event.payload as Payload;
    const key = agentProgressKey(p);
    const previous = cache.get(key);
    const next = { revision: (previous?.revision ?? 0) + 1,
      text: p.type === "message_update" ? agentMessageContent(p.message, "text") : agentResultText(p.partialResult),
      thinking: p.type === "message_update" ? agentMessageContent(p.message, "thinking") : "" };
    const progress: ProgressPatch = { revision: next.revision, baseRevision: previous?.revision,
      text: textPatch(previous?.text ?? "", next.text), thinking: textPatch(previous?.thinking ?? "", next.thinking) };
    cache.set(key, next);
    const { message: _message, partialResult: _result, assistantMessageEvent: _partial, ...header } = p;
    return { ...event, payload: { ...header, progress } };
  };
}

export function agentEventDecoder(resync: () => void) {
  const cache = new Map<string, Progress>();
  return (event: DesktopEvent): DesktopEvent | undefined => {
    if (event.type === "sessions") cache.clear();
    pruneAgentProgress(event, cache);
    if (event.type !== "agent") return event;
    const p = event.payload as Payload;
    const patch = p?.progress as ProgressPatch | undefined;
    if (!patch) return event;
    const key = agentProgressKey(p);
    const before = patch.baseRevision === undefined ? undefined : cache.get(key);
    if (!["message_update", "tool_execution_update"].includes(p.type)
      || !Number.isInteger(patch.revision) || patch.revision !== (before?.revision ?? 0) + 1
      || (patch.baseRevision !== undefined && before?.revision !== patch.baseRevision)
      || typeof patch.text?.value !== "string" || typeof patch.thinking?.value !== "string"
      || !Number.isInteger(patch.text.offset) || patch.text.offset < 0 || patch.text.offset > (before?.text.length ?? 0)
      || !Number.isInteger(patch.thinking.offset) || patch.thinking.offset < 0 || patch.thinking.offset > (before?.thinking.length ?? 0)) {
      cache.delete(key);
      resync();
      return undefined;
    }
    const next = { revision: patch.revision,
      text: (before?.text ?? "").slice(0, patch.text.offset) + patch.text.value,
      thinking: (before?.thinking ?? "").slice(0, patch.thinking.offset) + patch.thinking.value };
    cache.set(key, next);
    const { progress: _progress, ...header } = p;
    return { ...event, payload: { ...header, ...(p.type === "message_update"
      ? { message: { role: "assistant", content: [{ type: "text", text: next.text }, { type: "thinking", thinking: next.thinking }] } }
      : { partialResult: next.text }) } };
  };
}
