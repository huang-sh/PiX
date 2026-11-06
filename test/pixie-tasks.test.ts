import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PixieTasks, taskCompletionPrompt, taskSummary, taskDetails, type PixieTaskHost, type PixieTaskSource } from "../src/main/pixie-tasks.js";
import { PixieRuntime, pixieWorkspace } from "../src/main/pixie-runtime.js";
import { canvasCommand } from "../src/shared/canvas.js";
import type { SessionSnapshot } from "../src/shared/types.js";
import { projectSession } from "../src/shared/session.js";

const project = { name: "source", path: "/source" };
const target = { project, session: "/sessions/source.jsonl" };
const source: PixieTaskSource = { id: "user-request-1", text: "Fix login and preserve old clients", sessionId: "pixie-chat-1" };
const command = { action: "delegate" as const, context: "canvas-1", nodeId: null,
  text: "Fix login and run the compatibility tests", purpose: "Restore login while preserving old clients", acceptance: "Login and compatibility tests pass" };
function snapshot(requestId = "", status: "running" | "idle" = "running", runId = "run-1") {
  const entries = [
    { type: "message", id: "user", parentId: null, timestamp: "2026-11-05", message: { role: "user", content: command.text } },
    { type: "message", id: "answer", parentId: "user", timestamp: "2026-11-05", message: { role: "assistant", content: "Compatibility test failed; work is incomplete." } },
  ];
  return { session: { id: "session-1", path: target.session }, entries, projection: projectSession(entries, "answer"),
    runtime: { available: true }, graph: { id: target.session, revision: 1,
      runs: requestId ? [{ requestId, runId, branchId: "main", nodeId: "turn:user", status }] : [] } } as unknown as SessionSnapshot;
}
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pixie-tasks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "delegations.json");
  const journal = new PixieTasks(file);
  let current = snapshot();
  const calls: unknown[] = [];
  const host: PixieTaskHost = {
    available: value => value.session === target.session && value.project.path === project.path,
    snapshot: async () => current,
    control: async (_target, input) => {
      calls.push(input);
      if (input.action === "promptAt") {
        assert.equal(JSON.parse(readFileSync(file, "utf8")).tasks.at(-1).state, "submitting");
        current = snapshot(input.requestId);
      }
      return current;
    },
    read: async () => ({ text: "Compatibility test failed; work is incomplete." }),
  };
  journal.addHost(host);
  return { journal, file, host, calls, get current() { return current; }, set current(value: SessionSnapshot) { current = value; } };
}

test("invalid parent nodes are rejected before recording an ambiguous admission", async t => {
  const f = setup(t);
  await assert.rejects(f.journal.delegate({ ...command, nodeId: "missing" }, source, target), /Unknown parent nodeId/);
  assert.equal(f.journal.list().length, 0);
  assert.equal(f.calls.length, 0);
});

test("delegation persists its purpose before admission, returns while running, and queues completion once", async t => {
  const f = setup(t);
  const { task } = await f.journal.delegate(command, source, target);
  assert.equal(task.state, "running");
  assert.equal(f.journal.pending(), undefined);
  const restored = new PixieTasks(f.file).get(task.id);
  assert.equal(restored.source.text, source.text);
  assert.equal(restored.acceptance, command.acceptance);
  f.current = snapshot(task.requestId, "idle");
  f.journal.observe(project, f.current);
  const event = f.journal.pending()!;
  assert.equal(event.id, task.id);
  assert.equal((await f.journal.read(task.id)).task.purpose, command.purpose);
  assert.ok(!taskCompletionPrompt(event).includes(command.acceptance));
  assert.match(taskCompletionPrompt(event), /does not establish success/);
  f.journal.delivery(task.id, event.revision, "delivered");
  f.journal.observe(project, f.current);
  assert.equal(f.journal.pending(), undefined);
  assert.equal(new PixieTasks(f.file).pending(), undefined);
});

