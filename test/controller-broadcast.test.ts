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

// Settled sessions are remembered into PIX_HOME's settings.json (rememberSnapshot),
// so without an isolated home these tests would enroll their temp workspaces in
// the developer's real session panel.
const home = mkdtempSync(join(tmpdir(), "pix-broadcast-home-"));
process.env.PIX_HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

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

test("switching sessions keeps the other session's live progress for its return", async () => {
  const controller = new MainController(root, platform);
  const snapshotOf = (path: string): SessionSnapshot => ({
    session: { path }, entries: [], projection: projectSession([], null), runtime: {} as never,
    graph: { id: path, epoch: "e", revision: 1, runs: [] },
  }) as unknown as SessionSnapshot;
  const runtimes = new Map<string, { open(): Promise<void>; snapshot(): SessionSnapshot; state(): unknown; emit?(event: unknown): void }>();
  controller.createSessionRuntime = entry => {
    const runtime = { open: async () => {}, snapshot: () => snapshotOf(entry.path), state: () => ({}) };
    runtimes.set(entry.path, runtime);
    return runtime as never;
  };
  const received: string[] = [];
  const decode = sessionEventDecoder(async () => assert.fail("replay should decode without another resync"));
  controller.onEvent(event => {
    const decoded = decode(JSON.parse(JSON.stringify(event)));
    if (decoded?.type === "agent") received.push(agentMessageContent((decoded.payload as any).message, "text"));
  }, true);
  const stamped: unknown[] = [];
  controller.onEvent(event => {
    const payload = (event as { type: string; payload?: { graphId?: string } }).payload;
    if ((event as { type: string }).type === "agent" && payload) stamped.push(payload.graphId);
  });
  try {
    await controller.registry.open(controller.project!, null, "a.jsonl");
    // An unscoped main-line event identifies its session once routed.
    runtimes.get("a.jsonl")!.emit!({ type: "agent", payload: {
      type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "A streaming" }] },
    } });
    assert.ok(stamped.includes("a.jsonl"), "unscoped events are stamped with their session path");

    await controller.registry.open(controller.project!, null, "b.jsonl");
    received.length = 0;
    // Tokens arriving while a runs in the background are recorded for its
    // return, never forwarded to the session in view.
    runtimes.get("a.jsonl")!.emit!({ type: "agent", payload: {
      type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "A streaming more" }] },
    } });
    assert.deepEqual(received, [], "background token streams stay off the wire");

    await controller.invoke("session.snapshot");   // b is in view: a's progress must not leak
    assert.deepEqual(received, []);

    await controller.registry.open(controller.project!, null, "a.jsonl");
    received.length = 0;
    await controller.invoke("session.snapshot");
    assert.deepEqual(received, ["A streaming more"], "returning to a session replays its own progress");
  } finally { controller.dispose(); }
});

test("epoch records are pruned to the live set", async () => {
  const controller = new MainController(root, platform);
  const snapshotOf = (path: string): SessionSnapshot => ({
    session: { path }, entries: [], projection: projectSession([], null), runtime: {} as never,
    graph: { id: path, epoch: "e", revision: 1, runs: [] },
  }) as unknown as SessionSnapshot;
  controller.createSessionRuntime = entry =>
    ({ open: async () => {}, snapshot: () => snapshotOf(entry.path), state: () => ({}), close: async () => {} }) as never;
  const epochs = () => (controller as unknown as { liveProgressEpochs: Map<string, unknown> }).liveProgressEpochs;
  const note = (path: string) => controller.emit({ type: "sessions", payload: { current: snapshotOf(path) } });
  const stream = (graphId: string) => ({ type: "agent", payload: {
    type: "message_update", graphId, message: { role: "assistant", content: [{ type: "text", text: "streaming" }] },
  } } as never);
  try {
    await controller.registry.open(controller.project!, null, "a.jsonl");
    await controller.registry.open(controller.project!, null, "b.jsonl");
    note("a.jsonl");
    note("b.jsonl");
    assert.deepEqual([...epochs().keys()].sort(), ["a.jsonl", "b.jsonl"], "live entries keep their records");

    // A viewed session without a live entry (a remote host's, say) keeps its
    // record, and its stream keeps it across the view switch until it settles.
    controller.current = snapshotOf("r.jsonl");
    note("r.jsonl");
    controller.emit(stream("r.jsonl"));
    controller.current = snapshotOf("b.jsonl");
    note("b.jsonl");
    assert.ok(epochs().has("r.jsonl"), "a mid-stream session keeps its record without a live entry");
    controller.emit({ type: "agent", payload: { type: "message_end", graphId: "r.jsonl",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] } } } as never);
    note("b.jsonl");
    assert.ok(!epochs().has("r.jsonl"), "the record dies with its last baseline");

    await controller.registry.dispose("a.jsonl");
    note("b.jsonl");
    assert.deepEqual([...epochs().keys()].sort(), ["b.jsonl"],
      "a disposed session's record goes with it; live entries survive every pass");
  } finally { controller.dispose(); }
});

