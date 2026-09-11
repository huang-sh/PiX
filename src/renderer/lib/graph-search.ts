import { entrySearchText, sessionEntryIndex } from "../../shared/session";
import type { RawSessionEntry, SessionProjection } from "../../shared/types";

// Snapshots are immutable, so the per-node text blobs are built once per
// (projection, entries) pair; every keystroke afterwards is a substring scan.
const blobCache = new WeakMap<SessionProjection, { entries: RawSessionEntry[]; blobs: string[] }>();

export function graphNodeBlobs(projection: SessionProjection, entries: RawSessionEntry[]): string[] {
  const cached = blobCache.get(projection);
  if (cached && cached.entries === entries) return cached.blobs;
  const index = sessionEntryIndex(entries);
  const blobs = projection.nodes.map(node =>
    [node.title, ...node.rawEntryIds.flatMap(id => index.get(id) ?? []).map(entrySearchText)]
      .filter(Boolean)
      .join("\n"),
  );
  blobCache.set(projection, { entries, blobs });
  return blobs;
}

export function searchGraphNodeIds(
  projection: SessionProjection,
  entries: RawSessionEntry[],
  query: string,
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const blobs = graphNodeBlobs(projection, entries);
  return projection.nodes
    .filter((_, i) => blobs[i]!.toLowerCase().includes(needle))
    .map(node => node.id);
}
