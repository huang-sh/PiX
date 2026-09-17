import type { ProjectInfo, SessionSnapshot } from "../shared/types.js";
import { projectId } from "../shared/types.js";
import { GraphRuntime } from "./graph-runtime.js";
import { debugLog } from "./debug-log.js";
import { managedSessionFile } from "./services.js";

/** A cold open in flight; its project is kept so disposal can drain exactly the opens it races. */
interface PendingOpen {
  project: string;
  promise: Promise<SessionEntry>;
}

/** A new-session file may be created before its runtime can be registered. */
interface PendingCreate {
  project: string;
  cancelled: boolean;
  promise: Promise<SessionSnapshot>;
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
  private pendingCreates = new Set<PendingCreate>();
  private blockedPaths = new Set<string>();
  private blockedProjects = new Set<string>();
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
    void this.evict().catch(e => debugLog("session-registry: evict on restore", e));
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
    const owner = projectId(project);
    if (this.blockedPaths.has(path) || this.blockedProjects.has(owner))
      throw new Error("Session was closed while opening");
    let dead: SessionEntry | undefined;
    const settled = this.settled.get(path);
    if (settled?.runtime) {
      try {
        const snapshot = settled.runtime.snapshot();
        settled.lastUsed = Date.now();
        if (selection === this.selection) this.setActive(settled);
        return snapshot;
      } catch {
        // The cached runtime died underneath us; reopen so the caller gets a
        // working session or the read-only fallback instead of the error. The
        // disposal joins the pending open below, where a drain can wait for
        // it: kept before the registration, a racing disposal of this path or
        // project could finish unseen and the reopen would resurrect the
        // entry it just closed.
        dead = settled;
      }
    }
    // A previous open left only a read-only fallback; the next open retries.
    if (settled) this.settled.delete(path);
    let opening = this.pending.get(path);
    if (!opening) {
      const created: PendingOpen = { project: projectId(project), promise: this.launch(project, dir, path, dead) };
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
      // A disposal of this path or project raced the failed launch and is
      // still draining it; settling a read-only fallback — or serving a
      // concurrent winner's snapshot — would resurrect what it closes.
      if (this.blockedPaths.has(path) || this.blockedProjects.has(owner))
        throw new Error("Session was closed while opening");
      if (!this.settled.has(path))
        this.settled.set(path, { path, project, dir, lastUsed: Date.now(), fallback: fallback(error) });
      const failed = this.settled.get(path)!;
      if (selection === this.selection) this.setActive(failed);
      // A concurrent open can win this path while ours is failing; serve its
      // snapshot instead of the missing fallback of a superseded entry. Going
      // through snapshotOf keeps a winner whose runtime died underneath us on
      // the read-only degradation instead of surfacing its error.
      const snapshot = this.snapshotOf(failed);
      if (snapshot) return snapshot;
      failed.fallback ??= fallback(error);
      return failed.fallback!;
    }
    // Disposal may have raced this open (delete, project removal, session
    // directory change). Its runtime is already closed, and returning a
    // snapshot here would resurrect the entry in the view and the history.
    // The settled check catches the disposal that finished first; the block
    // check catches the one still draining this open — a disposer holds its
    // block until its destructive step is done, and a snapshot served inside
    // that window would reach the view before the disposer's own cleanup.
    if (this.settled.get(path) !== entry
      || this.blockedPaths.has(path) || this.blockedProjects.has(projectId(entry.project)))
      throw new Error("Session was closed while opening");
    if (selection === this.selection) this.setActive(entry);
    const snapshot = entry.runtime!.snapshot();
    void this.evict().catch(e => debugLog("session-registry: evict on open", e));
    return snapshot;
  }

  async create(project: ProjectInfo, dir: string | null, createFile: () => Promise<string>): Promise<SessionSnapshot> {
    const owner = projectId(project);
    if (this.blockedProjects.has(owner)) throw new Error("Project is being closed");
    const selection = ++this.selection;
    const pending = {
      project: owner,
      cancelled: false,
    } as PendingCreate;
    this.pendingCreates.add(pending);
    pending.promise = (async () => {
      const path = await createFile();
      if (pending.cancelled || this.blockedProjects.has(owner))
        throw new Error("Session creation was cancelled");
      const snapshot = await this.load(project, dir, path, selection);
      if (!pending.cancelled) return snapshot;
      const entry = this.settled.get(path);
      if (entry) await this.disposeEntry(entry);
      throw new Error("Session creation was cancelled");
    })();
    try {
      return await pending.promise;
    } finally {
      this.pendingCreates.delete(pending);
    }
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

  async dispose(path: string, after?: () => void | Promise<void>): Promise<void> {
    // Keep new opens out while the caller performs the destructive operation.
    // Otherwise a second open could create a runtime between close and unlink.
    this.blockedPaths.add(path);
    try {
      await this.drainPending(pendingPath => pendingPath === path);
      const entry = this.settled.get(path);
      if (entry) await this.disposeEntry(entry);
      await after?.();
    } finally {
      this.blockedPaths.delete(path);
    }
  }

  async disposeProject(project: string): Promise<void> {
    this.blockedProjects.add(project);
    for (const pending of this.pendingCreates)
      if (pending.project === project) pending.cancelled = true;
    try {
      await this.drainPending((_path, pendingProject) => pendingProject === project);
      for (const entry of [...this.settled.values()])
        if (projectId(entry.project) === project) await this.disposeEntry(entry);
    } finally {
      this.blockedProjects.delete(project);
    }
  }

  async disposeAll(): Promise<void> {
    for (const pending of this.pendingCreates) pending.cancelled = true;
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
    const creates = [...this.pendingCreates]
      .filter(pending => match("", pending.project))
      .map(pending => pending.promise);
    if (opens.length || creates.length)
      await Promise.allSettled([...opens, ...creates]);
  }

  private async launch(project: ProjectInfo, dir: string | null, path: string,
    dead?: SessionEntry): Promise<SessionEntry> {
    if (dead) await this.disposeEntry(dead);
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
