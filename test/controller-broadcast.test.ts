import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MainController, type Platform } from "../src/main/controller.js";
import type { SessionSnapshot } from "../src/shared/types.js";

const root = resolve(process.cwd(), "test-workspace");
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
  quit() {},
};

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
