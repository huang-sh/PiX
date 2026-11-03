import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { exportSubtree } from "../src/main/graph-export.js";
import { GraphFiles, encodeSession, parseStrict, type SessionData, type BranchRecord } from "../src/main/graph-files.js";
import { projectSession } from "../src/shared/session.js";
import { GIT_BRANCH_CUSTOM_TYPE, PROMPT_DISPLAY_CUSTOM_TYPE, PROMPT_OVERRIDE_CUSTOM_TYPE, type RawSessionEntry } from "../src/shared/types.js";
import { latestPromptOverride } from "../src/main/extensions/prompt-override.js";

const entry = (type: string, id: string, parentId: string | null, extra = {}): RawSessionEntry =>
  ({ type, id, parentId, timestamp: "2026-01-01", ...extra });
const user = (id: string, parent: string | null) => entry("message", id, parent,
  { message: { role: "user", content: id, timestamp: 1 } });
const header = { type: "session", version: 3, id: "source", cwd: "/test", timestamp: "2026-01-01" };

test("subtree export preserves every fork, active settings, image display and bookmarks without old history", () => {
  const source: SessionData = { header, entries: [
    entry("model_change", "model", null, { provider: "faux", modelId: "test" }),
    entry("thinking_level_change", "old-thinking", "model", { thinkingLevel: "low" }),
    user("OLD_CONVERSATION", "old-thinking"),
    entry("thinking_level_change", "thinking", "OLD_CONVERSATION", { thinkingLevel: "high" }),
    entry("custom", "persona", "thinking", { customType: PROMPT_OVERRIDE_CUSTOM_TYPE,
      data: { mode: "append", name: "reviewer", text: "Check carefully" } }),
    entry("custom", "display", "persona", { customType: PROMPT_DISPLAY_CUSTOM_TYPE, data: { text: "image question" } }),
    entry("message", "selected", "display", { message: { role: "user", timestamp: 2, content: [
      { type: "text", text: "model image hint" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    ] } }),
    user("child-a", "selected"), user("grandchild", "child-a"), user("child-b", "selected"),
    user("UNRELATED", "display"),
    entry("label", "bookmark", "UNRELATED", { targetId: "selected", label: "Start here" }),
    entry("label", "old-bookmark", "child-b", { targetId: "OLD_CONVERSATION", label: "PRIVATE_OLD_LABEL" }),
  ] };
  const before = encodeSession(source);
  const result = exportSubtree(parseStrict(before), "selected");
  const raw = encodeSession(result);
  assert.doesNotMatch(raw, /OLD_CONVERSATION|UNRELATED|PRIVATE_OLD_LABEL|old-thinking/);
  assert.equal(encodeSession(source), before);
  const projection = projectSession(result.entries, result.entries.at(-1)!.id);
  assert.equal(projection.nodes.length, 4);
  const root = projection.nodes.find(node => node.userEntryId === "selected")!;
  assert.equal(root.parentId, null);
  assert.equal(root.title, "image question");
  assert.equal(root.label, "Start here");
  for (const id of ["child-a", "child-b"])
    assert.equal(projection.nodes.find(node => node.userEntryId === id)!.parentId, root.id);
  assert.equal(projection.nodes.find(node => node.userEntryId === "grandchild")!.parentId, "turn:child-a");
  assert.ok(raw.includes("aW1hZ2U="));
  assert.equal(result.entries.find(entry => entry.id === "bookmark")!.parentId, "child-b");
  const manager = SessionManager.inMemory("/test", undefined, [result.header, ...result.entries] as any);
  assert.equal(manager.getTree().length, 1);
  manager.branch("grandchild");
  assert.equal(manager.buildSessionContext().thinkingLevel, "high");
  assert.deepEqual(manager.buildSessionContext().model, { provider: "faux", modelId: "test" });
  assert.equal(manager.buildSessionContext().messages.length, 3);
});

test("subtree export removes summaries and external edits, reconnecting retained turns without dangling references", () => {
  const source: SessionData = { header, entries: [
    user("OLD_HISTORY", null), user("selected", "OLD_HISTORY"),
    entry("compaction", "compact", "selected", { firstKeptEntryId: "OLD_HISTORY", summary: "SECRET_SUMMARY" }),
    user("next", "compact"),
    entry("compaction", "inside-compact", "next", { firstKeptEntryId: "selected", summary: "ALSO_OLD_HISTORY" }),
    entry("branch_summary", "summary", "inside-compact", { fromId: "OLD_HISTORY", summary: "SECRET_BRANCH" }),
    entry("context_edit", "external-edit", "summary", { targetId: "OLD_HISTORY", replacement: { content: "PRIVATE_EDIT" } }),
    user("last", "external-edit"),
    entry("context_edit", "kept-edit", "last", { targetId: "next", replacement: { content: "edited next" } }),
    entry("custom", "branch-metadata", "kept-edit", { customType: "pix.branch-metadata", data: { label: "OLD_HISTORY" } }),
  ] };
  const result = exportSubtree(parseStrict(encodeSession(source)), "selected");
  assert.doesNotMatch(encodeSession(result), /OLD_HISTORY|SECRET|PRIVATE_EDIT/);
  assert.deepEqual(result.entries.map(entry => [entry.id, entry.parentId]), [
    ["selected", null], ["next", "selected"], ["last", "next"], ["kept-edit", "last"],
  ]);
  const manager = SessionManager.inMemory("/test", undefined, [result.header, ...result.entries] as any);
  assert.equal(manager.buildSessionContext().messages.length, 3);
  assert.throws(() => exportSubtree(source, "missing"), /not a user turn/);
  assert.throws(() => exportSubtree(source, "compact"), /not a user turn/);
});

test("an unanswered export root inherits the latest assistant model rather than an older model change", () => {
  const source: SessionData = { header, entries: [
    entry("model_change", "model", null, { provider: "old", modelId: "old-model" }),
    user("old-user", "model"),
    entry("message", "reply", "old-user", { message: {
      role: "assistant", provider: "faux", model: "latest-model", content: [{ type: "text", text: "OLD_REPLY" }],
    } }), user("selected", "reply"),
  ] };
  const result = exportSubtree(source, "selected");
  const original = SessionManager.inMemory("/test", undefined, [header, ...source.entries] as any);
  const exported = SessionManager.inMemory("/test", undefined, [header, ...result.entries] as any);
  assert.deepEqual(exported.buildSessionContext().model, original.buildSessionContext().model);
  assert.doesNotMatch(encodeSession(result), /OLD_REPLY/);
});

test("export retains the root display text across interturn metadata without relabeling later turns", () => {
  const source: SessionData = { header, entries: [
    user("old-user", null),
    entry("custom", "display", "old-user", { customType: PROMPT_DISPLAY_CUSTOM_TYPE, data: { text: "Original question" } }),
    entry("model_change", "model", "display", { provider: "faux", modelId: "test" }),
    user("selected", "model"), user("child", "selected"),
  ] };
  const result = exportSubtree(source, "selected");
  const original = projectSession(source.entries, "child");
  const exported = projectSession(result.entries, "child");
  for (const id of ["selected", "child"])
    assert.equal(exported.nodes.find(node => node.userEntryId === id)!.title,
      original.nodes.find(node => node.userEntryId === id)!.title);
});

test("export keeps the root's Git identity and ignores invalid persona overrides", () => {
  const source: SessionData = { header, entries: [
    entry("custom", "persona", null, { customType: PROMPT_OVERRIDE_CUSTOM_TYPE,
      data: { mode: "strict", name: "reviewer", text: "Check carefully" } }),
    user("old-user", "persona"),
    entry("custom", "invalid-persona", "old-user", { customType: PROMPT_OVERRIDE_CUSTOM_TYPE, data: { name: "invalid" } }),
    entry("custom", "git", "invalid-persona", { customType: GIT_BRANCH_CUSTOM_TYPE,
      data: { branch: "dev", commit: "a".repeat(40) } }),
    entry("custom", "display", "git", { customType: PROMPT_DISPLAY_CUSTOM_TYPE, data: { text: "Question" } }),
    user("selected", "display"),
  ] };
  const result = exportSubtree(source, "selected");
  const node = projectSession(result.entries, "selected").nodes[0]!;
  assert.equal(node.gitBranch, "dev");
  assert.equal(node.gitCommit, "a".repeat(40));
  assert.deepEqual(latestPromptOverride(result.entries), latestPromptOverride(source.entries));
});


test("branch composition supports native persona records while rejecting unknown extension state", () => {
  const main: SessionData = { header, entries: [user("old-user", null)] };
  const record: BranchRecord = { id: "branch", parentId: "main", forkEntryId: "old-user", requestId: "request",
    request: { text: "selected" }, inherited: { "old-user": "old-user" }, baseline: main.entries,
    header: { ...header, id: "branch" }, status: "idle", runId: "run" };
  const graph = new GraphFiles("/test/main.jsonl");
  graph.records.set(record.id, record);
  for (const data of [{ mode: "strict", name: "reviewer", text: "Review carefully" }, { off: true }]) {
    const source: SessionData = { header: record.header, entries: [...main.entries,
      entry("custom", "persona", "old-user", { customType: PROMPT_OVERRIDE_CUSTOM_TYPE, data }),
      user("selected", "persona"), user("child", "selected"),
    ] };
    const before = encodeSession(source);
    const composed = graph.candidate(main, new Map([[record.id, source]]));
    const exported = exportSubtree(composed, "branch:selected");
    assert.deepEqual(latestPromptOverride(exported.entries), latestPromptOverride(source.entries));
    assert.equal(encodeSession(source), before);
    source.entries[1] = { ...source.entries[1]!, customType: "unknown.extension" };
    assert.throws(() => graph.candidate(main, new Map([[record.id, source]])), /Extension state needs a compatible export adapter/);
  }
});


test("off-path bookmarks preserve replies and continuation context at every exported node", () => {
  const reply = (id: string, parentId: string) => entry("message", id, parentId, {
    message: { role: "assistant", content: [{ type: "text", text: id }], timestamp: 1 },
  });
  for (const withBranches of [false, true]) {
    const source: SessionData = { header, entries: [
      user("old", null), user("selected", "old"), reply("selected-answer", "selected"),
      ...(withBranches ? [user("child-a", "selected-answer"), reply("answer-a", "child-a"),
        user("child-b", "selected-answer"), reply("answer-b", "child-b")] : []),
      user("unrelated", "old"),
      entry("label", "bookmark", "unrelated", { targetId: "selected", label: "Selected bookmark" }),
      ...(withBranches ? [entry("label", "child-bookmark", "bookmark", { targetId: "child-a", label: "Child bookmark" })] : []),
    ] };
    const result = exportSubtree(parseStrict(encodeSession(source)), "selected");
    const original = SessionManager.inMemory("/test", undefined, [header, ...source.entries] as any);
    const exported = SessionManager.inMemory("/test", undefined, [header, ...result.entries] as any);
    const originalNodes = projectSession(source.entries, source.entries.at(-1)!.id).nodes;
    const exportedNodes = projectSession(result.entries, result.entries.at(-1)!.id).nodes;
    for (const node of exportedNodes) {
      const before = originalNodes.find(n => n.id === node.id)!;
      original.branch(before.leafEntryId);
      exported.branch(node.leafEntryId);
      assert.deepEqual(exported.buildSessionContext().messages, original.buildSessionContext().messages.slice(1),
        `continuing ${node.title} must keep its answer and exclude other branches`);
      assert.equal(node.label, before.label);
    }
  }
});


test("nested repeated exports preserve per-node edited context, settings and bookmarks across a branching tree", () => {
  const entries: RawSessionEntry[] = [
    entry("model_change", "model", null, { provider: "faux", modelId: "test" }),
    entry("thinking_level_change", "thinking", "model", { thinkingLevel: "high" }),
  ];
  const tips: string[] = [];
  for (let i = 0; i < 18; i++) {
    const parent = i ? tips[Math.floor((i - 1) / 2)]! : "thinking";
    entries.push(user(`q${i}`, parent));
    entries.push(entry("message", `a${i}`, `q${i}`, { message: {
      role: "assistant", provider: "faux", model: "test", timestamp: i,
      content: [{ type: "text", text: `answer ${i}` }],
    } }));
    entries.push(entry("context_edit", `edit${i}`, `a${i}`, {
      targetId: `a${i}`, replacement: i % 3 ? { content: `edited answer ${i}` } : null,
    }));
    tips.push(`edit${i}`);
  }
  for (let i = 0; i < 18; i++) entries.push(entry("label", `label${i}`, tips[(i + 7) % 18]!, {
    targetId: `q${i}`, label: `Bookmark ${i}`,
  }));
  const source = parseStrict(encodeSession({ header, entries }));
  const original = SessionManager.inMemory("/test", undefined, [header, ...source.entries] as any);
  const originalNodes = projectSession(source.entries, source.entries.at(-1)!.id).nodes;
  for (let i = 0; i < 18; i++) {
    let exported = exportSubtree(source, `q${i}`);
    // Re-export the same range from the standalone result as well.
    for (let round = 0; round < 2; round++) {
      const manager = SessionManager.inMemory("/test", undefined, [header, ...exported.entries] as any);
      const nodes = projectSession(exported.entries, exported.entries.at(-1)!.id).nodes;
      for (const node of nodes) {
        const before = originalNodes.find(n => n.id === node.id)!;
        original.branch(before.leafEntryId); manager.branch(node.leafEntryId);
        const expected = original.buildSessionContext();
        const start = expected.messages.findIndex(m => m.role === "user" && m.content === `q${i}`);
        assert.ok(start >= 0);
        assert.deepEqual(manager.buildSessionContext(), { ...expected, messages: expected.messages.slice(start) });
        assert.equal(node.label, before.label);
        assert.equal(node.parentId, node.userEntryId === `q${i}` ? null : before.parentId);
      }
      exported = exportSubtree(exported, `q${i}`);
    }
  }
});