test("a disposed runtime's late events record no baseline and reach no listener", async () => {
  const controller = new MainController(root, platform);
  const snapshotOf = (path: string): SessionSnapshot => ({
    session: { path }, entries: [], projection: projectSession([], null), runtime: {} as never,
    graph: { id: path, epoch: "e", revision: 1, runs: [] },
  }) as unknown as SessionSnapshot;
  controller.createSessionRuntime = entry =>
    ({ open: async () => {}, snapshot: () => snapshotOf(entry.path), state: () => ({}), close: async () => {} }) as never;
  const seen: string[] = [];
  controller.onEvent(event => seen.push((event as { type: string }).type));
  try {
    await controller.registry.open(controller.project!, null, "a.jsonl");
    const runtime = controller.registry.entry("a.jsonl")!.runtime as unknown as { emit(e: unknown): void };
    await controller.registry.dispose("a.jsonl");
    // The abort settling during a close can still fire the sink; it must not
    // record a baseline nothing will invalidate when the session reopens.
    runtime.emit({ type: "agent", payload: { type: "message_update", graphId: "a.jsonl",
      message: { role: "assistant", content: [{ type: "text", text: "straggler" }] } } });
    runtime.emit({ type: "notice", payload: { level: "error", message: "straggler" } });
    controller.current = snapshotOf("a.jsonl");
    await controller.invoke("session.snapshot");
    assert.deepEqual(seen, ["sessions"], "a closed runtime's stragglers stay off the wire and out of the replay");
  } finally { controller.dispose(); }
});

test("IPC subscribers get deltas and session.snapshot publishes a full resync without reopening", async () => {
  const controller = new MainController(null, platform);
  const before = { session: { path: "s" }, entries: [], projection: projectSession([], null), runtime: {},
    graph: { id: "s", epoch: "e", revision: 1, runs: [] } } as unknown as SessionSnapshot;
  const after = { ...before, graph: { ...before.graph!, revision: 2 } };
  const events: SessionUpdate[] = [];
  controller.onEvent(event => events.push(event.payload as SessionUpdate), true);
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
  controller.registry.activeOf = () => ({ runtime: { control: async () => snapshot } }) as never;
  controller.registry.isActive = () => true;
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
  controller.projectRuntime.control = async () => [{ provider: "zai", id: "glm-5.3" }];
  const events: { type: string; payload: unknown }[] = [];
  controller.onEvent((event) => events.push(event as { type: string; payload: unknown }));

  await controller.invoke("agent.control", { action: "getModels" });

  assert.deepEqual(events, []);
});

test("remote agent events of background host sessions stay off the view", () => {
  const controller = new MainController(root, platform);
  try {
    controller.project = { name: "remote", path: "/remote", remote: { kind: "ssh", host: "host" } };
    controller.installSlot({
      connected: true, onEvent: () => () => {}, onDisconnect: () => () => {}, dispose: async () => {},
    } as never, controller.project, controller.settings.bundle()).activePath = "r.jsonl";
    const current = { session: { path: "r.jsonl" }, entries: [], projection: projectSession([], null), runtime: {},
      graph: { id: "r.jsonl", epoch: "e", revision: 1, runs: [] } } as unknown as SessionSnapshot;
    controller.current = current;
    const seen: string[] = [];
    controller.onEvent(event => {
      const payload = (event as { type: string; payload?: { graphId?: string } }).payload;
      seen.push((event as { type: string }).type + ":" + (payload?.graphId ?? ""));
    });
    const message = (graphId: string) => ({ type: "agent", payload: {
      type: "message_update", graphId, message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    } } as never);

    controller.remoteEvent(message("other.jsonl"));
    assert.deepEqual(seen, [], "a background host session's events are recorded, not forwarded");
    controller.remoteEvent(message("r.jsonl"));
    assert.deepEqual(seen, ["agent:r.jsonl"], "the viewed remote session's events pass");
  } finally { controller.dispose(); }
});

