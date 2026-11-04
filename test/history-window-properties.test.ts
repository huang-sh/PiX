import assert from "node:assert/strict";
import test from "node:test";
import type { BranchMessage, RawSessionEntry } from "../src/shared/types.js";
import { PROMPT_DISPLAY_CUSTOM_TYPE } from "../src/shared/types.js";
import { projectSession, windowEntries } from "../src/shared/session.js";
import { createBranchMessageCache } from "../src/renderer/lib/session-view.js";

test("seeded branch windows preserve displayed text and complete paged ancestry", () => {
  let samples = 0, pages = 0;
  const text = (list: BranchMessage[]) => list.map(({ entryId, role, text }) => ({ entryId, role, text }));
  for (let seed = 1; seed <= 100; seed++) {
    let state = seed;
    const random = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
    const entries: RawSessionEntry[] = [], tips: string[] = [];
    const append = (value: { type: string; [key: string]: unknown }, parentId: string | null) => {
      const id = `e${entries.length}`;
      entries.push({ id, parentId, timestamp: new Date(entries.length * 1000).toISOString(), ...value });
      return id;
    };
    for (let turn = 0; turn < 100; turn++) {
      let parent = tips.length && random(5) ? tips.at(-1)! : tips[random(tips.length)] ?? null;
      if (!random(4)) parent = append({ type: "compaction", summary: `summary ${turn}`, firstKeptEntryId: entries[0]?.id ?? "root" }, parent);
      const display = !random(3);
      if (display) parent = append({ type: "custom", customType: PROMPT_DISPLAY_CUSTOM_TYPE, data: { text: `visible prompt ${turn}` } }, parent);
      parent = append({ type: "message", message: { role: "user", content: display ? `hidden instructions ${turn}` : `prompt ${turn}` } }, parent);
      parent = append({ type: "message", message: { role: "assistant", content: `answer ${turn} ` + "中文".repeat(random(250)) } }, parent);
      tips.push(parent);
    }
    for (let trial = 0; trial < 10; trial++) {
      const leaf = tips[random(tips.length)]!, limit = 1 + random(12), bytes = 200 + random(4000);
      const page = windowEntries(entries, leaf, limit, bytes), ids = new Set(page.entries.map(entry => entry.id));
      const expected = projectSession(entries, leaf).messages.filter(message => ids.has(message.entryId) && !message.compaction);
      const actual = createBranchMessageCache()(page.entries, leaf, limit).messages.filter(message => !message.compaction);
      assert.deepEqual(text(actual), text(expected), `seed ${seed}, leaf ${leaf}`);
      assert.ok(actual.filter(message => message.role === "user").length <= limit);
      const collected = new Map<string, RawSessionEntry>();
      let cursor: string | null = leaf;
      while (cursor) {
        const chunk = windowEntries(entries, cursor, 1 + random(12), bytes);
        pages++;
        const index = new Map(chunk.entries.map(entry => [entry.id, entry]));
        assert.ok(index.has(cursor));
        while (cursor && index.has(cursor)) {
          assert.ok(!collected.has(cursor));
          const entry: RawSessionEntry = index.get(cursor)!;
          collected.set(cursor, entry);
          cursor = entry.parentId;
        }
      }
      assert.deepEqual([...collected.keys()].reverse(), projectSession(entries, leaf).activeBranchEntryIds);
      samples++;
    }
  }
  assert.equal(samples, 1000);
  assert.ok(pages > samples);
});
