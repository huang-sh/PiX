import type { FileNode } from "../../../shared/types";

export function filterFileTree(nodes: FileNode[], rawQuery: string): FileNode[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return nodes;
  return nodes.flatMap((node) => {
    if (node.name.toLowerCase().includes(query)) return [node];
    const children = node.children ? filterFileTree(node.children, query) : [];
    return children.length ? [{ ...node, children }] : [];
  });
}
