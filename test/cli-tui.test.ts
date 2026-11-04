import test from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, Editor, ProcessTerminal, TuiMainScreen, type TUI } from "@earendil-works/pi-tui";
import { Conversation, conversationEntries, graphTree, GraphSelector, branchHistory, branchHistoryReader, interactive } from "../src/cli/tui.js";
import { windowEntries, projectSession } from "../src/shared/session.js";
import type { HostClient } from "../src/host/client.js";
import type { RawSessionEntry } from "../src/shared/types.js";
import { agentEventForwarder } from "../src/main/agent-event-forwarder.js";
import { PROMPT_DISPLAY_CUSTOM_TYPE, type SessionSnapshot } from "../src/shared/types.js";

const entry = (id: string, message: Record<string, unknown>) => ({ id, type: "message", parentId: null, timestamp: new Date(0).toISOString(), message });
const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0, stopReason: "stop" });
const snapshot = {
  entries: [entry("root-user", user("root")), entry("root-answer", assistant("root answer")),
    entry("a-user", user("branch A")), entry("a-answer", assistant("private A")),
    entry("b-user", user("branch B")), entry("b-answer", assistant("private B"))],
  projection: { nodes: [
    { id: "root", parentId: null, rawEntryIds: ["root-user", "root-answer"], title: "Root", branchId: "main", timestamp: new Date(0).toISOString() },
    { id: "a", parentId: "root", rawEntryIds: ["a-user", "a-answer"], title: "Branch A", branchId: "branch-a", timestamp: new Date(0).toISOString() },
    { id: "b", parentId: "root", rawEntryIds: ["b-user", "b-answer"], title: "Branch B", branchId: "branch-b", timestamp: new Date(0).toISOString(), running: true },
  ] },
} as unknown as SessionSnapshot;

test("TUI history follows the selected PiX ancestry and excludes siblings", () => {
  assert.deepEqual(conversationEntries(snapshot, "b").map(item => item.id), ["root-user", "root-answer", "b-user", "b-answer"]);
  assert.deepEqual(conversationEntries(snapshot, null), []);
  const tree = graphTree(snapshot);
  assert.equal(tree[0]!.entry.id, "root");
  assert.deepEqual(tree[0]!.children.map(node => node.entry.id), ["a", "b"]);
  assert.match(JSON.stringify(tree[0]!.children[1]), /● Branch B/);
});

test("Pi's native renderers reflow Markdown, CJK and tool output at narrow widths", () => {
  initTheme("dark");
  const conversation = new Conversation({ requestRender() {} } as TUI, "/tmp");
  conversation.load([
    entry("user", user("修复这个函数")),
    entry("assistant", assistant("## Result\n\n中文说明 and **bold text**.\n\n```ts\nconst answer = 42;\n```")),
    entry("tool", { role: "toolResult", toolCallId: "write-1", toolName: "write", content: [{ type: "text", text: "Saved output.ts" }] }),
  ]);
  for (const width of [30, 44, 100]) {
    const lines = conversation.render(width);
    const text = lines.map(stripTerminalSequences).join("\n");
    assert.match(text, /修复这个函数/);
    assert.match(text, /const answer = 42/);
    assert.match(text, /Saved output.ts/);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `render overflow at ${width}`);
  }
});

test("TUI history uses structured prompt display text", () => {
  initTheme("dark");
  const conversation = new Conversation({ requestRender() {} } as TUI, "/tmp");
  conversation.load([
    { type: "custom", id: "display", parentId: null, timestamp: new Date(0).toISOString(),
      customType: PROMPT_DISPLAY_CUSTOM_TYPE, data: { text: "检查截图" } },
    { ...entry("user", user("model-only coordinate hint\n\n检查截图")), parentId: "display" },
  ]);
  const text = conversation.render(80).map(stripTerminalSequences).join("\n");
  assert.match(text, /检查截图/);
  assert.doesNotMatch(text, /coordinate hint/);
});

test("streaming assistant and tool updates keep one native component per message/call", () => {
  initTheme("light");
  const conversation = new Conversation({ requestRender() {} } as TUI, "/tmp");
  conversation.event({ type: "message_start", message: assistant("") });
  conversation.event({ type: "message_update", message: assistant("Partial") });
  conversation.event({ type: "message_end", message: assistant("Complete") });
  conversation.event({ type: "tool_execution_start", toolName: "read", toolCallId: "one", args: { path: "input.ts" } });
  conversation.event({ type: "tool_execution_update", toolCallId: "one", partialResult: { content: [{ type: "text", text: "Loading" }] } });
  conversation.event({ type: "tool_execution_end", toolCallId: "one", result: { content: [{ type: "text", text: "Read complete" }] } });
  const text = conversation.render(80).map(stripTerminalSequences).join("\n");
  assert.match(text, /Complete/); assert.doesNotMatch(text, /Partial|Loading/);
  assert.match(text, /input.ts/); assert.match(text, /Read complete/);
  assert.equal(conversation.children.length, 2);
});

