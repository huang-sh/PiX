import test from "node:test";
import assert from "node:assert/strict";
import { entryAnchorForNode, needsPromptDisplayBoundary, projectSession, summarizeSession } from "../src/shared/session.js";
import { createBranchMessageCache } from "../src/renderer/lib/session-view.js";
import { GIT_BRANCH_CUSTOM_TYPE, PROMPT_DISPLAY_CUSTOM_TYPE, type RawSessionEntry } from "../src/shared/types.js";
test("history window matches the selected ancestry without including sibling turns", () => {
  const entries: RawSessionEntry[] = [
    { type: "message", id: "root", parentId: null, timestamp: "0", message: { role: "user", content: "root" } },
    ...Array.from({ length: 2000 }, (_, i) => ({ type: "message", id: `u${i}`, parentId: "root", timestamp: "1",
      message: { role: "user", content: `sibling ${i}` } })),
  ];
  const window = createBranchMessageCache();
  const branch = window(entries, "u1999", 40);
  assert.equal(branch.messages.length, 2);
  assert.equal(branch.hasEarlier, false);
  assert.deepEqual(branch.messages, projectSession(entries, "u1999").messages);
  assert.deepEqual(window(entries, null, 40), { messages: [], hasEarlier: false });
});
const e: RawSessionEntry[] = [
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "1",
    message: { role: "user", content: "root" },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "answer\nTool: read" },
        { type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } },
      ],
    },
  },
  {
    type: "message",
    id: "r1",
    parentId: "a1",
    timestamp: "3",
    message: { role: "toolResult", toolCallId: "call-read", toolName: "read", content: "ok" },
  },
  {
    type: "message",
    id: "u2",
    parentId: "r1",
    timestamp: "4",
    message: { role: "user", content: "A" },
  },
  {
    type: "message",
    id: "a2",
    parentId: "u2",
    timestamp: "5",
    message: { role: "assistant", content: "branch A" },
  },
  {
    type: "branch_summary",
    id: "s1",
    parentId: "r1",
    timestamp: "6",
    summary: "left branch",
  },
  {
    type: "message",
    id: "u3",
    parentId: "s1",
    timestamp: "7",
    message: { role: "user", content: "B" },
  },
  {
    type: "message",
    id: "a3",
    parentId: "u3",
    timestamp: "8",
    message: { role: "assistant", content: "branch B" },
  },
];
test("projects sibling branches without mixing chat", () => {
  const p = projectSession(e, "a3");
  assert.equal(p.nodes.length, 3);
  assert.deepEqual(
    p.edges.map((x) => [x.source, x.target]),
    [
      ["turn:u1", "turn:u2"],
      ["turn:u1", "turn:u3"],
    ],
  );
  assert.deepEqual(p.activeBranchNodeIds, ["turn:u1", "turn:u3"]);
  assert.equal(
    p.messages.some((x) => x.text === "branch A"),
    false,
  );
  assert.equal(
    p.messages.some((x) => x.text === "branch B"),
    true,
  );
  assert.equal(p.messages.find((x) => x.entryId === "a1")?.text, "answer");
  assert.equal(
    p.messages.find((x) => x.role === "tool")?.toolInput,
    "README.md",
  );
});
test("selects branch-specific raw anchor", () =>
  assert.equal(entryAnchorForNode(projectSession(e, "a3"), "turn:u1"), "s1"));

test("uses structured prompt display metadata without changing model-visible content", () => {
  const modelText = "model-only image coordinate hint\n\n检查这个截图";
  const entries: RawSessionEntry[] = [
    { type: "custom", id: "display", parentId: null, timestamp: "1", customType: PROMPT_DISPLAY_CUSTOM_TYPE,
      data: { text: "检查这个截图" } },
    { type: "message", id: "u1", parentId: "display", timestamp: "2", message: { role: "user", content: [
      { type: "text", text: modelText }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ] } },
  ];
  const projection = projectSession(entries, "u1");
  assert.equal(projection.messages[0]?.text, "检查这个截图");
  assert.equal(projection.messages[0]?.images?.length, 1);
  assert.equal(projection.nodes[0]?.title, "检查这个截图");
  assert.deepEqual(projection.nodes[0]?.rawEntryIds, ["display", "u1"]);
  assert.equal(summarizeSession("session.jsonl", null, entries, "2").firstMessage, "检查这个截图");
  assert.equal(((entries[1]!.message as { content: Array<{ text?: string }> }).content[0]?.text), modelText);
});

