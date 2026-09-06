// Progress carries cumulative content. Copy at display cadence, not per token.
// Keep lifecycle delivery ordered and outside the SDK persistence call stack.
export function agentEventForwarder(emit: (event: unknown) => void) {
  const updates = new Map<string, Record<string, unknown>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deliver = (event: Record<string, unknown>) => {
    try {
      const copy = structuredClone(event);
      setImmediate(() => { try { emit(copy); } catch {} });
    } catch {}
  };
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    for (const event of updates.values()) deliver(event);
    updates.clear();
  };
  return {
    push(event: Record<string, unknown>) {
      if (event.type === "message_update" || event.type === "tool_execution_update") {
        // This field repeats the full partial message; activity uses message.
        const { assistantMessageEvent: _partial, ...progress } = event;
        const key = event.type === "message_update" ? "message" : `tool:${event.toolCallId}`;
        updates.set(key, progress);
        timer ??= setTimeout(flush, 50);
      } else {
        flush();
        deliver(event);
      }
    },
    dispose() { clearTimeout(timer); updates.clear(); },
  };
}