test("interrupted review resumes with stable identity and cannot duplicate child dispatch or queue mutations", async t => {
  const f = setup(t);
  const { task } = await f.journal.delegate(command, source, target);
  f.journal.observe(project, snapshot(task.requestId, "idle"));
  f.journal.delivery(task.id, task.revision, "delivering");
  const restarted = new PixieTasks(f.file); restarted.addHost(f.host);
  assert.equal(restarted.pending()?.id, task.id);
  const eventSource = { ...source, id: `task:${task.id}:1` };
  const child = await restarted.delegate({ ...command, text: "Repair failed compatibility test" }, eventSource, target, task.id);
  const retried = new PixieTasks(f.file); retried.addHost(f.host);
  const duplicate = await retried.delegate({ ...command, text: "Repair failed compatibility test" }, eventSource, target, task.id);
  assert.equal(duplicate.task.id, child.task.id);
  assert.equal(duplicate.duplicate, true);
  const reordered = { acceptance: command.acceptance, purpose: command.purpose, text: "Repair failed compatibility test",
    nodeId: null, action: "delegate" as const, context: "refreshed-canvas" };
  assert.equal((await retried.delegate(reordered, { ...eventSource, id: "replayed-review" }, target, task.id)).task.id, child.task.id);
  await retried.control({ action: "followUp", taskId: child.task.id, text: "Report evidence" }, eventSource);
  await retried.control({ action: "followUp", taskId: child.task.id, text: "Report evidence" }, eventSource);
  assert.equal(f.calls.length, 3); // original, child, one follow-up
});

test("a failing task review backs off independently without blocking other completions", async t => {
  const f = setup(t);
  const first = (await f.journal.delegate(command, source, target)).task;
  f.journal.observe(project, snapshot(first.requestId, "idle"));
  const second = (await f.journal.delegate(command, { ...source, id: "second-request" }, target)).task;
  f.journal.observe(project, snapshot(second.requestId, "idle"));
  const previous = process.env.PIX_HOME;
  process.env.PIX_HOME = join(f.file, "..", "home");
  const runtime = new PixieRuntime(() => {}, () => ({}));
  runtime["taskJournal"] = f.journal;
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
  });
  let now = Date.now(), fail = true;
  t.mock.method(Date, "now", () => now);
  const attempts: string[] = [];
  t.mock.method(runtime as any, "sendTurn", async (_input: unknown, event: PixieTaskSource) => {
    attempts.push(event.id);
    if (event.id === `task:${first.id}:1` && fail) throw new Error("First task review failed");
    return snapshot();
  });
  await runtime["checkTasks"]();
  for (const guard of ["sending", "lifecycle", "followUpsPaused"] as const) {
    runtime[guard] = true;
    await runtime["checkTasks"]();
    assert.equal(attempts.length, 1, `${guard} must still prevent background reviews`);
    runtime[guard] = false;
  }
  await Promise.all([runtime["checkTasks"](), runtime["checkTasks"]()]);
  assert.equal(f.journal.get(first.id).notification, "pending");
  assert.equal(f.journal.get(second.id).notification, "delivered");
  assert.deepEqual(attempts, [`task:${first.id}:1`, `task:${second.id}:1`]);
  now += 59_999;
  await runtime["checkTasks"]();
  assert.equal(attempts.length, 2, "the failed task must respect its retry delay");
  now++;
  await runtime["checkTasks"]();
  assert.equal(attempts.length, 3, "the failed task becomes eligible again at its deadline");
  const third = (await f.journal.delegate(command, { ...source, id: "third-request" }, target)).task;
  f.journal.observe(project, snapshot(third.requestId, "idle"));
  await runtime["checkTasks"]();
  assert.equal(f.journal.get(third.id).notification, "delivered", "repeated failures cannot block new completions");
  fail = false;
  now += 60_000;
  await runtime["checkTasks"]();
  assert.equal(f.journal.get(first.id).notification, "delivered");
  assert.equal(f.journal.get(first.id).retryAt, undefined);
  assert.equal(new PixieTasks(f.file).pending(), undefined, "successful retries must not replay after restart");
  assert.equal(f.journal.pending(), undefined);
  assert.deepEqual(attempts, [`task:${first.id}:1`, `task:${second.id}:1`, `task:${first.id}:1`,
    `task:${third.id}:1`, `task:${first.id}:1`], "retries preserve the event identity for deduplication");
});

