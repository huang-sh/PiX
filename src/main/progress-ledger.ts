import type { DesktopEvent, SessionSnapshot } from "../shared/types.js";
import { agentProgressKey, isAgentProgress, pruneAgentProgress } from "../shared/agent-updates.js";

/** The session (graph id) a progress-baseline key is bucketed under. */
const keyGraphId = (key: string) => (JSON.parse(key) as unknown[])[0];

/** Live-session and view queries the baseline bookkeeping needs. */
export interface ProgressLedgerHost {
  /** Whether a graph id still has a live registry entry (a local session). */
  isLiveSession(id: string): boolean;
  /** The graph id of the session in view, if any. */
  viewedGraphId(): string | undefined;
}

/**
 * Progress baselines are keyed by graph id (= session path), so sessions
 * running in the background keep theirs across view switches; they are
 * replayed only when their session becomes the view again.
 */
export class ProgressLedger {
  private readonly progress = new Map<string, DesktopEvent>();
  /** Last-seen graph epoch per session; pruned to the live set in noteEpoch. */
  readonly epochs = new Map<string, string | undefined>();
  constructor(private readonly host: ProgressLedgerHost) {}

  /** The emit hook: records the event and applies the bookkeeping its type requires. */
  ingest(e: DesktopEvent) {
    this.record(e);
    if (e.type === "sessions") {
      this.noteEpoch((e.payload as { current?: SessionSnapshot }).current);
    } else if (e.type === "remote.connection" && !(e.payload as { connected: boolean }).connected) {
      // A dropped host's runs are dead; local sessions keep their baselines.
      this.forgetHostRuns();
    }
  }

  /** Records (or prunes) an event's baseline without publishing it. */
  record(e: DesktopEvent) {
    pruneAgentProgress(e, this.progress);
    if (isAgentProgress(e)) this.progress.set(agentProgressKey(e.payload as Record<string, unknown>), e);
  }

  /** A restarted session (new epoch) invalidates its own baselines, not other sessions'. */
  noteEpoch(current: SessionSnapshot | undefined) {
    const graph = current?.graph;
    if (!graph?.id) return;
    const known = this.epochs.get(graph.id);
    if (known !== undefined && known !== graph.epoch) {
      for (const key of [...this.progress.keys()])
        if (keyGraphId(key) === graph.id) this.progress.delete(key);
    }
    this.epochs.set(graph.id, graph.epoch);
    // A record can only invalidate baselines that still exist or could be
    // recorded again: a session that is neither live, mid-stream, nor in view
    // is inert, so its record goes and the map stays bounded by the live set
    // instead of every session ever opened.
    const tracked = new Set([...this.progress.keys()].map(keyGraphId));
    const viewed = this.host.viewedGraphId();
    for (const id of [...this.epochs.keys()])
      if (id !== graph.id && id !== viewed && !tracked.has(id) && !this.host.isLiveSession(id))
        this.epochs.delete(id);
  }

  /** The recorded baselines of one session, for replaying when it becomes the view again. */
  replay(graphId: string | undefined): DesktopEvent[] {
    if (!graphId) return [];
    return [...this.progress.values()]
      .filter((e) => (e.payload as { graphId?: string }).graphId === graphId);
  }

  private forgetHostRuns() {
    for (const key of [...this.progress.keys()]) {
      const graphId = keyGraphId(key);
      if (typeof graphId === "string" && !this.host.isLiveSession(graphId)) this.progress.delete(key);
    }
  }

  clear() {
    this.progress.clear();
  }
}
