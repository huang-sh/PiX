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

export type ManualPosition = {
  x: number;
  y: number;
  /** Carry the cards after this one along when it moves. */
  branch?: boolean;
  /** The layout moved this card to make room, so its ancestors keep following it. */
  yielded?: boolean;
};

/**
 * A manual card keeps the coordinates the user gave it. Only a card dropped with
 * the branch modifier drags the cards that follow it; otherwise the rest of its
 * branch stays where the layout put it. Only cards that appear in this render are
 * then slid out of a manual card's way: anything already on screen keeps the
 * position it has, so neither a drag nor a later rebuild re-arranges the graph
 * behind the user. The positions this hands back are the cards that made way, so
 * the caller can hold them there instead of letting the next rebuild drop them
 * back on top of the card they cleared.
 */
export function reserveManualPositions(nodes: LayoutBox[], manual: Map<string, ManualPosition>, fresh = new Set<string>()) {
  const moved = new Map<string, ManualPosition>();
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!manual.size) return moved;
  const offsets = new Map(nodes.filter(node => manual.has(node.id)).map(node => {
    const pin = manual.get(node.id)!;
    return [node.id, { x: pin.x - node.x, y: pin.y - node.y }];
  }));
  // A card is placed already when the user put it there, or when the nearest
  // manual ancestor above it is dragging its branch along. The renderer's tree
  // mixes projection and transient cards, so these upward walks stop on a repeat
  // instead of assuming every parent chain reaches a root.
  const fixed = new Set(manual.keys());
  for (const node of nodes) {
    const pin = manual.get(node.id);
    if (pin) { node.x = pin.x; node.y = pin.y; continue; }
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    const walked = new Set<string>();
    while (parent && !manual.has(parent.id) && !walked.has(parent.id)) {
      walked.add(parent.id);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    const offset = parent && manual.get(parent.id)?.branch ? offsets.get(parent.id) : undefined;
    if (!offset) continue;
    fixed.add(node.id);
    node.x += offset.x; node.y += offset.y;
  }
  const blocks = new Map<string, LayoutBox[]>();
  for (const node of nodes) {
    if (!fresh.has(node.id) || fixed.has(node.id)) continue;
    let root = node;
    const walked = new Set<string>();
    while (root.parentId && fresh.has(root.parentId) && !fixed.has(root.parentId) && !walked.has(root.parentId)) {
      walked.add(root.parentId);
      root = byId.get(root.parentId) ?? root;
    }
    const block = blocks.get(root.id) ?? [];
    block.push(node);
    blocks.set(root.id, block);
  }
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
    // The whole block moved together, so holding its root must hold its cards too.
    moved.set(rootId, { x: root.x, y: root.y, branch: true, yielded: true });
  }
  // A branch reads as one shape, so the parent of a card the layout moved aside takes
  // the centre of its children again. This runs on every render, for the cards that
  // still say they were moved aside: doing it only while sliding would let the parent
  // snap back on the next rebuild. Only a parent moves, only while it lands on
  // nothing, and never off a manual card.
  const yielded = new Set(moved.keys());
  for (const node of nodes) if (manual.get(node.id)?.yielded) yielded.add(node.id);
  for (const node of nodes) {
    if (!yielded.has(node.id)) continue;
    let cursor = node.parentId ? byId.get(node.parentId) : undefined;
    const walked = new Set<string>();
    while (cursor && !manual.has(cursor.id) && !walked.has(cursor.id)) {
      walked.add(cursor.id);
      const children = nodes.filter(child => child.parentId === cursor!.id);
      const rows = children.map(child => child.y + child.height / 2);
      const target = (Math.min(...rows) + Math.max(...rows)) / 2 - cursor.height / 2;
      const clear = !nodes.some(other => other !== cursor
        && other.y < target + cursor!.height && target < other.y + other.height
        && cursor!.x < other.x + other.width && other.x < cursor!.x + cursor!.width);
      if (!clear) break;
      cursor.y = target;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
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
