import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { PixieRpc } from "../src/main/pixie-rpc.js";
import { PixieRuntime } from "../src/main/pixie-runtime.js";
import type { SessionSnapshot } from "../src/shared/types.js";
import { CANVAS_ACTIONS, CANVAS_TOOLS, CANVAS_SKILLS, PIXIE_DEFAULT_TOOLS, canvasToolName, canvasToolCommand, canvasCommand, type CanvasAction, type CanvasCommand } from "../src/shared/canvas.js";

test("each canvas operation has a scoped native schema and cannot be redirected by arguments", () => {
  assert.equal(CANVAS_TOOLS.length, Object.keys(CANVAS_ACTIONS).length);
  assert.equal(new Set(CANVAS_TOOLS.map(tool => tool.name)).size, CANVAS_TOOLS.length);
  for (const tool of CANVAS_TOOLS) {
    assert.ok(!Object.hasOwn(tool.parameters.properties, "action"));
    assert.equal(tool.parameters.additionalProperties, false);
  }
  const validate = (action: CanvasAction, args: Parameters<typeof validateToolArguments>[1]["arguments"]) => {
    const tool = CANVAS_TOOLS.find(tool => tool.action === action)!;
    return canvasToolCommand(action, validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: args }));
  };
  assert.deepEqual(validate("inspect", {}), { action: "inspect" });
  assert.throws(() => validate("newSession", {}), /context/);
  assert.throws(() => validate("label", { context: "c", text: "label" }), /nodeId/);
  assert.throws(() => validate("move", { context: "c", nodeId: "n", x: 1 }), /y/);
  assert.throws(() => validate("delegate", { context: "c", purpose: "why", acceptance: "proof" }), /text/);
  assert.throws(() => validate("read", { context: "c" }), /Validation failed/);
  assert.equal(validate("read", { taskId: "t" }).taskId, "t");
  assert.equal(validate("read", { context: "c", nodeId: "n" }).nodeId, "n");
  assert.equal(validate("delegate", { context: "c", text: "work", purpose: "why", acceptance: "proof" }).nodeId, null);
  assert.equal(validate("delegate", { taskId: "t", text: "work", purpose: "why", acceptance: "proof" }).nodeId, undefined);
  assert.throws(() => canvasToolCommand("inspect", { action: "delete" }), /Unexpected argument/);
  assert.throws(() => validate("minimap", { context: "c", enabled: true, text: "unused" }), /text/);
});

test("canvas commands reject unknown actions, missing context and malformed attachments", () => {
  assert.throws(() => canvasCommand({ action: "shell" }), /Unknown/);
  assert.throws(() => canvasCommand({ action: "send", text: "hello", nodeId: null }), /context/);
  assert.throws(() => canvasCommand({ action: "move", context: "x", x: NaN }), /finite/);
  assert.throws(() => canvasCommand({ action: "inspect", limit: -1 }), /limit/);
  assert.throws(() => canvasCommand({ action: "send", context: "x", images: [{}] }), /image/i);
  assert.throws(() => canvasCommand({ action: "delegate", context: "x", nodeId: "null" }), /JSON null without quotes/);
  assert.equal(canvasCommand({ action: "delegate", context: "x" }).nodeId, null);
  assert.equal(canvasCommand({ action: "delegate", taskId: "task-1" }).nodeId, undefined);
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
  await assert.rejects(async () => runtime["rpc"]["canvas"]!({ action: "inspect" }), /no live canvas/);
});

