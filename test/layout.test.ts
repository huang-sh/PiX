import test from "node:test";
import assert from "node:assert/strict";
import { layoutGraph, reserveManualPositions } from "../src/renderer/graph-layout.js";
import type { SessionProjection } from "../src/shared/types.js";

test("manual cards hold their coordinates and leave the settled branches alone", () => {
  const nodes = [{ id: "root", parentId: null as string | null, timestamp: "0", depth: 0 }];
  for (let i = 0; i < 5; i++) {
    nodes.push({ id: `branch${i}`, parentId: "root", timestamp: String(i), depth: 1 });
    nodes.push({ id: `leaf${i}`, parentId: `branch${i}`, timestamp: String(i), depth: 2 });
  }
  const manual = new Map([
    ["leaf1", { x: 800, y: 100 }],
    ["leaf3", { x: 790, y: 500 }],
  ]);
  const settled = layoutGraph({ nodes }).nodes;
  const placed = layoutGraph({ nodes }).nodes;
  reserveManualPositions(placed, manual);
  for (const node of placed) {
    const pin = manual.get(node.id);
    const before = settled.find((item) => item.id === node.id)!;
    if (pin) assert.deepEqual({ x: node.x, y: node.y }, pin);
    else assert.deepEqual({ x: node.x, y: node.y }, { x: before.x, y: before.y },
      "a card that is already on screen keeps the position the layout gave it");
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
test("a node whose parent is missing keeps its own subtree aligned", () => {
  const tree = {
    nodes: [
      { id: "root", parentId: null as string | null, timestamp: "0", depth: 0 },
      { id: "kept", parentId: "root", timestamp: "1", depth: 1 },
      // "orphan" forked from a node that is not part of this graph.
      { id: "orphan", parentId: "turn:absent", timestamp: "2", depth: 1 },
      { id: "child", parentId: "orphan", timestamp: "3", depth: 2 },
      { id: "grandchild", parentId: "child", timestamp: "4", depth: 3 },
    ],
  };
  const placed = layoutGraph(tree).nodes;
  const at = (id: string) => placed.find((node) => node.id === id)!;
  assert.equal(at("child").x - at("orphan").x, at("kept").x - at("root").x, "columns stay on the depth grid");
  assert.equal(at("child").y, at("orphan").y, "a single child stays on its parent's row");
  assert.equal(at("grandchild").y, at("child").y);
  assert.notEqual(at("orphan").y, at("kept").y, "the detached component gets its own rows");
});

test("a card that appears later makes room for a pin", () => {
  const turn = (id: string, parentId: string | null, depth: number) => ({
    id, userEntryId: id, parentId, title: id, preview: "", timestamp: String(depth), rawEntryIds: [id],
    leafEntryId: id, toolCallCount: 0, hasError: false, depth,
  });
  const p: SessionProjection = {
    nodes: [turn("root", null, 0), turn("left", "root", 1)],
    edges: [],
    activeBranchNodeIds: ["root"],
    activeBranchEntryIds: ["root"],
    messages: [],
    leafId: "root",
    activeNodeId: "root",
  };
  const settled = layoutGraph(p).nodes;
  // The pin sits where the next child would land.
  const pin = { x: settled[1]!.x, y: settled[1]!.y + 174 };
  const tree = { nodes: [...p.nodes, turn("next", "root", 1)] };
  const placed = layoutGraph(tree).nodes;
  const moved = reserveManualPositions(placed, new Map([["left", pin]]), new Set(["next"]));
  const at = (id: string) => placed.find((node) => node.id === id)!;
  assert.equal(at("left").y, pin.y, "the pinned card keeps its coordinates");
  assert.ok(at("next").y + at("next").height + 28 <= pin.y || pin.y + at("left").height + 28 <= at("next").y,
    "the card that appeared clears the pin instead of sitting under it");
  assert.ok(at("next").y > settled.find((node) => node.id === "left")!.y,
    "making room moves it to a later lane, never ahead of the cards before it");
  assert.deepEqual([...moved], [["next", { x: at("next").x, y: at("next").y, branch: true }]],
    "the position it made room for is handed back, branch included, so the caller can hold it");
});

test("a manual card drags its branch only when it was dropped with the modifier", () => {
  const nodes = [
    { id: "root", parentId: null as string | null, timestamp: "0", depth: 0 },
    { id: "parent", parentId: "root", timestamp: "1", depth: 1 },
    { id: "child", parentId: "parent", timestamp: "2", depth: 2 },
  ];
  const settled = layoutGraph({ nodes }).nodes;
  const drag = (pin: { x: number; y: number; branch?: boolean }) => {
    const placed = layoutGraph({ nodes }).nodes;
    reserveManualPositions(placed, new Map([["parent", pin]]), new Set());
    return placed;
  };
  const at = (placed: ReturnType<typeof drag>, id: string) => placed.find((node) => node.id === id)!;
  const plain = drag({ x: 900, y: 700 });
  assert.deepEqual({ x: at(plain, "parent").x, y: at(plain, "parent").y }, { x: 900, y: 700 });
  assert.deepEqual({ x: at(plain, "child").x, y: at(plain, "child").y },
    { x: settled[2]!.x, y: settled[2]!.y }, "a plain drag leaves the cards after it where the layout put them");
  const carried = drag({ x: 900, y: 700, branch: true });
  assert.deepEqual(
    { x: at(carried, "child").x - settled[2]!.x, y: at(carried, "child").y - settled[2]!.y },
    { x: 900 - settled[1]!.x, y: 700 - settled[1]!.y },
    "the modifier carries them by the delta the card itself moved",
  );
});
