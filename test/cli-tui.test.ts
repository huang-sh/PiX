import test from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Conversation, conversationEntries, graphTree, GraphSelector } from "../src/cli/tui.js";
import { agentEventForwarder } from "../src/main/agent-event-forwarder.js";
import type { SessionSnapshot } from "../src/shared/types.js";

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
