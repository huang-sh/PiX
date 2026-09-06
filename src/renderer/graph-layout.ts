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
  const roots = children.get(null) ?? [];
  const seen = new Set<string>();
  const stack = [...roots].reverse().map((node) => ({ node, exit: false }));
  while (stack.length) {
    const { node, exit } = stack.pop()!;
    if (exit) {
      let min = Infinity, max = -Infinity;
      for (const child of children.get(node.id) ?? []) {
        const r = row.get(child.id);
        if (r !== undefined) { min = Math.min(min, r); max = Math.max(max, r); }
      }
      row.set(node.id, min === Infinity ? next++ : (min + max) / 2);
    } else if (!seen.has(node.id)) {
      seen.add(node.id);
      stack.push({ node, exit: true });
      for (const child of [...(children.get(node.id) ?? [])].reverse()) stack.push({ node: child, exit: false });
    }
  }
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
  const maxDepth = p.nodes.reduce((max, node) => Math.max(max, node.depth), 0);
  return {
    nodes,
    width:
      pad * 2 +
      (maxDepth + 1) * nw +
      maxDepth * cg,
    height: Math.max(
      400,
      pad * 2 + Math.max(1, next) * nh + Math.max(0, next - 1) * rg,
    ),
  };
}
