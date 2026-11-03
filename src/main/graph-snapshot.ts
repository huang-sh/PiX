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
  /** Every source's full history, keyed by entry id. The wire only carries a
   * bounded window, so lookups (search, windows, exports) must not read it. */
  readonly entriesById = new Map<string, RawSessionEntry>();
  /** Flattened history shared by search, windows and exports. Rebuilt only when
   * a source changes, so callers can key their own caches on its identity. */
  private history?: RawSessionEntry[];
  private sources = new Map<string, Source>();
  private nodes: GraphNode[] = [];
  private edges: SessionProjection["edges"] = [];
  private runningNodes = new WeakMap<GraphNode, GraphNode>();
  private forkOnlyNodes = new WeakMap<GraphNode, GraphNode>();
  private viewCache?: { source: GraphNode[]; active: string; continuable: string; nodes: GraphNode[] };

  update(graph: GraphFiles, main: SessionSnapshot, branches: Map<string, { snapshot?: SessionSnapshot }>,
    // Sources whose snapshots are already complete (tests, read-only graphs)
    // need no resolver; the live graph supplies the runtime's full history.
    fullEntries: (id: string) => RawSessionEntry[] =
      id => id === "main" ? main.entries : branches.get(id)?.snapshot?.entries ?? []) {
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
        const history = fullEntries(id);
        entries = record ? graph.delta(record, { header: {}, entries: history }, true) : history;
        const index = new Map(entries.map(entry => [entry.id, entry]));
        const previous = new Map(old?.nodes.map(node => [node.id, node]));
        const canonical = (entryId: string) => record ? graph.canonical(record, entryId) : entryId;
        nodes = snapshot.projection.nodes.filter(node => !record || !Object.hasOwn(record.inherited, node.userEntryId)).map(source => {
          const rawEntryIds = source.rawEntryIds.map(canonical).filter(entryId => index.has(entryId));
          // A crash can leave only a prompt or an unanswered tool call. The SDK
          // handles that history on the next prompt; only live runs block forks.
          const node: GraphNode = { ...source, id: `turn:${canonical(source.userEntryId)}`, userEntryId: canonical(source.userEntryId),
            parentId: source.parentId ? `turn:${canonical(source.parentId.slice(5))}` : null,
            rawEntryIds, leafEntryId: rawEntryIds.at(-1) ?? canonical(source.userEntryId), branchId: id, running: false,
            forkable: true };
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
      this.history = undefined;
      this.nodes = this.reattach([...this.sources.values()].flatMap(source => source.nodes));
      const edges = new Map(this.edges.map(edge => [edge.id, edge]));
      this.edges = this.nodes.filter(node => node.parentId).map(node => {
        const id = `${node.parentId}->${node.id}`;
        return edges.get(id) ?? { id, source: node.parentId!, target: node.id };
      });
    }
  }

  /**
   * A branch can be re-canonicalized or dropped independently of the branches
   * that forked from it, which leaves their first node pointing at a parent that
   * is no longer in this graph. Such a link draws no edge and leaves the layout
   * no structure to place the card by, so reattach it to the nearest ancestor
   * turn that survived.
   */
  private reattach(nodes: GraphNode[]) {
    const ids = new Set(nodes.map(node => node.id));
    const byUserEntry = new Map(nodes.map(node => [node.userEntryId, node.id]));
    const parent = new Map<string, string>();
    for (const node of nodes) {
      if (!node.parentId || ids.has(node.parentId)) continue;
      const walked = new Set<string>();
      let cursor = this.entriesById.get(node.userEntryId)?.parentId ?? undefined;
      while (cursor && !walked.has(cursor)) {
        walked.add(cursor);
        const entry = this.entriesById.get(cursor);
        if (!entry) break;
        const owner = entry.type === "message" && (entry.message as { role?: string })?.role === "user" ? byUserEntry.get(cursor) : undefined;
        if (owner) { parent.set(node.id, owner); break; }
        cursor = entry.parentId ?? undefined;
      }
    }
    return parent.size
      ? nodes.map(node => parent.has(node.id) ? { ...node, parentId: parent.get(node.id)! } : node)
      : nodes;
  }

  /** Every source's full history, in one array whose identity survives until a
   * source changes. */
  fullHistory() { return this.history ??= [...this.entriesById.values()]; }
  /** The last projection `view` produced; search keys its blob cache on this
   * identity, so an unchanged graph must keep returning the same object. */
  get projection() { return this.viewProjection; }
  private viewProjection?: SessionProjection;
  private viewProjectionParts?: { main: SessionProjection; nodes: GraphNode[]; edges: SessionProjection["edges"]; active: string; continuable: string; activeNodeId: string | null };
  error(id: string) { return this.sources.get(id)?.error; }

  /** The projection the renderer sees: `active` marks live turns (never
   * forkable, never continuable); nodes outside `continuable` are
   * explicit-fork-only. Both overlays keep node identity across views. */
  view(main: SessionSnapshot, active: Set<string>, continuable: Set<string>) {
    const key = [...active].sort().join(";");
    const tips = [...continuable].sort().join(";");
    const nodes = this.viewCache?.source === this.nodes && this.viewCache.active === key && this.viewCache.continuable === tips
      ? this.viewCache.nodes
      : this.nodes.map(node => {
        if (active.has(node.id)) {
          let running = this.runningNodes.get(node);
          if (!running) { running = { ...node, running: true, forkable: false, continuable: false }; this.runningNodes.set(node, running); }
          return running;
        }
        if (continuable.has(node.id)) return node;
        let forkOnly = this.forkOnlyNodes.get(node);
        if (!forkOnly) { forkOnly = { ...node, continuable: false }; this.forkOnlyNodes.set(node, forkOnly); }
        return forkOnly;
      });
    this.viewCache = { source: this.nodes, active: key, continuable: tips, nodes };
    // The merged entries stay in this.entriesById for search and window
    // fetches; the wire only carries the main line's bounded window, which
    // already arrived inside `main` from PiRuntime.snapshot.
    const activeNodeId = main.projection.activeBranchNodeIds.at(-1) ?? nodes.at(-1)?.id ?? null;
    const cached = this.viewProjection;
    const unchanged = cached && this.viewCache.source === this.viewProjectionParts?.nodes
      && this.viewProjectionParts?.active === key && this.viewProjectionParts?.continuable === tips
      && this.viewProjectionParts?.main === main.projection && this.viewProjectionParts?.edges === this.edges
      && this.viewProjectionParts?.activeNodeId === activeNodeId;
    if (!unchanged) {
      this.viewProjection = { ...main.projection, nodes, edges: this.edges, activeNodeId };
      this.viewProjectionParts = { main: main.projection, nodes: this.nodes, edges: this.edges, active: key, continuable: tips, activeNodeId };
    }
    return { entries: main.entries, projection: this.viewProjection! };
  }
}