test("task updates version pending context and cancellation suppresses stale follow-up", async t => {
  const f = setup(t);
  const { task } = await f.journal.delegate(command, source, target);
  f.journal.observe(project, snapshot(task.requestId, "idle"));
  const revised = f.journal.update({ action: "updateTask", taskId: task.id, purpose: "Investigate only; do not change files" });
  f.journal.delivery(task.id, task.revision, "delivered");
  assert.equal(f.journal.pending()?.revision, revised.revision);
  f.journal.update({ action: "updateTask", taskId: task.id, taskState: "cancelled" });
  f.journal.observe(project, snapshot(task.requestId, "idle"));
  assert.equal(f.journal.pending(), undefined);
  await assert.rejects(f.journal.control({ action: "followUp", taskId: task.id, text: "obsolete" }, source), /cancelled/);
});

test("review backoff survives restart and cannot delay an updated or cancelled task", async t => {
  const f = setup(t);
  const { task } = await f.journal.delegate(command, source, target);
  f.journal.observe(project, snapshot(task.requestId, "idle"));
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  f.journal.delivery(task.id, task.revision, "pending", now + 60_000);
  const restarted = new PixieTasks(f.file);
  assert.equal(restarted.pending(), undefined);
  now += 60_000;
  assert.equal(restarted.pending()?.id, task.id);
  restarted.delivery(task.id, task.revision, "delivering");
  assert.equal(new PixieTasks(f.file).pending()?.id, task.id, "an interrupted retry remains recoverable");
  restarted.delivery(task.id, task.revision, "pending", now + 60_000);
  const revised = restarted.update({ action: "updateTask", taskId: task.id, purpose: "Review the corrected requirements" });
  restarted.delivery(task.id, task.revision, "pending", now + 60_000);
  assert.equal(restarted.pending()?.revision, revised.revision, "an old review cannot defer a new revision");
  assert.equal(restarted.get(task.id).retryAt, undefined);
  restarted.delivery(task.id, revised.revision, "pending", now + 60_000);
  restarted.update({ action: "updateTask", taskId: task.id, taskState: "cancelled" });
  restarted.delivery(task.id, revised.revision, "pending", now + 60_000);
  now += 60_000;
  assert.equal(new PixieTasks(f.file).pending(), undefined, "a cancelled task never resumes after its retry deadline");
});

test("cancelling a parent cancels pending child follow-ups and preserves updated ancestor context", async t => {
  const f = setup(t);
  const parent = (await f.journal.delegate(command, source, target)).task;
  const child = (await f.journal.delegate({ ...command, text: "Check a separate concern" },
    { ...source, id: "child-source" }, target, parent.id)).task;
  f.journal.observe(project, snapshot(child.requestId, "idle"));
  f.journal.delivery(child.id, child.revision, "pending", Date.now() + 60_000);
  f.journal.update({ action: "updateTask", taskId: parent.id, purpose: "Requirements changed" });
  assert.equal((await f.journal.read(child.id)).ancestors[0]!.purpose, "Requirements changed");
  f.journal.update({ action: "updateTask", taskId: parent.id, taskState: "cancelled" });
  f.journal.observe(project, snapshot(child.requestId, "idle"));
  assert.equal(f.journal.get(child.id).state, "cancelled");
  assert.equal(f.journal.get(child.id).retryAt, undefined);
  assert.equal(f.journal.pending(), undefined);
  await f.journal.control({ action: "stop", taskId: child.id }, source);
  assert.equal((f.calls.at(-1) as { action: string }).action, "branchAbort");
  await assert.rejects(f.journal.delegate(command, source, target, child.id), /cancelled/);
});

test("run replacement and lost admission are uncertain, never replayed as new work", async t => {
  const f = setup(t);
  const { task } = await f.journal.delegate(command, source, target);
  f.current = snapshot("someone-elses-request", "running", "new-run");
  await assert.rejects(f.journal.control({ action: "stop", taskId: task.id }, source), /ended/);
  await f.journal.reconcile();
  assert.equal(f.journal.get(task.id).state, "uncertain");
  const restored = new PixieTasks(f.file); restored.addHost(f.host);
  await restored.reconcile();
  assert.equal(f.calls.length, 1);
  const failedHost = { ...f.host, control: async () => { throw new Error("connection lost after admission"); } };
  const other = new PixieTasks(join(f.file, "..", "other.json")); other.addHost(failedHost);
  const failed = await other.delegate(command, source, target);
  assert.equal(failed.task.state, "uncertain");
  assert.equal((await other.delegate(command, source, target)).duplicate, true);
});

