import { createPinia, setActivePinia } from "pinia";
import { expect, it } from "vitest";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";

it("bounds diagnostics and never serializes streaming payloads or session history", () => {
  setActivePinia(createPinia());
  const store = useWorkspaceStore();
  const large = { toJSON() { throw new Error("History/progress must not be serialized for logging"); } };
  for (let i = 0; i < 1000; i++) {
    store.record({ type: "agent", payload: { type: "message_update", message: large } });
    store.record({ type: "agent", payload: { type: "tool_execution_update", partialResult: large } });
  }
  expect(store.events).toHaveLength(0);
  for (let i = 0; i < 300; i++) store.record({ type: "sessions", payload: { current: {
    session: { path: "test.jsonl" }, entries: large, projection: { nodes: [] }, graph: { revision: i },
  } } });
  expect(store.events).toHaveLength(200);
  expect(store.events[0]).toContain('"revision":299');
  store.record({ type: "agent", payload: { type: "message_end", branchId: "A", message: large } });
  expect(store.events[0]).toContain('"branchId":"A"');
  store.record({ type: "shell", payload: { chunk: "shell output" } });
  expect(store.utilityOutput).toContain("shell output");
});
