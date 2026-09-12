import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PiRuntime } from "../src/main/pi-runtime.js";
import { GraphRuntime } from "../src/main/graph-runtime.js";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fileChange, turnFileChanges } from "../src/shared/file-changes.js";
import { readFileChange, summarizeChange } from "../src/main/file-changes.js";
import { projectSession } from "../src/shared/session.js";

async function fixture(t: test.TestContext, home?: string) {
  const root = home ?? mkdtempSync(join(tmpdir(), "pix-changes-"));
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const events: any[] = [];
  const runtime = new PiRuntime(root, sessionDir, event => events.push(event), async () => {});
  const options = runtime["sessionServicesOptions"].bind(runtime);
  runtime["sessionServicesOptions"] = (pi, cwd) => {
    const base = options(pi, cwd);
    return { ...base, agentDir: join(root, "agent"), settingsManager: pi.SettingsManager.inMemory({}),
      resourceLoaderOptions: { ...base.resourceLoaderOptions, additionalExtensionPaths: [] } };
  };
  await runtime.create();
  t.after(async () => { await runtime.close(); if (!home) rmSync(root, { recursive: true, force: true }); });
  const user = (text = "change files") => runtime.runtime.session.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  user();
  const start = async (name: string, args: Record<string, unknown>) => {
    const toolCall = { id: randomUUID(), name, arguments: args };
    await runtime.runtime.session.agent.beforeToolCall({ toolCall, args });
    return toolCall;
  };
  const finish = async (toolCall: any, result: any = { content: [] }, isError = false) => {
    await runtime.runtime.session.agent.afterToolCall({ toolCall, args: toolCall.arguments, result, isError });
  };
  const tool = async (name: "write" | "edit", args: Record<string, unknown>) => {
    const call = await start(name, args);
    const pi = await runtime.pi();
    try {
      const result = await (name === "write" ? pi.createWriteTool(root) : pi.createEditTool(root)).execute(call.id, args);
      await finish(call, result);
    } catch (error) {
      await finish(call, { content: [{ type: "text", text: String(error) }] }, true);
    }
  };
  const changes = () => runtime.snapshot().projection.nodes.at(-1)!.fileChanges!;
  return { root, runtime, events, user, start, finish, tool, changes };
}

test("real SDK hooks track non-Git writes/edits, net totals, failed edits and reload", async t => {
  const f = await fixture(t);
  assert.equal(existsSync(join(f.root, ".git")), false);
  const file = join(f.root, "existing.txt");
  writeFileSync(file, "original\nkeep\n");
  await f.tool("write", { path: "existing.txt", content: "replaced\nkeep\nextra\n" });
  assert.deepEqual([f.changes()[0]!.added, f.changes()[0]!.removed], [2, 1]);
  await f.tool("edit", { path: file, edits: [{ oldText: "extra\n", newText: "last\n" }] });
  assert.equal(f.changes().length, 1);
  assert.deepEqual([f.changes()[0]!.added, f.changes()[0]!.removed], [2, 1]);
  await f.tool("edit", { path: file, edits: [{ oldText: "missing", newText: "no" }] });
  assert.equal(f.changes().length, 1);
  await f.runtime.control({ action: "reload" });
  await f.tool("write", { path: file, content: "original\nkeep\n" });
  assert.deepEqual(f.changes(), [], "returning to the baseline removes the file from the card");
  f.user("new round");
  await f.tool("write", { path: "new/empty.txt", content: "" });
  assert.equal(f.changes()[0]!.status, "added");
  assert.equal(f.changes()[0]!.added, 0);
  if (process.platform === "win32") {
    await f.tool("write", { path: "NEW/EMPTY.TXT", content: "now populated\n" });
    assert.equal(f.changes().length, 1);
    assert.equal(f.changes()[0]!.path, "new/empty.txt");
    assert.equal(f.changes()[0]!.added, 1);
  }
  f.user("remove BOM");
  writeFileSync(join(f.root, "bom.txt"), "\uFEFFsame\n");
  await f.tool("write", { path: "bom.txt", content: "same\n" });
  assert.deepEqual([f.changes()[0]!.added, f.changes()[0]!.removed], [1, 1]);
  assert.equal(f.events.some(e => e.type === "notice" && /File change tracking/.test(e.payload.message)), false);
});

