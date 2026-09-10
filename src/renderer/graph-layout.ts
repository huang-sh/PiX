import type { GraphNode } from "../shared/types.js";
export type BranchDirection = "up" | "down";
export interface PositionedNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}
type LayoutNode = Pick<GraphNode, "id" | "parentId" | "timestamp" | "depth">;
type LayoutBox = { id: string; parentId: string | null; x: number; y: number; width: number; height: number };

/**
 * A manual card keeps the coordinates the user gave it, and its own branch follows
 * it. Only cards that appear in this render are then slid out of a pin's way:
 * anything already on screen keeps the position it has, so neither a drag nor a
 * later rebuild re-arranges the graph behind the user. The positions this hands
 * back are the cards that made way, so the caller can hold them there instead of
 * letting the next rebuild drop them back on top of the pin.
 */
export function reserveManualPositions(nodes: LayoutBox[], manual: Map<string, { x: number; y: number }>, fresh = new Set<string>()) {
  const moved = new Map<string, { x: number; y: number }>();
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!manual.size) return moved;
  const offsets = new Map(nodes.filter(node => manual.has(node.id)).map(node => {
    const pin = manual.get(node.id)!;
    return [node.id, { x: pin.x - node.x, y: pin.y - node.y }];
  }));
  // Cards under a pin already sit where the user put them, directly or by following.
  const fixed = new Set(manual.keys());
  for (const node of nodes) {
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    while (parent) {
      if (manual.has(parent.id)) { fixed.add(node.id); break; }
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
  }
  for (const node of nodes) {
    const pin = manual.get(node.id);
    if (pin) { Object.assign(node, pin); continue; }
    // A continuation follows its nearest manually positioned ancestor.
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    while (parent && !manual.has(parent.id)) parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    const offset = parent ? offsets.get(parent.id) : undefined;
    if (offset) { node.x += offset.x; node.y += offset.y; }
  }
  const blocks = new Map<string, LayoutBox[]>();
  for (const node of nodes) {
    if (!fresh.has(node.id) || fixed.has(node.id)) continue;
    let root = node;
    while (root.parentId && fresh.has(root.parentId) && !fixed.has(root.parentId)) root = byId.get(root.parentId) ?? root;
    const block = blocks.get(root.id) ?? [];
    block.push(node);
    blocks.set(root.id, block);
  }
  if (!blocks.size) return moved;
  const bounds = (items: LayoutBox[]) => {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const node of items) {
      left = Math.min(left, node.x); top = Math.min(top, node.y);
      right = Math.max(right, node.x + node.width); bottom = Math.max(bottom, node.y + node.height);
    }
    return { left, top, right, bottom };
  };
  const hits = (a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) =>
    a.left < b.right + 28 && a.right + 28 > b.left && a.top < b.bottom + 28 && a.bottom + 28 > b.top;
  // ponytail: scan the cards that stay; use a spatial index if many pins make this costly.
  for (const [rootId, block] of blocks) {
    const moving = new Set(block.map(node => node.id));
    const staying = nodes.filter(node => !moving.has(node.id))
      .map(node => ({ left: node.x, top: node.y, right: node.x + node.width, bottom: node.y + node.height }));
    const box = bounds(block);
    if (!staying.some(other => hits(box, other))) continue;
    // Make room by moving the new branch to later lanes: the graph reads top to
    // bottom, so a card must not jump ahead of the cards laid out before it. The
    // nearest free lane may be past a run of them, not just the one hit first.
    const offset = staying.map(other => other.bottom - box.top + 28).filter(delta => delta > 0)
      .sort((a, b) => a - b)
      .find(candidate => !staying.some(other => hits({ ...box, top: box.top + candidate, bottom: box.bottom + candidate }, other)));
    if (offset === undefined) continue;
    for (const node of block) node.y += offset;
    const root = byId.get(rootId)!;
    moved.set(rootId, { x: root.x, y: root.y });
  }
  return moved;
}

export function layoutGraph<T extends LayoutNode>(p: { nodes: T[] }, sizes = new Map<string, { width: number; height: number }>(), order = new Map<string, number>(), columnExclusions = new Set<string>()) {
  const nw = 280,
    nh = 146,
    cg = 92,
    rg = 28,
    pad = 48,
    children = new Map<string | null, T[]>();
  const size = (node: T) => sizes.get(node.id) ?? { width: nw, height: nh };
  for (const n of p.nodes) {
    const a = children.get(n.parentId) ?? [];
    a.push(n);
    children.set(n.parentId, a);
  }
  for (const a of children.values())
    a.sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0) || x.timestamp.localeCompare(y.timestamp));
  let next = 0;
  const row = new Map<string, number>();
  const seen = new Set<string>();
  const place = (seeds: T[]) => {
    const stack = [...seeds].reverse().map((node) => ({ node, exit: false, height: size(node).height }));
    while (stack.length) {
      const { node, exit, height } = stack.pop()!;
      if (exit) {
        let min = Infinity, max = -Infinity;
        for (const child of children.get(node.id) ?? []) {
          const r = row.get(child.id);
          if (r !== undefined) { min = Math.min(min, r); max = Math.max(max, r); }
        }
        row.set(node.id, min === Infinity ? next + height / 2 : (min + max) / 2);
        if (min === Infinity) next += height + rg;
      } else if (!seen.has(node.id)) {
        seen.add(node.id);
        stack.push({ node, exit: true, height });
        for (const child of [...(children.get(node.id) ?? [])].reverse())
          stack.push({ node: child, exit: false, height: Math.max(height, size(child).height) });
      }
    }
  };
  place(children.get(null) ?? []);
  // A node whose parent is missing from these nodes is the root of a detached
  // component: lay its own subtree out as one, so its cards stay aligned to each
  // other instead of being stacked flat past every other branch.
  place(p.nodes.filter((node) => !seen.has(node.id)));
  const maxDepth = p.nodes.reduce((max, node) => Math.max(max, node.depth), 0);
  const widths = new Map<number, number>();
  // Transient cards (draft, pending) reserve vertical space but never widen
  // their column, so opening a draft cannot shift deeper cards sideways.
  for (const node of p.nodes)
    if (!columnExclusions.has(node.id))
      widths.set(node.depth, Math.max(widths.get(node.depth) ?? nw, size(node).width));
  const columns = [pad];
  for (let depth = 0; depth < maxDepth; depth++) columns.push(columns[depth]! + (widths.get(depth) ?? nw) + cg);
  const nodes = p.nodes.map((n) => ({
    ...n,
    x: columns[n.depth]!,
    y: pad + row.get(n.id)! - size(n).height / 2,
    ...size(n),
  }));
  return {
    nodes,
    width: columns[maxDepth]! + (widths.get(maxDepth) ?? nw) + pad,
    height: Math.max(400, pad * 2 + next - rg),
  };
}