test("a journal write failure prevents execution and further admissions", async t => {
  const f = setup(t);
  const blocked = join(f.file, "..", "not-a-directory");
  const journal = new PixieTasks(join(blocked, "tasks.json"));
  journal.addHost(f.host);
  writeFileSync(blocked, "blocked");
  await assert.rejects(journal.delegate(command, source, target), /persistence failed/);
  await assert.rejects(journal.delegate(command, source, target), /persistence failed/);
  assert.equal(f.calls.length, 0);
});

test("task schema works without a visible canvas and rejects ambiguous task targets", () => {
  assert.deepEqual(canvasCommand({ action: "tasks" }), { action: "tasks" });
  assert.equal(canvasCommand({ action: "read", taskId: "a" }).taskId, "a");
  assert.throws(() => canvasCommand({ action: "delete", taskId: "a" }), /does not support/);
  assert.throws(() => canvasCommand({ action: "updateTask" }), /taskId/);
  assert.throws(() => canvasCommand({ action: "delegate", context: "a", purpose: " " }), /empty/);
});

test("Pixie stays free between dispatch and completion; a later turn restores intent and publishes its result", { timeout: 30_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pixie-async-"));
  const previous = process.env.PIX_HOME; process.env.PIX_HOME = dir;
  let current = snapshot();
  let automatic: SessionSnapshot | undefined;
  const runtime = new PixieRuntime(event => {
    const value = event.payload as { type: string; payload: SessionSnapshot };
    if (value.type === "snapshot") automatic = value.payload;
  }, () => ({ defaultModel: "faux/pixie-test", restoreLastConversation: false }));
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  runtime.registerTaskHost({
    available: () => true, snapshot: async () => current,
    control: async (_target, input) => { assert.equal(input.action, "promptAt"); current = snapshot((input as { requestId: string }).requestId); return current; },
    read: async () => ({ text: "Compatibility test failed; work is incomplete." }),
  });
  const extension = join(dir, "faux.mjs");
  writeFileSync(extension, `
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
    export default pi => {
      const faux = fauxProvider({ models: [{ id: "pixie-test", contextWindow: 128000 }] });
      pi.registerProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("canvas_inspect", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("canvas_delegate", ${JSON.stringify((({ action, ...args }) => args)(command))})], { stopReason: "toolUse" }),
        fauxAssistantMessage("Submitted; I can help with other questions."),
        fauxAssistantMessage("Here is the unrelated answer."),
        context => {
          const event = context.messages.findLast(message => message.role === "user" || message.role === "custom");
          const text = typeof event.content === "string" ? event.content : event.content.map(part => part.text ?? "").join("");
          const data = JSON.parse(text.split("<delegation_event>\\n")[1].split("\\n</delegation_event>")[0]);
          return fauxAssistantMessage([fauxToolCall("canvas_read", { taskId: data.task.id })], { stopReason: "toolUse" });
        },
        fauxAssistantMessage("The login task returned a failed compatibility check; it is incomplete.")
      ]);
    }
  `);
  t.mock.method(runtime as any, "startAgent", async () => runtime["rpc"].start(pixieWorkspace(), {
    PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1",
  }, ["--extension", fileURLToPath(new URL("../src/main/pixie-extension.js", import.meta.url)),
    "--extension", extension, "--no-skills", "--no-prompt-templates"]));
  await runtime.send({ text: source.text }, async () => ({ context: "canvas-1", project, session: { path: target.session } }));
  const task = runtime.tasks.list()[0]!;
  assert.equal(task.state, "running");
  assert.equal(runtime.busy, false);
  await runtime.send({ text: "An unrelated coordination question" });
  assert.equal(runtime.busy, false);
  // Completion while another turn owns Pixie remains queued without entering it.
  runtime["sending"] = true;
  current = snapshot(task.requestId, "idle");
  await runtime["checkTasks"]();
  assert.equal(runtime.tasks.pending()?.id, task.id);
  assert.equal(automatic, undefined);
  runtime["sending"] = false;
  await runtime["checkTasks"]();
  assert.equal(runtime.tasks.get(task.id).notification, "delivered");
  assert.ok(automatic);
  const transcript = JSON.stringify(automatic);
  assert.match(transcript, /Fix login and preserve old clients/);
  assert.match(transcript, /Login and compatibility tests pass/);
  assert.match(transcript, /unrelated coordination question/);
  assert.match(transcript, /failed compatibility check/);
  const reviewed = automatic as SessionSnapshot;
  const event = reviewed.entries.find(entry => entry.type === "custom_message" && entry.customType === "pixie.task-event");
  assert.equal(event?.display, false);
  assert.ok(!reviewed.projection.messages.some(message => message.text.includes("<delegation_event>")));
  assert.notEqual(reviewed.projection.messages.at(-1)?.turnId,
    reviewed.projection.messages.find(message => message.text === "An unrelated coordination question")?.turnId);
});

