import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson } from "../src/main/services.js";
import { UsageScanCache } from "../src/main/usage-scan-cache.js";
import type { UsageSessionInput } from "../src/shared/usage.js";

const home = mkdtempSync(join(tmpdir(), "pix-usage-cache-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const cachePath = join(home, "usage-scan-cache.json");

const session = (id: string): UsageSessionInput => ({
  id,
  path: `D:\\p\\${id}.jsonl`,
  created: "2026-09-23T10:00:00.000Z",
  modified: "2026-09-23T10:00:00.000Z",
  messageCount: 2,
  firstMessage: `prompt ${id}`,
  records: [
    {
      timestamp: "2026-09-23T10:00:01.000Z",
      model: "zai/glm-5.3",
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
    },
  ],
});

const withFile = (name: string) => {
  const path = join(home, name);
  writeFileSync(path, "{}");
  return { path, stat: statSync(path) };
};

test("scan cache validates by mtime and size, clones every hand-out, retags projects", () => {
  const cache = new UsageScanCache(cachePath);
  const { path, stat } = withFile("a.jsonl");
  cache.set(path, stat, session("a"));
  const first = cache.get(path, stat)!;
  // Mutating a handed-out record must never leak into the stored original.
  first.records[0]!.usage.cost = 99;
  first.records[0]!.source = "actual";
  const second = cache.get(path, stat)!;
  assert.equal(second.records[0]!.usage.cost, 0.1);
  assert.equal(second.records[0]!.source, undefined);
  // The project tag is scan metadata: applied per read, never stored.
  assert.equal(second.project, undefined);
  assert.equal(cache.get(path, stat, { id: "p1", name: "One", path: "D:\\one" })!.project!.name, "One");
  // A different mtime or size invalidates.
  const touched = { ...stat, mtimeMs: stat.mtimeMs + 1 };
  assert.equal(cache.get(path, touched), undefined);
  assert.equal(cache.get(path, { ...stat, size: stat.size + 1 }), undefined);
});

test("scan cache snapshots survive restarts and version bumps reset them", () => {
  const { path, stat } = withFile("b.jsonl");
  const writer = new UsageScanCache(cachePath);
  writer.set(path, stat, session("b"));
  writer.flush();
  // A fresh instance is a restart: the entry loads and validates.
  const reader = new UsageScanCache(cachePath);
  assert.equal(reader.get(path, stat)!.id, "b");
  // A foreign snapshot version is discarded wholesale.
  const snapshot = readJson(cachePath) as { version: number };
  snapshot.version = 999;
  writeFileSync(cachePath, JSON.stringify(snapshot));
  const afterBump = new UsageScanCache(cachePath);
  assert.equal(afterBump.get(path, stat), undefined);
});
