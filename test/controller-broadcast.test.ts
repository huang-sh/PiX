import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MainController, type Platform } from "../src/main/controller.js";
import type { SessionSnapshot } from "../src/shared/types.js";
import type { SessionUpdate } from "../src/shared/session-updates.js";
import { projectSession } from "../src/shared/session.js";
import { sessionEventDecoder } from "../src/shared/session-updates.js";
import { agentMessageContent } from "../src/shared/agent-stream.js";

const root = resolve(process.cwd(), "test", "workspace");
const platform: Platform = {
  async pickProject() {
    return undefined;
  },
  async pickSession() {
    return undefined;
  },
  async confirm() {
    return false;
  },
  async openExternal() {},
  showItemInFolder() {},
  quit() {},
};

test("resync replays current live progress for every branch even when no more tokens arrive", async () => {
  const controller = new MainController(null, platform);
  const current = { session: { path: "s" }, entries: [], projection: projectSession([], null), runtime: {},
    graph: { id: "s", epoch: "e", revision: 1, runs: [] } } as unknown as SessionSnapshot;
  controller.current = current;
  controller.emit({ type: "sessions", payload: { current } });
  const received: string[] = [];
  const decode = sessionEventDecoder(async () => assert.fail("checkpoint should decode without another resync"));
  controller.onEvent(event => {
    const decoded = decode(JSON.parse(JSON.stringify(event)));
    if (decoded?.type === "agent") received.push(agentMessageContent((decoded.payload as any).message, "text"));
  }, true);
  try {
    for (const branchId of ["A", "B"]) controller.emit({ type: "agent", payload: {
      type: "message_update", graphId: "s", branchId, runId: branchId + "1",
      message: { role: "assistant", content: [{ type: "text", text: branchId + " latest" }] },
    } });
    received.length = 0;
    await controller.invoke("session.snapshot");
    assert.deepEqual(received, ["A latest", "B latest"]);
    controller.emit({ type: "agent", payload: { type: "agent_settled", graphId: "s", branchId: "A", runId: "A1" } });
    received.length = 0;
    await controller.invoke("session.snapshot");
    assert.deepEqual(received, ["B latest"]);
    controller.current = { ...current, graph: { ...current.graph!, epoch: "restarted" } };
    received.length = 0;
    await controller.invoke("session.snapshot");
    assert.deepEqual(received, []);
  } finally { controller.dispose(); }
});

test("IPC subscribers get deltas and session.snapshot publishes a full resync without reopening", async () => {
  const controller = new MainController(null, platform);
  const before = { session: { path: "s" }, entries: [], projection: projectSession([], null), runtime: {},
    graph: { id: "s", epoch: "e", revision: 1, runs: [] } } as unknown as SessionSnapshot;
  const after = { ...before, graph: { ...before.graph!, revision: 2 } };
  const events: SessionUpdate[] = [];
  controller.onEvent(event => events.push(event.payload as SessionUpdate), true);
  controller.pi.open = async () => { throw Error("resync must not reopen or abort a session"); };
  controller.emit({ type: "sessions", payload: { current: before } });
  controller.current = after;
  controller.emit({ type: "sessions", payload: { current: after } });
  assert.equal(events[0]?.current, before);
  assert.equal(events[1]?.patch?.baseRevision, 1);
  assert.equal(events[1]?.current, undefined);
  assert.equal(await controller.invoke("session.snapshot"), after);
  assert.equal(events[2]?.current, after);
  assert.equal(events[2]?.resync, true);
  controller.dispose();
});

test("agent control broadcasts snapshots written after the last agent event", async () => {
  const controller = new MainController(root, platform);
  const snapshot = {
    session: { path: "session.jsonl" },
    projection: { nodes: [] },
  } as unknown as SessionSnapshot;
  controller.pi.control = async () => snapshot;
  const events: { type: string; payload: unknown }[] = [];
  controller.onEvent((event) => events.push(event as { type: string; payload: unknown }));

  const result = await controller.invoke("agent.control", { action: "prompt", text: "hello" });

  assert.equal(result, snapshot);
  assert.equal(controller.current, snapshot);
  // The prompt's node-footer record is appended after the final agent event,
  // so the refreshed snapshot must also go out on the broadcast channel —
  // not only through the invoke reply, which dies with a reloaded page.
  assert.deepEqual(events, [{ type: "sessions", payload: { current: snapshot } }]);
});

