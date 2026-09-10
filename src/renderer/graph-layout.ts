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

// Move whole automatic branches around manual cards, keeping parent/child offsets.
export function reserveManualPositions(nodes: LayoutBox[], manual: Map<string, { x: number; y: number }>) {
  if (!manual.size) return;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const offsets = new Map(nodes.filter(node => manual.has(node.id)).map(node => {
    const pin = manual.get(node.id)!;
    return [node.id, { x: pin.x - node.x, y: pin.y - node.y }];
  }));
  const anchored = new Set<string>();
  for (const id of manual.keys()) {
    let node = byId.get(id);
    while (node && !anchored.has(node.id)) {
      anchored.add(node.id);
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
  }
  const membership = new Map<string, string>();
  const branches = new Map<string, LayoutBox[]>();
  for (const node of nodes) {
    let root = node;
    const path: string[] = [];
    while (!anchored.has(root.id) && !membership.has(root.id)) {
      path.push(root.id);
      const parent = root.parentId ? byId.get(root.parentId) : undefined;
      if (!parent || anchored.has(parent.id)) break;
      root = parent;
    }
    const id = membership.get(root.id) ?? root.id;
    for (const child of path) membership.set(child, id);
    const branch = branches.get(id) ?? [];
    branch.push(node);
    branches.set(id, branch);
  }
  const groups = [...branches].map(([id, branch]) => {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const node of branch) {
      left = Math.min(left, node.x); top = Math.min(top, node.y);
      right = Math.max(right, node.x + node.width); bottom = Math.max(bottom, node.y + node.height);
    }
    const order = (top + bottom) / 2;
    const pin = manual.get(id);
    if (pin) {
      right += pin.x - left; bottom += pin.y - top;
      left = pin.x; top = pin.y;
      Object.assign(branch[0]!, pin);
    } else {
      // Continuations inherit their nearest manually positioned ancestor's offset.
      let parent = byId.get(id)?.parentId;
      while (parent && !offsets.has(parent)) parent = byId.get(parent)?.parentId;
      const offset = parent ? offsets.get(parent) : undefined;
      if (offset) {
        for (const node of branch) { node.x += offset.x; node.y += offset.y; }
        left += offset.x; right += offset.x; top += offset.y; bottom += offset.y;
      }
    }
    return { branch, left, top, right, bottom, order, pinned: Boolean(pin) };
  });
  const occupied = groups.filter(group => group.pinned);
  if (!occupied.length) return;
  // Pack outward from fixed cards so nearby branches get the closest free space.
  const distance = (order: number) => occupied.reduce((best, group) => Math.min(best, Math.abs(order - group.order)), Infinity);
  const automatic = groups.filter(group => !group.pinned).map(group => ({ group, distance: distance(group.order) }))
    .sort((a, b) => a.distance - b.distance || a.group.order - b.group.order);
  // ponytail: scan branch boxes; use a spatial index if many manual pins make this costly.
  for (const { group } of automatic) {
    const blockers = occupied.filter(other => group.left < other.right + 28 && group.right + 28 > other.left)
      .map(other => ({ start: other.top - group.bottom - 28, end: other.bottom - group.top + 28, order: other.order }))
      .sort((a, b) => a.start - b.start);
    const collision = blockers.find(blocker => blocker.start < 0 && blocker.end > 0);
    if (collision) {
      let offset = 0;
      if (group.order <= collision.order) {
        for (const blocker of [...blockers].reverse())
          if (offset > blocker.start && offset < blocker.end) offset = blocker.start;
      } else {
        for (const blocker of blockers)
          if (offset > blocker.start && offset < blocker.end) offset = blocker.end;
      }
      for (const node of group.branch) node.y += offset;
      group.top += offset; group.bottom += offset;
    }
    occupied.push(group);
  }
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
