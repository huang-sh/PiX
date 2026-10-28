import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { GraphRuntime } from "../src/main/graph-runtime.js";
import { validateRouteInput } from "../src/shared/contracts.js";
import type { AgentControl } from "../src/shared/types.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Timed out waiting for queue state");
}

async function fixture(t: test.TestContext, configure?: (runtime: GraphRuntime) => void) {
  const home = mkdtempSync(join(tmpdir(), "pix-input-queue-"));
  const previous = { home: process.env.PIX_HOME, agent: process.env.PI_CODING_AGENT_DIR };
  process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  const runtime = new GraphRuntime(home, join(home, "sessions"), () => {}, async () => {});
  const faux = fauxProvider({ models: [{ id: "test", input: ["text", "image"] }] });
  const factory = runtime.factory.bind(runtime);
  runtime.factory = pi => async args => {
    const created = await factory(pi)(args);
    created.services.modelRuntime.registerNativeProvider(faux.provider);
    return created;
  };
  t.after(async () => {
    await runtime.close();
    if (previous.home === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous.home;
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
    rmSync(home, { recursive: true, force: true });
  });
  configure?.(runtime);
  await runtime.create();
  return { runtime, faux, home };
}

test("queue controls preserve branch identity across IPC and reject partial targets", () => {
  for (const action of ["steer", "followUp", "clearQueue", "updateQueuedMessage"]) {
    const input = { action, text: "next", id: "message", operation: "steer", graphId: "g", branchId: "b", runId: "r" };
    const value = validateRouteInput("agent.control", input) as AgentControl & { graphId: string; branchId: string; runId: string };
    assert.equal(value.graphId, "g"); assert.equal(value.branchId, "b"); assert.equal(value.runId, "r");
    assert.throws(() => validateRouteInput("agent.control", { ...input, runId: undefined }));
  }
  assert.throws(() => validateRouteInput("agent.control", { action: "updateQueuedMessage", id: "q", operation: "unknown" }));
  for (const text of [undefined, null, 123, {}])
    assert.throws(() => validateRouteInput("agent.control", { action: "updateQueuedMessage", id: "q", operation: "edit", text }));
  assert.deepEqual(validateRouteInput("agent.control", { action: "updateQueuedMessage", id: "q", operation: "edit", text: "" }),
    { action: "updateQueuedMessage", id: "q", operation: "edit", text: "" });
});

test("idle sessions cannot enqueue or steer inputs", async t => {
  const { runtime, faux } = await fixture(t);
  for (const action of ["steer", "followUp"] as const)
    await assert.rejects(runtime.control({ action, text: "ordinary next turn" }), /finished/);
  await assert.rejects(runtime.control({ action: "updateQueuedMessage", id: "old-input", operation: "steer" }), /finished/);
  await assert.rejects(runtime.control({ action: "updateQueuedMessage", id: "old-input", operation: "edit", text: "edited" }), /finished/);
  assert.deepEqual(runtime.snapshot().runtime.queuedMessages, []);
  assert.equal(faux.state.callCount, 0);
});

test("Follow-up queues can be steered or removed without changing branch, order, or attachments", { timeout: 60000 }, async t => {
  for (const branch of [false, true]) for (const mode of ["one-at-a-time", "all"] as const) {
    await t.test(`${branch ? "branch" : "main"}: ${mode}`, async t => {
      const { runtime, faux, home } = await fixture(t);
      writeFileSync(join(home, "probe.txt"), "tool result must survive steering");
      if (branch) {
        runtime.runtime.session.sessionManager.appendMessage({ role: "user", content: "parent", timestamp: 1 });
        runtime.runtime.session.sessionManager.appendMessage(fauxAssistantMessage("parent answer"));
      }
      await runtime.control({ action: "setQueueMode", kind: "followUp", mode });
      let release!: () => void, entered = false;
      const gate = new Promise<void>(resolve => { release = resolve; });
      t.after(release);
      const requests: string[] = [];
      faux.setResponses([async context => {
        requests.push(JSON.stringify(context.messages)); entered = true; await gate;
        return fauxAssistantMessage(fauxToolCall("read", { path: "probe.txt" }));
      }, ...Array.from({ length: mode === "all" ? 2 : 3 }, () => (context: { messages: unknown }) => {
        requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage("done");
      })]);
      await runtime.control({ action: "promptAt", requestId: "original", nodeId: null, text: "original task", provider: "faux", modelId: "test" });
      await until(() => entered);
      const run = runtime.snapshot().graph!.runs.find(run => run.requestId === "original")!;
      assert.equal(run.branchId === "main", !branch);
      const target = { graphId: runtime.snapshot().graph!.id, branchId: run.branchId, runId: run.runId };
      const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
      for (const text of ["first follow-up", "urgent adjustment", "remove me", "second follow-up"])
        await runtime.control({ action: "followUp", text, ...(text === "first follow-up" ? { images: [image] } : {}), ...target });
      const queue = runtime.snapshot().graph!.runs.find(value => value.runId === run.runId)!.runtime!.queuedMessages!;
      assert.deepEqual(queue.map(message => message.text), ["first follow-up", "urgent adjustment", "remove me", "second follow-up"]);
      assert.equal(queue[0]!.imageCount, 1);
      await runtime.control({ action: "updateQueuedMessage", id: queue[0]!.id, operation: "edit", text: "edited first follow-up", ...target });
      const edited = runtime.snapshot().graph!.runs.find(value => value.runId === run.runId)!.runtime!.queuedMessages!;
      assert.deepEqual(edited.map(message => message.id), queue.map(message => message.id));
      assert.equal(edited[0]!.kind, "followUp");
      assert.equal(edited[0]!.imageCount, 1);
      await assert.rejects(runtime.control({ action: "updateQueuedMessage", id: queue[2]!.id, operation: "edit", text: "  ", ...target }), /contain text or images/);
      await runtime.control({ action: "updateQueuedMessage", id: queue[1]!.id, operation: "steer", ...target });
      await runtime.control({ action: "updateQueuedMessage", id: queue[2]!.id, operation: "remove", ...target });
      await assert.rejects(runtime.control({ action: "followUp", text: "stale", ...target, runId: "old-run" }), /ended/);
      assert.equal(requests.length, 1);
      release();
      await until(() => !runtime.busy);
      assert.equal(requests.length, mode === "all" ? 3 : 4);
      assert.match(requests[1]!, /urgent adjustment/);
      assert.match(requests[1]!, /tool result must survive steering/);
      assert.doesNotMatch(requests[1]!, /first follow-up|second follow-up|remove me/);
      assert.match(requests[2]!, /edited first follow-up/);
      assert.match(requests[2]!, /iVBORw0KGgo=/);
      if (mode === "all") assert.match(requests[2]!, /second follow-up/);
      else { assert.doesNotMatch(requests[2]!, /second follow-up/); assert.match(requests[3]!, /second follow-up/); }
      const snapshot = runtime.snapshot();
      assert.ok(!snapshot.graph!.storageError);
      const nodes = snapshot.projection.nodes.filter(node => node.branchId === run.branchId);
      assert.deepEqual(nodes.map(node => node.title), ["original task", "urgent adjustment", "edited first follow-up", "second follow-up"]);
      for (let index = 1; index < nodes.length; index++) assert.equal(nodes[index]!.parentId, nodes[index - 1]!.id);
      for (const node of nodes) {
        assert.equal(typeof node.metrics?.durationMs, "number", `missing duration on ${node.title}`);
        assert.ok(node.metrics?.startedAt, `missing timing on ${node.title}`);
        assert.equal(node.footer?.model?.provider, "faux");
      }
      assert.deepEqual(snapshot.graph!.runs.find(value => value.runId === run.runId)!.runtime!.queuedMessages, []);
      for (const message of queue) assert.ok(["settled", "cancelled"].includes(
        JSON.parse(readFileSync(join(runtime.graph!.dir, `request-${message.id}.json`), "utf8")).state));
      await assert.rejects(runtime.control({ action: "followUp", text: "too late", ...target }), /finished|ended/);
      const path = snapshot.session.path;
      await runtime.close(); await runtime.open(path);
      assert.deepEqual(runtime.snapshot().projection.nodes.map(node => node.title), snapshot.projection.nodes.map(node => node.title));
    });
  }
});

test("stopping cancels pending Follow-up messages and never starts another model call", { timeout: 30000 }, async t => {
  for (const branch of [false, true]) await t.test(branch ? "branch" : "main", async t => {
    const { runtime, faux } = await fixture(t);
    if (branch) {
      runtime.runtime.session.sessionManager.appendMessage({ role: "user", content: "parent", timestamp: 1 });
      runtime.runtime.session.sessionManager.appendMessage(fauxAssistantMessage("parent answer"));
    }
    let entered = false;
    faux.setResponses([async (_context, options) => {
      entered = true;
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }, fauxAssistantMessage("must not run")]);
    await runtime.control({ action: "promptAt", requestId: "stoppable", nodeId: null, text: "original task", provider: "faux", modelId: "test" });
    await until(() => entered);
    const run = runtime.snapshot().graph!.runs.find(run => run.requestId === "stoppable")!;
    await runtime.control({ action: "followUp", text: "must not run", graphId: runtime.snapshot().graph!.id, branchId: run.branchId, runId: run.runId });
    await runtime.control({ action: "branchAbort", branchId: run.branchId, runId: run.runId });
    assert.equal(runtime.busy, false);
    assert.equal(faux.state.callCount, 1);
    assert.ok(!runtime.snapshot().projection.nodes.some(node => node.title === "must not run"));
    assert.equal(runtime.snapshot().graph!.runs.find(value => value.runId === run.runId)!.runtime!.pendingMessageCount, 0);
  });
});

test("stopping a run rejects new queued input and edits before the stream becomes idle", { timeout: 15000 }, async t => {
  const { runtime, faux } = await fixture(t);
  let entered = false, abortEntered = false, releaseAbort!: () => void;
  const abortGate = new Promise<void>(resolve => { releaseAbort = resolve; });
  faux.setResponses([async (_context, options) => {
    entered = true;
    await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    return fauxAssistantMessage("", { stopReason: "aborted" });
  }]);
  await runtime.control({ action: "promptAt", requestId: "stopping-input", nodeId: null, text: "original", provider: "faux", modelId: "test" });
  await until(() => entered);
  const snapshot = runtime.snapshot(), run = snapshot.graph!.runs.find(run => run.requestId === "stopping-input")!;
  const target = { graphId: snapshot.graph!.id, branchId: run.branchId, runId: run.runId };
  await runtime.control({ action: "followUp", text: "before stop", ...target });
  const queuedId = runtime.snapshot().runtime.queuedMessages![0]!.id;
  const abort = runtime.runtime.session.abort.bind(runtime.runtime.session);
  runtime.runtime.session.abort = async () => { abortEntered = true; await abortGate; await abort(); };
  const stopped = runtime.control({ action: "branchAbort", branchId: run.branchId, runId: run.runId });
  try {
    await until(() => abortEntered);
    await assert.rejects(runtime.control({ action: "followUp", text: "arrived after stop", ...target }), /stopp|cancel|finished/i);
    await assert.rejects(runtime.control({ action: "updateQueuedMessage", id: queuedId, operation: "edit", text: "edited after stop", ...target }), /stopp|cancel|finished/i);
  } finally { releaseAbort(); await stopped; }
  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(runtime.snapshot().runtime.queuedMessages, []);
  assert.ok(!runtime.snapshot().graph!.recoveredInputs!.some(input => input.text === "arrived after stop"));
});

test("messages queued during final extension hooks are processed before the run closes", { timeout: 15000 }, async t => {
  let entered = false, held = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { runtime, faux } = await fixture(t, runtime => {
    const options = runtime["sessionServicesOptions"].bind(runtime);
    runtime["sessionServicesOptions"] = (pi, cwd) => {
      const value = options(pi, cwd);
      value.resourceLoaderOptions!.extensionFactories!.push({ name: "held-settlement", factory: extension => {
        extension.on("agent_before_settle", async () => {
          if (held) return;
          held = true; entered = true; await gate;
        });
      } });
      return value;
    };
  });
  faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("late follow-up answer")]);
  try {
    await runtime.control({ action: "promptAt", requestId: "late", nodeId: null, text: "original", provider: "faux", modelId: "test" });
    await until(() => entered);
    const run = runtime.snapshot().graph!.runs.find(run => run.requestId === "late")!;
    await runtime.control({ action: "followUp", text: "late follow-up", graphId: runtime.snapshot().graph!.id, branchId: run.branchId, runId: run.runId });
    release();
    await until(() => !runtime.busy);
    assert.equal(faux.state.callCount, 2);
    assert.deepEqual(runtime.snapshot().projection.nodes.map(node => node.title), ["original", "late follow-up"]);
  } finally { release(); }
});

