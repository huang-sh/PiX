import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { projectSession } from "../../src/shared/session";
import { useSessionStore } from "../../src/renderer/stores/session";
import { desktop } from "../../src/renderer/api";
import type { SessionSnapshot } from "../../src/shared/types";

function snapshot(): SessionSnapshot {
  const entries = [
    { type: "message", id: "root", parentId: null, timestamp: "0", message: { role: "user", content: "root" } },
    { type: "message", id: "A:user", parentId: "root", timestamp: "1", message: { role: "user", content: "A" } },
    { type: "message", id: "B:user", parentId: "root", timestamp: "2", message: { role: "user", content: "B" } },
  ];
  return { session: { id: "s", path: "main.jsonl", cwd: ".", created: "0", modified: "0", messageCount: 3, firstMessage: "root" },
    entries, projection: projectSession(entries, "A:user"), runtime: { available: true, isStreaming: true } as SessionSnapshot["runtime"],
    graph: { id: "main.jsonl", epoch: "one", revision: 1, runs: [
      { branchId: "A", runId: "a1", nodeId: "turn:A:user", status: "running" },
      { branchId: "B", runId: "b1", nodeId: "turn:B:user", status: "running" },
    ] } };
}
describe("parallel session state", () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.mocked(desktop.invoke).mockReset(); });
  it("routes stream output by run and never lets another branch steal selection", () => {
    const store = useSessionStore(); store.applySnapshot(snapshot()); store.focusedNode = "turn:A:user";
    for (const [branchId, runId] of [["A", "a1"], ["B", "b1"]]) {
      store.onAgentEvent({ graphId: "main.jsonl", branchId, runId, type: "agent_start" });
      store.onAgentEvent({ graphId: "main.jsonl", branchId, runId, type: "message_start", message: { role: "assistant", content: [{ type: "text", text: branchId }] } });
    }
    expect(store.selectedActivity?.items[0]?.text).toBe("A");
    const next = snapshot(); next.graph!.revision = 2; store.applySnapshot(next);
    expect(store.focusedNode).toBe("turn:A:user");
    store.focusedNode = "turn:B:user";
    expect(store.selectedActivity?.items[0]?.text).toBe("B");
    store.onAgentEvent({ graphId: "main.jsonl", branchId: "B", runId: "stale", type: "agent_settled" });
    expect(store.selectedActivity?.active).toBe(true);
  });
  it("ignores old snapshots but accepts a restarted host epoch", () => {
    const store = useSessionStore(); const initial = snapshot(); initial.graph!.revision = 20; store.applySnapshot(initial);
    store.applySnapshot(snapshot()); expect(store.current?.graph?.revision).toBe(20);
    const restarted = snapshot(); restarted.graph!.epoch = "two"; store.applySnapshot(restarted);
    expect(store.current?.graph?.epoch).toBe("two");
  });
  it("recovers current-run output when start events arrived before the new run snapshot", () => {
    const store = useSessionStore(); store.applySnapshot(snapshot());
    const scope = { graphId: "main.jsonl", branchId: "A", runId: "a2" };
    // A reused branch can still have the previous run in the renderer when
    // lifecycle events arrive. They must not overwrite that run's activity.
    store.onAgentEvent({ ...scope, type: "agent_start" });
    store.onAgentEvent({ ...scope, type: "message_start", message: { role: "assistant", content: [] } });
    const next = snapshot(); next.graph!.revision = 2; next.graph!.runs[0]!.runId = "a2";
    store.applySnapshot(next); store.focusedNode = "turn:B:user";
    store.onAgentEvent({ ...scope, type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "A is still streaming" }] } });
    store.focusedNode = "turn:A:user";
    expect(store.selectedActivity?.items.at(-1)?.text).toBe("A is still streaming");
    expect(store.selectedActivity?.active).toBe(true);
    store.onAgentEvent({ ...scope, type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "A completed" }] } });
    store.onAgentEvent({ ...scope, type: "agent_settled" });
    expect(store.selectedActivity?.active).toBe(false);
    expect(store.selectedActivity?.items.at(-1)?.text).toBe("A completed");
    store.onAgentEvent({ ...scope, runId: "a1", type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "stale" }] } });
    expect(store.selectedActivity?.items.at(-1)?.text).toBe("A completed");
  });
  it("restores the parent selection when a command settles without creating a turn", () => {
    const store = useSessionStore();
    const pending = snapshot();
    pending.graph!.runs.push({ branchId: "C", runId: "c1", nodeId: null, status: "running",
      pending: { text: "/status", parentNodeId: "turn:root" } });
    store.applySnapshot(pending);
    store.focusedNode = "pending:c1";
    const settled = snapshot(); settled.graph!.revision = 2;
    settled.graph!.runs.push({ branchId: "C", runId: "c1", nodeId: null, status: "idle" });
    store.applySnapshot(settled);
    expect(store.focusedNode).toBe("turn:root");
  });

  it("submits a scoped request without navigating or changing the active runtime", async () => {
    const store = useSessionStore(); store.applySnapshot(snapshot());
    vi.mocked(desktop.invoke).mockImplementation(async (_route, input: any) => {
      const response = snapshot(); response.graph!.revision = 2;
      response.graph!.runs.push({ branchId: "C", runId: "c1", requestId: input.requestId, nodeId: null,
        status: "running", pending: { text: "C", parentNodeId: "turn:root" } });
      return response as any;
    });
    await store.promptAt("turn:root", "C");
    expect(desktop.invoke).toHaveBeenCalledTimes(1);
    expect(desktop.invoke).toHaveBeenCalledWith("agent.control", expect.objectContaining({ action: "promptAt", nodeId: "turn:root", text: "C" }));
    expect(store.focusedNode).toBe("pending:c1");
    expect(store.messageWindow(40).messages.at(-1)?.text).toBe("C");
  });
});
