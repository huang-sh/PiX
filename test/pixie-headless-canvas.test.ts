import test from "node:test";
import assert from "node:assert/strict";
import { headlessCanvas, type HeadlessCanvasDeps } from "../src/main/pixie-headless-canvas.js";
import { canvasCommand } from "../src/shared/canvas.js";
import { PROJECT_ROUTES } from "../src/shared/remote-protocol.js";
import { projectSession } from "../src/shared/session.js";
import type { AgentControl, ProjectInfo, SessionSnapshot, SessionSummary } from "../src/shared/types.js";

const project: ProjectInfo = { name: "work", path: "/work" };
const sessionPath = "/work/.pi/sessions/s1.jsonl";

function snapshot(status: "running" | "idle" = "idle", withGraph = true) {
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-11-08", message: { role: "user", content: "fix the login" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-11-08", message: { role: "assistant", content: "done" } },
  ] as never;
  return { session: { id: "s1", path: sessionPath }, entries, projection: {
      ...projectSession(entries, "a1"),
      nodes: [{ id: "turn:u1", parentId: null, title: "fix the login", preview: "done", running: status === "running",
        hasError: false, forkable: status !== "running", continuable: true, branchId: "main", leafEntryId: "a1", timestamp: "2026-11-08" }],
    }, runtime: { available: true },
    ...(withGraph ? { graph: { id: sessionPath, revision: 1,
      runs: status === "running" ? [{ runId: "run-1", branchId: "main", nodeId: "turn:u1", status: "running" }] : [] } } : {}) } as unknown as SessionSnapshot;
}

function deps(current = snapshot(), overrides: Partial<HeadlessCanvasDeps> = {}): HeadlessCanvasDeps & { controls: AgentControl[]; reads: Array<{ leafId: string; limit?: number }> } {
  const controls: AgentControl[] = [];
  const reads: Array<{ leafId: string; limit?: number }> = [];
  return {
    project: () => project,
    listSessions: async () => [{ id: "s1", path: sessionPath, cwd: "/work", created: "2026-11-08", modified: "2026-11-08", messageCount: 2, firstMessage: "fix" } satisfies SessionSummary],
    openSession: async () => current,
    createSession: async () => current,
    control: async (_path, input) => { controls.push(input); return current; },
    read: async (_path, leafId, limit) => { reads.push({ leafId, limit }); return { messages: [], hasEarlier: false }; },
    ...overrides,
    controls, reads,
  };
}

test("inspect picks the latest session and mirrors the visible-canvas shape", async () => {
  const f = deps();
  const canvas = headlessCanvas(f);
  const result = await canvas(canvasCommand({ action: "inspect" })) as { context: string; session: { path: string }; nodes: Array<{ id: string }>; totalNodes: number };
  assert.equal(result.context, `h:${sessionPath}`);
  assert.equal(result.session.path, sessionPath);
  assert.equal(result.nodes[0]!.id, "turn:u1");
  assert.equal(result.totalNodes, 1);
});

test("inspect reports an empty project instead of failing", async () => {
  const canvas = headlessCanvas(deps(snapshot(), { listSessions: async () => [] }));
  const result = await canvas(canvasCommand({ action: "inspect" })) as { session: null; nodes: unknown[] };
  assert.equal(result.session, null);
  assert.deepEqual(result.nodes, []);
});

test("read serves the node's window and rejects unknown nodes", async () => {
  const f = deps();
  const canvas = headlessCanvas(f);
  const context = ((await canvas(canvasCommand({ action: "inspect" }))) as { context: string }).context;
  const result = await canvas(canvasCommand({ action: "read", context, nodeId: "turn:u1", limit: 10 })) as { node: { id: string }; messages: unknown[] };
  assert.equal(result.node.id, "turn:u1");
  assert.deepEqual(f.reads, [{ leafId: "a1", limit: 10 }]);
  await assert.rejects(canvas(canvasCommand({ action: "read", context, nodeId: "missing" })), /Canvas node not found/);
});

test("steer addresses the node's running branch; a settled branch is rejected", async () => {
  const f = deps(snapshot("running"));
  const canvas = headlessCanvas(f);
  const context = ((await canvas(canvasCommand({ action: "inspect" }))) as { context: string }).context;
  await canvas(canvasCommand({ action: "steer", context, nodeId: "turn:u1", text: "hurry" }));
  assert.deepEqual(f.controls, [{ action: "steer", text: "hurry", images: undefined, graphId: sessionPath, branchId: "main", runId: "run-1" }]);
  const settled = headlessCanvas(deps(snapshot("idle")));
  const settledContext = ((await settled(canvasCommand({ action: "inspect" }))) as { context: string }).context;
  await assert.rejects(settled(canvasCommand({ action: "steer", context: settledContext, nodeId: "turn:u1", text: "hurry" })), /no longer running/);
});

test("stop aborts the running branch; view operations fail with a clear reason", async () => {
  const f = deps(snapshot("running"));
  const canvas = headlessCanvas(f);
  const context = ((await canvas(canvasCommand({ action: "inspect" }))) as { context: string }).context;
  await canvas(canvasCommand({ action: "stop", context, nodeId: "turn:u1" }));
  assert.deepEqual(f.controls, [{ action: "branchAbort", graphId: sessionPath, branchId: "main", runId: "run-1" }]);
  await assert.rejects(canvas(canvasCommand({ action: "select", context, nodeId: "turn:u1" })), /needs the desktop canvas/);
  await assert.rejects(canvas(canvasCommand({ action: "compose", context, nodeId: null, text: "draft" })), /needs the desktop canvas/);
});

test("a stale context is rejected until the next inspect", async () => {
  const canvas = headlessCanvas(deps());
  await canvas(canvasCommand({ action: "inspect" }));
  await assert.rejects(canvas(canvasCommand({ action: "read", context: "h:/other.jsonl", nodeId: "turn:u1" })), /session changed/);
});

test("newSession mints a fresh context", async () => {
  const created = { ...snapshot(), session: { id: "s2", path: "/work/.pi/sessions/s2.jsonl" } } as SessionSnapshot;
  const f = deps(snapshot(), { createSession: async () => created, openSession: async () => created });
  const canvas = headlessCanvas(f);
  const first = ((await canvas(canvasCommand({ action: "inspect" }))) as { context: string }).context;
  const reply = await canvas(canvasCommand({ action: "newSession", context: first })) as { context: string; session: { path: string } };
  assert.equal(reply.context, "h:/work/.pi/sessions/s2.jsonl");
  assert.equal(reply.session.path, "/work/.pi/sessions/s2.jsonl");
});

test("client routes expose the conversational Pixie surface only", () => {
  for (const route of ["pixie.ensure", "pixie.send", "pixie.stop", "pixie.newSession", "pixie.tasks"])
    assert.ok((PROJECT_ROUTES as readonly string[]).includes(route), `${route} is client-invokable`);
  for (const desktopOnly of ["pixie.clearHistory", "pixie.reload", "pixie.previewPrompt", "pixie.reveal"])
    assert.ok(!(PROJECT_ROUTES as readonly string[]).includes(desktopOnly), `${desktopOnly} stays desktop-only`);
});
