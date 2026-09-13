import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MainController, type Platform } from "../src/main/controller.js";
import type { SessionSnapshot } from "../src/shared/types.js";

// Sessions are remembered into PIX_HOME's settings.json, so without an
// isolated home these tests would enroll their temp workspaces in the
// developer's real session panel.
const home = mkdtempSync(join(tmpdir(), "pix-registry-home-"));
process.env.PIX_HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

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

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error("Timed out waiting for controller state");
}

const workspace = () => mkdtempSync(join(tmpdir(), "pix-registry-ws-"));

function injectFaux(controller: MainController, faux: ReturnType<typeof fauxProvider>) {
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
}

/** Starts a gated run on a fresh session; `finish()` completes it. */
async function startGatedRun(controller: MainController, faux: ReturnType<typeof fauxProvider>, text: string) {
  await controller.invoke("agent.control", { action: "newSession" });
  await controller.invoke("agent.control", { action: "setModel", provider: "faux", modelId: "faux-1" });
  const path = controller.current!.session.path;
  const entry = controller.registry.entry(path)!;
  let release!: () => void;
  faux.setResponses([async (_context: unknown, options?: { signal?: AbortSignal }) => {
    await Promise.race([
      new Promise<void>(r => { release = r; }),
      new Promise<void>(r => options?.signal?.addEventListener("abort", () => r(), { once: true })),
    ]);
    if (options?.signal?.aborted) return fauxAssistantMessage("", { stopReason: "aborted" });
    return fauxAssistantMessage(text);
  }]);
  // A prompt invoke settles only when the whole turn does; keep it pending.
  const pending = controller.invoke("agent.control", { action: "prompt", text: "hello" }).catch(() => {});
  await until(() => entry.runtime!.snapshot().graph!.runs.some(run => run.status === "running"));
  return {
    path,
    entry,
    finish: async () => {
      release();
      await pending;
      await until(() => entry.runtime!.snapshot().graph!.runs.every(run => run.status !== "running"));
    },
  };
}

test("switching sessions keeps a background run alive and returns its full answer", { timeout: 30000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }] });
    injectFaux(controller, faux);
    const first = await startGatedRun(controller, faux, "the background answer");

    await controller.invoke("agent.control", { action: "newSession" });
    assert.notEqual(controller.current!.session.path, first.path);
    await until(() => controller.registry.entry(first.path)!.runtime!.snapshot().graph!.runs.some(run => run.status === "running"));
    await first.finish();

    const resumed = await controller.invoke("session.open", { path: first.path }) as SessionSnapshot;
    assert.equal(controller.current!.session.path, first.path);
    assert.ok(JSON.stringify(resumed.entries).includes("the background answer"), "switching back shows the completed answer");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("creating a session is silent and never interrupts the running one", { timeout: 30000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const notices: unknown[] = [];
    controller.onEvent(event => { if ((event as { type: string }).type === "notice") notices.push(event); });
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }] });
    injectFaux(controller, faux);
    const first = await startGatedRun(controller, faux, "settled later");

    await controller.invoke("agent.control", { action: "newSession" });
    assert.deepEqual(notices, [], "a new session reports nothing");
    assert.equal(controller.current!.projection.nodes.length, 0, "the fresh graph is empty");
    await until(() => controller.registry.entry(first.path)!.runtime!.snapshot().graph!.runs.some(run => run.status === "running"));
    await first.finish();
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("background completions refresh history and the list without touching the view", { timeout: 30000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }] });
    injectFaux(controller, faux);
    const first = await startGatedRun(controller, faux, "background output");
    await controller.invoke("agent.control", { action: "newSession" });
    const viewPath = controller.current!.session.path;

    const viewSnapshots: string[] = [];
    let listRefreshes = 0;
    controller.onEvent(event => {
      const pushed = event as { type: string; payload?: { current?: SessionSnapshot; sessions?: unknown[] } };
      if (pushed.type !== "sessions") return;
      if (pushed.payload?.current) viewSnapshots.push(pushed.payload.current.session.path);
      else if (pushed.payload?.sessions) listRefreshes++;
    });

    await first.finish();
    await until(() => listRefreshes > 0);
    assert.ok(viewSnapshots.every(path => path === viewPath), `only the session in view may drive snapshots: ${viewSnapshots}`);
    const recorded = controller.settings.projectHistory()
      .find(record => record.project.path === ws)?.sessions
      .find(session => session.path === first.path);
    assert.equal(recorded?.firstMessage, "hello", "the background run is remembered in its project");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a background run keeps its history in its own project across project switches", { timeout: 30000 }, async () => {
  const first = workspace(), second = workspace();
  const controller = new MainController(first, platform);
  try {
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }] });
    injectFaux(controller, faux);
    const run = await startGatedRun(controller, faux, "cross project answer");

    controller.configure(second);
    assert.equal(controller.current, undefined, "entering another project shows no session");
    assert.ok(controller.registry.entry(run.path)?.runtime, "the other project's entry survives the switch");
    assert.equal(controller.registry.isActive(run.entry), false, "only the project in view has an active session");
    await until(() => controller.registry.entry(run.path)!.runtime!.snapshot().graph!.runs.some(run => run.status === "running"));
    await run.finish();
    await controller.invoke("session.list");

    const groups = controller.projectGroups();
    const own = groups.find(group => group.project.path === first)?.sessions ?? [];
    const other = groups.find(group => group.project.path === second)?.sessions ?? [];
    assert.ok(own.some(session => session.path === run.path && session.firstMessage === "hello"), "history lands in the owning project");
    assert.ok(!other.some(session => session.path === run.path), "history never leaks into the active project");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("session.stop aborts a background run and preserves its file", { timeout: 30000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }] });
    injectFaux(controller, faux);
    const first = await startGatedRun(controller, faux, "never delivered");
    await controller.invoke("agent.control", { action: "newSession" });

    assert.deepEqual(await controller.invoke("session.stop", { path: controller.current!.session.path }), { stopped: false });
    assert.deepEqual(await controller.invoke("session.stop", { path: first.path }), { stopped: true });
    await until(() => !controller.registry.busy(controller.registry.entry(first.path)!));

    const reopened = await controller.invoke("session.open", { path: first.path }) as SessionSnapshot;
    assert.ok(JSON.stringify(reopened.entries).includes("hello"), "the submitted prompt is preserved");
    assert.ok(!JSON.stringify(reopened.entries).includes("never delivered"), "the aborted answer never lands");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("concurrent opens of a cold session share one runtime", { timeout: 30000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }] });
    injectFaux(controller, faux);
    await controller.invoke("agent.control", { action: "newSession" });
    const path = controller.current!.session.path;
    await controller.registry.dispose(path);

    let builds = 0;
    const original = controller.createSessionRuntime.bind(controller);
    controller.createSessionRuntime = entry => { builds++; return original(entry); };
    const [a, b] = await Promise.all([
      controller.invoke("session.open", { path }),
      controller.invoke("session.open", { path }),
    ]);
    assert.equal((a as SessionSnapshot).session.path, path);
    assert.equal((b as SessionSnapshot).session.path, path);
    assert.equal(builds, 1, "the in-flight open is shared, not duplicated");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("deleting a running session is refused", { timeout: 30000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }] });
    injectFaux(controller, faux);
    const first = await startGatedRun(controller, faux, "protected answer");
    await controller.invoke("agent.control", { action: "newSession" });

    await assert.rejects(controller.invoke("session.delete", { path: first.path, confirmed: true }), /Stop the running session/);
    assert.ok(controller.registry.entry(first.path)?.runtime, "the runtime survives the refused delete");
    await first.finish();
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});