test("agent control actions without a projection response do not broadcast", async () => {
  const controller = new MainController(root, platform);
  controller.pi.control = async () => [{ provider: "zai", id: "glm-5.3" }];
  const events: { type: string; payload: unknown }[] = [];
  controller.onEvent((event) => events.push(event as { type: string; payload: unknown }));

  await controller.invoke("agent.control", { action: "getModels" });

  assert.deepEqual(events, []);
});

test("child lifecycle events use the graph owner's fresh snapshot without duplicating it", () => {
  const controller = new MainController(null, platform);
  const snapshot = { session: { path: "session.jsonl" }, projection: { nodes: [] } } as unknown as SessionSnapshot;
  let snapshots = 0;
  controller.pi.snapshot = () => { snapshots++; return snapshot; };
  const events: string[] = [];
  controller.onEvent(event => events.push(event.type));
  try {
    for (const type of ["message_end", "entry_appended", "agent_settled", "session_info_changed", "compaction_start", "compaction_end"]) {
      events.length = 0;
      controller.pi.emit({ type: "agent", payload: { type, graphId: "graph", branchId: "child", runId: "run" } });
      assert.equal(snapshots, 0, "raw child events must not publish stale worker state");
      controller.pi.emit({ type: "sessions", payload: { current: snapshot } });
      assert.deepEqual(events, ["agent", "sessions"]);
      assert.equal(controller.current, snapshot);
    }
    controller.pi.emit({ type: "agent", payload: { type: "entry_appended", graphId: "graph", branchId: "main", runId: "run" } });
    assert.equal(snapshots, 1, "main branch lifecycle still refreshes through the controller");
  } finally { controller.dispose(); }
});

test("compaction lifecycle events refresh and broadcast the snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-compaction-"));
  mkdirSync(join(dir, "ws"), { recursive: true });
  const controller = new MainController(join(dir, "ws"), platform);
  try {
    const snapshot = {
      session: { path: "session.jsonl" },
      projection: { nodes: [] },
    } as unknown as SessionSnapshot;
    controller.pi.snapshot = () => snapshot;
    const events: { type: string; payload?: { current?: SessionSnapshot } }[] = [];
    controller.onEvent((event) => events.push(event as { type: string; payload?: { current?: SessionSnapshot } }));

    controller.pi.emit({ type: "agent", payload: { type: "compaction_start" } });
    controller.pi.emit({ type: "agent", payload: { type: "compaction_end" } });

    const broadcast = events.filter((event) => event.type === "sessions");
    assert.equal(broadcast.length, 2);
    assert.equal(broadcast[0]?.payload?.current, snapshot);
    assert.equal(broadcast[1]?.payload?.current, snapshot);
  } finally {
    controller.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a page attached mid-run receives the settled node footer via broadcast", async () => {
  const faux = fauxProvider({
    models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }],
  });
  const dir = mkdtempSync(join(tmpdir(), "pix-broadcast-"));
  mkdirSync(join(dir, "ws"), { recursive: true });
  const controller = new MainController(join(dir, "ws"), platform);
  try {
    const originalFactory = controller.pi.factory.bind(controller.pi);
    controller.pi.factory = (pi: unknown) => async (args: unknown) => {
      const created = await originalFactory(pi)(args);
      created.services.modelRuntime.registerNativeProvider(faux.provider);
      return created;
    };
    await controller.invoke("agent.control", { action: "newSession" });
    await controller.invoke("agent.control", { action: "setModel", provider: "faux", modelId: "faux-1" });
    faux.setResponses([fauxAssistantMessage("the answer")]);

    // Only the broadcast channel is watched: the page that submitted the
    // prompt is gone (reload/HMR), so the invoke reply must be irrelevant.
    const broadcasts: SessionSnapshot[] = [];
    controller.onEvent((event) => {
      const current = (event as { type: string; payload?: { current?: SessionSnapshot } })
        .payload?.current;
      if ((event as { type: string }).type === "sessions" && current)
        broadcasts.push(current);
    });

    await controller.invoke("agent.control", { action: "prompt", text: "hello" });

    const last = broadcasts.at(-1);
    const node = last?.projection.nodes.at(-1);
    assert.ok(
      typeof node?.footer?.contextUsage?.tokens === "number",
      `final broadcast must carry the node footer usage, got ${JSON.stringify(node?.footer)}`,
    );
  } finally {
    controller.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
