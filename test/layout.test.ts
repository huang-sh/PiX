import test from "node:test";
import assert from "node:assert/strict";
import { layoutGraph } from "../src/renderer/graph-layout.js";
import type { SessionProjection } from "../src/shared/types.js";
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