test("native tool cards show partial output received through the host event forwarder", async () => {
  initTheme("dark");
  const conversation = new Conversation({ requestRender() {} } as TUI, "/tmp");
  conversation.toggleTools();
  const forwarder = agentEventForwarder(event => conversation.event(event as Record<string, unknown>));
  try {
    forwarder.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "live", args: { command: "long-running" } });
    forwarder.push({ type: "tool_execution_update", toolName: "bash", toolCallId: "live", partialResult: { content: [{ type: "text", text: "Live progress" }] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(conversation.render(100).map(stripTerminalSequences).join("\n"), /Live progress/);
    forwarder.push({ type: "tool_execution_end", toolName: "bash", toolCallId: "live", result: { content: [{ type: "text", text: "Final output" }] } });
    await new Promise(resolve => setImmediate(resolve));
    const text = conversation.render(100).map(stripTerminalSequences).join("\n");
    assert.match(text, /Final output/); assert.doesNotMatch(text, /Live progress/);
    assert.equal(conversation.children.length, 1);
  } finally { forwarder.dispose(); }
});


test("task tree uses native labels, searches bookmarks and keeps empty filters open", async () => {
  initTheme("dark");
  const data = structuredClone(snapshot);
  data.runtime = { available: true } as SessionSnapshot["runtime"];
  data.projection.nodes[1]!.label = "Bookmark";
  data.projection.nodes[1]!.userEntryId = "a-user";
  assert.equal(graphTree(data, "labeled")[0]!.children.length, 1);
  assert.equal(graphTree(data, "labeled")[0]!.children[0]!.label, "Bookmark");
  let cancelled = false, saved: unknown;
  const component = new GraphSelector(data, "a", 30, () => {}, () => { cancelled = true; }, "all", () => {}, async (id, label) => {
    saved = { id, label }; data.projection.nodes[1]!.label = label; return data;
  });
  component.focused = true;
  component.handleInput("L");
  component.handleInput("\x01"); component.handleInput("\x0b");
  component.handleInput("New label"); component.handleInput("\r");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(saved, { id: "a-user", label: "New label" });
  component.handleInput("\x05"); // Ctrl+E: errors, none in this session
  assert.match(component.render(100).map(stripTerminalSequences).join("\n"), /No matching tasks/);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(cancelled, false);
  component.handleInput("\x01"); // Ctrl+A: all
  assert.match(component.render(100).map(stripTerminalSequences).join("\n"), /New label/);
});

test("TUI pages all ancestors beyond 64 pages without repeating the cursor", async () => {
  const entries: RawSessionEntry[] = Array.from({ length: 150 }, (_, i) =>
    ({ ...entry(`u${i}`, user(`prompt ${i}`)), parentId: i ? `u${i - 1}` : null }));
  const cursors: string[] = [];
  const client = { async invoke(_route: string, input: { leafId: string; limit: number; bytes: number }) {
    cursors.push(input.leafId);
    return windowEntries(entries, input.leafId, Math.min(2, input.limit), input.bytes);
  } } as unknown as HostClient;
  assert.deepEqual(await branchHistory(client, "s", "u149"), entries);
  assert.equal(cursors.length, 75);
  assert.equal(new Set(cursors).size, 75);
  assert.deepEqual(await branchHistory(client, "s", null), []);
});

test("TUI can page past a turn larger than its byte budget", async () => {
  const entries: RawSessionEntry[] = [
    entry("old", user("old")),
    { ...entry("large", assistant("x".repeat(65 << 20))), parentId: "old" },
    { ...entry("latest", user("latest")), parentId: "large" },
  ];
  const client = { async invoke(_route: string, input: { leafId: string; limit: number; bytes: number }) {
    return windowEntries(entries, input.leafId, input.limit, input.bytes);
  } } as unknown as HostClient;
  assert.deepEqual((await branchHistory(client, "s", "latest")).map(item => item.id), ["old", "large", "latest"]);
});

test("TUI reports incomplete history and cycles instead of silently returning a prefix", async () => {
  const empty = { async invoke() { return { entries: [], hasEarlier: false }; } } as unknown as HostClient;
  await assert.rejects(branchHistory(empty, "s", "missing"), /unavailable/);
  const cycle = { async invoke() { return { entries: [{ ...entry("loop", user("loop")), parentId: "loop" }] }; } } as unknown as HostClient;
  await assert.rejects(branchHistory(cycle, "s", "loop"), /cycle/);
});

for (const replacement of [{ session: "other", epoch: "e" }, { session: "s", epoch: "new" }])
test(`TUI rejects mixed history pages ${JSON.stringify(replacement)}`, async () => {
  let calls = 0;
  const client = { async invoke() {
    return ++calls === 1
      ? { entries: [{ ...entry("tip", user("latest")), parentId: "old" }], session: "s", epoch: "e", hasEarlier: true }
      : { entries: [entry("old", user("different history"))], ...replacement, hasEarlier: false };
  } } as unknown as HostClient;
  await assert.rejects(branchHistory(client, "s", "tip", "e"), /Session changed/);
  assert.equal(calls, 2);
});

test("a history read pending at submission cannot replace the live conversation", async t => {
  let editor!: Editor;
  t.mock.method(TuiMainScreen.prototype, "start", () => {});
  t.mock.method(TuiMainScreen.prototype, "stop", () => {});
  t.mock.method(TuiMainScreen.prototype, "requestRender", () => {});
  t.mock.method(TuiMainScreen.prototype, "queryTerminalColors", async () => undefined);
  t.mock.method(TuiMainScreen.prototype, "setFocus", (target: unknown) => { if (target instanceof Editor) editor = target; });
  t.mock.method(ProcessTerminal.prototype, "drainInput", async () => {});
  const loaded = t.mock.method(Conversation.prototype, "load");
  const entries = [entry("u", user("old prompt")), { ...entry("a", assistant("old answer")), parentId: "u" }];
  const initial = { session: { path: "/s", id: "s" }, entries: [], projection: projectSession(entries, "a"),
    runtime: { available: true, thinkingLevel: "off" }, graph: { id: "/s", epoch: "e", revision: 1, runs: [] } } as unknown as SessionSnapshot;
  let release!: (value: unknown) => void, rejectPrompt!: (error: Error) => void;
  const listeners = new Set<(event: any) => void>();
  const client = {
    connected: true,
    onEvent(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    onDisconnect() { return () => {}; },
    async invoke(route: string, input: any) {
      if (route === "session.branchWindow") return new Promise(resolve => { release = resolve; });
      if (input?.action === "promptAt") return new Promise((_resolve, reject) => { rejectPrompt = reject; });
      return [];
    },
  } as unknown as HostClient;
  const running = interactive(client, initial, {});
  try {
    assert.ok(editor);
    editor.onSubmit!("new prompt");
    assert.ok(rejectPrompt, "the live submission is in progress");
    release({ entries, hasEarlier: false, session: "/s", epoch: "e" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(loaded.mock.callCount(), 0, "the old history must not erase the newly submitted message");
  } finally {
    for (const listener of listeners) listener({ type: "host.shutdown" });
    rejectPrompt?.(new Error("detached"));
    await running;
  }
});

test("TUI reuses the selected ancestry across background updates and cancels superseded pages", async () => {
  const calls: Array<{ session: string; leafId: string }> = [];
  let release!: (page: unknown) => void;
  const client = { async invoke(_route: string, input: { session: string; leafId: string }) {
    calls.push(input);
    if (input.leafId === "slow") return new Promise(resolve => { release = resolve; });
    return { entries: [entry(input.leafId, user(input.leafId))], hasEarlier: false, session: input.session, epoch: "e" };
  } } as unknown as HostClient;
  const reader = branchHistoryReader(client);
  const first = reader.read("s", "slow", "e");
  const rejected = assert.rejects(first, { name: "AbortError" });
  assert.equal(reader.read("s", "slow", "e"), first);
  assert.equal(calls.length, 1);
  const changed = reader.read("s", "new", "e");
  release({ entries: [{ ...entry("slow", user("old")), parentId: "unneeded-older-page" }], hasEarlier: true });
  await rejected;
  await changed;
  assert.equal(reader.read("s", "new", "e"), changed);
  assert.deepEqual(calls.map(call => call.leafId), ["slow", "new"]);
  reader.clear();
  await reader.read("s", "new", "e");
  assert.equal(calls.length, 3);
  await reader.read("s", null, "e");
  assert.equal(calls.length, 3, "the root composer needs no history request");
});
