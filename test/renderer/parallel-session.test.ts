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
    expect(store.selectedMessages.at(-1)?.text).toBe("C");
  });
});
