import type { GraphNode, SessionProjection } from "../shared/types.js";
export interface PositionedNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function layoutGraph(p: SessionProjection) {
  const nw = 280,
    nh = 146,
    cg = 92,
    rg = 28,
    pad = 48,
    children = new Map<string | null, GraphNode[]>();
  for (const n of p.nodes) {
    const a = children.get(n.parentId) ?? [];
    a.push(n);
    children.set(n.parentId, a);
  }
  for (const a of children.values())
    a.sort((x, y) => x.timestamp.localeCompare(y.timestamp));
  let next = 0;
  const row = new Map<string, number>();
  const assign = (n: GraphNode, seen = new Set<string>()): number => {
    if (seen.has(n.id)) return next++;
    seen.add(n.id);
    const c = children.get(n.id) ?? [];
    if (!c.length) {
      const r = next++;
      row.set(n.id, r);
      return r;
    }
    const rs = c.map((x) => assign(x, new Set(seen))),
      r = (Math.min(...rs) + Math.max(...rs)) / 2;
    row.set(n.id, r);
    return r;
  };
  const roots = children.get(null) ?? [];
  roots.forEach((n) => assign(n));
  p.nodes.forEach((n) => {
    if (!row.has(n.id)) row.set(n.id, next++);
  });
  const nodes: PositionedNode[] = p.nodes.map((n) => ({
    ...n,
    x: pad + n.depth * (nw + cg),
    y: pad + (row.get(n.id) ?? 0) * (nh + rg),
    width: nw,
    height: nh,
  }));
  return {
    nodes,
    width:
      pad * 2 +
      (Math.max(0, ...p.nodes.map((n) => n.depth)) + 1) * nw +
      Math.max(0, ...p.nodes.map((n) => n.depth)) * cg,
    height: Math.max(
      400,
      pad * 2 + Math.max(1, next) * nh + Math.max(0, next - 1) * rg,
    ),
  };
}
