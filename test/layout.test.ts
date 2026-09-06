import test from "node:test";
import assert from "node:assert/strict";
import { layoutGraph, reserveManualPositions } from "../src/renderer/graph-layout.js";
import type { SessionProjection } from "../src/shared/types.js";

test("manual obstacles keep their coordinates while automatic branches stay connected and clear", () => {
  const nodes = [{ id: "root", parentId: null as string | null, timestamp: "0", depth: 0 }];
  for (let i = 0; i < 5; i++) {
    nodes.push({ id: `branch${i}`, parentId: "root", timestamp: String(i), depth: 1 });
    nodes.push({ id: `leaf${i}`, parentId: `branch${i}`, timestamp: String(i), depth: 2 });
  }
  const manual = new Map([
    ["leaf1", { x: 800, y: 100 }],
    ["leaf3", { x: 790, y: 500 }],
  ]);
  const placed = layoutGraph({ nodes }).nodes;
  reserveManualPositions(placed, manual);
  for (const node of placed) {
    const pin = manual.get(node.id);
    if (pin) assert.deepEqual({ x: node.x, y: node.y }, pin);
    for (const other of placed) {
      if (node.id === other.id || (pin && manual.has(other.id))) continue;
      assert.ok(node.x + node.width + 28 <= other.x || other.x + other.width + 28 <= node.x
        || node.y + node.height + 28 <= other.y || other.y + other.height + 28 <= node.y,
      `${node.id} overlaps ${other.id}`);
    }
  }
  for (const i of [0, 2, 4]) {
    const parent = placed.find(node => node.id === `branch${i}`)!;
    const child = placed.find(node => node.id === `leaf${i}`)!;
    assert.equal(child.x - parent.x, 372);
    assert.equal(child.y, parent.y);
  }
});
test("graph is laid out left to right with separated siblings", () => {
  const p: SessionProjection = {
      nodes: [
        {
          id: "a",
          userEntryId: "a",
          parentId: null,
          title: "a",
          preview: "",
          timestamp: "1",
          rawEntryIds: ["a"],
          leafEntryId: "a",
          toolCallCount: 0,
          hasError: false,
          depth: 0,
        },
        {
          id: "b",
          userEntryId: "b",
          parentId: "a",
          title: "b",
          preview: "",
          timestamp: "2",
          rawEntryIds: ["b"],
          leafEntryId: "b",
          toolCallCount: 0,
          hasError: false,
          depth: 1,
        },
        {
          id: "c",
          userEntryId: "c",
          parentId: "a",
          title: "c",
          preview: "",
          timestamp: "3",
          rawEntryIds: ["c"],
          leafEntryId: "c",
          toolCallCount: 0,
          hasError: false,
          depth: 1,
        },
      ],
      edges: [
        { id: "ab", source: "a", target: "b" },
        { id: "ac", source: "a", target: "c" },
      ],
      activeBranchNodeIds: ["a", "b"],
      activeBranchEntryIds: ["a", "b"],
      messages: [],
      leafId: "b",
      activeNodeId: "b",
    },
    l = layoutGraph(p),
    r = l.nodes.find((x) => x.id === "a")!,
    children = l.nodes.filter((x) => x.parentId === "a");
  assert.ok(children.every((x) => x.x > r.x));
  assert.notEqual(children[0]?.y, children[1]?.y);
});