test("a late Follow-up that fails after preflight stays recoverable unless explicitly cancelled", { timeout: 30000 }, async t => {
  for (const cancel of ["none", "clearQueue", "branchAbort"] as const) await t.test(cancel, async t => {
    let entered = false, held = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let failureEntered = false, releaseFailure!: () => void;
    const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
    const { runtime, faux } = await fixture(t, runtime => {
      const options = runtime["sessionServicesOptions"].bind(runtime);
      runtime["sessionServicesOptions"] = (pi, cwd) => {
        const value = options(pi, cwd);
        value.resourceLoaderOptions!.extensionFactories!.push({ name: "held-settlement-failure", factory: extension => {
          extension.on("agent_before_settle", async () => {
            if (held) return;
            held = true; entered = true; await gate;
          });
        } });
        return value;
      };
    });
    faux.setResponses([fauxAssistantMessage("original answer")]);
    try {
      await runtime.control({ action: "promptAt", requestId: "late-failure", nodeId: null, text: "original", provider: "faux", modelId: "test" });
      await until(() => entered);
      const snapshot = runtime.snapshot(), run = snapshot.graph!.runs.find(run => run.requestId === "late-failure")!;
      const target = { graphId: snapshot.graph!.id, branchId: run.branchId, runId: run.runId };
      await runtime.control({ action: "followUp", text: "keep failed late input", ...target });
      const message = runtime.snapshot().runtime.queuedMessages![0]!;
      // The SDK calls preflightResult before Agent.prompt, which can still reject.
      runtime.runtime.session.agent.prompt = async () => {
        failureEntered = true; await failureGate; throw new Error("simulated failure after preflight");
      };
      release(); await until(() => failureEntered);
      let cancelled: Promise<unknown> | undefined;
      if (cancel === "clearQueue") await runtime.control({ action: "clearQueue", ...target });
      else if (cancel === "branchAbort") {
        cancelled = runtime.control({ action: "branchAbort", branchId: run.branchId, runId: run.runId });
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      releaseFailure(); await cancelled; await until(() => !runtime.busy);
      const after = runtime.snapshot();
      const expectedCount = cancel === "none" ? 1 : 0;
      assert.equal(after.graph!.recoveredInputs!.filter(input => input.requestId === message.id && input.text === message.text).length, expectedCount);
      assert.equal(JSON.parse(readFileSync(join(runtime.graph!.dir, `request-${message.id}.json`), "utf8")).state, cancel === "none" ? "prepared" : "cancelled");
      assert.deepEqual(after.runtime.queuedMessages, []);
      assert.equal(faux.state.callCount, 1);
      await runtime.close(); await runtime.open(after.session.path);
      assert.equal(runtime.snapshot().graph!.recoveredInputs!.filter(input => input.requestId === message.id).length, expectedCount);
      assert.equal(faux.state.callCount, 1);
    } finally { release(); releaseFailure(); }
  });
});

test("an image-only follow-up does not leave the session permanently busy", { timeout: 15000 }, async t => {
  const { runtime, faux } = await fixture(t);
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  faux.setResponses([async () => { entered = true; await gate; return fauxAssistantMessage("first answer"); }, fauxAssistantMessage("image answer")]);
  try {
    await runtime.control({ action: "promptAt", requestId: "image", nodeId: null, text: "original", provider: "faux", modelId: "test" });
    await until(() => entered);
    const run = runtime.snapshot().graph!.runs.find(run => run.requestId === "image")!;
    await runtime.control({ action: "followUp", text: "", images: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
      graphId: runtime.snapshot().graph!.id, branchId: run.branchId, runId: run.runId });
    release();
    await until(() => !runtime.busy);
    assert.equal(faux.state.callCount, 2);
    assert.equal(runtime.snapshot().runtime.pendingMessageCount, 0);
    assert.equal(runtime.snapshot().projection.nodes.at(-1)!.imageCount, 1);
  } finally { release(); }
});

test("closing retains unfinished queued inputs for recovery without automatically replaying them", { timeout: 30000 }, async t => {
  for (const branch of [false, true]) await t.test(branch ? "branch" : "main", async t => {
    const { runtime, faux } = await fixture(t);
    if (branch) {
      runtime.runtime.session.sessionManager.appendMessage({ role: "user", content: "parent", timestamp: 1 });
      runtime.runtime.session.sessionManager.appendMessage(fauxAssistantMessage("parent answer"));
    }
    let entered = false;
    faux.setResponses([async (_context, options) => {
      entered = true;
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    }]);
    await runtime.control({ action: "promptAt", requestId: "recover", nodeId: null, text: "original", provider: "faux", modelId: "test" });
    await until(() => entered);
    const snapshot = runtime.snapshot(), run = snapshot.graph!.runs.find(run => run.requestId === "recover")!;
    const target = { graphId: snapshot.graph!.id, branchId: run.branchId, runId: run.runId };
    const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
    await runtime.control({ action: "followUp", text: "keep after restart", images: [image], ...target });
    await runtime.control({ action: "followUp", text: "removed before restart", ...target });
    const messages = runtime.snapshot().graph!.runs.find(value => value.runId === run.runId)!.runtime!.queuedMessages!;
    await runtime.control({ action: "updateQueuedMessage", id: messages[0]!.id, operation: "edit", text: "edited after restart", ...target });
    await runtime.control({ action: "updateQueuedMessage", id: messages[1]!.id, operation: "remove", ...target });
    await runtime.close(); await runtime.open(snapshot.session.path);
    assert.equal(faux.state.callCount, 1);
    const recovered = runtime.snapshot().graph!.recoveredInputs!.filter(input => input.requestId === messages[0]!.id);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.text, "edited after restart");
    assert.deepEqual(recovered[0]!.images, [image]);
    assert.ok(!runtime.snapshot().graph!.recoveredInputs!.some(input => input.text === "removed before restart"));
  });
});

