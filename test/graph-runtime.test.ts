import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { GraphRuntime } from "../src/main/graph-runtime.js";
import { durableWrite } from "../src/main/graph-files.js";
import type { SessionSnapshot } from "../src/shared/types.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error("Timed out waiting for graph state");
}

test("permanent node deletion preserves tools and deduplication, and recovers failed commits", { timeout: 30000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pix-delete-runtime-"));
  const previous = process.env.PIX_HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
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
    assert.equal(runtime.runtime.session.sessionManager.buildSessionContext().messages.length, 0);
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
  process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
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
    const root = runtime.snapshot().projection.activeNodeId!;
    faux.setResponses([
      async () => { await new Promise<void>(r => { releaseMain = r; }); return fauxAssistantMessage("main answer"); },
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
