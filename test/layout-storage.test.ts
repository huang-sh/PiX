import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DEFAULT_LAYOUT, SettingsService } from "../src/main/services.js";
import { layoutGraph } from "../src/renderer/graph-layout.js";

test("branch layout order persists separately from session and branch contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "pix-layout-storage-"));
  try {
    const main = join(directory, "main.jsonl"), branch = join(directory, "branch.jsonl");
    const mainData = '{"id":"root","parentId":null,"message":{"role":"user","content":"root"}}\n';
    const branchData = '{"id":"child","parentId":"root","message":{"role":"user","content":"branch"}}\n';
    writeFileSync(main, mainData); writeFileSync(branch, branchData);
    const settings = new SettingsService(directory);
    settings.appPath = join(directory, "app-settings.json");
    settings.update("app", { theme: "dark" });
    const key = JSON.stringify(["project", main, "session"]);
    settings.saveLayout({ ...DEFAULT_LAYOUT, branchOrders: { [key]: [["pending:run", -1]] } });
    settings.saveLayout({ ...DEFAULT_LAYOUT, branchOrders: { [key]: [["turn:child", -1]] } });
    const reopened = new SettingsService(directory);
    reopened.appPath = settings.appPath;
    assert.deepEqual(reopened.layout().branchOrders, { [key]: [["turn:child", -1]] });
    assert.equal(JSON.parse(readFileSync(settings.appPath, "utf8")).theme, "dark");
    assert.equal(readFileSync(main, "utf8"), mainData);
    assert.equal(readFileSync(branch, "utf8"), branchData);

    const graph = { nodes: [
      { id: "root", parentId: null, timestamp: "0", depth: 0 },
      { id: "old", parentId: "root", timestamp: "1", depth: 1 },
      { id: "turn:child", parentId: "root", timestamp: "2", depth: 1 },
    ] };
    const before = structuredClone(graph);
    const placed = layoutGraph(graph, undefined, new Map(reopened.layout().branchOrders![key]));
    assert.ok(placed.nodes[2]!.y < placed.nodes[1]!.y);
    assert.deepEqual(graph, before, "layout must not mutate the source graph or parent relationships");
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "pix-layout-storage-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