test("removing or stopping during async input processing cannot deliver later cancelled messages", { timeout: 30000 }, async t => {
  for (const stop of [false, true]) await t.test(stop ? "stop" : "remove", async t => {
    let releaseModel!: () => void, releaseInput!: () => void, modelEntered = false, inputEntered = false;
    const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
    const inputGate = new Promise<void>(resolve => { releaseInput = resolve; });
    const { runtime, faux } = await fixture(t, runtime => {
      const options = runtime["sessionServicesOptions"].bind(runtime);
      runtime["sessionServicesOptions"] = (pi, cwd) => {
        const value = options(pi, cwd);
        value.resourceLoaderOptions!.extensionFactories!.push({ name: "slow-input", factory: extension => {
          extension.on("input", async event => {
            if (event.text === "first queued") { inputEntered = true; await inputGate; }
            return { action: "continue" as const };
          });
        } });
        return value;
      };
    });
    faux.setResponses([async () => { modelEntered = true; await modelGate; return fauxAssistantMessage("first answer"); }, fauxAssistantMessage("queued answer")]);
    try {
      await runtime.control({ action: "setQueueMode", kind: "followUp", mode: "all" });
      await runtime.control({ action: "promptAt", requestId: "async-input", nodeId: null, text: "original", provider: "faux", modelId: "test" });
      await until(() => modelEntered);
      const snapshot = runtime.snapshot(), run = snapshot.graph!.runs.find(run => run.requestId === "async-input")!;
      const target = { graphId: snapshot.graph!.id, branchId: run.branchId, runId: run.runId };
      await runtime.control({ action: "followUp", text: "first queued", ...target });
      await runtime.control({ action: "followUp", text: "must not run", ...target });
      const messages = runtime.snapshot().runtime.queuedMessages!;
      releaseModel(); await until(() => inputEntered);
      await assert.rejects(runtime.control({ action: "updateQueuedMessage", id: messages[0]!.id, operation: "edit", text: "too late", ...target }), /already being processed/);
      if (stop) {
        const stopped = runtime.control({ action: "branchAbort", branchId: run.branchId, runId: run.runId });
        releaseInput(); await stopped;
      } else {
        await runtime.control({ action: "updateQueuedMessage", id: messages[1]!.id, operation: "remove", ...target });
        releaseInput(); await until(() => !runtime.busy);
      }
      assert.equal(faux.state.callCount, stop ? 1 : 2);
      assert.ok(!runtime.snapshot().projection.nodes.some(node => node.title === "must not run"));
      assert.equal(runtime.snapshot().runtime.pendingMessageCount, 0);
    } finally { releaseModel(); releaseInput(); }
  });
});

