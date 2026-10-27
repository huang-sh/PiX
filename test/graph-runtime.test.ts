import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GraphRuntime } from "../src/main/graph-runtime.js";
import { GraphFiles, durableWrite, encodeSession, parseStrict, type BranchRecord } from "../src/main/graph-files.js";
import type { SessionSnapshot } from "../src/shared/types.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error("Timed out waiting for graph state");
}

test("admitted prompts stay pending and busy throughout startup and model configuration", { timeout: 30000 }, async t => {
  for (const stage of ["startup", "model", "model failure", "startup abort", "model abort", "open abort", "startup direct abort", "model direct abort"]) for (const target of ["main", "branch", "continuation"]) {
    if (stage === "open abort" && target === "main") continue;
    if (stage.includes("direct") && target !== "main") continue;
    await t.test(`${target}: ${stage}`, async () => {
      const home = mkdtempSync(join(tmpdir(), "pix-pending-startup-"));
      const previous = { home: process.env.PIX_HOME, agent: process.env.PI_CODING_AGENT_DIR };
      process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
      const runtime = new GraphRuntime(home, join(home, "sessions"), () => {}, async () => {});
      const faux = fauxProvider({ models: [{ id: "test", contextWindow: 128000 }] });
      const startup = stage.startsWith("startup"), cancelled = stage.endsWith("abort");
      let block = target === "main" && startup, entered = false;
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      runtime["sessionServicesOptions"] = (pi, cwd) => ({
        cwd, agentDir: home, settingsManager: pi.SettingsManager.inMemory({}),
        resourceLoaderOptions: { additionalExtensionPaths: [], noExtensions: true, extensionFactories: [
          (pi: any) => pi.on("session_start", async () => {
            if (block && startup) { entered = true; await blocked; }
          }),
        ] },
      });
      const factory = runtime.factory.bind(runtime);
      runtime.factory = pi => async args => {
        const result = await factory(pi)(args);
        result.services.modelRuntime.registerNativeProvider(faux.provider);
        if (block && stage === "open abort") { entered = true; await blocked; }
        const setModel = result.session.setModel.bind(result.session);
        result.session.setModel = async (...args: any[]) => {
          if (block && stage.startsWith("model")) {
            entered = true; await blocked;
            if (stage === "model failure") throw new Error("simulated model configuration failure");
          }
          return setModel(...args);
        };
        return result;
      };
      let submitted: Promise<unknown> | undefined, stopped: Promise<unknown> | undefined;
      try {
        await runtime.create();
        if (!block) await runtime.control({ action: "commands" });
        const manager = runtime.runtime.session.sessionManager;
        manager.appendMessage({ role: "user", content: "parent", timestamp: 1 });
        manager.appendMessage(fauxAssistantMessage("parent reply"));
        let parentId = target === "main" ? runtime.snapshot().projection.activeNodeId : null;
        if (target === "continuation") {
          faux.setResponses([fauxAssistantMessage("branch reply")]);
          await runtime.control({ action: "promptAt", requestId: "first-branch", nodeId: null,
            text: "branch parent", provider: "faux", modelId: "test" });
          await until(() => !runtime.busy);
          parentId = runtime.snapshot().graph!.runs.find(run => run.requestId === "first-branch")!.nodeId;
          assert.ok(parentId);
        }
        block = true;
        faux.setResponses([fauxAssistantMessage("new reply")]);
        // The input metadata must survive refresh even before a user entry exists.
        submitted = runtime.control({ action: "promptAt", requestId: "pending-request", nodeId: parentId,
          text: "pending question", provider: "faux", modelId: "test" });
        const failure = cancelled ? /Session operation cancelled/ : /simulated model configuration failure/;
        const rejected = cancelled || stage === "model failure" ? assert.rejects(submitted, failure) : undefined;
        assert.equal(runtime.busy, true, "queued admission must prevent session eviction");
        await until(() => entered && Boolean(runtime.snapshot().graph!.runs.find(run => run.requestId === "pending-request")));
        for (let refresh = 0; refresh < 2; refresh++) {
          const snapshot = runtime.snapshot();
          const run = snapshot.graph!.runs.find(run => run.requestId === "pending-request")!;
          assert.equal(runtime.busy, true);
          assert.equal(run.status, "running");
          assert.equal(run.nodeId, null, "an old parent must never be acknowledged as the new turn");
          assert.deepEqual(run.pending, { text: "pending question", parentNodeId: parentId, images: undefined });
          assert.ok(!snapshot.projection.nodes.some(node => node.title === "pending question"));
        }
        if (cancelled) {
          const run = runtime.snapshot().graph!.runs.find(run => run.requestId === "pending-request")!;
          stopped = runtime.control(stage.includes("direct") ? { action: "abort" }
            : { action: "branchAbort", branchId: run.branchId, runId: run.runId });
          void stopped.catch(() => {});
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        release();
        if (rejected) await rejected; else await submitted;
        if (stopped) {
          const result = await stopped;
          const stoppedSnapshot = stage.includes("direct") ? runtime.snapshot() : result as SessionSnapshot;
          assert.notEqual(stoppedSnapshot.graph!.runs.find(run => run.requestId === "pending-request")?.status, "running");
        }
        await until(() => !runtime.busy);
        const snapshot = runtime.snapshot();
        const run = snapshot.graph!.runs.find(run => run.requestId === "pending-request")!;
        assert.notEqual(run.status, "running");
        assert.equal(run.pending, undefined);
        if (rejected) assert.match(run.error ?? "", failure);
        else {
          const node = snapshot.projection.nodes.find(node => node.id === run.nodeId)!;
          assert.equal(node.title, "pending question");
          assert.equal(node.parentId, parentId);
          assert.match(JSON.stringify(snapshot.entries), /new reply/);
        }
        if (cancelled) {
          assert.ok(!snapshot.projection.nodes.some(node => node.title === "pending question"));
          assert.ok(!JSON.stringify(snapshot.entries).includes("new reply"), "no model call may start after stop");
          block = false;
          faux.setResponses([fauxAssistantMessage("after cancellation")]);
          await runtime.control({ action: "promptAt", requestId: "after-stop", nodeId: parentId,
            text: "fresh question", provider: "faux", modelId: "test" });
          await until(() => !runtime.busy);
          assert.match(JSON.stringify(runtime.snapshot().entries), /after cancellation/);
        }
      } finally {
        release();
        await submitted?.catch(() => {});
        await stopped?.catch(() => {});
        await runtime.close();
        if (previous.home === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous.home;
        if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test("broker model preflight respects cancellation before a prompt starts", { timeout: 15000 }, async t => {
  for (const action of ["run", "abort", "branchAbort", "close"] as const) await t.test(action, async t => {
    const home = mkdtempSync(join(tmpdir(), "pix-broker-preflight-"));
    const previous = { home: process.env.PIX_HOME, agent: process.env.PI_CODING_AGENT_DIR };
    process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, "agent");
    const runtime = new GraphRuntime(home, join(home, "sessions"), () => {}, async () => {});
    const faux = fauxProvider({ models: [{ id: "test", contextWindow: 128000 }] });
    const factory = runtime.factory.bind(runtime);
    runtime.factory = pi => async args => {
      const result = await factory(pi)(args);
      result.services.modelRuntime.registerNativeProvider(faux.provider);
      return result;
    };
    let entered!: () => void, release!: () => void;
    const updating = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let stopped: Promise<unknown> | undefined;
    try {
      await runtime.create();
      await runtime.control({ action: "setModel", provider: "faux", modelId: "test" });
      const session = runtime.runtime.session, manager = session.sessionManager;
      runtime.brokerProviders.add("faux");
      const getModel = session.modelRuntime.getModel.bind(session.modelRuntime);
      t.mock.method(session.modelRuntime, "getModel", (provider: string, id: string) => {
        const model = getModel(provider, id);
        return model ? { ...model, name: "updated broker model" } : model;
      });
      const setModel = session.setModel.bind(session);
      const updatingModel = t.mock.method(session, "setModel", async (...args: unknown[]) => {
        entered(); await blocked;
        return setModel(...args);
      });
      faux.setResponses([fauxAssistantMessage("preflight reply")]);
      await runtime.control({ action: "promptAt", requestId: "broker-preflight", nodeId: null, text: "pending broker question" });
      await updating;
      const run = runtime.snapshot().graph!.runs.find(run => run.requestId === "broker-preflight")!;
      assert.equal(run.status, "running");
      assert.equal(run.nodeId, null);
      if (action !== "run") {
        stopped = action === "close" ? runtime.close() : runtime.control(action === "abort" ? { action: "abort" }
          : { action: "branchAbort", branchId: run.branchId, runId: run.runId });
        void stopped.catch(() => {});
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      release();
      await stopped;
      await until(() => !runtime.busy);
      assert.equal(updatingModel.mock.callCount(), 1);
      const entries = JSON.stringify(manager.getEntries().filter((entry: { message?: { role?: string } }) =>
        entry.message?.role === "user" || entry.message?.role === "assistant"));
      if (action === "run") {
        assert.match(entries, /pending broker question/);
        assert.match(entries, /preflight reply/);
        assert.equal(session.model.name, "updated broker model");
      } else {
        assert.doesNotMatch(entries, /pending broker question|preflight reply/);
        if (action === "close") assert.equal(runtime.runtime, undefined);
        else {
          assert.match(runtime.snapshot().graph!.runs.find(run => run.requestId === "broker-preflight")?.error ?? "", /cancelled/);
          faux.setResponses([fauxAssistantMessage("reply after stop")]);
          await runtime.control({ action: "promptAt", requestId: "after-broker-stop", nodeId: null, text: "fresh question" });
          await until(() => !runtime.busy);
          assert.match(JSON.stringify(runtime.snapshot().entries), /reply after stop/);
        }
      }
    } finally {
      release();
      await stopped?.catch(() => {});
      await runtime.close();
      if (previous.home === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous.home;
      if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test("each branch waits for its own extension startup without blocking the main session", { timeout: 15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-branch-startup-"));
  const previous = { home: process.env.PIX_HOME, agent: process.env.PI_CODING_AGENT_DIR };
  process.env.PIX_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
  const events: any[] = [];
  const runtime = new GraphRuntime(home, join(home, "sessions"), event => { events.push(event); }, async () => {});
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let starts = 0, invoked = 0, shutdown = 0;
  runtime["sessionServicesOptions"] = (pi, cwd) => ({
    cwd, agentDir: home, settingsManager: pi.SettingsManager.inMemory({}),
    resourceLoaderOptions: { additionalExtensionPaths: [], noExtensions: true, extensionFactories: [
      (pi: any) => {
        let ready = false;
        pi.on("session_start", async () => {
          if (++starts > 1) await blocked;
          ready = true;
        });
        pi.on("session_shutdown", () => { assert.equal(ready, true); shutdown++; });
        pi.registerCommand("startup-test", { handler: () => { assert.equal(ready, true); invoked++; } });
      },
    ] },
  });
  try {
    const root = await runtime.create();
    await runtime.control({ action: "commands" });
    runtime.runtime.session.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
    for (const requestId of ["branch-one", "branch-two"])
      await runtime.control({ action: "promptAt", requestId, nodeId: null, text: "/startup-test" });
    let mainCommandsReady = false;
    const commands = runtime.control({ action: "commands" }).then(() => { mainCommandsReady = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(starts, 3);
    assert.equal(invoked, 0, "branch commands must wait for their own hooks");
    assert.equal(shutdown, 0, "a pending branch must not shut down before startup finishes");
    assert.equal(mainCommandsReady, true, "worker startup must not replace main readiness");
    release();
    await commands;
    await until(() => !runtime.busy);
    assert.equal(invoked, 2);
    assert.equal(shutdown, 2);
    assert.ok(events.filter(event => event.type === "sessions" && event.payload.current)
      .every(event => event.payload.current.session.path === root.session.path), "worker snapshots stay inside the root graph");
  } finally {
    release();
    await runtime.close();
    if (previous.home === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous.home;
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
    rmSync(home, { recursive: true, force: true });
  }
});

test("restart can continue main and branch turns left without a reply or tool result", { timeout: 30000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pix-crash-followup-"));
  const previous = { home: process.env.PIX_HOME, agent: process.env.PI_CODING_AGENT_DIR };
  process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
  const cwd = join(home, "workspace"); mkdirSync(cwd);
  try {
    for (const branch of [false, true]) for (const toolCall of [false, true]) {
      await t.test(`${branch ? "branch" : "main"}: ${toolCall ? "missing tool result" : "user message only"}`, async () => {
        const path = join(home, `${branch}-${toolCall}.jsonl`);
        const manager = SessionManager.inMemory(cwd);
        manager.appendModelChange("faux", "test");
        const baselineCount = manager.getEntries().length;
        const userId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "interrupted prompt" }], timestamp: 1 });
        if (toolCall) manager.appendMessage(fauxAssistantMessage([
          { type: "toolCall", id: "unfinished", name: "bash", arguments: { command: "echo must-not-replay" } },
        ], { stopReason: "toolUse" }));
        const data = parseStrict([manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n"));
        const baseline = data.entries.slice(0, baselineCount);
        const files = new GraphFiles(path);
        files.acquire();
        if (branch) {
          durableWrite(path, encodeSession({ header: data.header, entries: baseline }));
          const record: BranchRecord = { id: "crashed", parentId: "main", forkEntryId: "", requestId: "crashed",
            request: { text: "interrupted prompt" }, inherited: Object.fromEntries(baseline.map(entry => [entry.id, entry.id])),
            header: data.header, baseline, status: "running", runId: "crashed-run" };
          files.create(record, data);
        } else durableWrite(path, encodeSession(data));
        files.release();

        const events: unknown[] = [];
        const runtime = new GraphRuntime(cwd, home, event => { events.push(event); }, async () => {});
        const faux = fauxProvider({ models: [{ id: "test", contextWindow: 128000 }] });
        const factory = runtime.factory.bind(runtime);
        runtime.factory = pi => async args => {
          const result = await factory(pi)(args);
          result.services.modelRuntime.registerNativeProvider(faux.provider);
          return result;
        };
        try {
          const restored = await runtime.open(path);
          const nodeId = `turn:${branch ? "crashed:" : ""}${userId}`;
          const node = restored.projection.nodes.find(node => node.id === nodeId)!;
          assert.equal(restored.runtime.available, true);
          assert.equal(runtime.busy, false);
          assert.equal(node.running, false);
          assert.equal(node.forkable, true, "the restored turn must unlock the composer and pass promptAt admission");
          if (branch) assert.equal(restored.graph!.runs.find(run => run.branchId === "crashed")?.status, "interrupted");
          const retained = structuredClone(restored.entries);
          faux.setResponses([fauxAssistantMessage("continued after restart")]);
          await runtime.control({ action: "promptAt", requestId: "followup", nodeId, text: "continue", provider: "faux", modelId: "test" });
          await until(() => !runtime.busy);
          const continued = runtime.snapshot();
          assert.match(JSON.stringify(continued.entries), /continued after restart/);
          for (const entry of retained) assert.deepEqual(continued.entries.find(value => value.id === entry.id), entry);
          assert.ok(continued.projection.nodes.some(node => node.title === "continue" && node.parentId === nodeId));
          assert.ok(!JSON.stringify(events).includes('"tool_execution_start"'), "old tool calls must not be replayed");
          await runtime.close();
          assert.equal((await runtime.open(path)).projection.nodes.find(node => node.id === nodeId)?.forkable, true);
        } finally { await runtime.close(); }
      });
    }
  } finally {
    if (previous.home === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous.home;
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
    rmSync(home, { recursive: true, force: true });
  }
});

test("interrupted turns resume and retain native bookmarks across branches, restart, export and removal", { timeout: 20000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-abort-followup-"));
  const previous = process.env.PIX_HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
  const cwd = join(home, "workspace"); mkdirSync(cwd);
  const runtime = new GraphRuntime(cwd, join(home, "sessions"), () => {}, async () => {});
  const faux = fauxProvider({ models: [{ id: "test", contextWindow: 128000 }] });
  const factory = runtime.factory.bind(runtime);
  runtime.factory = pi => async args => {
    const result = await factory(pi)(args);
    result.services.modelRuntime.registerNativeProvider(faux.provider);
    return result;
  };
  try {
    await runtime.create();
    await runtime.control({ action: "setModel", provider: "faux", modelId: "test" });
    let started = false;
    faux.setResponses([
      async (_context, options) => {
        started = true;
        await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
      fauxAssistantMessage("after interrupt"),
    ]);
    await runtime.control({ action: "promptAt", requestId: "interrupted", nodeId: null, text: "first", provider: "faux", modelId: "test" });
    await until(() => started);
    const running = runtime.snapshot().graph!.runs.find(run => run.status === "running")!;
    await runtime.control({ action: "branchAbort", branchId: running.branchId, runId: running.runId });
    assert.equal(runtime.snapshot().graph!.runs.find(run => run.branchId === "main")?.status, "idle");
    const target = runtime.snapshot().projection.activeNodeId;
    await runtime.control({ action: "promptAt", requestId: "followup", nodeId: target, text: "second", provider: "faux", modelId: "test" });
    await until(() => runtime.snapshot().projection.nodes.some(node => node.title === "second")
      && runtime.snapshot().graph!.runs.every(run => run.status !== "running"));
    assert.ok(JSON.stringify(runtime.snapshot().entries).includes("after interrupt"));

    let branchStarted = false;
    faux.setResponses([
      async (_context, options) => {
        branchStarted = true;
        await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
      fauxAssistantMessage("branch after interrupt"),
    ]);
    await runtime.control({ action: "promptAt", requestId: "branch-interrupted", nodeId: null,
      text: "branch first", provider: "faux", modelId: "test" });
    await until(() => branchStarted);
    const branch = runtime.snapshot().graph!.runs.find(run => run.requestId === "branch-interrupted")!;
    assert.equal(branch.status, "running");
    const busyNode = runtime.snapshot().projection.nodes.find(node => node.title === "branch first");
    if (busyNode) await assert.rejects(runtime.control({ action: "setLabel", entryId: busyNode.userEntryId, label: "busy" }), /finish/);

    await runtime.control({ action: "branchAbort", branchId: branch.branchId, runId: branch.runId });
    assert.equal(runtime.snapshot().graph!.runs.find(run => run.branchId === branch.branchId)?.status, "idle");
    const branchNode = runtime.snapshot().projection.nodes.find(node => node.title === "branch first")!;
    await runtime.control({ action: "promptAt", requestId: "branch-followup", nodeId: branchNode.id,
      text: "branch second", provider: "faux", modelId: "test" });
    await until(() => runtime.snapshot().projection.nodes.some(node => node.title === "branch second")
      && runtime.snapshot().graph!.runs.every(run => run.status !== "running"));
    assert.ok(JSON.stringify(runtime.snapshot().entries).includes("branch after interrupt"));
    const tree = runtime.snapshot(), path = tree.session.path;
    const main = tree.projection.nodes.find(node => node.title === "first")!;
    const label = async (entryId: string, value?: string) => runtime.control({ action: "setLabel", entryId, label: value }) as Promise<SessionSnapshot>;
    await label(main.userEntryId, "Main bookmark");
    const marked = await label(branchNode.userEntryId, "分支测试通过");
    assert.equal(marked.projection.nodes.find(node => node.id === main.id)?.label, "Main bookmark");
    assert.equal(marked.projection.nodes.find(node => node.id === branchNode.id)?.label, "分支测试通过");
    assert.equal(marked.projection.nodes.length, tree.projection.nodes.length);
    faux.setResponses([fauxAssistantMessage("after bookmark")]);
    await runtime.control({ action: "promptAt", requestId: "labeled-fork", nodeId: main.id, text: "fork after labels", provider: "faux", modelId: "test" });
    await until(() => runtime.snapshot().graph!.runs.every(run => run.status !== "running"));
    await assert.rejects(label("unknown", "bad"), /not found/);
    await assert.rejects(label(main.userEntryId, "bad\nlabel"), /single-line/);
    await runtime.close(); await runtime.open(path);
    assert.equal(runtime.snapshot().projection.nodes.find(node => node.id === branchNode.id)?.label, "分支测试通过");
    const exported = await runtime.control({ action: "exportJsonl" }) as { path: string };
    const data = parseStrict(readFileSync(exported.path, "utf8"));
    assert.ok(data.entries.some(entry => entry.type === "label" && entry.targetId === branchNode.userEntryId && entry.label === "分支测试通过"));
    const exportedBranch = await runtime.control({ action: "exportBranchSession", graphId: path, nodeId: main.id }) as { path: string };
    const exportedData = parseStrict(readFileSync(exportedBranch.path, "utf8"));
    assert.ok(exportedData.entries.some(entry => entry.type === "label" && entry.targetId === main.userEntryId && entry.label === "Main bookmark"));
    await label(branchNode.userEntryId);
    await runtime.close(); await runtime.open(path);
    assert.equal(runtime.snapshot().projection.nodes.find(node => node.id === branchNode.id)?.label, undefined);
    assert.equal(runtime.snapshot().projection.nodes.find(node => node.id === main.id)?.label, "Main bookmark");

  } finally {
    await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(home, { recursive: true, force: true });
  }
});

test("failed persistence after abort blocks writes until the graph is reopened", { timeout: 20000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pix-abort-storage-"));
  const previous = process.env.PIX_HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
  const cwd = join(home, "workspace"); mkdirSync(cwd);
  const runtime = new GraphRuntime(cwd, join(home, "sessions"), () => {}, async () => {});
  const faux = fauxProvider({ models: [{ id: "test", contextWindow: 128000 }] });
  const factory = runtime.factory.bind(runtime);
  runtime.factory = pi => async args => {
    const result = await factory(pi)(args);
    result.services.modelRuntime.registerNativeProvider(faux.provider);
    return result;
  };
  const interrupted = (started: () => void) => async (_context: unknown, options?: { signal?: AbortSignal }) => {
    started();
    await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    return fauxAssistantMessage("", { stopReason: "aborted" });
  };
  try {
    await runtime.create();
    await runtime.control({ action: "setModel", provider: "faux", modelId: "test" });
    const path = runtime.graph!.main;
    let mainStarted = false;
    faux.setResponses([interrupted(() => { mainStarted = true; })]);
    await runtime.control({ action: "promptAt", requestId: "main-fault", nodeId: null, text: "first", provider: "faux", modelId: "test" });
    await until(() => mainStarted);
    const sealMain = t.mock.method(runtime.graph!, "sealMain", () => { throw new Error("simulated main EIO"); });
    const main = runtime.snapshot().graph!.runs.find(run => run.status === "running")!;
    await assert.rejects(runtime.control({ action: "branchAbort", branchId: main.branchId, runId: main.runId }), /storage failure.*main EIO/);
    assert.equal(runtime.snapshot().runtime.available, false);
    assert.match(runtime.snapshot().graph!.storageError ?? "", /Reopen this session.*main EIO/);
    await assert.rejects(runtime.control({ action: "promptAt", requestId: "blocked-main", nodeId: null, text: "must not send" }), /Reopen this session/);
    assert.equal(readdirSync(runtime.graph!.dir).some(name => name.includes("blocked-main")), false);
    sealMain.mock.restore();
    await runtime.open(path);
    assert.equal(runtime.snapshot().runtime.available, true);

    let branchStarted = false;
    faux.setResponses([interrupted(() => { branchStarted = true; })]);
    await runtime.control({ action: "promptAt", requestId: "branch-fault", nodeId: null, text: "branch", provider: "faux", modelId: "test" });
    await until(() => branchStarted);
    const sealBranch = t.mock.method(runtime.graph!, "seal", () => { throw new Error("simulated branch EIO"); });
    const branch = runtime.snapshot().graph!.runs.find(run => run.requestId === "branch-fault")!;
    await assert.rejects(runtime.control({ action: "branchAbort", branchId: branch.branchId, runId: branch.runId }), /storage failure.*branch EIO/);
    assert.equal(runtime.snapshot().runtime.available, false);
    await assert.rejects(runtime.control({ action: "promptAt", requestId: "blocked-branch", nodeId: null, text: "must not send" }), /Reopen this session/);
    sealBranch.mock.restore();
    await runtime.open(path);
    assert.equal(runtime.snapshot().runtime.available, true);
    faux.setResponses([fauxAssistantMessage("after reopen")]);
    await runtime.control({ action: "promptAt", requestId: "recovered", nodeId: runtime.snapshot().projection.activeNodeId,
      text: "safe again", provider: "faux", modelId: "test" });
    await until(() => runtime.snapshot().graph!.runs.every(run => run.status !== "running"));
    assert.ok(JSON.stringify(runtime.snapshot().entries).includes("after reopen"));
    const failedCursor = t.mock.method(runtime.graph!, "saveLeaf", () => { throw new Error("simulated cursor EIO"); });
    await assert.rejects(runtime.close(), /simulated cursor EIO/);
    assert.equal(runtime.graph, undefined, "a failed close releases graph ownership");
    failedCursor.mock.restore();
    await runtime.open(path);
    assert.equal(runtime.snapshot().runtime.available, true);
  } finally {
    await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(home, { recursive: true, force: true });
  }
});

test("permanent node deletion preserves tools and deduplication, and recovers failed commits", { timeout: 30000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pix-delete-runtime-"));
  const previous = process.env.PIX_HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
  const cwd = join(home, "workspace"); mkdirSync(cwd);
  let broadcast: SessionSnapshot | undefined;
  const runtime = new GraphRuntime(cwd, join(home, "sessions"), event => {
    const current = (event as { payload?: { current?: SessionSnapshot } }).payload?.current;
    if (current) broadcast = current;
  }, async () => {});
  const faux = fauxProvider({ models: [{ id: "test", contextWindow: 128000 }] });
  const factory = runtime.factory.bind(runtime);
  runtime.factory = pi => async args => {
    const result = await factory(pi)(args);
    result.services.modelRuntime.registerNativeProvider(faux.provider);
    return result;
  };
  let release!: () => void;
  try {
    await runtime.create();
    await runtime.control({ action: "setModel", provider: "faux", modelId: "test" });
    async function prompt(requestId: string, nodeId: string | null, text: string) {
      faux.setResponses([fauxAssistantMessage(`answer ${text}`)]);
      await runtime.control({ action: "promptAt", requestId, nodeId, text, provider: "faux", modelId: "test" });
      await until(() => runtime.snapshot().graph!.runs.every(run => run.status !== "running"));
      return runtime.snapshot().projection.nodes.find(node => node.title === text)!.id;
    }
    const root = await prompt("root", null, "root");
    const graphId = runtime.graph!.main;
    faux.setResponses([async () => { await new Promise<void>(r => { release = r; }); return fauxAssistantMessage("main answer"); }]);
    await runtime.control({ action: "promptAt", requestId: "main", nodeId: root, text: "main" });
    await until(() => Boolean(release));
    await assert.rejects(runtime.control({ action: "deleteNode", graphId, nodeId: root }), /Stop running tasks/);
    release();
    await until(() => runtime.snapshot().graph!.runs.every(run => run.status !== "running"));
    const a = await prompt("a", root, "DELETE_A_SECRET");
    const a2 = await prompt("a2", a, "DELETE_A2_SECRET");
    const b = await prompt("b", a, "DELETE_B_SECRET");
    const sibling = await prompt("sibling", root, "sibling");
    await assert.rejects(runtime.control({ action: "deleteNode", graphId: "another-session", nodeId: a2 }), /same writable graph/);
    await runtime.control({ action: "setTools", names: ["read"] });
    await runtime.control({ action: "deleteNode", graphId, nodeId: a2 });
    assert.deepEqual(runtime.runtime.session.getActiveToolNames(), ["read"]);
    assert.ok(runtime.snapshot().projection.nodes.some(node => node.id === a));
    assert.ok(runtime.snapshot().projection.nodes.some(node => node.id === b));
    assert.ok(!JSON.stringify(runtime.snapshot()).includes("DELETE_A2_SECRET"));
    async function retryOldRequests() {
      const ids = runtime.snapshot().projection.nodes.map(node => node.id).sort();
      for (const request of [
        { requestId: "root", nodeId: null, text: "root" },
        { requestId: "a", nodeId: root, text: "DELETE_A_SECRET" },
        { requestId: "a2", nodeId: a, text: "DELETE_A2_SECRET" },
      ]) await runtime.control({ action: "promptAt", ...request, provider: "faux", modelId: "test" });
      assert.deepEqual(runtime.snapshot().projection.nodes.map(node => node.id).sort(), ids, "retries never recreate deleted turns or rerun surviving turns");
      assert.ok(runtime.snapshot().graph!.runs.every(run => run.status !== "running"));
    }
    await retryOldRequests();
    const continued = await prompt("continue-a", a, "continued");
    assert.equal(runtime.snapshot().projection.nodes.find(node => node.id === continued)!.parentId, a);
    await runtime.control({ action: "deleteNode", graphId, nodeId: a });
    assert.ok(runtime.snapshot().projection.nodes.some(node => node.id === sibling));
    assert.ok(!runtime.snapshot().projection.nodes.some(node => [a, b, continued].includes(node.id)));
    for (const name of readdirSync(runtime.graph!.dir))
      assert.ok(!readFileSync(join(runtime.graph!.dir, name), "utf8").includes("DELETE_"), name);
    const exported = await runtime.control({ action: "exportJsonl" }) as { path: string };
    assert.ok(!readFileSync(exported.path, "utf8").includes("DELETE_"));
    const ids = runtime.snapshot().projection.nodes.map(node => node.id).sort();
    await runtime.close(); await runtime.open(graphId);
    assert.deepEqual(runtime.snapshot().projection.nodes.map(node => node.id).sort(), ids);
    await retryOldRequests();
    const mainNode = runtime.snapshot().projection.nodes.find(node => node.title === "main")!;
    await runtime.control({ action: "deleteNode", graphId, nodeId: mainNode.id });
    assert.equal(runtime.snapshot().projection.activeNodeId, root);
    assert.ok(!JSON.stringify(runtime.runtime.session.sessionManager.buildSessionContext()).includes("main answer"));
    await retryOldRequests();
    await runtime.control({ action: "setModel", provider: "faux", modelId: "test" });
    await runtime.control({ action: "deleteNode", graphId, nodeId: root });
    assert.equal(runtime.snapshot().projection.nodes.length, 0);
    assert.equal(runtime.state().model?.provider, "faux");
    assert.equal(runtime.state().model?.id, "test");
    assert.ok(runtime.runtime.session.sessionManager.buildSessionContext().messages.every(
      (message: { role: string }) => message.role === "system"), "deletion leaves no conversation messages in model context");
    const fresh = await prompt("fresh", null, "fresh");
    assert.equal(runtime.snapshot().projection.nodes.length, 1);
    const failingChild = await prompt("failure-child", fresh, "failure child");
    await runtime.control({ action: "setTools", names: ["read"] });
    const graph = runtime.graph!;
    const commitFailure = t.mock.method(graph, "finishDeletion", () => {
      const plan = JSON.parse(readFileSync(join(graph.dir, "delete-pending.json"), "utf8"));
      durableWrite(graph.main, plan.writes.main); // Fail after one file has already committed.
      throw new Error("simulated EACCES");
    });
    await assert.rejects(runtime.control({ action: "deleteNode", graphId, nodeId: failingChild }), /simulated EACCES/);
    assert.equal(commitFailure.mock.callCount(), 2);
    commitFailure.mock.restore();
    assert.equal(Boolean(runtime.runtime), false);
    assert.equal(runtime.snapshot().runtime.available, false);
    assert.equal(broadcast?.runtime.available, false, "every connected renderer sees the unavailable state");
    assert.match(broadcast?.graph?.storageError ?? "", /Reopen this session/);
    await assert.rejects(runtime.control({ action: "promptAt", requestId: "blocked", nodeId: fresh, text: "blocked" }), /Reopen this session/);
    const openFailure = t.mock.method(runtime, "factory", () => async () => { throw new Error("simulated open failure"); });
    await assert.rejects(runtime.open(graphId), /simulated open failure/);
    openFailure.mock.restore();
    assert.equal(runtime.snapshot().runtime.available, false);
    await runtime.open(graphId);
    assert.equal(runtime.snapshot().runtime.available, true);
    assert.equal(runtime.snapshot().graph?.storageError, undefined);
    assert.deepEqual(runtime.runtime.session.getActiveToolNames(), ["read"], "recovery restores tool restrictions even after a failed reopen");
    assert.ok(!runtime.snapshot().projection.nodes.some(node => node.id === failingChild));
    const last = await prompt("after-recovery", fresh, "after recovery");
    const prepareFailure = t.mock.method(runtime.graph!, "deleteNode", () => { throw new Error("simulated validation failure"); });
    await assert.rejects(runtime.control({ action: "deleteNode", graphId, nodeId: last }), /simulated validation failure/);
    prepareFailure.mock.restore();
    assert.equal(runtime.snapshot().runtime.available, true, "a pre-commit failure restores the usable original session");
    assert.equal(runtime.snapshot().projection.activeNodeId, last);
    assert.deepEqual(runtime.runtime.session.getActiveToolNames(), ["read"]);
  } finally {
    release?.(); await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(home, { recursive: true, force: true });
  }
});
test("independent branches persist without merging; export during a run preserves the live runtime", { timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-parallel-"));
  const previous = process.env.PIX_HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
  const cwd = join(home, "workspace"); mkdirSync(cwd);
  const runtime = new GraphRuntime(cwd, join(home, "sessions"), () => {}, async () => {});
  const faux = fauxProvider({ models: [{ id: "test", contextWindow: 128000 }] });
  const factory = runtime.factory.bind(runtime);
  runtime.factory = pi => async args => {
    const result = await factory(pi)(args);
    result.services.modelRuntime.registerNativeProvider(faux.provider);
    return result;
  };
  let releaseMain!: () => void;
  let releaseA!: () => void;
  try {
    await runtime.create();
    await runtime.control({ action: "setModel", provider: "faux", modelId: "test" });
    // Real providers keep optional fields in memory which Pi omits from JSONL.
    faux.setResponses([{ ...fauxAssistantMessage("root answer"), errorMessage: undefined }]);
    await runtime.control({ action: "prompt", text: "root prompt" });
    const manager = runtime.runtime.session.sessionManager as SessionManager;
    const answer = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "assistant")!;
    manager.appendContextEdit(answer.id, { content: "edited root context" });
    manager.appendUsage("cache_warm", "faux", "test", fauxAssistantMessage("").usage);
    await runtime.runtime.session.refreshContext();
    const root = runtime.snapshot().projection.activeNodeId!;
    faux.setResponses([
      async (context) => {
        assert.ok(JSON.stringify(context.messages).includes("edited root context"));
        assert.ok(!JSON.stringify(context.messages).includes("root answer"));
        await new Promise<void>(r => { releaseMain = r; }); return fauxAssistantMessage("main answer");
      },
      fauxAssistantMessage("A answer"),
      async (_context, options) => { await new Promise<void>(r => { releaseA = r; options?.signal?.addEventListener("abort", () => r(), { once: true }); }); return fauxAssistantMessage("A continuation"); },
      fauxAssistantMessage("B answer"),
    ]);
    await runtime.control({ action: "promptAt", requestId: "main-run", nodeId: root, text: "main question" });
    await until(() => Boolean(releaseMain));
    const mainFile = runtime.graph!.main;
    const runningMain = readFileSync(mainFile, "utf8");
    await runtime.control({ action: "promptAt", requestId: "A-run", nodeId: root, text: "A question" });
    await until(() => {
      const run = runtime.snapshot().graph!.runs.find(r => r.requestId === "A-run");
      if (run?.status === "interrupted") throw new Error(run.error);
      return run?.status === "idle";
    });
    const a = runtime.snapshot().graph!.runs.find(r => r.requestId === "A-run")!;
    assert.equal(runtime.snapshot().session.firstMessage, "root prompt", "branch snapshots retain the main session title");
    assert.equal(runtime.runtime.session.isStreaming, true);
    assert.equal(readFileSync(mainFile, "utf8"), runningMain, "main file is untouched by finished child");
    const beforeContinuation = runtime.graph!.records.size;
    await runtime.control({ action: "promptAt", requestId: "A-next", nodeId: a.nodeId, text: "A next question" });
    await until(() => Boolean(releaseA));
    assert.equal(runtime.graph!.records.size, beforeContinuation, "continuing an idle leaf reuses its session");
    await runtime.control({ action: "promptAt", requestId: "B-run", nodeId: a.nodeId, text: "B question" });
    await until(() => runtime.snapshot().graph!.runs.some(r => r.requestId === "B-run" && r.status === "idle"));
    const b = runtime.snapshot().graph!.runs.find(r => r.requestId === "B-run")!;
    assert.equal(runtime.snapshot().projection.nodes.find(n => n.id === b.nodeId)!.parentId, a.nodeId);
    const count = runtime.graph!.records.size;
    await runtime.control({ action: "promptAt", requestId: "B-run", nodeId: a.nodeId, text: "B question" });
    assert.equal(runtime.graph!.records.size, count);
    const continuing = runtime.snapshot().graph!.runs.find(r => r.requestId === "A-next")!;
    await assert.rejects(runtime.control({ action: "branchAbort", branchId: continuing.branchId, runId: "stale-run" }), /stale/);
    assert.equal(runtime.snapshot().graph!.runs.find(r => r.requestId === "A-next")!.status, "running");
    await runtime.control({ action: "branchAbort", branchId: continuing.branchId, runId: continuing.runId });
    assert.equal(runtime.runtime.session.isStreaming, true, "stopping A does not stop the main run");
    const live = runtime.runtime;
    const exported = await runtime.control({ action: "exportJsonl" }) as { path: string };
    assert.ok(readFileSync(exported.path, "utf8").includes("B answer"));
    assert.equal(runtime.runtime, live, "export never replaces the active runtime");
    assert.equal(runtime.runtime.session.isStreaming, true);
    assert.equal(readFileSync(mainFile, "utf8"), runningMain);
    const html = await runtime.control({ action: "exportHtml" }) as { path: string };
    assert.ok(readFileSync(html.path, "utf8").includes("<!DOCTYPE html>"));
    await assert.rejects(runtime.control({ action: "exportHtml", outputPath: mainFile }), /already exists/);
    releaseMain();
    await until(() => runtime.snapshot().graph!.runs.every(r => r.status !== "running"));
    await new Promise(r => setTimeout(r, 600));
    const done = runtime.snapshot();
    assert.equal(done.graph!.storageError, undefined);
    assert.ok(!readFileSync(mainFile, "utf8").includes("B answer"), "idle sessions never merge automatically");
    const messages = runtime.runtime.session.sessionManager.buildSessionContext().messages;
    assert.ok(messages.some((m: any) => JSON.stringify(m).includes("main answer")));
    assert.ok(!messages.some((m: any) => JSON.stringify(m).includes("B answer")));
    const nodes = new Map(done.projection.nodes.map(n => [n.id, { parentId: n.parentId, leafEntryId: n.leafEntryId }]));
    await runtime.close(); await runtime.open(mainFile);
    // Source files are enumerated by filename after restart, not creation order.
    assert.deepEqual(new Map(runtime.snapshot().projection.nodes.map(n => [n.id, { parentId: n.parentId, leafEntryId: n.leafEntryId }])), nodes);
    assert.ok(JSON.stringify(runtime.runtime.session.sessionManager.buildSessionContext()).includes("edited root context"));
    runtime.runtime.session.sessionManager.resetLeaf();
    await runtime.close(); await runtime.open(mainFile);
    assert.equal(runtime.runtime.session.sessionManager.buildSessionContext().messages.length, 0,
      "an explicitly empty main context survives reopening, even if SDK startup appends settings");
  } finally {
    releaseA?.(); releaseMain?.(); await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(home, { recursive: true, force: true });
  }
});
test("branch export copies a root-to-node path into a standalone session without touching the graph", { timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-export-branch-"));
  const previous = process.env.PIX_HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
  const cwd = join(home, "workspace"); mkdirSync(cwd);
  const sessions = join(home, "sessions");
  const runtime = new GraphRuntime(cwd, sessions, () => {}, async () => {});
  const faux = fauxProvider({ models: [{ id: "test", contextWindow: 128000 }] });
  const factory = runtime.factory.bind(runtime);
  runtime.factory = pi => async args => {
    const result = await factory(pi)(args);
    result.services.modelRuntime.registerNativeProvider(faux.provider);
    return result;
  };
  let releaseHeld!: () => void;
  try {
    await runtime.create();
    await runtime.control({ action: "setModel", provider: "faux", modelId: "test" });
    async function turn(requestId: string, nodeId: string | null, text: string, answer: string) {
      faux.setResponses([fauxAssistantMessage(answer)]);
      await runtime.control({ action: "promptAt", requestId, nodeId, text, provider: "faux", modelId: "test" });
      await until(() => runtime.snapshot().graph!.runs.every(run => run.status !== "running"));
      return runtime.snapshot().projection.nodes.find(node => node.title === text)!.id;
    }
    const root = await turn("root", null, "root prompt", "root answer");
    // Advance main past the root so prompts at the historical root fork parallel branches.
    await turn("main", root, "main question", "main answer");
    const a = await turn("a", root, "A question", "A answer");
    const a2 = await turn("a-next", a, "A next question", "A next answer");
    const b = await turn("b", a, "B question", "B answer");
    const graphId = runtime.graph!.main;
    const graphBefore = readFileSync(graphId, "utf8");
    const recordsBefore = runtime.graph!.records.size;
    const nodesBefore = runtime.snapshot().projection.nodes.map(node => node.id).sort();

    await assert.rejects(runtime.control({ action: "exportBranchSession", graphId: "other", nodeId: a2 }), /same graph/);
    await assert.rejects(runtime.control({ action: "exportBranchSession", graphId, nodeId: "turn:gone" }), /no longer exists/);
    // Any node exports its root-to-node path; the turns after it stay behind.
    const midExport = await runtime.control({ action: "exportBranchSession", graphId, nodeId: a }) as { path: string };
    const midRaw = readFileSync(midExport.path, "utf8");
    assert.ok(midRaw.includes("root prompt") && midRaw.includes("A answer"));
    for (const text of ["A next question", "B question", "main question"]) assert.ok(!midRaw.includes(text), text);
    const rootExport = await runtime.control({ action: "exportBranchSession", graphId, nodeId: root }) as { path: string };
    const rootRaw = readFileSync(rootExport.path, "utf8");
    assert.ok(rootRaw.includes("root answer"));
    assert.ok(!rootRaw.includes("A question") && !rootRaw.includes("main question"));

    const exported = await runtime.control({ action: "exportBranchSession", graphId, nodeId: a2 }) as { path: string };
    const raw = readFileSync(exported.path, "utf8");
    assert.ok(exported.path.startsWith(sessions), "the exported session lands in the session directory");
    for (const text of ["root prompt", "root answer", "A question", "A answer", "A next question", "A next answer"])
      assert.ok(raw.includes(text), text);
    for (const text of ["main question", "B question", "B answer"]) assert.ok(!raw.includes(text), text);
    const parsed = parseStrict(raw);
    assert.notEqual(parsed.header.id, parseStrict(graphBefore).header.id);
    assert.equal(parsed.header.parentSession, graphId);
    const manager = SessionManager.inMemory(cwd, undefined, [parsed.header, ...parsed.entries] as any);
    assert.equal(manager.getTree().length, 1, "the exported path is one linear branch");
    assert.equal(readFileSync(graphId, "utf8"), graphBefore);
    assert.equal(runtime.graph!.records.size, recordsBefore);
    assert.deepEqual(runtime.snapshot().projection.nodes.map(node => node.id).sort(), nodesBefore);

    const exportedB = await runtime.control({ action: "exportBranchSession", graphId, nodeId: b }) as { path: string };
    const rawB = readFileSync(exportedB.path, "utf8");
    assert.ok(rawB.includes("B answer"));
    assert.ok(!rawB.includes("A next question"));

    faux.setResponses([async () => { await new Promise<void>(r => { releaseHeld = r; }); return fauxAssistantMessage("held answer"); }]);
    await runtime.control({ action: "promptAt", requestId: "held", nodeId: a2, text: "held question", provider: "faux", modelId: "test" });
    await until(() => {
      const run = runtime.snapshot().graph!.runs.find(r => r.requestId === "held");
      return run?.status === "running" && Boolean(run.nodeId);
    });
    const held = runtime.snapshot().graph!.runs.find(r => r.requestId === "held")!;
    await assert.rejects(runtime.control({ action: "exportBranchSession", graphId, nodeId: held.nodeId! }), /Wait for this turn/);
    releaseHeld();
    await until(() => runtime.snapshot().graph!.runs.every(run => run.status !== "running"));

    // The export is a live, standalone session: it reopens and continues on its own.
    await runtime.close();
    await runtime.open(exported.path);
    assert.deepEqual(runtime.snapshot().projection.nodes.map(node => node.title),
      ["root prompt", "A question", "A next question"]);
    await runtime.control({ action: "setModel", provider: "faux", modelId: "test" });
    faux.setResponses([fauxAssistantMessage("exported continuation")]);
    await runtime.control({ action: "prompt", text: "continue exported" });
    await until(() => runtime.snapshot().graph!.runs.every(run => run.status !== "running"));
    assert.equal(runtime.snapshot().projection.nodes.length, 4);
    assert.equal(runtime.snapshot().projection.nodes.at(-1)!.title, "continue exported");
  } finally {
    releaseHeld?.(); await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(home, { recursive: true, force: true });
  }
});