test("snapshots survive abort/reopen and render historical content after later disk edits", async t => {
  const f = await fixture(t);
  await f.tool("write", { path: "one.txt", content: "one\ntwo\n" });
  await f.runtime.control({ action: "abort" });
  const snapshot = f.runtime.snapshot();
  const ref = f.changes()[0]!.ref;
  writeFileSync(join(f.root, "one.txt"), "later unrelated content");
  const patch = await readFileChange(snapshot.session.path, snapshot.entries, ref);
  assert.match(patch, /\+one\n\+two/);
  assert.doesNotMatch(patch, /unrelated/);
  // Force persistence of the synthetic conversation, just as an assistant response does.
  f.runtime.runtime.session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }],
    api: "openai-responses", provider: "openai", model: "test", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  await f.runtime.close();
  await f.runtime.open(snapshot.session.path);
  assert.equal(f.changes()[0]!.ref, ref);
  assert.equal(await readFileChange(snapshot.session.path, f.runtime.snapshot().entries, ref), patch);
  await assert.rejects(readFileChange(snapshot.session.path, snapshot.entries, "../secret"), /Unknown/);
  await assert.rejects(readFileChange(snapshot.session.path, snapshot.entries, randomUUID()), /Unknown/);
});

test("interleaved sessions are flagged and independent directories are isolated", async t => {
  const a = await fixture(t);
  const b = await fixture(t, a.root);
  const c = await fixture(t);
  const args = { path: "shared.txt", content: "a" };
  const ca = await a.start("write", args);
  const cb = await b.start("write", args);
  writeFileSync(join(a.root, "shared.txt"), "mixed");
  await a.finish(ca); await b.finish(cb);
  assert.equal(a.changes()[0]!.reason, "conflict");
  assert.equal(b.changes()[0]!.added, null);
  await c.tool("write", { path: "shared.txt", content: "separate\n" });
  assert.equal(c.changes()[0]!.reason, undefined);
  assert.equal(c.changes()[0]!.added, 1);
});

test("external edits between tools do not become attributed net changes; failure may still modify a file", async t => {
  const f = await fixture(t);
  await f.tool("write", { path: "file", content: "first\n" });
  writeFileSync(join(f.root, "file"), "external\n");
  await f.tool("write", { path: "file", content: "last\n" });
  assert.equal(f.changes()[0]!.reason, "conflict");
  f.user();
  const call = await f.start("write", { path: "partial" });
  writeFileSync(join(f.root, "partial"), "partial output\n");
  await f.finish(call, { content: [] }, true);
  assert.equal(f.changes()[0]!.added, 1);
});

test("large/binary files have no invented totals and out-of-project tools are excluded", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "binary"), Buffer.from([0, 1]));
  await f.tool("write", { path: "binary", content: "text" });
  await f.tool("write", { path: "large", content: "x".repeat(2 * 1024 * 1024 + 1) });
  assert.equal(f.changes()[0]!.reason, "binary");
  assert.equal(f.changes()[1]!.reason, "large");
  assert.ok(f.changes().every(file => file.added === null));
  const count = f.changes().length;
  await f.finish(await f.start("write", { path: "../outside" }));
  assert.equal(f.changes().length, count);
});

test("projection keeps each branch's latest record and suppresses reverted files", () => {
  const record = (id: string, parentId: string, added: number, status = "modified") => ({ id, parentId, type: "custom", timestamp: "2026-01-01", customType: "pix.file-change",
    data: { path: "file", ref: randomUUID(), status, added, removed: 0 } });
  const entries = [
    { id: "u", parentId: null, type: "message", timestamp: "2026-01-01", message: { role: "user", content: "a" } },
    record("c1", "u", 1), record("c2", "c1", 0, "unchanged"),
    { id: "v", parentId: "u", type: "message", timestamp: "2026-01-01", message: { role: "user", content: "b" } }, record("c3", "v", 3),
  ];
  const nodes = projectSession(entries, "c3").nodes;
  assert.deepEqual(nodes[0]!.fileChanges, []);
  assert.equal(nodes[1]!.fileChanges![0]!.added, 3);
  assert.equal(fileChange({ ...entries[1]!, data: { path: "x", ref: "../x" } }), undefined);
  assert.equal(turnFileChanges(entries.slice(0, 3)).length, 0);
});