test("an undeliverable input moves to recovery when the task ends instead of keeping an idle queue", { timeout: 15000 }, async t => {
  const { runtime, faux } = await fixture(t);
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  faux.setResponses([async () => { entered = true; await gate; return fauxAssistantMessage("original answer"); }]);
  runtime.runtime.session.followUp = async () => { throw new Error("simulated input failure"); };
  try {
    await runtime.control({ action: "promptAt", requestId: "failed-input", nodeId: null, text: "original", provider: "faux", modelId: "test" });
    await until(() => entered);
    await runtime.control({ action: "followUp", text: "keep this failed input" });
    const before = runtime.snapshot();
    release(); await until(() => !runtime.busy);
    const snapshot = runtime.snapshot();
    assert.deepEqual(snapshot.runtime.queuedMessages, []);
    assert.equal(snapshot.runtime.pendingMessageCount, 0);
    assert.ok(snapshot.graph!.recoveredInputs!.some(input => input.text === "keep this failed input"));
    assert.deepEqual(before.graph!.recoveredInputs, [], "later recovery cannot mutate an older wire snapshot");
    assert.equal(faux.state.callCount, 1);
  } finally { release(); }
});

test("Steer during Follow-up input processing takes priority before the next model request", { timeout: 30000 }, async t => {
  for (const mode of ["one-at-a-time", "all"] as const) await t.test(mode, async t => {
    let releaseModel!: () => void, releaseInput!: () => void, modelEntered = false, inputEntered = false;
    const modelGate = new Promise<void>(resolve => { releaseModel = resolve; });
    const inputGate = new Promise<void>(resolve => { releaseInput = resolve; });
    const { runtime, faux } = await fixture(t, runtime => {
      const options = runtime["sessionServicesOptions"].bind(runtime);
      runtime["sessionServicesOptions"] = (pi, cwd) => {
        const value = options(pi, cwd);
        value.resourceLoaderOptions!.extensionFactories!.push({ name: "slow-follow-up", factory: extension => {
          extension.on("input", async event => {
            if (event.text === "follow-up") { inputEntered = true; await inputGate; }
            return { action: "continue" as const };
          });
        } });
        return value;
      };
    });
    const requests: string[] = [];
    faux.setResponses([async () => { modelEntered = true; await modelGate; return fauxAssistantMessage("original answer"); },
      ...Array.from({ length: 2 }, () => (context: { messages: unknown }) => {
        requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage("queued answer");
      })]);
    try {
      await runtime.control({ action: "setQueueMode", kind: "followUp", mode });
      await runtime.control({ action: "promptAt", requestId: "steer-during-input", nodeId: null, text: "original", provider: "faux", modelId: "test" });
      await until(() => modelEntered);
      const snapshot = runtime.snapshot(), run = snapshot.graph!.runs.find(run => run.requestId === "steer-during-input")!;
      const target = { graphId: snapshot.graph!.id, branchId: run.branchId, runId: run.runId };
      await runtime.control({ action: "followUp", text: "follow-up", ...target });
      await runtime.control({ action: "followUp", text: "urgent steer", ...target });
      const urgent = runtime.snapshot().runtime.queuedMessages!.find(message => message.text === "urgent steer")!;
      releaseModel(); await until(() => inputEntered);
      await runtime.control({ action: "updateQueuedMessage", id: urgent.id, operation: "steer", ...target });
      releaseInput(); await until(() => !runtime.busy);
      assert.equal(requests.length, 2);
      assert.match(requests[0]!, /urgent steer/);
      assert.doesNotMatch(requests[0]!, /"text":"follow-up"/);
      assert.match(requests[1]!, /"text":"follow-up"/);
    } finally { releaseModel(); releaseInput(); }
  });
});

