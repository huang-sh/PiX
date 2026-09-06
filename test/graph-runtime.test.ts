import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { GraphRuntime } from "../src/main/graph-runtime.js";
import type { SessionSnapshot } from "../src/shared/types.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error("Timed out waiting for graph state");
}
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
