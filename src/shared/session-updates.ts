import type { DesktopEvent, SessionProjection, SessionSnapshot } from "./types.js";
import { agentEventDecoder, agentEventEncoder } from "./agent-updates.js";

interface ListPatch<T> {
  updated: T[];
  inserted: Array<{ index: number; value: T }>;
  removed: string[];
}
export interface SessionPatch {
  baseRevision: number;
  session: SessionSnapshot["session"];
  runtime: SessionSnapshot["runtime"];
  graph: NonNullable<SessionSnapshot["graph"]>;
  recoveredInputs?: { value: NonNullable<SessionSnapshot["graph"]>["recoveredInputs"] };
  entries?: ListPatch<SessionSnapshot["entries"][number]>;
  nodes?: ListPatch<SessionProjection["nodes"][number]>;
  edges?: ListPatch<SessionProjection["edges"][number]>;
  messages?: ListPatch<SessionProjection["messages"][number]>;
  projection: Partial<Omit<SessionProjection, "nodes" | "edges" | "messages">>;
}
export interface SessionUpdate {
  current?: SessionSnapshot;
  patch?: SessionPatch;
  resync?: boolean;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key)
    && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function diffList<T>(before: T[], after: T[], id: (value: T) => string): ListPatch<T> | undefined | null {
  if (before === after) return undefined;
  const old = new Map(before.map((value, index) => [id(value), { value, index }]));
  const patch: ListPatch<T> = { updated: [], inserted: [], removed: [] };
  let last = -1;
  for (const [index, value] of after.entries()) {
    const previous = old.get(id(value));
    if (!previous) patch.inserted.push({ index, value });
    else {
      // Reordering/rebasing is rare; send a complete checkpoint for it.
      if (previous.index <= last) return null;
      last = previous.index;
      if (!equal(previous.value, value)) patch.updated.push(value);
      old.delete(id(value));
    }
  }
  patch.removed = [...old.keys()];
  return patch.updated.length || patch.inserted.length || patch.removed.length ? patch : undefined;
}

function applyList<T>(before: T[], patch: ListPatch<T> | undefined, id: (value: T) => string): T[] {
  if (!patch) return before;
  const removed = new Set(patch.removed), updated = new Map(patch.updated.map(value => [id(value), value]));
  const result = before.filter(value => !removed.has(id(value))).map(value => updated.get(id(value)) ?? value);
  for (const { index, value } of patch.inserted) result.splice(index, 0, value);
  return result;
}

export function sessionPatch(before: SessionSnapshot, after: SessionSnapshot): SessionPatch | undefined {
  if (!before.graph || !after.graph || before.graph.id !== after.graph.id || before.graph.epoch !== after.graph.epoch
    || after.graph.revision <= before.graph.revision) return undefined;
  const entries = diffList(before.entries, after.entries, value => value.id);
  const nodes = diffList(before.projection.nodes, after.projection.nodes, value => value.id);
  const edges = diffList(before.projection.edges, after.projection.edges, value => value.id);
  const messages = diffList(before.projection.messages, after.projection.messages, value => value.entryId);
  if (entries === null || nodes === null || edges === null || messages === null) return undefined;
  const projection: SessionPatch["projection"] = {};
  for (const key of ["activeBranchNodeIds", "activeBranchEntryIds", "leafId", "activeNodeId"] as const)
    if (!equal(before.projection[key], after.projection[key])) Object.assign(projection, { [key]: after.projection[key] });
  return { baseRevision: before.graph.revision, session: after.session, runtime: after.runtime,
    graph: { ...after.graph, recoveredInputs: undefined },
    ...(!equal(before.graph.recoveredInputs, after.graph.recoveredInputs) ? { recoveredInputs: { value: after.graph.recoveredInputs } } : {}),
    entries, nodes, edges, messages, projection };
}

export function applySessionPatch(before: SessionSnapshot | undefined, patch: SessionPatch): SessionSnapshot | undefined {
  if (!before?.graph || before.graph.id !== patch.graph.id || before.graph.epoch !== patch.graph.epoch
    || before.graph.revision !== patch.baseRevision || patch.graph.revision <= patch.baseRevision) return undefined;
  return { session: patch.session, runtime: patch.runtime,
    graph: { ...patch.graph, recoveredInputs: patch.recoveredInputs ? patch.recoveredInputs.value : before.graph.recoveredInputs },
    entries: applyList(before.entries, patch.entries, value => value.id),
    projection: { ...before.projection, ...patch.projection,
      nodes: applyList(before.projection.nodes, patch.nodes, value => value.id),
      edges: applyList(before.projection.edges, patch.edges, value => value.id),
      messages: applyList(before.projection.messages, patch.messages, value => value.entryId) } };
}

/** One baseline per subscriber. Internal controller consumers can keep full snapshots. */
export function sessionEventEncoder() {
  let previous: SessionSnapshot | undefined;
  const encodeAgent = agentEventEncoder();
  return (event: DesktopEvent): DesktopEvent => {
    event = encodeAgent(event);
    if (event.type !== "sessions") return event;
    const payload = event.payload as SessionUpdate;
    const current = payload.current;
    const patch = current && previous && !payload.resync ? sessionPatch(previous, current) : undefined;
    previous = current;
    return patch ? { ...event, payload: { patch } satisfies SessionUpdate } : event;
  };
}

/** Wire baseline is independent of newer snapshots returned by concurrent RPCs. */
export function sessionEventDecoder(resync: () => Promise<unknown>) {
  let previous: SessionSnapshot | undefined, requesting = false;
  const requestResync = () => {
    if (requesting) return;
    requesting = true;
    void resync().finally(() => { requesting = false; }).catch(() => {});
  };
  const decodeAgent = agentEventDecoder(requestResync);
  return (event: DesktopEvent): DesktopEvent | undefined => {
    if (event.type !== "sessions") return decodeAgent(event);
    decodeAgent(event);
    const payload = event.payload as SessionUpdate;
    if (!payload.patch) { previous = payload.current; return event; }
    const patch = payload.patch;
    if (previous?.graph?.id === patch.graph.id && previous.graph.epoch === patch.graph.epoch
      && previous.graph.revision >= patch.graph.revision) return undefined;
    const current = applySessionPatch(previous, patch);
    if (!current) {
      requestResync();
      return undefined;
    }
    previous = current;
    return { ...event, payload: { current } satisfies SessionUpdate };
  };
}
