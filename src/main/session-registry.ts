import type { ProjectInfo, SessionSnapshot } from "../shared/types.js";
import { projectId } from "../shared/types.js";
import { GraphRuntime } from "./graph-runtime.js";
import { managedSessionFile } from "./services.js";

/** A cold open in flight; its project is kept so disposal can drain exactly the opens it races. */
interface PendingOpen {
  project: string;
  promise: Promise<SessionEntry>;
}

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
  private pending = new Map<string, PendingOpen>();
  private activePath = "";
  private selection = 0;
  private readonly activeByProject = new Map<string, string>();

  constructor(private readonly host: SessionRegistryHost) {}

  entry(path: string): SessionEntry | undefined {
    return this.settled.get(path);
  }

  /** Every settled entry, for maintenance passes that touch each runtime. */
  liveEntries(): SessionEntry[] {
    return [...this.settled.values()];
  }

  /**
   * Resolves a renderer-supplied path to a live entry by validating it against
   * the entry's own session directory, so background sessions stay reachable
   * while another project is in view.
   */
  resolve(raw: string): { entry: SessionEntry; path: string } | undefined {
    for (const entry of this.settled.values()) {
      try {
        const path = managedSessionFile(entry.dir, raw);
        if (path === entry.path) return { entry, path };
      } catch { /* belongs to another project's directory */ }
    }
    return undefined;
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
    ++this.selection;
    const path = this.activeByProject.get(project);
    const entry = path ? this.settled.get(path) : undefined;
    this.activePath = entry?.path ?? "";
    void this.evict();
    return entry;
  }

  snapshotOf(entry: SessionEntry): SessionSnapshot | undefined {
    if (entry.runtime) {
      try { return entry.runtime.snapshot(); } catch { /* closed underneath us */ }
    }
    return entry.fallback;
  }

  open(
    project: ProjectInfo,
    dir: string | null,
    path: string,
    fallback?: (error: unknown) => SessionSnapshot,
  ): Promise<SessionSnapshot> {
    return this.load(project, dir, path, ++this.selection, fallback);
  }

  private async load(project: ProjectInfo, dir: string | null, path: string, selection: number,
    fallback?: (error: unknown) => SessionSnapshot): Promise<SessionSnapshot> {
    const settled = this.settled.get(path);
    if (settled?.runtime) {
      try {
        const snapshot = settled.runtime.snapshot();
        settled.lastUsed = Date.now();
        if (selection === this.selection) this.setActive(settled);
        return snapshot;
      } catch {
        // The cached runtime died underneath us; reopen so the caller gets a
        // working session or the read-only fallback instead of the error.
        await this.disposeEntry(settled);
      }
    }
    // A previous open left only a read-only fallback; the next open retries.
    if (settled) this.settled.delete(path);
    let opening = this.pending.get(path);
    if (!opening) {
      const created: PendingOpen = { project: projectId(project), promise: this.launch(project, dir, path) };
      opening = created;
      this.pending.set(path, created);
      void created.promise.catch(() => {}).finally(() => {
        if (this.pending.get(path) === created) this.pending.delete(path);
      });
    }
    let entry: SessionEntry;
    try {
      entry = await opening.promise;
    } catch (error) {
      if (!fallback) throw error;
      if (!this.settled.has(path))
        this.settled.set(path, { path, project, dir, lastUsed: Date.now(), fallback: fallback(error) });
      const failed = this.settled.get(path)!;
      if (selection === this.selection) this.setActive(failed);
      // A concurrent open can win this path while ours is failing; serve its
      // snapshot instead of the missing fallback of a superseded entry.
      if (failed.runtime) return failed.runtime.snapshot();
      return failed.fallback!;
    }
    // Disposal may have raced this open (delete, project removal, session
    // directory change). Its runtime is already closed, and returning a
    // snapshot here would resurrect the entry in the view and the history.
    if (this.settled.get(path) !== entry) throw new Error("Session was closed while opening");
    if (selection === this.selection) this.setActive(entry);
    const snapshot = entry.runtime!.snapshot();
    void this.evict();
    return snapshot;
  }

  async create(project: ProjectInfo, dir: string | null, createFile: () => Promise<string>): Promise<SessionSnapshot> {
    const selection = ++this.selection;
    return this.load(project, dir, await createFile(), selection);
  }

  /**
   * Re-reads the runtime before treating an entry as idle: a missed event must
   * never let eviction or deletion kill a live run.
   */
  busy(entry: SessionEntry): boolean {
    try {
      return entry.runtime?.busy === true;
    } catch {
      return true;
    }
  }

  /** Canonical session paths that currently have work in flight. */
  runningPaths(): Set<string> {
    const paths = new Set<string>();
    for (const entry of this.settled.values())
      if (entry.runtime?.busy) paths.add(entry.path);
    return paths;
  }

  /** True when any of the project's entries has work in flight (re-read from the runtimes). */
  hasBusy(project: string): boolean {
    for (const entry of this.settled.values())
      if (projectId(entry.project) === project && this.busy(entry)) return true;
    return false;
  }

  /**
   * Re-binds an entry whose runtime moved to a new session file (deletion
   * recovery). The map key, the view markers, and the entry's path must all
   * follow the runtime, or the old row would keep serving the new session.
   */
  rekey(entry: SessionEntry, path: string) {
    const previous = entry.path;
    if (previous === path) return;
    this.settled.delete(previous);
    (entry as { path: string }).path = path;
    this.settled.set(path, entry);
    if (this.activePath === previous) this.activePath = path;
    const remembered = this.activeByProject.get(projectId(entry.project));
    if (remembered === previous) this.activeByProject.set(projectId(entry.project), path);
  }

  async dispose(path: string): Promise<void> {
    await this.drainPending(pendingPath => pendingPath === path);
    const entry = this.settled.get(path);
    if (entry) await this.disposeEntry(entry);
  }

  async disposeProject(project: string): Promise<void> {
    await this.drainPending((_path, pendingProject) => pendingProject === project);
    for (const entry of [...this.settled.values()])
      if (projectId(entry.project) === project) await this.disposeEntry(entry);
  }

  async disposeAll(): Promise<void> {
    await this.drainPending(() => true);
    for (const entry of [...this.settled.values()]) await this.disposeEntry(entry);
    this.activePath = "";
    this.activeByProject.clear();
  }

  /**
   * Waits for in-flight opens before disposing. A late open would otherwise
   * settle into `settled` after the disposal that raced it, leaving a runtime
   * that keeps writing the disposed project's history.
   */
  private async drainPending(match: (path: string, project: string) => boolean): Promise<void> {
    const opens = [...this.pending.entries()]
      .filter(([path, opening]) => match(path, opening.project))
      .map(([, opening]) => opening.promise);
    if (opens.length) await Promise.allSettled(opens);
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
        // A half-opened runtime may still hold workers or the graph ownership
        // file; close it best-effort so the failed open cannot leak them.
        void runtime.close().catch(() => {});
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
    for (const entry of idle.slice(0, Math.max(0, idle.length - this.maxIdle))) {
      // Closing an earlier victim takes time, and a project switch during that
      // window restores one of the entries still queued here.
      if (entry.path === this.activePath || this.busy(entry)) continue;
      await this.disposeEntry(entry);
    }
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
