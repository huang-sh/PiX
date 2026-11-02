import type { GraphFilter, GraphNode } from "./types.js";

export const GRAPH_FILTERS: GraphFilter[] = ["all", "labeled", "running", "errors"];

export function matchesGraphFilter(node: GraphNode, filter: GraphFilter): boolean {
  switch (filter) {
    case "labeled": return Boolean(node.label);
    case "running": return Boolean(node.running);
    case "errors": return node.hasError;
    default: return true;
  }
}

/** Keep ancestors as context so filtering never invents parent/child links. */
export function graphFilterIds(nodes: GraphNode[], filter: GraphFilter): Set<string> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const visible = new Set<string>();
  for (const node of nodes) if (matchesGraphFilter(node, filter)) {
    let cursor: GraphNode | undefined = node;
    while (cursor && !visible.has(cursor.id)) {
      visible.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }
  return visible;
}
