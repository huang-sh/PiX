import test from "node:test";
import assert from "node:assert/strict";
import { readRunTiming, runDurations, type RunTiming } from "../src/shared/run-timing.js";
import { projectSession } from "../src/shared/session.js";
import { NODE_FOOTER_CUSTOM_TYPE } from "../src/shared/types.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 27) + seconds * 1000).toISOString();

test("submission, compaction and execution clocks stay separate across multiple compactions", () => {
  const timing: RunTiming = { startedAt: at(0), agentStartedAt: at(140), compactions: [
    { status: "complete", startedAt: at(8), endedAt: at(140), durationMs: 132000 },
    { status: "complete", startedAt: at(160), endedAt: at(180), durationMs: 20000 },
    { status: "running", startedAt: at(190) },
  ] };
  assert.deepEqual(runDurations(timing, Date.parse(at(200))), {
    durationMs: 200000, compactionDurationMs: 162000, agentDurationMs: 30000,
  });
  // Finishing compaction resumes execution without resetting any clock.
  timing.compactions[2] = { status: "aborted", startedAt: at(190), endedAt: at(200), durationMs: 10000 };
  assert.deepEqual(runDurations(timing, Date.parse(at(210))), {
    durationMs: 210000, compactionDurationMs: 162000, agentDurationMs: 40000,
  });
  assert.deepEqual(runDurations({ startedAt: at(0), compactions: [{ status: "running", startedAt: at(8) }] }, Date.parse(at(140))), {
    durationMs: 140000, compactionDurationMs: 132000,
  });
});

test("persisted timing restores durations even though the SDK user entry was appended after compaction", () => {
  const timing: RunTiming = { startedAt: at(0), agentStartedAt: at(140), compactions: [
    { status: "complete", startedAt: at(8), endedAt: at(140), durationMs: 132000, entryTimestamp: at(140), tokensBefore: 275761, tokensAfter: 4000 },
  ] };
  const entries = [
    { type: "compaction", id: "compact", parentId: null, timestamp: at(140), summary: "Earlier history.", firstKeptEntryId: "user", tokensBefore: 275761 },
    { type: "message", id: "user", parentId: "compact", timestamp: at(140), message: { role: "user", content: "hello" } },
    { type: "message", id: "reply", parentId: "user", timestamp: at(146), message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
    { type: "custom", id: "footer", parentId: "reply", timestamp: at(146), customType: NODE_FOOTER_CUSTOM_TYPE, data: { timing } },
  ];
  const node = projectSession(entries, "footer").nodes[0]!;
  assert.equal(node.timestamp, at(140), "the native message time is preserved");
  assert.equal(node.metrics!.startedAt, at(0));
  assert.equal(node.metrics!.durationMs, 146000);
  assert.equal(node.metrics!.compactionDurationMs, 132000);
  assert.equal(node.metrics!.agentDurationMs, 6000);
  assert.deepEqual(node.metrics!.compactions, readRunTiming(timing)!.compactions);
  const legacy = projectSession(entries.map(entry => entry.id === "footer" ? { ...entry, data: {} } : entry), "footer").nodes[0]!;
  assert.equal(legacy.metrics!.durationMs, 6000);
  assert.equal(legacy.metrics!.compactions, undefined);
});

test("malformed timing does not invent history or carry nonfinite numbers", () => {
  assert.equal(readRunTiming({ startedAt: "bad" }), undefined);
  const result = readRunTiming({ startedAt: at(0), agentStartedAt: "bad", compactions: [
    null, { status: "unknown" }, { status: "complete", startedAt: "bad", durationMs: NaN, tokensBefore: -1 },
  ] })!;
  assert.equal(result.agentStartedAt, undefined);
  assert.equal(result.compactions.length, 1);
  assert.equal(result.compactions[0]!.durationMs, undefined);
  assert.equal(result.compactions[0]!.tokensBefore, undefined);
});
