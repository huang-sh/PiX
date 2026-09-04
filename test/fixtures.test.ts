import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSessionJsonl, projectSession } from "../src/shared/session.js";
const dir = resolve(process.cwd(), "test-workspace", ".pi", "sessions"),
  files = readdirSync(dir).filter((x: string) => x.endsWith(".jsonl"));
test("both required session IDs are installed", () => {
  assert.equal(files.length, 2);
  assert.ok(
    files.some((x: string) =>
      x.includes("01a05820-0a00-73a4-a6cb-ac4ee5223f4b"),
    ),
  );
  assert.ok(
    files.some((x: string) =>
      x.includes("01a05c3c-8181-7527-9509-ff9d5358c3a0"),
    ),
  );
});
for (const file of files)
  test(`parses and projects ${file}`, () => {
    const x = parseSessionJsonl(readFileSync(join(dir, file), "utf8"));
    assert.equal(x.header?.type, "session");
    assert.ok(x.entries.length > 0);
    assert.equal(new Set(x.entries.map((e) => e.id)).size, x.entries.length);
    const leaf = x.entries.at(-1)?.id ?? null,
      p = projectSession(x.entries, leaf);
    assert.ok(p.nodes.length > 0);
    assert.equal(p.activeBranchEntryIds.at(-1), leaf);
    for (const edge of p.edges) {
      assert.ok(p.nodes.some((n) => n.id === edge.source));
      assert.ok(p.nodes.some((n) => n.id === edge.target));
    }
  });