test("concurrent delegation and controls admit each mutation only once", async t => {
  const f = setup(t);
  const results = await Promise.all([
    f.journal.delegate(command, source, target),
    f.journal.delegate(command, source, target),
  ]);
  assert.equal(results[0].task.id, results[1].task.id);
  assert.equal(f.calls.length, 1);
  const control = { action: "followUp" as const, taskId: results[0].task.id, text: "Check compatibility" };
  await Promise.all([f.journal.control(control, source), f.journal.control(control, source)]);
  assert.equal(f.calls.length, 2);
});

test("cancellation during host lookup prevents new child execution", async t => {
  const f = setup(t);
  const parent = (await f.journal.delegate(command, source, target)).task;
  f.host.snapshot = async () => {
    f.journal.update({ action: "updateTask", taskId: parent.id, taskState: "cancelled" });
    return f.current;
  };
  await assert.rejects(f.journal.delegate(command, source, target, parent.id), /cancelled/);
  await assert.rejects(f.journal.control({ action: "followUp", taskId: parent.id, text: "Continue" }, source), /cancelled/);
  assert.equal(f.calls.length, 1);
});

test("an admission error cannot revive a cancelled task", async t => {
  const f = setup(t);
  f.host.control = async () => {
    f.journal.update({ action: "updateTask", taskId: f.journal.list()[0]!.id, taskState: "cancelled" });
    throw new Error("connection lost");
  };
  const { task } = await f.journal.delegate(command, source, target);
  assert.equal(task.state, "cancelled");
  assert.equal(f.journal.pending(), undefined);
});

test("cancellation while a control reads its host prevents queue mutation", async t => {
  const f = setup(t);
  const task = (await f.journal.delegate(command, source, target)).task;
  f.host.snapshot = async () => {
    f.journal.update({ action: "updateTask", taskId: task.id, taskState: "cancelled" });
    return f.current;
  };
  await assert.rejects(f.journal.control({ action: "steer", taskId: task.id, text: "Continue" }, source), /cancelled/);
  assert.equal(f.calls.length, 1);
});

test("ensure waits for boot even after the subprocess starts running", async t => {
  const runtime = new PixieRuntime(() => {}, () => ({}));
  t.mock.method(runtime as any, "startMonitoring", () => {});
  let finish!: (value: SessionSnapshot) => void;
  const ready = snapshot();
  t.mock.method(runtime as any, "boot", () => new Promise<SessionSnapshot>(resolve => { finish = resolve; }));
  t.mock.method(runtime as any, "snapshot", async () => { throw new Error("Boot has not restored its session yet"); });
  const first = runtime.ensure();
  Object.defineProperty(runtime["rpc"], "running", { value: true });
  const second = runtime.ensure();
  finish(ready);
  assert.deepEqual(await Promise.all([first, second]), [ready, ready]);
});

