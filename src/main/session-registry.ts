import type { ProjectInfo, SessionSnapshot } from "../shared/types.js";
import { projectId } from "../shared/types.js";
import { GraphRuntime } from "./graph-runtime.js";

/** One live session per file; opening an entry never closes another. */
export interface SessionEntry {
  /** Canonical session file path; also the registry key. */
  readonly path: string;
  /** The project the session was opened from; history is written here. */
  readonly project: ProjectInfo;
  /** That project's session directory, frozen at open time. */
  readonly dir: string | null;
  runtime?: GraphRuntime;
  /** Last read-only fallback snapshot, kept only while no runtime could open. */
  fallback?: SessionSnapshot;
  lastUsed: number;
}

export interface SessionRegistryHost {
  /** Builds the runtime for a new entry; the registry installs the event sink. */
  createRuntime(entry: SessionEntry): GraphRuntime;
  /** Every runtime event arrives here with the entry that emitted it. */
  onEvent(entry: SessionEntry, event: unknown): void;
}

/**
 * App-level coexistence of session runtimes. `open` switches the view, it never
 * aborts another entry's runs; only eviction (idle entries), disposal, or the
 * owning project's session directory changing will close a runtime.
 */
export class SessionRegistry {
  private settled = new Map<string, SessionEntry>();
  private pending = new Map<string, Promise<SessionEntry>>();
  private activePath = "";
  private readonly activeByProject = new Map<string, string>();

  constructor(private readonly host: SessionRegistryHost) {}

  entry(path: string): SessionEntry | undefined {
    return this.settled.get(path);
  }

  isActive(entry: SessionEntry): boolean {
    return this.activePath === entry.path;
  }

  activeOf(project: string): SessionEntry | undefined {
    const path = this.activeByProject.get(project);
    return path ? this.settled.get(path) : undefined;
  }

  /**
   * Points the view at a project: its remembered session becomes the one
   * active entry, and every other project's sessions go background.
   */
  viewProject(project: string): SessionEntry | undefined {
    const path = this.activeByProject.get(project);
    const entry = path ? this.settled.get(path) : undefined;
    this.activePath = entry?.path ?? "";
    return entry;
  }

  snapshotOf(entry: SessionEntry): SessionSnapshot | undefined {
    if (entry.runtime) {
      try { return entry.runtime.snapshot(); } catch { /* closed underneath us */ }
    }
    return entry.fallback;
  }

  async open(
    project: ProjectInfo,
    dir: string | null,
    path: string,
    fallback?: (error: unknown) => SessionSnapshot,
  ): Promise<SessionSnapshot> {
    const settled = this.settled.get(path);
    if (settled?.runtime) {
      settled.lastUsed = Date.now();
      this.setActive(settled);
      return settled.runtime.snapshot();
    }
    // A previous open left only a read-only fallback; the next open retries.
    if (settled) this.settled.delete(path);
    let opened = this.pending.get(path);
    if (!opened) {
      opened = this.launch(project, dir, path);
      this.pending.set(path, opened);
      void opened.catch(() => {}).finally(() => {
        if (this.pending.get(path) === opened) this.pending.delete(path);
      });
    }
    try {
      const entry = await opened;
      this.setActive(entry);
      void this.evict();
      return entry.runtime!.snapshot();
    } catch (error) {
      if (!fallback) throw error;
      if (!this.settled.has(path))
        this.settled.set(path, { path, project, dir, lastUsed: Date.now(), fallback: fallback(error) });
      const entry = this.settled.get(path)!;
      this.setActive(entry);
      return entry.fallback!;
    }
  }

  async create(project: ProjectInfo, dir: string | null, createFile: () => Promise<string>): Promise<SessionSnapshot> {
    return this.open(project, dir, await createFile());
  }

  /**
   * Re-reads the runtime before treating an entry as idle: a missed event must
   * never let eviction or deletion kill a live run.
   */
  busy(entry: SessionEntry): boolean {
    const runtime = entry.runtime;
    if (!runtime) return false;
    try {
      const state = runtime.state();
      if (state.isStreaming || state.isCompacting || state.isRetrying || state.pendingMessageCount) return true;
      return Boolean(runtime.snapshot().graph?.runs.some(run => run.status === "running"));
    } catch {
      return true;
    }
  }

  async dispose(path: string): Promise<void> {
    const entry = this.settled.get(path);
    if (entry) await this.disposeEntry(entry);
  }

  async disposeProject(project: string): Promise<void> {
    for (const entry of [...this.settled.values()])
      if (projectId(entry.project) === project) await this.disposeEntry(entry);
  }

  async disposeAll(): Promise<void> {
    for (const entry of [...this.settled.values()]) await this.disposeEntry(entry);
    this.activePath = "";
    this.activeByProject.clear();
  }

  private launch(project: ProjectInfo, dir: string | null, path: string): Promise<SessionEntry> {
    const entry: SessionEntry = { path, project, dir, lastUsed: Date.now() };
    const runtime = this.host.createRuntime(entry);
    runtime.emit = event => this.host.onEvent(entry, event);
    entry.runtime = runtime;
    return runtime.open(path).then(
      () => {
        this.settled.set(path, entry);
        return entry;
      },
      error => {
        entry.runtime = undefined;
        throw error;
      },
    );
  }

  private setActive(entry: SessionEntry) {
    this.activePath = entry.path;
    this.activeByProject.set(projectId(entry.project), entry.path);
  }

  private get maxIdle(): number {
    return Math.min(64, Math.max(1, Number.parseInt(process.env.PIX_MAX_LIVE_SESSIONS ?? "4", 10) || 4));
  }

  /** Idle-only LRU: running, in-flight, and the active entry are never evicted. */
  private async evict(): Promise<void> {
    const idle = [...this.settled.values()]
      .filter(entry => entry.path !== this.activePath && !this.busy(entry))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of idle.slice(0, Math.max(0, idle.length - this.maxIdle)))
      await this.disposeEntry(entry);
  }

  private async disposeEntry(entry: SessionEntry): Promise<void> {
    this.settled.delete(entry.path);
    if (this.activePath === entry.path) this.activePath = "";
    const remembered = this.activeByProject.get(projectId(entry.project));
    if (remembered === entry.path) this.activeByProject.delete(projectId(entry.project));
    const runtime = entry.runtime;
    entry.runtime = undefined;
    await runtime?.close();
  }
}