test("line totals account for replacements, CRLF and missing final newlines", () => {
  for (const [before, after, added, removed] of [["a\r\nb\r\n", "a\r\nc\r\n", 1, 1], ["a", "b", 1, 1], ["", "x\n", 1, 0]] as const) {
    const { change, patch } = summarizeChange({ path: "text", before: { exists: true, text: before }, after: { exists: true, text: after } }, randomUUID());
    assert.deepEqual([change.added, change.removed], [added, removed]);
    assert.match(patch!, /--- a\/text\n\+\+\+ b\/text/);
  }
});

test("a patch larger than the file cap is reported without totals and is not kept", () => {
  const before = "x".repeat(2 * 1024 * 1024), after = "y".repeat(2 * 1024 * 1024);
  const { change, patch } = summarizeChange({ path: "minified.js", before: { exists: true, text: before }, after: { exists: true, text: after } }, randomUUID());
  assert.equal(patch, undefined);
  assert.equal(change.reason, "large");
  assert.deepEqual([change.added, change.removed], [null, null]);
  assert.equal(change.status, "modified");
});

test("a diff too expensive to compute is reported without totals and is not kept", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} of a file that changed everywhere`).join("\n") + "\n";
  const before = lines(40000), after = before.replace(/line /g, "row ");
  const { change, patch } = summarizeChange({ path: "bulk.txt", before: { exists: true, text: before }, after: { exists: true, text: after } }, randomUUID());
  assert.equal(patch, undefined);
  assert.equal(change.reason, "large");
  assert.deepEqual([change.added, change.removed], [null, null]);
});

test("real graph workers preserve root snapshot references across forks and restart", { timeout: 30000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "pix-graph-changes-"));
  const previous = process.env.PIX_HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
  const runtime = new GraphRuntime(home, join(home, "sessions"), () => {}, async () => {});
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(home, { recursive: true, force: true });
  });
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const factory = runtime.factory.bind(runtime);
  runtime.factory = pi => async args => {
    const created = await factory(pi)(args);
    created.services.modelRuntime.registerNativeProvider(faux.provider);
    return created;
  };
  await runtime.create();
  const prompt = async (text: string, nodeId: string | null, filename?: string) => {
    faux.setResponses([
      ...(filename ? [fauxAssistantMessage(fauxToolCall("write", { path: filename, content: `${text}\n` }), { stopReason: "toolUse" })] : []),
      fauxAssistantMessage("done"),
    ]);
    await runtime.control({ action: "promptAt", requestId: randomUUID(), nodeId, text, provider: "faux", modelId: "test" });
    for (let i = 0; i < 500 && runtime.snapshot().graph!.runs.some(run => run.status === "running"); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(runtime.snapshot().graph!.runs.every(run => run.status === "idle"));
    return runtime.snapshot().projection.nodes.find(node => node.title === text)!;
  };
  const root = await prompt("root", null);
  await prompt("main edit", root.id, "main.txt");
  const branch = await prompt("branch edit", root.id, "branch.txt");
  const path = runtime.snapshot().session.path;
  assert.match(await readFileChange(path, runtime.snapshot().entries, branch.fileChanges![0]!.ref), /\+branch edit/);
  await runtime.close(); await runtime.open(path);
  const next = await prompt("after restart", root.id, "restart.txt");
  assert.match(await readFileChange(path, runtime.snapshot().entries, next.fileChanges![0]!.ref), /\+after restart/);
  assert.equal(runtime.snapshot().projection.nodes.find(node => node.id === branch.id)!.fileChanges![0]!.path, "branch.txt");
});