test("task follow-ups use only the live extension after new, switch, reload and restore", { timeout: 30_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pixie-followup-lifecycle-"));
  const previous = process.env.PIX_HOME;
  process.env.PIX_HOME = dir;
  const extension = join(dir, "faux.mjs");
  writeFileSync(extension, `
    import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
    export default pi => {
      const faux = fauxProvider({ models: [{ id: "lifecycle-test", contextWindow: 128000 }] });
      pi.registerProvider(faux.provider);
      faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("Reviewed the delegated result.")));
    }
  `);
  let current = snapshot();
  let automatic: SessionSnapshot | undefined;
  const notices: unknown[] = [];
  const runtimes: PixieRuntime[] = [];
  const createRuntime = () => {
    const runtime = new PixieRuntime(event => {
      if (event.type !== "pixie") return;
      const payload = event.payload as { type: string; payload: SessionSnapshot };
      if (payload.type === "snapshot") automatic = payload.payload;
      if (payload.type === "notice") notices.push(payload.payload);
    }, () => ({ defaultModel: "faux/lifecycle-test", restoreLastConversation: true }));
    runtimes.push(runtime);
    t.mock.method(runtime as any, "startMonitoring", () => {});
    t.mock.method(runtime as any, "startAgent", async () => runtime["rpc"].start(pixieWorkspace(), {
      PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1",
    }, ["--extension", fileURLToPath(new URL("../src/main/pixie-extension.js", import.meta.url)),
      "--extension", extension, "--no-skills", "--no-prompt-templates"]));
    runtime.registerTaskHost({
      available: () => true, snapshot: async () => current,
      control: async (_target, input) => {
        current = snapshot((input as { requestId: string }).requestId);
        return current;
      },
      read: async () => ({ text: "Verified result" }),
    });
    return runtime;
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  let runtime = createRuntime();
  const original = await runtime.send({ text: "Save a conversation to restore" });
  const followUp = async (label: string) => {
    automatic = undefined;
    const { task } = await runtime.tasks.delegate(command, { ...source, id: label }, target);
    current = snapshot(task.requestId, "idle");
    await runtime["checkTasks"]();
    assert.deepEqual(notices, [], `${label}: no stale extension errors`);
    assert.equal(runtime.tasks.get(task.id).notification, "delivered", label);
    assert.equal(runtime.busy, false);
    assert.ok(automatic);
    const events = (automatic as SessionSnapshot).entries.filter(entry =>
      entry.type === "custom_message" && String(entry.content).includes(`"eventId":"${task.id}:1"`));
    assert.equal(events.length, 1, `${label}: one event, not one per old listener`);
  };
  await runtime.newSession();
  await followUp("new-session");
  await runtime["rpc"].request({ type: "switch_session", sessionPath: original.session.path });
  await followUp("switch-session");
  await runtime.reload();
  await followUp("reload");
  await runtime.close();
  runtime = createRuntime();
  await runtime.ensure();
  await followUp("restore");
});


test("public task results hide journal bookkeeping and reads honor a message limit", async t => {
  const f = setup(t);
  const { task } = await f.journal.delegate(command, source, target);
  const brief = taskSummary(task);
  assert.equal(brief.id, task.id);
  assert.ok(!("key" in brief));
  assert.ok(!("source" in brief));
  assert.ok(!("instruction" in brief));
  const details = taskDetails(task);
  assert.equal(details.source.text, source.text);
  assert.ok(!("sessionFile" in details.source));
  assert.ok(!("requestId" in details));
  let readLimit: number | undefined;
  f.host.read = async (_target, _leaf, limit) => { readLimit = limit; return { messages: [] }; };
  await f.journal.read(task.id, 7);
  assert.equal(readLimit, 7);
  f.host.read = async () => { throw new Error("host disconnected"); };
  const offline = await f.journal.read(task.id, 7);
  assert.equal(offline.task.purpose, command.purpose);
  assert.deepEqual(offline.output, { unavailable: "host disconnected" });
  await assert.rejects(f.journal.read("missing"), /Unknown delegation task ID/);
  const event = taskCompletionPrompt(task);
  assert.match(event, /First use canvas_read/);
  assert.ok(!event.includes(source.text));
  assert.ok(!event.includes(task.key));
});
