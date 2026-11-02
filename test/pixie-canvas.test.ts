import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PixieRpc } from "../src/main/pixie-rpc.js";
import { PixieRuntime } from "../src/main/pixie-runtime.js";
import type { SessionSnapshot } from "../src/shared/types.js";
import { canvasCommand, type CanvasCommand } from "../src/shared/canvas.js";

test("canvas commands reject unknown actions, missing context and malformed attachments", () => {
  assert.throws(() => canvasCommand({ action: "shell" }), /Unknown/);
  assert.throws(() => canvasCommand({ action: "send", text: "hello", nodeId: null }), /context/);
  assert.throws(() => canvasCommand({ action: "move", context: "x", x: NaN }), /finite/);
  assert.throws(() => canvasCommand({ action: "inspect", limit: -1 }), /limit/);
  assert.throws(() => canvasCommand({ action: "send", context: "x", images: [{}] }), /image/i);
});

test("a concurrent Pixie send cannot take over the current turn's canvas", async t => {
  const home = mkdtempSync(join(tmpdir(), "pixie-canvas-owner-")), previous = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const runtime = new PixieRuntime(() => {}, () => ({}));
  const snapshot = {} as SessionSnapshot;
  t.mock.method(runtime, "ensure", async () => snapshot);
  t.mock.method(runtime as any, "snapshot", async () => snapshot);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(runtime["rpc"], "request", async (...[command]: Parameters<PixieRpc["request"]>) => {
    if (command.type === "prompt") { entered(); await gate; }
    return {};
  });
  const first = runtime.send({ text: "first" }, async () => "window-a");
  await started;
  assert.equal(runtime.busy, true);
  await assert.rejects(runtime.send({ text: "second" }, async () => "window-b"), /already answering/);
  assert.equal(await runtime["rpc"]["canvas"]!({ action: "inspect" }), "window-a");
  release();
  runtime["onWireEvent"]({ type: "agent_settled" });
  await first;
  assert.equal(runtime.busy, false);
  assert.throws(() => runtime["rpc"]["canvas"]!({ action: "inspect" }), /connected desktop/);
});

test("the real Pi subprocess loads the canvas tool and exchanges tool calls over private IPC", { timeout: 60_000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "pixie-canvas-"));
  const previousHome = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  const agentDir = join(home, "agent"); mkdirSync(agentDir);
  const extension = join(home, "faux.mjs");
  writeFileSync(extension, `
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
    export default pi => {
      const faux = fauxProvider({ models: [{ id: "canvas-test", contextWindow: 128000 }] });
      pi.registerProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("canvas", { action: "inspect" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("canvas", { action: "send", context: "fixture", nodeId: "turn:root", text: "new branch" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("canvas", { action: "delete", context: "fixture", nodeId: "turn:busy" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("Canvas work submitted; busy node was kept.")
      ]);
    }
  `);
  const commands: CanvasCommand[] = [];
  const rpc = new PixieRpc(async command => {
    commands.push(command);
    if (command.action === "delete") throw new Error("The branch is running");
    return command.action === "inspect" ? { context: "fixture", nodes: [{ id: "turn:root" }] } : { submitted: true, nodeId: "turn:new" };
  });
  t.after(async () => {
    await rpc.stop();
    if (previousHome === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  await rpc.start(home, { PI_CODING_AGENT_DIR: agentDir, PIX_HOME: home, PI_OFFLINE: "1" }, [
    "--extension", fileURLToPath(new URL("../src/main/pixie-extension.js", import.meta.url)),
    "--extension", extension, "--provider", "faux", "--model", "canvas-test", "--no-skills", "--no-prompt-templates",
  ]);
  const events: any[] = [];
  const settled = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Pixie did not settle: ${JSON.stringify(events)}`)), 40_000);
    rpc.onExit(error => { clearTimeout(timer); reject(error); });
    rpc.onEvent(event => {
      events.push(event);
      if (event.type === "agent_settled") { clearTimeout(timer); resolve(); }
    });
  });
  await rpc.request({ type: "prompt", message: "Create a canvas branch, then try deleting a busy node." });
  await settled;
  assert.deepEqual(commands.map(command => command.action), ["inspect", "send", "delete"]);
  const results = events.filter(event => event.type === "tool_execution_end");
  assert.equal(results.length, 3);
  assert.match(JSON.stringify(results[1].result), /turn:new/);
  assert.match(JSON.stringify(results[2].result), /branch is running/);
  assert.equal(results[2].isError, true);
});
