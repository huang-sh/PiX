import test from "node:test";
import assert from "node:assert/strict";
import { entryAnchorForNode, projectSession } from "../src/shared/session.js";
import type { RawSessionEntry } from "../src/shared/types.js";
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