test("the real Pi subprocess loads skills on demand, preserves core tools and resets auxiliary tools next turn", { timeout: 60_000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "pixie-canvas-"));
  const previousHome = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  const agentDir = join(home, "agent"); mkdirSync(agentDir);
  const extension = join(home, "faux.mjs");
  writeFileSync(extension, `
    import { getCurrentTools } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
    export default pi => {
      const faux = fauxProvider({ models: [{ id: "canvas-test", contextWindow: 128000 }] });
      pi.registerProvider(faux.provider);
      faux.setResponses([
        context => {
          const names = getCurrentTools(context.messages).map(tool => tool.name).sort();
          if (JSON.stringify(names) !== JSON.stringify(${JSON.stringify(PIXIE_DEFAULT_TOOLS.map(tool => tool.name).sort())})) throw new Error('Unexpected active tool set: ' + names.join(','));
          return fauxAssistantMessage([fauxToolCall("canvas_inspect", {})], { stopReason: "toolUse" });
        },
        fauxAssistantMessage([fauxToolCall("canvas_skill", { name: "canvas-editing" })], { stopReason: "toolUse" }),
        context => {
          const names = getCurrentTools(context.messages).map(tool => tool.name).sort();
          const expected = ${JSON.stringify([...PIXIE_DEFAULT_TOOLS.map(tool => tool.name), ...CANVAS_SKILLS.find(s => s.name === "canvas-editing")!.actions.map(canvasToolName)].sort())};
          if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('Skill activated incorrect tools: ' + names);
          const result = context.messages.findLast(m => m.role === 'toolResult');
          if (!JSON.stringify(result).includes('Drafts and direct session editing')) throw new Error('Skill instructions missing');
          return fauxAssistantMessage([fauxToolCall("canvas_send", { context: "fixture", nodeId: "turn:root", text: "new branch" })], { stopReason: "toolUse" });
        },
        fauxAssistantMessage([fauxToolCall("canvas_skill", { name: "canvas-view" })], { stopReason: "toolUse" }),
        context => {
          const names = getCurrentTools(context.messages).map(tool => tool.name);
          if (!names.includes('canvas_send') || !names.includes('canvas_label') || names.includes('canvas_clear_queue')) throw new Error('Skill groups must activate cumulatively and independently');
          return fauxAssistantMessage([fauxToolCall("canvas_label", { context: "fixture", nodeId: "turn:new", text: "Reviewed" })], { stopReason: "toolUse" });
        },
        fauxAssistantMessage([fauxToolCall("canvas_delete", { context: "fixture", nodeId: "turn:busy" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("Canvas work submitted; busy node was kept."),
        context => {
          const names = getCurrentTools(context.messages).map(tool => tool.name).sort();
          if (JSON.stringify(names) !== JSON.stringify(${JSON.stringify(PIXIE_DEFAULT_TOOLS.map(tool => tool.name).sort())})) throw new Error('Auxiliary tools leaked into the next turn: ' + names);
          return fauxAssistantMessage('Core tools restored.');
        }
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
  assert.deepEqual(commands.map(command => command.action), ["inspect", "send", "label", "delete"], JSON.stringify(events.filter(event => event.type === "message_end")));
  const results = events.filter(event => event.type === "tool_execution_end");
  assert.equal(results.length, 6);
  assert.match(JSON.stringify(results[2].result), /turn:new/);
  assert.match(JSON.stringify(results[5].result), /branch is running/);
  assert.equal(results[5].isError, true);
  const nextSettled = new Promise<void>(resolve => {
    const off = rpc.onEvent(event => { if (event.type === "agent_settled") { off(); resolve(); } });
  });
  await rpc.request({ type: "prompt", message: "An unrelated coordination question." });
  await nextSettled;
  assert.match(JSON.stringify(events.filter(e => e.type === "message_end").at(-1)), /Core tools restored/);
});


test("canvas schema exposes opt-in details and rejects ignored address combinations", () => {
  assert.deepEqual(canvasCommand({ action: "inspect", include: ["models", "queue"] }).include, ["models", "queue"]);
  assert.throws(() => canvasCommand({ action: "inspect", include: ["unknown"] }), /include/);
  assert.throws(() => canvasCommand({ action: "inspect", include: [["models"]] }), /include/);
  assert.throws(() => canvasCommand({ action: "inspect", include: ["models", "models"] }), /include/);
  assert.throws(() => canvasCommand({ action: "read", taskId: "t", context: "c" }), /not both/);
  assert.throws(() => canvasCommand({ action: "stop", taskId: "t", nodeId: "n" }), /not both/);
  assert.throws(() => canvasCommand({ action: "tasks", taskId: "t", limit: 2 }), /listings/);
  assert.equal(canvasCommand({ action: "delegate", taskId: "t", nodeId: "n" }).nodeId, "n");
});
