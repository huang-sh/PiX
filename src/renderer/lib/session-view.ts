import type { RawSessionEntry, SessionProjection } from "../../shared/types.js";
import { projectSession, sessionEntryIndex } from "../../shared/session.js";

// Snapshots cross IPC as JSON-shaped data. Compare without serializing large
// tool results; retaining equal objects keeps background runs out of view work.
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key =>
    Object.hasOwn(b, key) && sameData((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export function reuseGraphProjection(previous: SessionProjection, next: SessionProjection) {
  const nodes = new Map(previous.nodes.map(node => [node.id, node]));
  next.nodes = next.nodes.map(node => {
    const old = nodes.get(node.id);
    return old && sameData(old, node) ? old : node;
  });
  if (next.nodes.length === previous.nodes.length && next.nodes.every((node, i) => node === previous.nodes[i]))
    next.nodes = previous.nodes;
  if (sameData(previous.edges, next.edges)) next.edges = previous.edges;
  if (sameData(previous.activeBranchNodeIds, next.activeBranchNodeIds)) next.activeBranchNodeIds = previous.activeBranchNodeIds;
}

export function createBranchMessageCache() {
  const cache = new Map<string, { entries: RawSessionEntry[]; result: { messages: SessionProjection["messages"]; hasEarlier: boolean } }>();
  return (entries: RawSessionEntry[], leaf: string | null, limit: number) => {
    const index = sessionEntryIndex(entries);
    const path: RawSessionEntry[] = [];
    const seen = new Set<string>();
    let entry = leaf ? index.get(leaf) : undefined;
    let turns = 0, cut = 0, hasEarlier = false;
    while (entry && !seen.has(entry.id)) {
      seen.add(entry.id);
      path.push(entry);
      if (entry.type === "message" && (entry.message as { role?: string })?.role === "user") {
        if (++turns > limit) { hasEarlier = true; break; }
        cut = path.length;
      }
      entry = entry.parentId ? index.get(entry.parentId) : undefined;
    }
    // Keep complete turns. In particular, never parse text in the older prefix
    // merely to decide whether the "load earlier" button should be visible.
    const window = (hasEarlier ? path.slice(0, cut) : path).reverse();
    const key = `${leaf}:${limit}`;
    const old = cache.get(key);
    const result = old && old.result.hasEarlier === hasEarlier && sameData(old.entries, window)
      ? old.result : { messages: projectSession(window, leaf).messages, hasEarlier };
    cache.delete(key);
    cache.set(key, { entries: window, result });
    // Bound view caching independently of the number of historical graph nodes.
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
    return result;
  };
}