test("a newer prompt display marker supersedes an interrupted marker without changing the previous turn", () => {
  const entries: RawSessionEntry[] = [
    { type: "message", id: "u1", parentId: null, timestamp: "1", message: { role: "user", content: "first" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2", message: { role: "assistant", content: "done" } },
    { type: "custom", id: "interrupted", parentId: "a1", timestamp: "3", customType: PROMPT_DISPLAY_CUSTOM_TYPE,
      data: { text: "interrupted image" } },
    { type: "custom", id: "next", parentId: "interrupted", timestamp: "4", customType: PROMPT_DISPLAY_CUSTOM_TYPE,
      data: { text: "next prompt" } },
    { type: "message", id: "u2", parentId: "next", timestamp: "5", message: { role: "user", content: "model text" } },
  ];
  const projection = projectSession(entries, "u2");
  assert.equal(projection.messages.find(message => message.entryId === "u2")?.text, "next prompt");
  assert.deepEqual(projection.nodes.find(node => node.userEntryId === "u1")?.rawEntryIds, ["u1", "a1"]);
  assert.deepEqual(projection.nodes.find(node => node.userEntryId === "u2")?.rawEntryIds, ["next", "u2"]);
});

test("a text prompt adds a boundary only when an image display marker was interrupted before its user message", () => {
  const interrupted: RawSessionEntry[] = [
    { type: "message", id: "u1", parentId: null, timestamp: "1", message: { role: "user", content: "first" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2", message: { role: "assistant", content: "done" } },
    { type: "custom", id: "display", parentId: "a1", timestamp: "3", customType: PROMPT_DISPLAY_CUSTOM_TYPE,
      data: { text: "interrupted image" } },
  ];
  assert.equal(needsPromptDisplayBoundary(interrupted, "display"), true);
  const entries: RawSessionEntry[] = [...interrupted,
    { type: "custom", id: "boundary", parentId: "display", timestamp: "4", customType: PROMPT_DISPLAY_CUSTOM_TYPE,
      data: { boundary: true } },
    { type: "message", id: "u2", parentId: "boundary", timestamp: "5", message: { role: "user", content: "plain text" } },
  ];
  assert.equal(needsPromptDisplayBoundary(entries, "u2"), false);
  const projection = projectSession(entries, "u2");
  assert.equal(projection.messages.find(message => message.entryId === "u2")?.text, "plain text");
  assert.deepEqual(projection.nodes.find(node => node.userEntryId === "u2")?.rawEntryIds, ["u2"]);
});

test("prompt display metadata preserves the Git record immediately before it", () => {
  const entries: RawSessionEntry[] = [
    { type: "custom", id: "git", parentId: null, timestamp: "1", customType: GIT_BRANCH_CUSTOM_TYPE,
      data: { branch: "feature/image", commit: "a".repeat(40) } },
    { type: "custom", id: "display", parentId: "git", timestamp: "2", customType: PROMPT_DISPLAY_CUSTOM_TYPE,
      data: { text: "检查图片" } },
    { type: "message", id: "user", parentId: "display", timestamp: "3", message: { role: "user", content: "model text" } },
  ];
  const node = projectSession(entries, "user").nodes[0];
  assert.equal(node?.gitBranch, "feature/image");
  assert.equal(node?.gitCommit, "a".repeat(40));
});

test("context status follows the selected branch and latest edit while preserving original messages", () => {
  const entries: RawSessionEntry[] = [...e,
    { type: "context_edit", id: "omit", parentId: "a2", timestamp: "9", targetId: "u1", replacement: null },
    { type: "context_edit", id: "edit", parentId: "omit", timestamp: "10", targetId: "a1", replacement: { content: "different model input" } },
    { type: "context_edit", id: "tool", parentId: "edit", timestamp: "11", targetId: "r1", replacement: null },
    { type: "context_edit", id: "restore", parentId: "tool", timestamp: "12", targetId: "u1", replacement: { content: "restored input" } },
  ];
  const window = createBranchMessageCache();
  assert.deepEqual(window(entries, "tool", 2).messages.map(message => [message.entryId, message.contextStatus]),
    [["u1", "excluded"], ["a1", "modified"], ["r1", "excluded"], ["u2", undefined], ["a2", undefined]]);
  assert.equal(window(entries, "restore", 2).messages[0]?.contextStatus, "modified");
  assert.equal(window(entries, "restore", 2).messages[0]?.text, "root");
  assert.equal(window(entries, "tool", 2).messages.find(message => message.entryId === "a1")?.text, "answer");
  assert.ok(window(entries, "tool", 1).messages.every(message => !message.contextStatus));
  assert.ok(window(entries, "a3", 2).messages.every(message => !message.contextStatus), "sibling edits never leak");
  assert.ok(projectSession(entries, "a2").messages.every(message => !message.contextStatus), "earlier leaves predate the edits");
});

test("context status accounts for compaction and preserves edits in retained history", () => {
  const entries: RawSessionEntry[] = [...e,
    { type: "context_edit", id: "edit", parentId: "a2", timestamp: "9", targetId: "a2", replacement: { content: "adjusted" } },
    { type: "compaction", id: "compact", parentId: "edit", timestamp: "10", firstKeptEntryId: "u2", summary: "summary" },
    { type: "compaction", id: "none", parentId: "compact", timestamp: "11", firstKeptEntryId: "none", summary: "summary only" },
  ];
  const window = createBranchMessageCache();
  const full = window(entries, "compact", 2).messages;
  assert.equal(full.find(message => message.entryId === "u1")?.contextStatus, "excluded");
  assert.equal(full.find(message => message.entryId === "a2")?.contextStatus, "modified");
  assert.equal(full.find(message => message.entryId === "u2")?.contextStatus, undefined);
  assert.deepEqual(window(entries, "compact", 1).messages, full.filter(message => message.turnId === "turn:u2"));
  assert.ok(window(entries, "none", 2).messages.filter(message => message.entryId !== "none")
    .every(message => message.contextStatus === "excluded"));
});
test("projects failed assistant replies as error messages", () => {
  const failed: RawSessionEntry[] = [
    { type: "message", id: "u1", parentId: null, timestamp: "1", message: { role: "user", content: "hello" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: '401: {"message":"Authentication Fails"}',
      },
    },
  ];
  const message = projectSession(failed, "a1").messages.find((x) => x.entryId === "a1");
  assert.equal(message?.isError, true);
  assert.equal(message?.errorMessage, '401: {"message":"Authentication Fails"}');
  assert.equal(message?.text, "");
  assert.equal(projectSession(failed, "a1").nodes[0]?.hasError, true);
});
test("node error follows the final assistant reply, not tool failures", () => {
  const recovered: RawSessionEntry[] = [
    { type: "message", id: "u1", parentId: null, timestamp: "1", message: { role: "user", content: "read missing file" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "nope.md" } }],
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: "3",
      message: { role: "toolResult", toolCallId: "call-read", toolName: "read", content: "File not found", isError: true },
    },
    {
      type: "message",
      id: "a2",
      parentId: "r1",
      timestamp: "4",
      message: { role: "assistant", content: [{ type: "text", text: "that file does not exist" }] },
    },
  ];
  const p = projectSession(recovered, "a2");
  assert.equal(p.nodes[0]?.hasError, false);
  assert.equal(p.messages.find((x) => x.entryId === "r1")?.isError, true);
});
test("node error ignores an intermediate failed reply that was retried", () => {
  const retried: RawSessionEntry[] = [
    { type: "message", id: "u1", parentId: null, timestamp: "1", message: { role: "user", content: "hello" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" },
    },
    {
      type: "message",
      id: "a2",
      parentId: "a1",
      timestamp: "3",
      message: { role: "assistant", content: [{ type: "text", text: "recovered answer" }] },
    },
  ];
  assert.equal(projectSession(retried, "a2").nodes[0]?.hasError, false);
});
test("projection is append-order independent", () =>
  assert.equal(projectSession([...e].reverse(), "a3").nodes.length, 3));
test("session metadata does not become a fake prompt node", () => {
  const metadata: RawSessionEntry[] = [
    {
      type: "model_change",
      id: "model-1",
      parentId: null,
      timestamp: "1",
      provider: "example",
      modelId: "example-model",
    },
  ];
  const p = projectSession(metadata, "model-1");
  assert.deepEqual(p.nodes, []);
  assert.deepEqual(p.edges, []);
  assert.equal(p.activeNodeId, null);
});
test("reads saved node footer usage without recalculating assistant usage", () => {
  const entries: RawSessionEntry[] = [
    { type: "model_change", id: "m1", parentId: null, timestamp: "1", provider: "openai", modelId: "gpt-5.4" },
    { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2", thinkingLevel: "high" },
    { type: "message", id: "u1", parentId: "t1", timestamp: "3", message: { role: "user", content: "hello" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "4",
      message: {
        role: "assistant",
        content: "hi",
        provider: "openai",
        model: "gpt-5.4",
        usage: { totalTokens: 99_999 },
      },
    },
    {
      type: "custom",
      customType: "pix.node-footer",
      id: "f1",
      parentId: "a1",
      timestamp: "5",
      data: {
        contextUsage: { tokens: 41_000, contextWindow: 128_000, percent: 32.03125 },
        model: { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
        thinkingLevel: "high",
      },
    },
    { type: "model_change", id: "m2", parentId: "f1", timestamp: "6", provider: "zai", modelId: "glm-5.3" },
    { type: "thinking_level_change", id: "t2", parentId: "m2", timestamp: "7", thinkingLevel: "low" },
  ];

  assert.deepEqual(projectSession(entries, "t2").nodes[0]?.footer, {
    contextUsage: { tokens: 41_000, contextWindow: 128_000, percent: 32.03125 },
    model: { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
    thinkingLevel: "high",
  });
  assert.equal(projectSession(entries.slice(0, -3), "a1").nodes[0]?.footer?.contextUsage, undefined);
});
test("turns inherit effective settings while streaming, before the footer entry lands", () => {
  const entries: RawSessionEntry[] = [
    { type: "model_change", id: "m1", parentId: null, timestamp: "1", provider: "zai", modelId: "glm-5.3" },
    { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2", thinkingLevel: "high" },
    { type: "message", id: "u1", parentId: "t1", timestamp: "3", message: { role: "user", content: "first" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "4",
      message: { role: "assistant", content: "answer", provider: "zai", model: "glm-5.3" },
    },
    {
      type: "custom",
      customType: "pix.node-footer",
      id: "f1",
      parentId: "a1",
      timestamp: "5",
      data: {
        contextUsage: { tokens: 10, contextWindow: 1000, percent: 1 },
        model: { provider: "zai", id: "glm-5.3", name: "GLM-5.3", reasoning: true },
        thinkingLevel: "high",
      },
    },
    { type: "message", id: "u2", parentId: "f1", timestamp: "6", message: { role: "user", content: "second" } },
    {
      type: "message",
      id: "a2",
      parentId: "u2",
      timestamp: "7",
      message: { role: "assistant", content: "partial", provider: "zai", model: "glm-5.3" },
    },
  ];
  const footer = projectSession(entries, "a2").nodes[1]?.footer;
  assert.equal(footer?.thinkingLevel, "high");
  assert.deepEqual(footer?.model, { provider: "zai", id: "glm-5.3" });
  assert.equal(footer?.contextUsage, undefined);
});
test("branch-local thinking changes apply to their branch only", () => {
  const entries: RawSessionEntry[] = [
    { type: "model_change", id: "m1", parentId: null, timestamp: "1", provider: "zai", modelId: "glm-5.3" },
    { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2", thinkingLevel: "high" },
    { type: "message", id: "u1", parentId: "t1", timestamp: "3", message: { role: "user", content: "root" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "4",
      message: { role: "assistant", content: "answer", provider: "zai", model: "glm-5.3" },
    },
    {
      type: "custom",
      customType: "pix.node-footer",
      id: "f1",
      parentId: "a1",
      timestamp: "5",
      data: { model: { provider: "zai", id: "glm-5.3", name: "GLM-5.3", reasoning: true }, thinkingLevel: "high" },
    },
    { type: "message", id: "u2", parentId: "f1", timestamp: "6", message: { role: "user", content: "A" } },
    {
      type: "message",
      id: "a2",
      parentId: "u2",
      timestamp: "7",
      message: { role: "assistant", content: "branch A", provider: "zai", model: "glm-5.3" },
    },
    { type: "thinking_level_change", id: "t2", parentId: "f1", timestamp: "8", thinkingLevel: "low" },
    { type: "message", id: "u3", parentId: "t2", timestamp: "9", message: { role: "user", content: "B" } },
    {
      type: "message",
      id: "a3",
      parentId: "u3",
      timestamp: "10",
      message: { role: "assistant", content: "branch B", provider: "zai", model: "glm-5.3" },
    },
  ];
  const p = projectSession(entries, "a3");
  assert.equal(p.nodes.find((n) => n.id === "turn:u1")?.footer?.thinkingLevel, "high");
  assert.equal(p.nodes.find((n) => n.id === "turn:u2")?.footer?.thinkingLevel, "high");
  assert.equal(p.nodes.find((n) => n.id === "turn:u3")?.footer?.thinkingLevel, "low");
});
test("sessions without footer entries still show the effective thinking level", () => {
  const entries: RawSessionEntry[] = [
    { type: "model_change", id: "m1", parentId: null, timestamp: "1", provider: "zai", modelId: "glm-5.3" },
    { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2", thinkingLevel: "high" },
    { type: "message", id: "u1", parentId: "t1", timestamp: "3", message: { role: "user", content: "hello" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "4",
      message: { role: "assistant", content: "hi", provider: "zai", model: "glm-5.3" },
    },
  ];
  const footer = projectSession(entries, "a1").nodes[0]?.footer;
  assert.equal(footer?.thinkingLevel, "high");
  assert.deepEqual(footer?.model, { provider: "zai", id: "glm-5.3" });
});
test("a turn's own settled footer entry beats the inherited chain", () => {
  const entries: RawSessionEntry[] = [
    { type: "model_change", id: "m1", parentId: null, timestamp: "1", provider: "zai", modelId: "glm-5.3" },
    { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2", thinkingLevel: "high" },
    { type: "message", id: "u1", parentId: "t1", timestamp: "3", message: { role: "user", content: "first" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "4",
      message: { role: "assistant", content: "answer", provider: "zai", model: "glm-5.3" },
    },
    { type: "message", id: "u2", parentId: "a1", timestamp: "5", message: { role: "user", content: "second" } },
    {
      type: "message",
      id: "a2",
      parentId: "u2",
      timestamp: "6",
      message: { role: "assistant", content: "answer", provider: "zai", model: "glm-5.3" },
    },
    {
      type: "custom",
      customType: "pix.node-footer",
      id: "f2",
      parentId: "a2",
      timestamp: "7",
      data: { model: { provider: "zai", id: "glm-5.3", name: "GLM-5.3", reasoning: true }, thinkingLevel: "low" },
    },
  ];
  assert.equal(projectSession(entries, "f2").nodes[1]?.footer?.thinkingLevel, "low");
});

test("node metrics aggregate only owned usage and end at the saved completion", () => {
  const entry = (id: string, parentId: string | null, seconds: number, extra: Record<string, unknown>): RawSessionEntry => ({
    id, parentId, timestamp: new Date(Date.UTC(2026, 9, 27, 0, 0, seconds)).toISOString(), type: "message", ...extra,
  });
  const entries = [
    entry("u", null, 0, { message: { role: "user", content: "root" } }),
    entry("a", "u", 1, { message: { role: "assistant", provider: "openai", model: "m", usage: { input: 100, output: 20, cacheRead: 50, cost: { total: 0.01 } } } }),
    entry("r", "a", 2, { message: { role: "toolResult", usage: { output: 5, cost: 0.02 } } }),
    entry("a2", "r", 3, { message: { role: "assistant", provider: "openai", model: "m", usage: { input: 30, output: 10, cacheWrite: 8, cost: { total: 0.03 } } } }),
    entry("f", "a2", 6, { type: "custom", customType: "pix.node-footer", data: {} }),
    entry("label", "f", 60, { type: "label", targetId: "u", label: "later" }),
    entry("child", "f", 10, { message: { role: "user", content: "child" } }),
    entry("ac", "child", 11, { message: { role: "assistant", provider: "anthropic", model: "m", usage: { output: 3 } } }),
    entry("sibling", "f", 12, { message: { role: "user", content: "sibling" } }),
    entry("as", "sibling", 13, { message: { role: "assistant", provider: "openai", model: "m", usage: { output: 500, cost: { total: 4 } } } }),
  ];
  const p = projectSession(entries, "as");
  const root = p.nodes.find(node => node.userEntryId === "u")!.metrics!;
  assert.deepEqual(root.usage, { input: 130, output: 35, cacheRead: 50, cacheWrite: 8, cost: 0.06 });
  assert.equal(root.costs?.openai, 0.04);
  assert.equal(root.costs?.Tools, 0.02);
  assert.equal(root.durationMs, 6000);
  const child = p.nodes.find(node => node.userEntryId === "child")!.metrics!;
  assert.equal(child.durationMs, undefined);
  assert.equal(child.costs?.anthropic, null);
  assert.equal(child.usage?.output, 3);
  assert.equal(p.nodes.find(node => node.userEntryId === "sibling")!.metrics!.usage?.output, 500);
});
