import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MainController, type Platform } from "../src/main/controller.js";
import { projectId, type ProjectInfo, type SessionSnapshot } from "../src/shared/types.js";
import { SessionRegistry } from "../src/main/session-registry.js";

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

test("late local opens keep the latest selection, including a project switch", async () => {
  const ws = workspace(), other = workspace();
  const controller = new MainController(ws, platform);
  const project = controller.project!;
  const paths = ["A", "B", "C"].map(name => join(controller.files.dir!, name + ".jsonl"));
  for (const path of paths) writeFileSync(path, "");
  const release = new Map<string, () => void>();
  controller.createSessionRuntime = entry => ({
    open: () => new Promise<void>(resolve => release.set(entry.path, resolve)),
    snapshot: () => ({ session: { path: entry.path }, entries: [], projection: { nodes: [] } }),
    state: () => ({}), close: async () => {},
  }) as never;
  try {
    const a = controller.invoke("session.open", { path: paths[0] });
    const b = controller.invoke("session.open", { path: paths[1] });
    release.get(paths[1]!)!(); await b;
    release.get(paths[0]!)!(); await a;
    assert.equal(controller.current?.session.path, paths[1]);
    assert.equal(controller.registry.activeOf(projectId(project))?.path, paths[1]);
    assert.equal(controller.registry.isActive(controller.registry.entry(paths[0]!)!), false);

    const c = controller.invoke("session.open", { path: paths[2] });
    controller.configure(other);
    release.get(paths[2]!)!(); await c;
    assert.equal(controller.project?.path, other);
    assert.equal(controller.current, undefined);
    assert.equal(controller.registry.isActive(controller.registry.entry(paths[2]!)!), false);
    controller.configure(ws);
    assert.equal((controller.current as SessionSnapshot | undefined)?.session.path, paths[1], "late C must not replace the project's remembered choice");
  } finally {
    await controller.closeAll();
    rmSync(ws, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("late read-only opens and new-session creation cannot undo a later selection", async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  let fail!: (error: Error) => void, create!: (path: string) => void;
  const snapshot = (path: string) => ({ session: { path }, entries: [], projection: { nodes: [] } }) as unknown as SessionSnapshot;
  controller.createSessionRuntime = entry => ({
    open: () => entry.path === "failed" ? new Promise<void>((_, reject) => { fail = reject; }) : Promise.resolve(),
    snapshot: () => snapshot(entry.path), state: () => ({}), close: async () => {},
  }) as never;
  try {
    const readonly = controller.registry.open(controller.project!, null, "failed", () => snapshot("failed"));
    const creating = controller.registry.create(controller.project!, null, () => new Promise(resolve => { create = resolve; }));
    await controller.registry.open(controller.project!, null, "latest");
    fail(new Error("read-only")); await readonly;
    create("created"); await creating;
    assert.equal(controller.registry.activeOf(projectId(controller.project!))?.path, "latest");
    assert.equal(controller.registry.isActive(controller.registry.entry("created")!), false);
  } finally { await controller.closeAll(); rmSync(ws, { recursive: true, force: true }); }
});

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
      const pushed = event as { type: string; payload?: { current?: SessionSnapshot; projects?: unknown[] } };
      if (pushed.type !== "sessions") return;
      if (pushed.payload?.current) viewSnapshots.push(pushed.payload.current.session.path);
      else if (pushed.payload?.projects) listRefreshes++;
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

test("background sessions stay operable while another project is in view", { timeout: 30000 }, async () => {
  const first = workspace(), second = workspace();
  const controller = new MainController(first, platform);
  try {
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }] });
    injectFaux(controller, faux);
    const run = await startGatedRun(controller, faux, "cross project work");
    controller.configure(second);

    assert.deepEqual(await controller.invoke("session.stop", { path: run.path }), { stopped: true });
    await until(() => !controller.registry.busy(controller.registry.entry(run.path)!));

    await controller.invoke("session.rename", { path: run.path, name: "Renamed from away" });
    assert.equal(controller.registry.entry(run.path)!.runtime!.snapshot().session.name, "Renamed from away");
    const renamedRow = controller.projectGroups().find(group => group.project.path === first)?.sessions
      .find(session => session.path === run.path);
    assert.equal(renamedRow?.name, "Renamed from away", "the owning project's history row carries the rename");

    await controller.invoke("session.delete", { path: run.path, confirmed: true });
    assert.equal(existsSync(run.path), false);
    assert.equal(controller.registry.entry(run.path), undefined);
    const own = controller.projectGroups().find(group => group.project.path === first)?.sessions ?? [];
    assert.ok(!own.some(session => session.path === run.path), "the owning project's history drops the deleted row");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("closeSessions drains an open that is still in flight", { timeout: 30000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    let closed = false;
    const runtime = {
      open: async () => { await new Promise(resolve => setTimeout(resolve, 50)); },
      close: async () => { closed = true; },
      state: () => ({}),
      snapshot: () => ({}) as never,
    };
    controller.createSessionRuntime = () => runtime as never;
    const opening = controller.registry.open(controller.project!, null, "in-flight.jsonl");
    await controller.closeSessions();
    await opening;
    assert.ok(closed, "the in-flight runtime is closed by shutdown");
    assert.equal(controller.registry.entry("in-flight.jsonl"), undefined);
  } finally {
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("background bookkeeping coalesces a burst of activity into one refresh", { timeout: 15000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const snapshot = { session: { path: "bg.jsonl" }, entries: [], projection: { nodes: [] } } as unknown as SessionSnapshot;
    const runtime: { open(): Promise<void>; snapshot(): SessionSnapshot; state(): unknown; emit?(event: unknown): void } = {
      open: async () => {},
      snapshot: () => snapshot,
      state: () => ({}),
    };
    controller.createSessionRuntime = () => runtime as never;
    await controller.registry.open(controller.project!, null, "bg.jsonl");
    controller.registry.viewProject("");   // the entry goes background
    let pushes = 0;
    controller.onEvent(event => {
      const pushed = event as { type: string; payload?: { projects?: unknown } };
      if (pushed.type === "sessions" && pushed.payload?.projects) pushes++;
    });
    for (let i = 0; i < 5; i++) {
      runtime.emit!({ type: "agent", payload: { type: i ? "entry_appended" : "message_end", graphId: "g", branchId: "main", runId: "r" } });
      runtime.emit!({ type: "sessions", payload: { current: snapshot } });
    }
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(pushes, 1, "one project refresh per burst");
    const recorded = controller.settings.projectHistory().find(record => record.project.path === ws)?.sessions ?? [];
    assert.ok(recorded.some(session => session.path === "bg.jsonl"), "history still lands once");
  } finally {
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a disposed entry's coalesced refresh publishes nothing", { timeout: 15000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const snapshot = { session: { path: "bg.jsonl" }, entries: [], projection: { nodes: [] } } as unknown as SessionSnapshot;
    const runtime: { open(): Promise<void>; snapshot(): SessionSnapshot; state(): unknown; close(): Promise<void>; emit?(event: unknown): void } = {
      open: async () => {},
      snapshot: () => snapshot,
      state: () => ({}),
      close: async () => {},
    };
    controller.createSessionRuntime = () => runtime as never;
    await controller.registry.open(controller.project!, null, "bg.jsonl");
    controller.registry.viewProject("");   // background: refreshes are coalesced, not immediate
    runtime.emit!({ type: "sessions", payload: { current: snapshot } });
    await controller.registry.dispose("bg.jsonl");   // disposed inside the coalescing window

    let pushes = 0;
    controller.onEvent(event => {
      const pushed = event as { type: string; payload?: { current?: unknown; projects?: unknown } };
      if (pushed.type === "sessions" && !pushed.payload?.current) pushes++;
    });
    await new Promise(resolve => setTimeout(resolve, 700));

    assert.equal(pushes, 0, "a disposed entry does not publish a stale refresh");
  } finally {
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("quitting flushes the pending background history write", { timeout: 15000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const snapshot = { session: { path: "late.jsonl", firstMessage: "late" }, entries: [], projection: { nodes: [] } } as unknown as SessionSnapshot;
    const runtime: { open(): Promise<void>; snapshot(): SessionSnapshot; state(): unknown; close(): Promise<void>; emit?(event: unknown): void } = {
      open: async () => {},
      snapshot: () => snapshot,
      state: () => ({}),
      close: async () => {},
    };
    controller.createSessionRuntime = () => runtime as never;
    await controller.registry.open(controller.project!, null, "late.jsonl");
    controller.registry.viewProject("");
    runtime.emit!({ type: "agent", payload: { type: "message_end", graphId: "late.jsonl", branchId: "main", runId: "r" } });

    await controller.closeSessions();
    const recorded = controller.settings.projectHistory().find(record => record.project.path === ws)?.sessions ?? [];
    assert.ok(recorded.some(session => session.path === "late.jsonl"),
      "the coalesced write lands even when quitting inside the window");
  } finally {
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the session list and project groups carry running markers that flip back to idle", { timeout: 30000 }, async () => {
  const first = workspace(), second = workspace();
  const controller = new MainController(first, platform);
  try {
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }] });
    injectFaux(controller, faux);
    const run = await startGatedRun(controller, faux, "marked answer");
    await controller.invoke("agent.control", { action: "newSession" });

    const list = await controller.sessions();
    assert.equal(list.find(session => session.path === run.path)?.running, true, "the background run is marked");
    assert.equal(list.find(session => session.path === controller.current!.session.path)?.running, undefined);

    controller.configure(second);
    await controller.invoke("session.list");
    const group = controller.projectGroups().find(record => record.project.path === first);
    assert.equal(group?.sessions.find(session => session.path === run.path)?.running, true,
      "the marker follows the session into its own project group");

    // Rows of a project that is not in view still update when its run settles.
    const awayRows: Array<{ path: string; running?: boolean; firstMessage?: string }> = [];
    controller.onEvent(event => {
      const pushed = event as { type: string; payload?: { projects?: Array<{ project: { path: string }; sessions: Array<{ path: string; running?: boolean; firstMessage?: string }> }> } };
      if (pushed.type !== "sessions" || !pushed.payload?.projects) return;
      const rows = pushed.payload.projects.find(record => record.project.path === first)?.sessions
        .filter(session => session.path === run.path) ?? [];
      awayRows.push(...rows);
    });

    await run.finish();
    await until(() => awayRows.length > 0);
    assert.ok(awayRows.some(row => row.firstMessage === "hello"),
      "the settled row reaches the view without entering its project");
    assert.equal((await controller.sessions()).find(session => session.path === run.path)?.running, undefined,
      "the marker clears once the run settles");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("forgetting a local project refuses while it runs and disposes its entries otherwise", { timeout: 30000 }, async () => {
  const first = workspace(), second = workspace();
  const controller = new MainController(first, platform);
  try {
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }] });
    injectFaux(controller, faux);
    const run = await startGatedRun(controller, faux, "kept alive by the guard");
    controller.configure(second);
    await controller.invoke("session.list");

    await assert.rejects(controller.invoke("app.forgetProject", { id: `local:${first}` }), /Stop the running sessions/);
    assert.ok(controller.registry.entry(run.path)?.runtime, "the running entry survives the refused removal");

    await run.finish();
    await controller.invoke("app.forgetProject", { id: `local:${first}` });
    assert.equal(controller.registry.entry(run.path), undefined, "the entry goes with the history row");
    assert.ok(!controller.projectGroups().some(record => record.id === `local:${first}`), "the project is gone from the list");
    await new Promise(resolve => setTimeout(resolve, 700));   // past the background coalescing window
    assert.ok(!controller.projectGroups().some(record => record.id === `local:${first}`), "nothing writes the project back");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("dispose waits for an in-flight open instead of settling it afterwards", { timeout: 30000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    let closed = false;
    const runtime = {
      open: async () => { await new Promise(resolve => setTimeout(resolve, 50)); },
      close: async () => { closed = true; },
      state: () => ({}),
      snapshot: () => ({}) as never,
    };
    controller.createSessionRuntime = () => runtime as never;
    const opening = controller.registry.open(controller.project!, null, "in-flight.jsonl");

    await controller.registry.dispose("in-flight.jsonl");
    await opening;

    assert.equal(Boolean(controller.registry.entry("in-flight.jsonl")), false, "the late open does not settle after disposal");
    assert.ok(closed, "the runtime the late open built is closed");
    assert.equal(controller.registry.activeOf(projectId(controller.project!)), undefined,
      "the disposed entry is not left as its project's view");
  } finally {
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("forgetting a project during an in-flight open disposes the late runtime", { timeout: 30000 }, async () => {
  const first = workspace(), second = workspace();
  const controller = new MainController(first, platform);
  try {
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }] });
    injectFaux(controller, faux);
    await controller.invoke("agent.control", { action: "newSession" });
    const path = controller.current!.session.path;
    await controller.registry.dispose(path);   // the file stays behind; only the runtime goes

    const original = controller.createSessionRuntime.bind(controller);
    controller.createSessionRuntime = entry => {
      const runtime = original(entry);
      const open = runtime.open.bind(runtime);
      runtime.open = async (p: string) => { await new Promise(resolve => setTimeout(resolve, 100)); return open(p); };
      return runtime;
    };

    const opening = controller.invoke("session.open", { path });
    await new Promise(resolve => setTimeout(resolve, 20));   // the open is registered as pending
    controller.configure(second);
    await controller.invoke("app.forgetProject", { id: `local:${first}` });
    await opening.catch(() => {});

    assert.equal(Boolean(controller.registry.entry(path)), false, "the late open goes with the history row");
    assert.ok(!controller.projectGroups().some(record => record.id === `local:${first}`), "the project is gone from the list");
    await new Promise(resolve => setTimeout(resolve, 700));   // past the background coalescing window
    assert.ok(!controller.projectGroups().some(record => record.id === `local:${first}`), "nothing writes the project back");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("session.open never publishes a snapshot the registry no longer owns", { timeout: 15000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const dir = controller.files.dir!;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "gone.jsonl");
    writeFileSync(path, "");
    // A disposal that lands while the open is in flight leaves the registry
    // with nothing to hand back.
    controller.registry.open = async () => ({ session: { path } }) as never;

    await assert.rejects(controller.invoke("session.open", { path }), /closed while opening/);
    assert.equal(controller.current, undefined, "a closed session never becomes the view");
    assert.ok(!JSON.stringify(controller.projectGroups()).includes("gone.jsonl"),
      "nothing is written back into the history");
  } finally {
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("switching the view away shrinks the idle pool", { timeout: 15000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const runtime = { open: async () => {}, close: async () => {}, state: () => ({}), snapshot: () => ({}) as never };
    controller.createSessionRuntime = () => runtime as never;
    const live = () => ["s0", "s1", "s2", "s3", "s4", "s5", "s6"]
      .filter(name => controller.registry.entry(`${name}.jsonl`)).length;
    for (const name of ["s0", "s1", "s2", "s3", "s4", "s5", "s6"])
      await controller.registry.open(controller.project!, null, `${name}.jsonl`);
    assert.equal(live(), 5, "the idle cap holds beyond the active entry");
    controller.registry.viewProject("");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(live(), 4, "leaving the view lets the pool shrink");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("deletion recovery rekeys the entry to the session the runtime moved to", { timeout: 15000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const dir = controller.files.dir!;
    const old = join(dir, "old.jsonl"), next = join(dir, "new.jsonl");
    writeFileSync(old, "");
    let pathNow = old, recovering = true;
    const snapshot = (): SessionSnapshot =>
      ({ session: { path: pathNow }, entries: [], projection: { nodes: [] } }) as never;
    controller.createSessionRuntime = () => ({
      get recovering() { return recovering; },
      async open() {},
      snapshot,
      state: () => ({ sessionFile: pathNow }),
      async control(input: { action: string }) {
        if (input.action === "newSession") { pathNow = next; recovering = false; }
        return snapshot();
      },
      async close() {},
    }) as never;
    await controller.invoke("session.open", { path: old });
    const entry = controller.registry.entry(old)!;

    await controller.invoke("agent.control", { action: "newSession" });

    assert.equal(controller.registry.entry(old), undefined, "the old path no longer serves the recovered runtime");
    assert.equal(controller.registry.entry(next), entry, "the entry follows the runtime's new file");
    assert.ok(controller.registry.isActive(entry), "the recovered session stays in view");
    assert.equal(controller.registry.activeOf(projectId(controller.project!))?.path, next);
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a failed open closes the runtime it half-built", { timeout: 15000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    let closed = false;
    controller.createSessionRuntime = () => ({
      open: () => Promise.reject(new Error("corrupt session")),
      snapshot: () => ({}) as never,
      state: () => ({}),
      close: async () => { closed = true; },
    }) as never;
    await assert.rejects(controller.registry.open(controller.project!, null, "bad.jsonl"), /corrupt session/);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(closed, "the half-built runtime is closed, not leaked");
  } finally {
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("one refused abort does not fail the stop of the remaining runs", { timeout: 15000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const dir = controller.files.dir!;
    const path = join(dir, "two-runs.jsonl");
    writeFileSync(path, "");
    const actions: unknown[] = [];
    controller.createSessionRuntime = () => ({
      async open() {},
      snapshot: () => ({ session: { path }, graph: { runs: [
        { branchId: "a", runId: "1", status: "running" },
        { branchId: "b", runId: "2", status: "running" },
      ] } }) as never,
      state: () => ({}),
      async control(input: { action: string; runId: string }) {
        if (input.runId === "1") throw new Error("abort refused");
        actions.push(input);
      },
      async close() {},
    }) as never;
    await controller.invoke("session.open", { path });

    assert.deepEqual(await controller.invoke("session.stop", { path }), { stopped: true });
    assert.deepEqual(actions, [{ action: "branchAbort", branchId: "b", runId: "2" }]);
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("changing the session directory disposes every entry before repointing the view", { timeout: 15000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const dir = controller.files.dir!;
    const a = join(dir, "a.jsonl"), b = join(dir, "b.jsonl");
    writeFileSync(a, "");
    writeFileSync(b, "");
    const closed: string[] = [];
    controller.createSessionRuntime = entry => ({
      async open() {},
      snapshot: () => ({ session: { path: entry.path }, entries: [], projection: { nodes: [] } }) as never,
      state: () => ({}),
      async close() { closed.push(entry.path); },
    }) as never;
    await controller.invoke("session.open", { path: a });
    await controller.invoke("session.open", { path: b });   // the active entry is the last inserted

    const bundle = controller.settings.bundle();
    bundle.piProject.sessionDir = "moved";
    bundle.effective = { ...bundle.effective, sessionDir: "moved" };
    controller.settings.updatePi = async () => bundle;
    await controller.invoke("settings.update", { scope: "project", patch: { sessionDir: "moved" } });

    assert.equal(controller.current, undefined, "the view no longer restores an entry that is closing");
    assert.deepEqual([...closed].sort(), [a, b].sort(), "both entries were disposed");
    assert.equal(controller.files.dir, join(ws, "moved"));
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("deleting still succeeds when the viewed session file is already gone", { timeout: 15000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const dir = controller.files.dir!;
    const keep = join(dir, "keep.jsonl");
    writeFileSync(keep, "");
    controller.current = { session: { path: join(dir, "gone.jsonl") } } as never;

    const result = await controller.invoke("session.delete", { path: keep, confirmed: true }) as { sessions: unknown[] };

    assert.equal(existsSync(keep), false, "the requested file is deleted");
    assert.ok(Array.isArray(result.sessions), "the route completes despite the missing viewed file");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a persisted model choice is written to the profile defaults a new session starts from", { timeout: 30000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const faux = fauxProvider({ models: [
      { id: "faux-1", name: "Faux One", reasoning: false, contextWindow: 128_000 },
      { id: "faux-2", name: "Faux Two", reasoning: false, contextWindow: 128_000 },
    ] });
    injectFaux(controller, faux);
    await controller.invoke("agent.control", { action: "newSession" });
    // The desktop's "set as default" (Settings writes these keys directly) and
    // the SDK's persist option are the same profile defaults: a fresh session
    // resolves its model from exactly these (SDK sdk.js findInitialModel).
    // (Resolving it here is not observable — the faux provider is injected
    // after the session is built, past that resolution point.)
    await controller.invoke("agent.control", { action: "setModel", provider: "faux", modelId: "faux-2", persist: true });

    const pi = controller.settings.bundle().piGlobal;
    assert.equal(pi.defaultProvider, "faux", "the pick is written as the profile default provider");
    assert.equal(pi.defaultModel, "faux-2", "the pick is written as the profile default model");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

for (const action of ["fork", "clone"] as const) {
  test(`${action} rekeys the entry to the session the runtime moved to`, { timeout: 15000 }, async () => {
    const ws = workspace();
    const controller = new MainController(ws, platform);
    try {
      const dir = controller.files.dir!;
      const old = join(dir, "old.jsonl"), next = join(dir, "next.jsonl");
      writeFileSync(old, "");
      let pathNow = old;
      const snapshot = (): SessionSnapshot =>
        ({ session: { path: pathNow }, entries: [], projection: { nodes: [] } }) as never;
      controller.createSessionRuntime = () => ({
        async open() {},
        snapshot,
        state: () => ({ sessionFile: pathNow }),
        async control(input: { action: string }) {
          if (input.action === action) { pathNow = next; writeFileSync(next, ""); }
          return snapshot();
        },
        async close() {},
      }) as never;
      await controller.invoke("session.open", { path: old });
      const entry = controller.registry.entry(old)!;

      await controller.invoke("agent.control", { action, ...(action === "fork" ? { entryId: "n1" } : {}) });

      assert.equal(controller.registry.entry(old), undefined, "the old path no longer serves the moved runtime");
      assert.equal(controller.registry.entry(next), entry, "the entry follows the runtime's new file");
      assert.ok(controller.registry.isActive(entry), "the moved session stays in view");
    } finally {
      await controller.closeSessions();
      controller.dispose();
      rmSync(ws, { recursive: true, force: true });
    }
  });
}

test("a cached runtime that died reopens instead of surfacing its error", { timeout: 15000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    const dir = controller.files.dir!;
    const path = join(dir, "dying.jsonl");
    writeFileSync(path, "");
    let builds = 0, broken = false;
    const snapshot = (): SessionSnapshot =>
      ({ session: { path }, entries: [], projection: { nodes: [] } }) as never;
    controller.createSessionRuntime = () => {
      const instance = ++builds;
      return {
        async open() {},
        snapshot: () => { if (instance === 1 && broken) throw new Error("runtime died"); return snapshot(); },
        state: () => ({}),
        async close() {},
      } as never;
    };
    await controller.invoke("session.open", { path });
    broken = true;

    const reopened = await controller.invoke("session.open", { path }) as SessionSnapshot;

    assert.equal(reopened.session.path, path, "the session reopens on a fresh runtime");
    assert.equal(builds, 2, "the dead cached runtime is replaced, not reused");
  } finally {
    await controller.closeSessions();
    controller.dispose();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a catalog change reaches the sessions that are already open", { timeout: 30000 }, async () => {
  const ws = workspace();
  const controller = new MainController(ws, platform);
  try {
    await controller.invoke("agent.control", { action: "newSession" });
    const entry = controller.registry.entry(controller.current!.session.path)!;
    // A login or a custom model on the desktop re-sends the broker catalog; the
    // host applies it to the project runtime, which open sessions must follow.
    const catalog = {
      providers: ["faux"], models: [{ provider: "faux", id: "faux-1", name: "Faux", api: "openai-completions",
        contextWindow: 1000, maxTokens: 100, cost: {} }] };
    await controller.invoke("agent.control", { action: "setBrokerProviders", ...catalog });
    await controller.invoke("agent.control", { action: "setBrokerProviders", ...catalog });

    const projectModels = await controller.projectRuntime.modelRuntime();
    const entryModels = await entry.runtime!.modelRuntime();
    assert.ok(projectModels.getModel("faux", "faux-1"), "the project runtime registered the model");
    assert.ok(entryModels.getModel("faux", "faux-1"), "the open session sees the updated catalog");
  } finally {
    await controller.closeAll();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a junctioned project keeps one canonical history row and its running marker", { timeout: 30000 }, async () => {
  const real = workspace();
  const link = `${real}-link`;
  symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  const controller = new MainController(link, platform);
  try {
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux", reasoning: false, contextWindow: 128_000 }] });
    injectFaux(controller, faux);
    const run = await startGatedRun(controller, faux, "junction answer");
    const id = controller.current!.session.id;

    const rows = await controller.sessions();
    assert.equal(rows.length, 1, "the list carries one row per session file");
    assert.equal(rows[0]?.path, run.path, "the row spells the canonical file");
    assert.equal(rows[0]?.running, true, "the running row keeps its marker");

    await controller.invoke("session.list");
    await controller.invoke("session.open", { path: run.path });
    const group = controller.projectGroups().find(record => record.project.path === link);
    assert.equal(group?.sessions.filter(row => row.id === id).length, 1, "history keeps one row");
    await run.finish();
  } finally {
    await controller.closeAll();
    rmSync(link, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("eviction never disposes an entry that became active while it was closing another", async () => {
  const project = (id: string): ProjectInfo => ({ name: id, path: `/ws/${id}` });
  const gates = new Map<string, () => void>();
  const registry = new SessionRegistry({
    createRuntime: entry => ({
      open: async () => {},
      close: () => new Promise<void>(resolve => gates.set(entry.path, resolve)),
      snapshot: () => ({ session: { path: entry.path }, entries: [], projection: { nodes: [] } }) as unknown as SessionSnapshot,
      state: () => ({ sessionFile: entry.path }),
      busy: false,
    }) as never,
    onEvent: () => {},
  });
  const previousLimit = process.env.PIX_MAX_LIVE_SESSIONS;
  process.env.PIX_MAX_LIVE_SESSIONS = "64";
  const p1 = project("a"), p2 = project("b"), p3 = project("c");
  const dir = (p: ProjectInfo) => `${p.path}/.pi/sessions`;
  try {
    await registry.open(p3, dir(p3), "/ws/c/.pi/sessions/x.jsonl");
    await registry.open(p2, dir(p2), "/ws/b/.pi/sessions/b.jsonl");
    await registry.open(p1, dir(p1), "/ws/a/.pi/sessions/c.jsonl");
    await registry.open(p1, dir(p1), "/ws/a/.pi/sessions/d.jsonl");

    // Shrinking the pool queues x, b, and c for eviction in one pass.
    process.env.PIX_MAX_LIVE_SESSIONS = "1";
    const opening = registry.open(p1, dir(p1), "/ws/a/.pi/sessions/e.jsonl");
    await new Promise(resolve => setImmediate(resolve));

    // The user switches back to p2 while x.jsonl is still closing.
    const restored = registry.viewProject(projectId(p2));
    assert.equal(restored?.path, "/ws/b/.pi/sessions/b.jsonl");

    gates.get("/ws/c/.pi/sessions/x.jsonl")?.();
    await opening;
    await new Promise(resolve => setImmediate(resolve));
    for (const release of [...gates.values()]) release();
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(registry.entry("/ws/b/.pi/sessions/b.jsonl"), "the restored entry survives eviction");
    assert.ok(registry.isActive(restored!), "the view keeps the entry it restored");
  } finally {
    if (previousLimit === undefined) delete process.env.PIX_MAX_LIVE_SESSIONS;
    else process.env.PIX_MAX_LIVE_SESSIONS = previousLimit;
    for (const release of [...gates.values()]) release();
  }
});
