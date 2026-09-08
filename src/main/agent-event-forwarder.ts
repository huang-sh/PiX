import { agentResultText } from "../shared/agent-stream.js";

// Dispatch every event on the next event-loop turn, outside SDK persistence.
// Progress strings are immutable: capture them without cloning the growing body.
export function agentEventForwarder(emit: (event: unknown) => void) {
  let disposed = false;
  return {
    push(event: Record<string, unknown>) {
      if (disposed) return;
      try {
        const { assistantMessageEvent: _partial, ...copy } = event;
        if (event.type === "message_update") {
          const message = event.message as { role?: string; content?: Array<{ type?: string; text?: string; thinking?: string }> };
          copy.message = { role: message?.role, content: message?.content?.map(({ type, text, thinking }) => ({ type, text, thinking })) };
        } else if (event.type === "tool_execution_update") {
          copy.partialResult = agentResultText(event.partialResult);
        }
        const captured = event.type === "message_update" || event.type === "tool_execution_update"
          ? copy : structuredClone(copy);
        setImmediate(() => { if (!disposed) { try { emit(captured); } catch {} } });
      } catch {}
    },
    dispose() { disposed = true; },
  };
}
