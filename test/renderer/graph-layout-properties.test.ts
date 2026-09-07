import { describe, expect, it } from "vitest";
import { layoutGraph } from "../../src/renderer/graph-layout";

const node = (id: string, parentId: string | null, depth: number, timestamp: string) => ({ id, parentId, depth, timestamp });

describe("real layoutGraph with measured sizes", () => {
  it("keeps tall inner nodes clear of same-column siblings", () => {
    const nodes = [node("root", null, 0, "0"), node("P", "root", 1, "1"), node("c", "P", 2, "2"), node("Q", "root", 1, "3")];
    const sizes = new Map<string, { width: number; height: number }>([
      ["root", { width: 280, height: 176 }], ["P", { width: 280, height: 300 }],
      ["c", { width: 280, height: 146 }], ["Q", { width: 280, height: 150 }],
    ]);
    const placed = layoutGraph({ nodes }, sizes).nodes;
    const P = placed.find(n => n.id === "P")!, Q = placed.find(n => n.id === "Q")!;
    expect(P.y + P.height <= Q.y || Q.y + Q.height <= P.y).toBe(true);
  });

  it("gives every branch a disjoint vertical band: 300 random trees × random measured heights", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let overlaps = 0, interleaves = 0, minMargin = Infinity;
    for (let trial = 0; trial < 300; trial++) {
      const nodes = [node("r", null, 0, "0")];
      let n = 1;
      const grow = (parentId: string, depth: number, budget: number) => {
        const kids = Math.floor(rnd() * 3) + (budget > 0 ? 1 : 0);
        for (let k = 0; k < kids && n < 40; k++) {
          const id = `n${n++}`;
          nodes.push(node(id, parentId, depth, String(nodes.length)));
          grow(id, depth + 1, budget - 1);
        }
      };
      grow("r", 1, 4);
      const sizes = new Map<string, { width: number; height: number }>(
        nodes.map(m => [m.id, { width: 280, height: 120 + Math.floor(rnd() * 200) }]));
      const placed = layoutGraph({ nodes }, sizes).nodes;
      for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!, b = placed[j]!;
        if (a.x !== b.x) continue;
        const margin = a.y < b.y ? b.y - (a.y + a.height) : a.y - (b.y + b.height);
        minMargin = Math.min(minMargin, margin);
        if (margin < 0) overlaps++;
      }
      const children = new Map<string | null, string[]>();
      for (const m of nodes) { const arr = children.get(m.parentId) ?? []; arr.push(m.id); children.set(m.parentId, arr); }
      const byId = new Map(placed.map(m => [m.id, m]));
      const sub = (id: string): string[] => [id, ...(children.get(id) ?? []).flatMap(sub)];
      const center = (id: string) => { const p = byId.get(id)!; return p.y + p.height / 2; };
      const sibs = children.get("r") ?? [];
      for (let i = 0; i < sibs.length; i++) for (let j = i + 1; j < sibs.length; j++) {
        const A = sub(sibs[i]!).map(center), B = sub(sibs[j]!).map(center);
        if (Math.min(...A) < Math.max(...B) && Math.min(...B) < Math.max(...A)) interleaves++;
      }
    }
    expect(overlaps, `same-column overlaps (minMargin=${minMargin}px)`).toBe(0);
    expect(interleaves, "sibling-subtree interleaves").toBe(0);
  });

  it("documents the lane-pitch inflation: a tall card widens the fork lanes below it", () => {
    // r → a(320 tall) → {b1, b2} (both 146): b1/b2 lanes get the inflated 320+28 pitch.
    const nodes = [node("r", null, 0, "0"), node("a", "r", 1, "1"), node("b1", "a", 2, "2"), node("b2", "a", 2, "3")];
    const sizes = new Map<string, { width: number; height: number }>([["a", { width: 280, height: 320 }]]);
    const placed = layoutGraph({ nodes }, sizes).nodes;
    const lane = (id: string) => { const p = placed.find(n => n.id === id)!; return p.y + p.height / 2; };
    expect(lane("b2") - lane("b1")).toBe(348);
  });

  it("excludes transient cards from column widths so drafts never shift deeper columns", () => {
    const nodes = [node("root", null, 0, "0"), node("a", "root", 1, "1"), node("c", "b", 2, "2"), node("d1", "c", 3, "3")];
    nodes.splice(2, 0, node("b", "root", 1, "1b"));
    const sizes = new Map<string, { width: number; height: number }>([["draft:turn:a", { width: 360, height: 280 }]]);
    const withDraft = [...nodes, node("draft:turn:a", "a", 2, "\uffff")];
    const without = layoutGraph({ nodes }, sizes).nodes;
    const withExclusion = layoutGraph({ nodes: withDraft }, sizes, new Map(), new Set(["draft:turn:a"])).nodes;
    const withoutExclusion = layoutGraph({ nodes: withDraft }, sizes).nodes;
    expect(withExclusion.find(n => n.id === "d1")!.x).toBe(without.find(n => n.id === "d1")!.x);
    expect(withoutExclusion.find(n => n.id === "d1")!.x).toBeGreaterThan(without.find(n => n.id === "d1")!.x);
  });
});