test("concurrent branches keep their edited queues and cancellation independent", { timeout: 15000 }, async t => {
  const { runtime, faux } = await fixture(t);
  runtime.runtime.session.sessionManager.appendMessage({ role: "user", content: "parent", timestamp: 1 });
  runtime.runtime.session.sessionManager.appendMessage(fauxAssistantMessage("parent answer"));
  const parent = runtime.snapshot().projection.activeNodeId!;
  let entered = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = [];
  const held = async () => { entered++; await gate; return fauxAssistantMessage("original answer"); };
  faux.setResponses([held, held, context => {
    requests.push(JSON.stringify(context.messages)); return fauxAssistantMessage("remaining branch answer");
  }]);
  try {
    for (const id of ["branch-a", "branch-b"])
      await runtime.control({ action: "promptAt", requestId: id, nodeId: parent, text: id, provider: "faux", modelId: "test" });
    await until(() => entered === 2);
    const snapshot = runtime.snapshot();
    const runA = snapshot.graph!.runs.find(run => run.requestId === "branch-a")!;
    const runB = snapshot.graph!.runs.find(run => run.requestId === "branch-b")!;
    const targetA = { graphId: snapshot.graph!.id, branchId: runA.branchId, runId: runA.runId };
    const targetB = { graphId: snapshot.graph!.id, branchId: runB.branchId, runId: runB.runId };
    await runtime.control({ action: "followUp", text: "queue a", ...targetA });
    await runtime.control({ action: "followUp", text: "queue b", ...targetB });
    const queuedA = runtime.snapshot().graph!.runs.find(run => run.runId === runA.runId)!.runtime!.queuedMessages![0]!;
    const queuedB = runtime.snapshot().graph!.runs.find(run => run.runId === runB.runId)!.runtime!.queuedMessages![0]!;
    await assert.rejects(runtime.control({ action: "updateQueuedMessage", id: queuedA.id, operation: "edit", text: "wrong branch", ...targetB }), /already being processed/);
    await runtime.control({ action: "updateQueuedMessage", id: queuedB.id, operation: "edit", text: "edited queue b", ...targetB });
    await runtime.control({ action: "clearQueue", ...targetA });
    release(); await until(() => !runtime.busy);
    assert.equal(faux.state.callCount, 3);
    assert.match(requests[0]!, /edited queue b/);
    assert.doesNotMatch(requests[0]!, /queue a|wrong branch/);
    const nodes = runtime.snapshot().projection.nodes;
    assert.ok(!nodes.some(node => node.title === "queue a"));
    assert.equal(nodes.find(node => node.title === "edited queue b")!.branchId, runB.branchId);
    assert.deepEqual(runtime.snapshot().graph!.recoveredInputs, []);
  } finally { release(); }
});
