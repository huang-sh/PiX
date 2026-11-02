import test from "node:test";
import assert from "node:assert/strict";
import { graphFilterIds, matchesGraphFilter } from "../src/shared/graph-filter.js";
import { projectSession } from "../src/shared/session.js";
import type { GraphNode, RawSessionEntry } from "../src/shared/types.js";

const nodes = [
  { id: "root", parentId: null },
  { id: "middle", parentId: "root" },
  { id: "marked", parentId: "middle", label: "测试通过" },
  { id: "busy", parentId: "root", running: true },
  { id: "failed", parentId: "root", hasError: true },
] as GraphNode[];

test("task filters retain ancestry and exclude unrelated branches", () => {
  assert.deepEqual([...graphFilterIds(nodes, "labeled")], ["marked", "middle", "root"]);
  assert.deepEqual([...graphFilterIds(nodes, "running")], ["busy", "root"]);
  assert.deepEqual([...graphFilterIds(nodes, "errors")], ["failed", "root"]);
  assert.equal(graphFilterIds(nodes, "all").size, 5);
  assert.equal(matchesGraphFilter(nodes[0]!, "labeled"), false);
  assert.equal(graphFilterIds([], "labeled").size, 0);
  assert.equal(graphFilterIds([{ ...nodes[0]!, parentId: "root", label: "cycle" }], "labeled").size, 1);
});

test("native Pi label changes project globally onto their target task, including removal", () => {
  const entries: RawSessionEntry[] = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-25", message: { role: "user", content: "first" } },
    { type: "message", id: "u2", parentId: "u1", timestamp: "2026-10-25", message: { role: "user", content: "second" } },
    { type: "label", id: "l1", parentId: "u2", timestamp: "2026-10-25", targetId: "u1", label: "登录完成" },
  ];
  assert.equal(projectSession(entries, "l1").nodes[0]!.label, "登录完成");
  assert.equal(projectSession(entries, "l1").nodes[1]!.label, undefined);
  entries.push({ type: "label", id: "l2", parentId: "l1", timestamp: "2026-10-25", targetId: "u1", label: "测试通过" });
  assert.equal(projectSession(entries, "l2").nodes[0]!.label, "测试通过");
  entries.push({ type: "label", id: "l3", parentId: "l2", timestamp: "2026-10-25", targetId: "u1" });
  assert.equal(projectSession(entries, "l3").nodes[0]!.label, undefined);
});
