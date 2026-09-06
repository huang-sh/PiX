import { isDeepStrictEqual } from "node:util";
import type { GraphNode, RawSessionEntry, SessionProjection, SessionSnapshot } from "../shared/types.js";
import type { GraphFiles } from "./graph-files.js";

interface Source {
  projection: SessionProjection;
  entries: RawSessionEntry[];
  nodes: GraphNode[];
  error?: string;
}

/** Reuse the SDK's per-session projections; never re-project the merged graph. */
export class GraphSnapshotCache {
  readonly entriesById = new Map<string, RawSessionEntry>();
  private sources = new Map<string, Source>();
  private entries: RawSessionEntry[] = [];
  private nodes: GraphNode[] = [];
  private edges: SessionProjection["edges"] = [];
  private runningNodes = new WeakMap<GraphNode, GraphNode>();
  private viewCache?: { source: GraphNode[]; active: string; nodes: GraphNode[] };

  update(graph: GraphFiles, main: SessionSnapshot, branches: Map<string, { snapshot?: SessionSnapshot }>) {
    let changed = false;
    const snapshots = new Map<string, SessionSnapshot>([["main", main]]);
    for (const [id, worker] of branches) if (worker.snapshot && graph.records.has(id)) snapshots.set(id, worker.snapshot);
    for (const [id, old] of this.sources) if (!snapshots.has(id)) {
      for (const entry of old.entries) this.entriesById.delete(entry.id);
      this.sources.delete(id); changed = true;
    }
    for (const [id, snapshot] of snapshots) {
      const old = this.sources.get(id);
      if (old?.projection === snapshot.projection) continue;
      const record = id === "main" ? undefined : graph.records.get(id)!;
      let entries: RawSessionEntry[] = [], nodes: GraphNode[] = [], error: string | undefined;
      try {
        entries = record ? graph.delta(record, { header: {}, entries: snapshot.entries }, true) : snapshot.entries;
        const index = new Map(entries.map(entry => [entry.id, entry]));
        const previous = new Map(old?.nodes.map(node => [node.id, node]));
        const canonical = (entryId: string) => record ? graph.canonical(record, entryId) : entryId;
        nodes = snapshot.projection.nodes.filter(node => !record || !Object.hasOwn(record.inherited, node.userEntryId)).map(source => {
          const rawEntryIds = source.rawEntryIds.map(canonical).filter(entryId => index.has(entryId));
          const calls = new Set<string>(), results = new Set<string>();
          let hasAssistant = false;
          for (const entryId of rawEntryIds) {
            const message = index.get(entryId)?.message as { role?: string; toolCallId?: string; content?: Array<{ type?: string; id?: string }> } | undefined;
            if (message?.role === "assistant") {
              hasAssistant = true;
              if (Array.isArray(message.content)) for (const item of message.content) if (item.type === "toolCall" && item.id) calls.add(item.id);
            }
            if (message?.role === "toolResult" && message.toolCallId) results.add(message.toolCallId);
          }
          const node: GraphNode = { ...source, id: `turn:${canonical(source.userEntryId)}`, userEntryId: canonical(source.userEntryId),
            parentId: source.parentId ? `turn:${canonical(source.parentId.slice(5))}` : null,
            rawEntryIds, leafEntryId: rawEntryIds.at(-1) ?? canonical(source.userEntryId), branchId: id, running: false,
            forkable: hasAssistant && [...calls].every(call => results.has(call)) };
          const prior = previous.get(node.id);
          return prior && isDeepStrictEqual(prior, node) ? prior : node;
        });
      } catch (failure) {
        if (!record) throw failure;
        entries = []; nodes = []; error = String(failure);
      }
      for (const entry of old?.entries ?? []) this.entriesById.delete(entry.id);
      for (const entry of entries) this.entriesById.set(entry.id, entry);
      this.sources.set(id, { projection: snapshot.projection, entries, nodes, error });
      changed = true;
    }
    if (changed) {
      // Flatten references only when a source changes. Payloads and node objects
      // in every unaffected branch retain their identity for the wire diff.
      this.entries = [...this.sources.values()].flatMap(source => source.entries);
      this.nodes = [...this.sources.values()].flatMap(source => source.nodes);
      const edges = new Map(this.edges.map(edge => [edge.id, edge]));
      this.edges = this.nodes.filter(node => node.parentId).map(node => {
        const id = `${node.parentId}->${node.id}`;
        return edges.get(id) ?? { id, source: node.parentId!, target: node.id };
      });
    }
  }

  error(id: string) { return this.sources.get(id)?.error; }

  view(main: SessionSnapshot, active: Set<string>) {
    const key = [...active].sort().join(";");
    const nodes = this.viewCache?.source === this.nodes && this.viewCache.active === key ? this.viewCache.nodes : this.nodes.map(node => {
      if (!active.has(node.id)) return node;
      let running = this.runningNodes.get(node);
      if (!running) { running = { ...node, running: true, forkable: false }; this.runningNodes.set(node, running); }
      return running;
    });
    this.viewCache = { source: this.nodes, active: key, nodes };
    return { entries: this.entries, projection: { ...main.projection, nodes, edges: this.edges,
      activeNodeId: main.projection.activeBranchNodeIds.at(-1) ?? nodes.at(-1)?.id ?? null } };
  }
}
