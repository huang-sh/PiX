import test from "node:test";
import assert from "node:assert/strict";
import { projectSession, SNAPSHOT_TURN_LIMIT, SNAPSHOT_WINDOW_BYTES, windowEntries } from "../src/shared/session.js";
import type { RawSessionEntry } from "../src/shared/types.js";
import { validateRouteInput } from "../src/shared/contracts.js";

/** Adversarial shapes: the two ways a session blows up are many small turns
 * and a few turns that each carry far more than the whole byte budget. */
function conversation(turnBytes: number[]): RawSessionEntry[] {
  const entries: RawSessionEntry[] = [];
  let parentId: string | null = null;
  turnBytes.forEach((size, i) => {
    const user = `u${i}`, answer = `a${i}`;
    entries.push({ type: "message", id: user, parentId, timestamp: String(i),
      message: { role: "user", content: [{ type: "text", text: `question ${i}` }] } });
    entries.push({ type: "message", id: answer, parentId: user, timestamp: String(i),
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(size) }] } });
    parentId = answer;
  });
  return entries;
}
const wireBytes = (entries: RawSessionEntry[]) => entries.reduce((total, entry) => total + JSON.stringify(entry).length, 0);
const turnCount = (entries: RawSessionEntry[]) =>
  entries.filter(entry => entry.type === "message" && (entry.message as { role?: string }).role === "user").length;
/** Every window is a run of complete turns: it starts at a user message and
 * every projected reply keeps the prompt of its own turn. */
const assertCompleteTurns = (entries: RawSessionEntry[]) => {
  assert.ok(entries.length > 0);
  assert.equal((entries[0]!.message as { role?: string }).role, "user", "a window never starts mid-turn");
  const messages = projectSession(entries, entries.at(-1)!.id).messages;
  const prompted = new Set(messages.filter(message => message.role === "user").map(message => message.turnId));
  for (const message of messages) assert.ok(prompted.has(message.turnId), `reply ${message.entryId} lost its prompt`);
};

test("the turn limit bounds a session of many small turns", () => {
  const entries = conversation(Array.from({ length: 500 }, () => 2_000));
  const window = windowEntries(entries, entries.at(-1)!.id, SNAPSHOT_TURN_LIMIT, SNAPSHOT_WINDOW_BYTES);
  assert.equal(turnCount(window.entries), SNAPSHOT_TURN_LIMIT);
  assert.equal(window.hasEarlier, true);
  assert.ok(wireBytes(window.entries) < SNAPSHOT_WINDOW_BYTES, "small turns never reach the byte cap");
  assertCompleteTurns(window.entries);
});

test("the byte limit bounds turns that are individually large but not oversized", () => {
  const entries = conversation(Array.from({ length: 8 }, () => SNAPSHOT_WINDOW_BYTES));
  const window = windowEntries(entries, entries.at(-1)!.id, 1_000, SNAPSHOT_WINDOW_BYTES);
  assert.equal(turnCount(window.entries), 1, "a turn that alone fills the budget still ships, and no more");
  assert.equal(window.hasEarlier, true);
  assertCompleteTurns(window.entries);
});

test("an oversized turn still ships whole so paging can advance", () => {
  const huge = 50 << 20;
  const entries = conversation([1_000, 1_000, huge]);
  const first = windowEntries(entries, entries.at(-1)!.id, SNAPSHOT_TURN_LIMIT, SNAPSHOT_WINDOW_BYTES);
  assert.equal(turnCount(first.entries), 1, "the window floors at one turn instead of returning nothing");
  assert.ok(wireBytes(first.entries) > 4 * SNAPSHOT_WINDOW_BYTES, "documents the known cost of one huge turn");
  assertCompleteTurns(first.entries);
  // Paging must make progress: a larger budget reaches further, and the last
  // page reports that it reached the root instead of repeating itself forever.
  const wider = windowEntries(entries, entries.at(-1)!.id, SNAPSHOT_TURN_LIMIT, 64 << 20);
  assert.equal(turnCount(wider.entries), 3);
  assert.equal(wider.hasEarlier, false);
  assert.notDeepEqual(wider.entries.map(entry => entry.id), first.entries.map(entry => entry.id), "a bigger page is a different page");
});

test("the default snapshot stays inside the wire budget", () => {
  const entries = conversation(Array.from({ length: 500 }, () => 2_000));
  const window = windowEntries(entries, entries.at(-1)!.id, SNAPSHOT_TURN_LIMIT, SNAPSHOT_WINDOW_BYTES);
  const payload = wireBytes(window.entries);
  assert.ok(payload <= 2 << 20, `a bounded window must stay small; got ${(payload / 1048576).toFixed(2)} MB`);
  const startedAt = performance.now();
  JSON.parse(JSON.stringify(window.entries));
  assert.ok(performance.now() - startedAt < 500, "serializing a bounded window stays cheap");
});

test("tool metadata cannot dominate a window, but display text stays", () => {
  const entries = conversation([1_000]);
  const toolResult = { type: "message", id: "tool", parentId: "a0", timestamp: "2", message: { role: "toolResult", toolName: "computer-use",
    content: [{ type: "text", text: "Observed visual @r3" }],
    details: { note: "small note", renderedOutline: "o".repeat(200_000),
      outline: { lookId: "l1", root: { children: Array.from({ length: 20_000 }, (_, i) => ({ id: i, label: `node ${i}` })) } } } } } as RawSessionEntry;
  entries.push(toolResult);
  const window = windowEntries(entries, "tool", SNAPSHOT_TURN_LIMIT, SNAPSHOT_WINDOW_BYTES);
  const shipped = window.entries.at(-1)!.message as { content: Array<{ text: string }>; details: Record<string, unknown> };
  assert.ok(wireBytes(window.entries) < 300 * 1024, `tool metadata must not dominate the window; got ${wireBytes(window.entries)} bytes`);
  assert.equal(shipped.content[0]!.text, "Observed visual @r3", "the readable result is never trimmed");
  assert.equal(shipped.details.note, "small note", "small details still ship");
  // Long strings keep both ends: the head carries context, the tail the outcome.
  const cut = String(shipped.details.renderedOutline);
  assert.match(cut, /\(134464 characters omitted for display\)/, "the middle says how much was dropped");
  assert.equal(cut.startsWith("o".repeat(32_768)), true, "the head ships");
  assert.equal(cut.endsWith("o".repeat(32_768)), true, "the tail ships");
  assert.equal(shipped.details.outline, undefined, "an oversized structured dump is left out");
  // The record on disk is untouched: only the wire copy is bounded.
  assert.equal((toolResult.message as { details: { outline?: unknown } }).details.outline !== undefined, true);
});

test("a page request must stay inside the route contract", () => {
  // The renderer and the CLI page history through this route; a limit or byte
  // budget above the contract is rejected outright, so callers loop instead.
  const page = validateRouteInput("session.branchWindow", { session: "s.jsonl", leafId: "a1", limit: 500, bytes: 64 << 20 }) as {
    limit: number; bytes: number; leafId: string | null };
  assert.equal(page.limit, 500);
  assert.equal(page.bytes, 64 << 20);
  assert.equal(page.leafId, "a1");
  assert.throws(() => validateRouteInput("session.branchWindow", { session: "s.jsonl", leafId: "a1", limit: 10_000, bytes: 256 << 20 }));
});
