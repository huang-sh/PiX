import test from "node:test";
import assert from "node:assert/strict";
import type { HostClient } from "../src/host/client.js";
import { runTask, type RunView } from "../src/cli/run.js";
import type { SessionSnapshot } from "../src/shared/types.js";

const snapshot = (requestId: string) => ({
  session: { path: "/tmp/session.jsonl" },
  projection: { nodes: [{ id: "cancelled-turn", rawEntryIds: ["cancelled-message"] }] },
  entries: [{ id: "cancelled-message", type: "message", message: { role: "assistant", stopReason: "aborted", errorMessage: "Previous request was aborted" } }],
  graph: { runs: [{ requestId, runId: "run", branchId: "main", nodeId: "cancelled-turn", status: "idle" }] },
} as unknown as SessionSnapshot);
const view = (): RunView => ({ signal: new AbortController().signal, agent() {}, notice() {}, snapshot() {}, async dialog() { return undefined; } });
const client = (current: SessionSnapshot) => ({ connected: true, async invoke() { return current; },
  onEvent() { return () => {}; }, onDisconnect() { return () => {}; } } as unknown as HostClient);

test("a command with no new turn does not inherit the previous cancellation error", async () => {
  const result = await runTask(client(snapshot("command")), snapshot("cancelled"), "/extension-command", "cancelled-turn", { requestId: "command" }, view());
  assert.equal(result.nodeId, "cancelled-turn");
});

test("retrying the same failed request still reports its original error", async () => {
  const current = snapshot("cancelled");
  await assert.rejects(runTask(client(current), current, "same request", "cancelled-turn", { requestId: "cancelled" }, view()), /Previous request was aborted/);
});

test("a newly appended failed response still fails the current task", async () => {
  const before = snapshot("previous"), after = snapshot("current");
  after.entries.push({ id: "new-error", type: "message", parentId: null, timestamp: "", message: { role: "assistant", stopReason: "error", errorMessage: "New model failure" } });
  after.projection.nodes[0]!.rawEntryIds = ["cancelled-message", "new-error"];
  await assert.rejects(runTask(client(after), before, "new task", "cancelled-turn", { requestId: "current" }, view()), /New model failure/);
});
