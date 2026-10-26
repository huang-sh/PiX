import test from "node:test";
import assert from "node:assert/strict";
import paths, { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import type { HostClient } from "../src/host/client.js";
import { runTask, type RunView } from "../src/cli/run.js";
import type { ExtensionDialog, SessionSnapshot } from "../src/shared/types.js";

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

test("a successful final response supersedes earlier failed attempts in the same task", async () => {
  const before = snapshot("previous"), after = snapshot("current");
  after.entries.push(
    { id: "retry-error", type: "message", parentId: null, timestamp: "", message: { role: "assistant", stopReason: "error", errorMessage: "503 service unavailable" } },
    { id: "retry-success", type: "message", parentId: "retry-error", timestamp: "", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Recovered" }] } },
  );
  after.projection.nodes[0]!.rawEntryIds = ["cancelled-message", "retry-error", "retry-success"];
  const result = await runTask(client(after), before, "new task", "cancelled-turn", { requestId: "current" }, view());
  assert.equal(result.snapshot, after);
  // Reattaching to the saved successful run must also ignore its earlier errors.
  await runTask(client(after), after, "retry request", "cancelled-turn", { requestId: "current" }, view());
});

for (const windows of [false, true]) test(`branch input requests use ${windows ? "Windows" : "native"} paths and exclude siblings`, async t => {
  // Exercise Windows path semantics even when this suite runs on Unix.
  const joinMock = windows ? t.mock.method(paths, "join", paths.win32.join) : undefined;
  if (joinMock) syncBuiltinESMExports();
  try {
    const before = snapshot("previous"), running = snapshot("current"), settled = snapshot("current");
    const path = windows ? "C:\\workspace\\session.jsonl" : join(process.cwd(), "session.jsonl");
    for (const current of [before, running, settled]) {
      current.session.path = path;
      current.entries = []; current.projection.nodes = [];
      current.graph!.runs[0]!.branchId = "branch";
    }
    running.graph!.runs[0]!.status = "running";
    const own: ExtensionDialog = { id: "own", kind: "input", title: "Question", source: process.cwd(), sessionPath: join(`${path}.pix-tree`, "branch.jsonl") };
    const sibling = { ...own, id: "sibling", sessionPath: join(`${path}.pix-tree`, "sibling.jsonl") };
    const replies: unknown[] = [], shown: string[] = [];
    const fake = { ...client(running), async invoke(route: string, input?: unknown) {
      if (route === "ui.pending") return [sibling, own];
      if (route === "ui.respond") { replies.push(input); return true; }
      if (route === "session.snapshot") return settled;
      return running;
    } } as unknown as HostClient;
    await runTask(fake, before, "question", null, { requestId: "current" }, {
      ...view(), async dialog(dialog) { shown.push(dialog.id); return "answer"; },
    });
    assert.deepEqual(shown, ["own"]);
    assert.deepEqual(replies, [{ id: "own", value: "answer" }]);
    await assert.rejects(runTask(fake, before, "question", null, { requestId: "current" }), /Agent needs input: Question/);
  } finally {
    joinMock?.mock.restore();
    if (joinMock) syncBuiltinESMExports();
  }
});