test("child lifecycle events use the graph owner's fresh snapshot without duplicating it", async () => {
  const controller = new MainController(root, platform);
  const snapshot = { session: { path: "session.jsonl" }, projection: { nodes: [] } } as unknown as SessionSnapshot;
  let snapshots = 0;
  const runtime: { open(): Promise<void>; snapshot(): SessionSnapshot; emit?(event: unknown): void } = {
    open: async () => {},
    snapshot: () => { snapshots++; return snapshot; },
  };
  controller.createSessionRuntime = () => runtime as never;
  await controller.registry.open(controller.project!, null, "session.jsonl");
  snapshots = 0;   // the open reply itself takes one snapshot
  const events: string[] = [];
  controller.onEvent(event => events.push(event.type));
  try {
    for (const type of ["message_end", "entry_appended", "agent_settled", "session_info_changed", "compaction_start", "compaction_end"]) {
      events.length = 0;
      runtime.emit!({ type: "agent", payload: { type, graphId: "graph", branchId: "child", runId: "run" } });
      assert.equal(snapshots, 0, "raw child events must not publish stale worker state");
      runtime.emit!({ type: "sessions", payload: { current: snapshot } });
      assert.deepEqual(events, ["agent", "sessions"]);
      assert.equal(controller.current, snapshot);
    }
    runtime.emit!({ type: "agent", payload: { type: "entry_appended", graphId: "graph", branchId: "main", runId: "run" } });
    assert.equal(snapshots, 1, "main branch lifecycle still refreshes through the controller");
  } finally { controller.dispose(); }
});

test("compaction lifecycle events refresh and broadcast the snapshot", async () => {
  const controller = new MainController(root, platform);
  const snapshot = {
    session: { path: "session.jsonl" },
    projection: { nodes: [] },
  } as unknown as SessionSnapshot;
  const runtime: { open(): Promise<void>; snapshot(): SessionSnapshot; emit?(event: unknown): void } = {
    open: async () => {},
    snapshot: () => snapshot,
  };
  controller.createSessionRuntime = () => runtime as never;
  await controller.registry.open(controller.project!, null, "session.jsonl");
  const events: { type: string; payload?: { current?: SessionSnapshot } }[] = [];
  controller.onEvent((event) => events.push(event as { type: string; payload?: { current?: SessionSnapshot } }));

  runtime.emit!({ type: "agent", payload: { type: "compaction_start" } });
  runtime.emit!({ type: "agent", payload: { type: "compaction_end" } });

  const broadcast = events.filter((event) => event.type === "sessions");
  assert.equal(broadcast.length, 2);
  assert.equal(broadcast[0]?.payload?.current, snapshot);
  assert.equal(broadcast[1]?.payload?.current, snapshot);
  controller.dispose();
});

test("a page attached mid-run receives the settled node footer via broadcast", async () => {
  const faux = fauxProvider({
    models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }],
  });
  const dir = mkdtempSync(join(tmpdir(), "pix-broadcast-"));
  mkdirSync(join(dir, "ws"), { recursive: true });
  const controller = new MainController(join(dir, "ws"), platform);
  try {
    const original = controller.createSessionRuntime.bind(controller);
    controller.createSessionRuntime = entry => {
      const runtime = original(entry);
      const factory = runtime.factory.bind(runtime);
      runtime.factory = (pi: unknown) => async (args: unknown) => {
        const created = await factory(pi as never)(args as never);
        created.services.modelRuntime.registerNativeProvider(faux.provider);
        return created;
      };
      return runtime;
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
