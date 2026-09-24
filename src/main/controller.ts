import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, posix, resolve } from "node:path";
import { debugLog, logFile } from "./debug-log.js";
import type {
  AgentControl,
  DesktopEvent,
  DesktopRoute,
  LayoutState,
  ProjectGroup,
  ProjectInfo,
  SessionSnapshot,
  SessionSummary,
  SettingsBundle,
} from "../shared/types.js";
import { projectId } from "../shared/types.js";
import { validateRouteInput } from "../shared/contracts.js";
import { isProjectRoute, type ProjectRoute } from "../shared/remote-protocol.js";
import { canonicalPath } from "./paths.js";
import { isSessionRunning, parseSessionJsonl, projectSession } from "../shared/session.js";
import { sessionEventEncoder } from "../shared/session-updates.js";
import type { UsageRange } from "../shared/usage.js";
import { PiRuntime, MODEL_ACTIONS } from "./pi-runtime.js";
import { GraphRuntime } from "./graph-runtime.js";
import { ProgressLedger } from "./progress-ledger.js";
import { RemoteWorkspacePool, migratesSession, unavailable, type RemoteSlot } from "./remote-pool.js";
import { SessionRegistry, type SessionEntry } from "./session-registry.js";
import { LibraryService } from "./library.js";
import { readFileChange } from "./file-changes.js";
import { WslHostClient } from "./wsl-host-client.js";
import { sessionModifiedAt } from "./graph-files.js";
import { listSshHosts } from "./ssh-host-installer.js";
import {
  configuredSessionDir,
  GitService,
  historySessionDir,
  managedSessionFile,
  SessionFiles,
  SettingsService,
  ShellService,
  WorkspaceService,
} from "./services.js";
export interface Platform {
  pickProject(): Promise<string | undefined>;
  pickSession(): Promise<string | undefined>;
  confirm(message: string, detail?: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  /** Windows opens the system Open With dialog; macOS a native app picker. */
  openWith(path: string): Promise<void>;
  /** Linux lists .desktop applications registered for the file's MIME type. */
  openWithApps(path: string): Promise<{ id: string; name: string }[]>;
  /** Launches one of the openWithApps entries on Linux. */
  openWithApp(path: string, appId: string): Promise<void>;
  showItemInFolder(path: string): void;
  quit(): void;
}
/** Model actions whose catalog or credential change must reach open sessions. */
const CATALOG_MUTATIONS = ["addCustomModel", "updateCustomModel", "refreshModels", "loginApiKey", "loginOAuth", "logout"];
export class MainController {
  project: ProjectInfo | null;
  settings: SettingsService;
  library: LibraryService;
  workspace: WorkspaceService;
  git: GitService;
  shell: ShellService;
  files: SessionFiles;
  /** View-independent runtime: model catalog, skills, login — never opens a session. */
  projectRuntime: PiRuntime;
  /** Live session runtimes; opening a session switches the view, never closes another. */
  registry: SessionRegistry;
  current?: SessionSnapshot;
  platform: Platform;
  localProjectPath: string | null;
  /** Pooled remote workspaces: slots, connections, recycling, and routing. */
  pool: RemoteWorkspacePool;
  private viewRequest = 0;
  private gitSwitches = new Set<string>();
  private pendingAgentControls = new Map<string, number>();
  listeners = new Set<(e: DesktopEvent) => void>();
  /** Progress baselines of background runs, replayed when their session returns to view. */
  readonly progress = new ProgressLedger({
    isLiveSession: (id) => Boolean(this.registry.entry(id)),
    viewedGraphId: () => this.current?.graph?.id,
  });
  /** The client of the remote workspace in view, pooled or freshly connected. */
  get wsl(): WslHostClient | undefined {
    return this.pool.active()?.client;
  }
  get remoteBrokerModels(): Set<string> {
    const slot = this.pool.active();
    return (slot && this.pool.brokerModelsFor(slot.client)) ?? new Set<string>();
  }
  constructor(path: string | null, platform: Platform) {
    path = path ? resolve(path) : null;
    this.localProjectPath = path;
    this.project = path ? { name: basename(path), path } : null;
    this.platform = platform;
    this.settings = new SettingsService(path);
    this.library = new LibraryService();
    this.settings.applyInstallerLanguage();
    this.workspace = new WorkspaceService(path);
    this.git = new GitService(path);
    this.shell = new ShellService(path, (e) => this.emit(e as DesktopEvent));
    const dir = path
      ? configuredSessionDir(path, this.settings.bundle())
      : null;
    this.files = new SessionFiles(path, dir);
    this.projectRuntime = new PiRuntime(path, dir, (e) => this.emit(e as DesktopEvent), (url) => this.platform.openExternal(url));
    this.registry = new SessionRegistry({
      createRuntime: entry => this.createSessionRuntime(entry),
      onEvent: (entry, event) => this.routeSessionEvent(entry, event),
    });
    this.pool = new RemoteWorkspacePool({
      emit: e => this.emit(e),
      platform,
      projectRuntime: this.projectRuntime,
      settings: this.settings,
      projectGroups: () => this.projectGroups(),
      rememberProject: (sessions, project) => this.rememberProject(sessions, project),
      rememberSnapshot: (project, snapshot) => this.rememberSnapshot(project, snapshot),
      view: {
        nextRequest: () => ++this.viewRequest,
        request: () => this.viewRequest,
        isCurrent: request => request === this.viewRequest,
        project: () => this.project,
        current: () => this.current,
        setCurrent: snapshot => { this.current = snapshot; },
        // A committed workspace adopts the registry's own restore, like configure().
        enter: project => {
          this.project = project;
          return this.restoreCurrent();
        },
        // A reactivated pooled workspace restores through its host instead.
        enterEmpty: project => {
          this.project = project;
          this.registry.viewProject(projectId(project));
          this.current = undefined;
        },
      },
    });
  }
  /**
   * Registry entries build their own runtime with the entry's frozen project.
   * Broker state lives on the project runtime; cloning it here keeps sessions
   * created after a remote host connects streaming through the desktop broker.
   */
  createSessionRuntime(entry: SessionEntry): GraphRuntime {
    const runtime = new GraphRuntime(entry.project.path, entry.dir, () => {}, (url) => this.platform.openExternal(url));
    runtime.modelBroker = this.projectRuntime.modelBroker;
    runtime.brokerProviders = new Set(this.projectRuntime.brokerProviders);
    runtime.brokerModels = [...this.projectRuntime.brokerModels];
    return runtime;
  }
  private routeSessionEvent(entry: SessionEntry, e: unknown) {
    // A runtime that is no longer its entry's (closed underneath a disposal)
    // must not publish: its baselines would outlive the epoch record that
    // would have invalidated them on reopen.
    if (!entry.runtime) return;
    const pushed = e as DesktopEvent;
    if (pushed.type !== "agent") {
      if (pushed.type === "sessions") {
        const current = (pushed.payload as { current?: SessionSnapshot })?.current;
        if (current && !this.registry.isActive(entry)) {
          // A background session settled: refresh history and the list, never the view.
          this.progress.noteEpoch(current);
          this.scheduleBackgroundRefresh(entry);
          return;
        }
        if (current) this.current = current;
      }
      // A parked session's notices are dropped like a pooled host's — an
      // invisible workspace must not toast; its failed run settles onto the
      // row and the session's own error state instead.
      if (!this.registry.isActive(entry)) return;
      this.emit(pushed);
      return;
    }
    // Main-line events outside a scoped run still identify their session, so
    // progress baselines stay per-session across view switches.
    let p = pushed.payload as { type?: string; graphId?: string; branchId?: string };
    let routed = pushed;
    if (!p.graphId) {
      p = { ...p, graphId: entry.path };
      routed = { ...pushed, payload: p };
    }
    if (this.registry.isActive(entry)) this.emit(routed);
    else this.progress.record(routed);   // token streams of background runs are recorded for their return, never forwarded
    // GraphRuntime publishes child snapshots after updating its worker. Taking
    // one here would broadcast the old worker state, then the new state again.
    const childEvent = Boolean(p?.graphId && p.branchId && p.branchId !== "main");
    if (
      !childEvent &&
      entry.runtime &&
      [
        "message_end",
        "agent_settled",
        "entry_appended",
        "session_info_changed",
        "compaction_start",
        "compaction_end",
      ].includes(p?.type ?? "")
    ) {
      try {
        const snapshot = entry.runtime.snapshot();
        if (this.registry.isActive(entry)) {
          if (p.type !== "entry_appended" && snapshot.session.path)
            this.rememberSnapshot(entry.project, snapshot);
          this.current = snapshot;
          this.emit({ type: "sessions", payload: { current: snapshot } });
        } else {
          this.scheduleBackgroundRefresh(entry);
        }
      } catch (e) { debugLog("controller: live snapshot refresh", e); }
    }
  }
  private readonly backgroundRefresh = new Map<SessionEntry, NodeJS.Timeout>();
  /**
   * Coalesces background bookkeeping: one settings write and one list refresh
   * per burst, instead of one per appended entry in a tool-heavy run.
   */
  private scheduleBackgroundRefresh(entry: SessionEntry) {
    if (this.backgroundRefresh.has(entry)) return;
    const timer = setTimeout(() => {
      this.backgroundRefresh.delete(entry);
      // A disposed entry must not publish a refresh for a project that may have
      // just been removed from the list or moved to another session directory.
      if (this.registry.entry(entry.path) !== entry) return;
      const snapshot = this.registry.snapshotOf(entry);
      if (snapshot) this.rememberSnapshot(entry.project, snapshot);
      // Decorated project groups carry running markers and fresh rows for
      // every project, not just the one in view.
      try { this.emit({ type: "sessions", payload: { projects: this.projectGroups() } }); } catch (e) { debugLog("controller: project groups emit", e); }
    }, 500);
    timer.unref();
    this.backgroundRefresh.set(entry, timer);
  }
  /** Quitting must not lose the last background history write to the coalescing window. */
  private flushBackgroundRefresh() {
    for (const [entry, timer] of [...this.backgroundRefresh]) {
      clearTimeout(timer);
      this.backgroundRefresh.delete(entry);
      const snapshot = this.registry.snapshotOf(entry);
      if (snapshot) this.rememberSnapshot(entry.project, snapshot);
    }
  }
  /** The entry the view is showing in the active project, if any. */
  private activeEntry(): SessionEntry | undefined {
    return this.project ? this.registry.activeOf(projectId(this.project)) : undefined;
  }
  /** Keeps a background project's own history in step with what happened to one of its sessions. */
  private rememberOwnerProject(entry: SessionEntry, update: (sessions: SessionSummary[]) => SessionSummary[]) {
    if (!this.project || projectId(entry.project) === projectId(this.project)) return;
    const record = this.settings.projectHistory().find(item => item.id === projectId(entry.project));
    if (record) this.settings.rememberProject(entry.project, update(record.sessions));
  }
  /**
   * Resolves a session path to a live entry even when another project is in
   * view; unopened sessions still have to pass the active project's check.
   */
  private entryFor(raw: string): { entry: SessionEntry; path: string } | undefined {
    const resolved = this.registry.resolve(raw);
    if (resolved) return resolved;
    try {
      const path = this.files.managed(raw);
      const entry = this.registry.entry(path);
      return entry ? { entry, path } : undefined;
    } catch {
      return undefined;
    }
  }
  private async stopSession(path: string, owner?: string) {
    const entry = this.entryFor(path)?.entry;
    if (entry?.runtime && (!owner || projectId(entry.project) === owner)) {
      const runtime = entry.runtime;
      const runs = this.registry.snapshotOf(entry)?.graph?.runs.filter(run => run.status === "running") ?? [];
      // Aborts are best-effort per run: one refusal must not fail the stop
      // while the other runs' aborts are already in flight.
      await Promise.allSettled(runs.map(run => runtime.control({ action: "branchAbort", branchId: run.branchId, runId: run.runId })));
      this.scheduleBackgroundRefresh(entry);
      return { stopped: Boolean(runs.length) };
    }
    const slot = owner ? this.pool.slot(owner) : this.pool.active();
    if (slot) {
      if (!slot.client.connected) throw new Error("Remote host is not connected");
      slot.lastActivity = Date.now();
      // The desktop project id selects the host; the host resolves its own path.
      const result = await slot.client.request("session.stop", { path });
      const sessions = await slot.client.request<SessionSummary[]>("session.list");
      this.rememberProject(sessions, slot.project);
      this.emit({ type: "sessions", payload: { projects: this.projectGroups() } });
      return result;
    }
    if (owner && /^(?:ssh|wsl):/u.test(owner)) throw new Error("Remote host is not connected");
    return { stopped: false };
  }
  /** Routes a control action: model actions to the project runtime, everything else to the active session. */
  private async controlAgent(input: AgentControl): Promise<{ result: unknown; entry?: SessionEntry }> {
    if (input.action === "newSession") {
      const entry = this.activeEntry();
      // A failed node deletion recovers by reusing the old close-and-create
      // semantics on the same runtime; otherwise a new session is a new entry
      // and the previous one keeps running in the background.
      if (entry?.runtime?.recovering) {
        const result = await entry.runtime.control(input);
        this.followRuntimeFile(entry);
        return { result, entry };
      }
      if (!this.project) throw new Error("Open a project first");
      const project = this.project;
      const files = this.files;
      const result = await this.registry.create(
        project,
        files.dir,
        // Canonicalize through the session files service so junctioned and
        // symlinked projects key and look up the same entry.
        async () => files.managed(await this.projectRuntime.createSessionFile()),
      );
      return { result, entry: this.registry.entry((result as SessionSnapshot).session.path) };
    }
    if ((MODEL_ACTIONS as readonly string[]).includes(input.action)) {
      const result = await this.projectRuntime.control(input);
      // Every open session holds its own copy of the catalog, so a change has
      // to be pushed or the new model is invisible until the session reopens.
      if (input.action === "setBrokerProviders") await this.adoptProjectBroker();
      else if ((CATALOG_MUTATIONS as readonly string[]).includes(input.action)) await this.pushCatalogs(input);
      return { result };
    }
    const entry = this.activeEntry();
    if (!entry?.runtime) throw new Error("Open a session first");
    const result = await entry.runtime.control(input);
    // Fork and clone move this runtime to the new session file they created;
    // the entry's key must follow it or the old row would serve the new file.
    if (migratesSession(input.action)) this.followRuntimeFile(entry);
    return { result, entry };
  }
  /** Points every open session runtime at the project runtime's broker catalog. */
  private async adoptProjectBroker() {
    for (const entry of this.registry.liveEntries())
      await entry.runtime?.adoptBroker(this.projectRuntime);
  }
  /** Re-reads the project runtime's catalog change into every open session. */
  private async pushCatalogs(input: AgentControl) {
    for (const entry of this.registry.liveEntries())
      // Best-effort per session: one stale runtime must not fail the settings reply.
      try { await entry.runtime?.adoptCatalog(input); } catch (e) { debugLog("controller: adoptCatalog", e); }
  }
  /**
   * Re-binds an entry whose runtime moved to another session file (fork,
   * clone, deletion recovery). The key keeps the canonical realpath spelling
   * the registry compares; a miss falls back to the runtime's own spelling.
   */
  private followRuntimeFile(entry: SessionEntry) {
    let file = "";
    try { file = entry.runtime?.state().sessionFile ?? ""; } catch { /* closed underneath us */ }
    if (!file || file === entry.path) return;
    try { file = managedSessionFile(entry.dir, file); } catch { /* keep the runtime's spelling */ }
    this.registry.rekey(entry, file);
  }
  private restoreCurrent(): SessionSnapshot | undefined {
    const entry = this.registry.viewProject(this.project ? projectId(this.project) : "");
    return entry ? this.registry.snapshotOf(entry) : undefined;
  }
  onEvent(f: (e: DesktopEvent) => void, patches = false) {
    const encode = patches ? sessionEventEncoder() : undefined;
    const listener = encode ? (event: DesktopEvent) => f(encode(event)) : f;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(e: DesktopEvent) {
    this.progress.ingest(e);
    this.listeners.forEach((f) => f(e));
  }
  remoteEvent(event: DesktopEvent, project?: ProjectInfo | null) {
    this.pool.remoteEvent(event, project);
  }
  configure(path: string | null) {
    ++this.viewRequest;
    if (path) {
      path = resolve(path);
      if (!existsSync(path)) throw new Error("Project not found");
      this.localProjectPath = path;
      this.project = { name: basename(path), path };
      this.settings.setProject(path);
      this.settings.lastProject(path);
    } else {
      this.localProjectPath = null;
      this.project = null;
      this.settings.setProject(null);
    }
    this.workspace.setRoot(path);
    this.git.setRoot(path);
    this.shell.setRoot(path);
    const dir = path
      ? configuredSessionDir(path, this.settings.bundle())
      : null;
    this.files = new SessionFiles(path, dir);
    this.projectRuntime.setProject(path, dir);
    // Session entries survive project switches; the view restores whatever was
    // last active in the project being entered.
    this.current = this.restoreCurrent();
  }
  /** Test seam: subscribes a pre-existing connection as a pooled workspace. */
  installSlot(client: WslHostClient, project: ProjectInfo, settings: SettingsBundle): RemoteSlot {
    return this.pool.installSlot(client, project, settings);
  }
  /** Detaches the active remote workspace; pooled hosts of other projects keep serving them. */
  closeWsl() {
    return this.pool.closeWsl();
  }
  async connectWsl(distro: string, cwd: string, browse = false) {
    return this.pool.connectWsl(distro, cwd, browse);
  }
  async connectSsh(host: string, cwd: string, browse = false) {
    return this.pool.connectSsh(host, cwd, browse);
  }
  projectGroups(): ProjectGroup[] {
    const active = this.project ? projectId(this.project) : "";
    const marks = this.library.marks();
    const running = this.registry.runningPaths();
    const pinned = new Set(marks.pinned),
      archivedSessions = new Set(marks.archivedSessions),
      archivedProjects = new Set(marks.archivedProjects);
    return this.settings.projectHistory().map((record) => ({
      ...record,
      connected: record.project.remote
        ? Boolean(this.pool.slot(record.id)?.client.connected)
        : record.id === active,
      archived: archivedProjects.has(record.id) || undefined,
      // History snapshots embed whatever flags were current when remembered;
      // the library sidecar is the source of truth, so reapply it here.
      sessions: record.sessions.map((session) => ({
        ...session,
        pinned: pinned.has(session.path) || undefined,
        archived: archivedSessions.has(session.path) || undefined,
        running: (record.project.remote
          ? this.pool.slot(record.id)?.client.connected && session.running
          : running.has(session.path)) || undefined,
      })),
    }));
  }
  rememberProject(sessions: SessionSummary[], project: ProjectInfo | null = this.project) {
    if (!project) return this.projectGroups();
    this.settings.rememberProject(project, sessions);
    return this.projectGroups();
  }
  rememberSnapshot(project: ProjectInfo | null, snapshot: SessionSnapshot) {
    if (!project) return;
    const old = this.settings.projectHistory().find(
      (record) => record.id === projectId(project),
    )?.sessions ?? [];
    this.settings.rememberProject(project, [
      { ...snapshot.session, running: isSessionRunning(snapshot) || undefined },
      ...old.filter((session) => session.path !== snapshot.session.path),
    ]);
  }
  /**
   * Session directories behind the usage panel's all-projects scope: every
   * local project in the history, the project in view first. Remote projects
   * stay on their hosts, which answer the same route with their own scans.
   */
  private usageScans(bundle: SettingsBundle): Array<{ project: { id: string; name: string; path: string }; dir: string }> {
    const current = this.project && !this.project.remote ? this.project : null;
    const projects = [
      ...(current ? [current] : []),
      ...this.settings
        .projectHistory()
        .filter((record) => !record.project.remote && record.project.path !== current?.path)
        .map((record) => record.project),
    ];
    // Two history entries can resolve to one directory (case variants, or a
    // shared custom sessionDir); scanning it twice would double every number.
    // The project in view wins the attribution. Windows paths compare
    // case-insensitively: realpath keeps the caller's spelling.
    const seenDirs = new Set<string>();
    const dirKey = (dir: string) =>
      process.platform === "win32" ? canonicalPath(dir).toLowerCase() : canonicalPath(dir);
    return projects
      .map((project) => ({
        project: { id: projectId(project), name: project.name, path: project.path },
        dir: historySessionDir(project, bundle),
      }))
      .filter((scan) => {
        const key = dirKey(scan.dir);
        if (seenDirs.has(key) || !existsSync(scan.dir)) return false;
        seenDirs.add(key);
        return true;
      });
  }
  async sessions() {
    const files = this.files;
    const running = this.registry.runningPaths();
    const decorate = (list: SessionSummary[]) => {
      const marks = this.library.marks();
      const pinned = new Set(marks.pinned),
        archivedSessions = new Set(marks.archivedSessions);
      return list.map((x) => ({
        ...x,
        running: running.has(x.path) || undefined,
        pinned: pinned.has(x.path) || undefined,
        archived: archivedSessions.has(x.path) || undefined,
      }));
    };
    try {
      const s = await this.projectRuntime.list();
      return decorate(s.length ? s : files.list());
    } catch {
      return decorate(files.list());
    }
  }
  fallback(path: string, files = this.files): SessionSnapshot {
    const x = files.read(path),
      summary = files.list().find((s) => s.path === resolve(path)) ?? {
        id: String(x.header?.id ?? path),
        path: resolve(path),
        cwd: String(x.header?.cwd ?? files.cwd ?? path),
        created: String(x.header?.timestamp ?? new Date().toISOString()),
        modified: sessionModifiedAt(resolve(path), new Date().toISOString()),
        messageCount: x.entries.filter((e) => e.type === "message").length,
        firstMessage: "",
      },
      leaf = x.entries.at(-1)?.id ?? null;
    return {
      session: summary,
      entries: x.entries,
      projection: projectSession(x.entries, leaf),
      runtime: unavailable(),
    };
  }
  async invoke(route: DesktopRoute, raw?: unknown): Promise<unknown> {
    const v = validateRouteInput(route, raw);
    const request = ["session.open", "remote.disconnect", "wsl.disconnect"].includes(route) || (route === "agent.control" && v.action === "newSession")
      ? ++this.viewRequest : this.viewRequest;
    if (route === "app.revealSession") {
      const record = this.projectGroups().find((record) => record.id === v.id);
      const session = record?.sessions.find((session) => session.path === v.path);
      if (!record || !session) throw new Error("Session is not in the project history");
      const remote = record.project.remote;
      if (remote?.kind === "ssh") throw new Error("SSH sessions cannot be shown in the local file manager");
      let path = session.path;
      if (remote?.kind === "wsl") {
        if (process.platform !== "win32" || !remote.distro || /[\\/\x00]/.test(remote.distro) || !posix.isAbsolute(path) || /[\\\x00]/.test(path))
          throw new Error("Invalid WSL session path");
        path = `\\\\wsl.localhost\\${remote.distro}${posix.normalize(path).replaceAll("/", "\\")}`;
      } else {
        path = resolve(path);
      }
      this.platform.showItemInFolder(path);
      return;
    }
    if (route === "app.openPath") {
      // Local-side only: remote workspace files have no local filesystem path.
      if (this.project?.remote) throw new Error("Remote files cannot be opened with local applications");
      // safe() confines the path to the open project, so the renderer cannot
      // ask the OS to open arbitrary files outside the workspace.
      await this.platform.openPath(this.workspace.safe(String(v.path ?? "")));
      return;
    }
    if (route === "app.openWith") {
      if (this.project?.remote) throw new Error("Remote files cannot be opened with local applications");
      await this.platform.openWith(this.workspace.safe(String(v.path ?? "")));
      return;
    }
    if (route === "app.openWithApps") {
      if (this.project?.remote) throw new Error("Remote files cannot be opened with local applications");
      return this.platform.openWithApps(this.workspace.safe(String(v.path ?? "")));
    }
    if (route === "app.openWithApp") {
      if (this.project?.remote) throw new Error("Remote files cannot be opened with local applications");
      await this.platform.openWithApp(this.workspace.safe(String(v.path ?? "")), String(v.appId ?? ""));
      return;
    }
    if (route === "wsl.list") return WslHostClient.distributions();
    if (route === "wsl.names") return WslHostClient.names();
    if (route === "ssh.list") return listSshHosts();
    if (route === "remote.cancel") return this.pool.cancelRemote();
    if (route === "remote.directories") return this.pool.browseDirectories(v);
    if (route === "remote.deployed") return this.pool.deployedWorkspaces();
    if (route === "remote.revoke") return this.pool.revokeDeployedCredentials(String(v.id));
    if (route === "wsl.connect")
      return this.pool.connectWsl(String(v.distro), String(v.cwd), Boolean(v.browse));
    if (route === "ssh.connect")
      return this.pool.connectSsh(String(v.host), String(v.cwd), Boolean(v.browse));
    if (route === "remote.openProject")
      return this.pool.openRemoteProject(String(v.path));
    if (route === "app.openProject") {
      const record = this.settings.projectHistory().find(
        (item) => item.id === String(v.id),
      );
      if (!record || record.project.remote)
        throw new Error("Local project is not in the project history");
      // The remote workspace stays pooled; its host keeps serving it.
      this.configure(record.project.path);
      const selected = this.viewRequest;
      const sessions = await this.sessions();
      if (selected !== this.viewRequest) throw new Error("Project selection changed");
      return {
        project: this.project,
        sessions,
        projects: this.rememberProject(sessions),
        settings: this.settings.bundle(),
        layout: this.settings.layout(),
        current: this.current,
      };
    }
    if (route === "app.revealLogs") {
      const file = logFile();
      mkdirSync(dirname(file), { recursive: true });
      // Revealing the file itself points a bug report at what to send; before
      // the first failure there is only the empty folder to show.
      this.platform.showItemInFolder(existsSync(file) ? file : dirname(file));
      return;
    }
    if (route === "app.forgetProject") {
      const id = String(v.id);
      if (this.project && id === projectId(this.project))
        throw new Error("The open project cannot be removed from the list");
      const slot = this.pool.slot(id);
      if (slot && slot.client.connected && await this.pool.slotBusy(slot))
        throw new Error("Stop the running sessions before removing this project");
      if (this.registry.hasBusy(id))
        throw new Error("Stop the running sessions before removing this project");
      // Pooled hosts and live entries would write the forgotten project back
      // into the history through their events; they go with the entry.
      if (slot) await this.pool.dropSlot(slot, true);
      // Removing the project also gives up on any lingering host it left.
      this.pool.forgetHost(id);
      await this.registry.disposeProject(id);
      this.settings.forgetProject(id);
      return this.projectGroups();
    }
    if (route === "wsl.disconnect" || route === "remote.disconnect") {
      await this.pool.closeWsl();
      if (request !== this.viewRequest) throw new Error("Project selection changed");
      this.configure(this.localProjectPath);
      const selected = this.viewRequest;
      const sessions = await this.sessions();
      if (selected !== this.viewRequest) throw new Error("Project selection changed");
      return {
        project: this.project,
        sessions,
        projects: this.rememberProject(sessions),
        settings: this.settings.bundle(),
        layout: this.settings.layout(),
        current: this.current,
      };
    }
    if (this.wsl && route === "session.import")
      throw new Error("Importing sessions into a remote host is not available yet");
    if (route === "session.stop") return this.stopSession(String(v.path), v.projectId as string | undefined);
    if (this.wsl && isProjectRoute(route)) return this.pool.invokeWsl(route, v, request);
    if (
      !this.project &&
      [
        "session.list",
        "session.open",
        "session.import",
        "session.rename",
        "session.delete",
        "usage.overview",
        "workspace.tree",
        "workspace.read",
        "workspace.write",
        "git.status",
        "git.branches",
        "git.switch",
        "git.diff",
        "changes.read",
        "shell.run",
        "shell.abort",
        "terminal.create",
        "terminal.write",
        "terminal.resize",
        "terminal.kill",
      ].includes(route)
    )
      throw new Error("Open a project first");
    switch (route) {
      case "app.bootstrap": {
        if (this.wsl) return this.pool.wslBootstrap();
        const last = this.settings.bundle().app.lastProject;
        if (last && existsSync(last) && resolve(last) !== this.project?.path)
          this.configure(last);
        const selected = this.viewRequest;
        const sessions = this.project ? await this.sessions() : [];
        if (selected !== this.viewRequest) throw new Error("Project selection changed");
        return {
          project: this.project,
          sessions,
          projects: this.project
            ? this.rememberProject(sessions)
            : this.projectGroups(),
          settings: this.settings.bundle(),
          layout: this.settings.layout(),
          current: this.current,
        };
      }
      case "app.pickProject": {
        const p = await this.platform.pickProject();
        if (!p) return null;
        // The remote workspace stays pooled; its host keeps serving it.
        this.configure(p);
        const selected = this.viewRequest;
        const sessions = await this.sessions();
        if (selected !== this.viewRequest) throw new Error("Project selection changed");
        return {
          project: this.project,
          sessions,
          projects: this.rememberProject(sessions),
          settings: this.settings.bundle(),
          layout: this.settings.layout(),
        };
      }
      case "app.openExternal":
        await this.platform.openExternal(String(v.url));
        return { ok: true };
      case "app.quit":
        this.platform.quit();
        return { ok: true };
      case "session.list":
        return this.sessions().then((sessions) => {
          if (request === this.viewRequest) this.rememberProject(sessions);
          return sessions;
        });
      case "session.snapshot": {
        const entry = this.activeEntry();
        const current = entry?.runtime ? entry.runtime.snapshot() : this.current;
        if (current) {
          this.current = current;
          this.emit({ type: "sessions", payload: { current, resync: true } });
          // Replay only the session in view; other buckets wait for their turn.
          for (const progress of this.progress.replay(current.graph?.id)) this.emit(progress);
        }
        return current;
      }
      case "session.open": {
        const p = this.files.managed(String(v.path));
        const project = this.project!;
        const files = this.files;
        const snapshot = await this.registry.open(
          project,
          files.dir,
          p,
          error => {
            if (request === this.viewRequest) this.emit({
              type: "notice",
              payload: {
                level: "warning",
                message: `Read-only session: ${error instanceof Error ? error.message : String(error)}`,
              },
            });
            return this.fallback(p, files);
          },
        );
        // The registry refuses a snapshot for an entry it no longer owns, and a
        // concurrent delete or project removal can dispose this one between the
        // two steps; publishing then would resurrect what was just removed.
        if (!this.registry.entry(p)) throw new Error("Session was closed while opening");
        if (request === this.viewRequest && this.registry.isActive(this.registry.entry(p)!))
          this.current = snapshot;
        this.rememberSnapshot(project, snapshot);
        return snapshot;
      }
      case "session.import": {
        const p = await this.platform.pickSession();
        if (!p) return null;
        try {
          await this.projectRuntime.validate(p);
        } catch (e) { debugLog("controller: session import validation", e); }
        const imported = this.files.import(p);
        return { imported, sessions: await this.sessions() };
      }
      case "session.rename": {
        const raw = String(v.path), name = String(v.name);
        const resolved = this.entryFor(raw);
        let renamed: SessionSnapshot | undefined;
        if (resolved?.entry.runtime) {
          // Renames go through the owning runtime; a static append would race
          // the background session's own writes.
          renamed = await resolved.entry.runtime.control({ action: "setName", name }) as SessionSnapshot;
          if (this.registry.isActive(resolved.entry)) this.current = renamed;
        }
        else {
          // Unopened or read-only sessions append the rename on disk; the
          // path is either entry-validated or checked against the project in view.
          const p = resolved?.path ?? this.files.managed(raw);
          try {
            await this.projectRuntime.rename(p, name);
          } catch {
            this.files.renameAt(p, name);
          }
        }
        if (resolved)
          this.rememberOwnerProject(resolved.entry, sessions => sessions.map(session =>
            session.path === resolved.path || session.path === raw
              ? renamed?.session ?? { ...session, name } : session));
        const sessions = await this.sessions();
        this.rememberProject(sessions);
        return { sessions, current: this.current };
      }
      case "session.delete": {
        const resolved = this.entryFor(String(v.path));
        const p = resolved?.path ?? this.files.managed(String(v.path));
        if (
          v.confirmed !== true &&
          this.settings.bundle().app.confirmDestructiveActions &&
          !(await this.platform.confirm("Delete this Pi session?", p))
        )
          return { cancelled: true, sessions: await this.sessions() };
        if (resolved?.entry && this.registry.busy(resolved.entry))
          throw new Error("Stop the running session before deleting it");
        if (v.pristineOnly === true) {
          // Undo of "create session" must never destroy a file that grew
          // content behind the journal's back: only a message-free file may
          // be unlinked, and anything unreadable counts as grown.
          let pristine = false;
          try {
            pristine = !parseSessionJsonl(readFileSync(p, "utf8")).entries.some(e => e.type === "message");
          } catch {}
          if (!pristine) return { skipped: true, sessions: await this.sessions() };
        }
        // Disposal drains an open still in flight for this file — its late
        // settlement would otherwise resurrect the deleted session — and the
        // unlink runs inside the blocked window so no new open can build a
        // runtime between the close and the missing file.
        await this.registry.dispose(p, () => this.files.deleteAt(p));
        // A racing open can have settled the view during the drain; capture
        // the viewed path only now so that view still clears.
        const currentPath = this.current?.session.path;
        const deletingCurrent = Boolean(currentPath && canonicalPath(currentPath) === p);
        if (resolved)
          this.rememberOwnerProject(resolved.entry, sessions => sessions.filter(
            session => session.path !== p && session.path !== String(v.path),
          ));
        if (deletingCurrent) this.current = undefined;
        const sessions = await this.sessions();
        this.rememberProject(sessions);
        this.emit({ type: "sessions", payload: { deletedPath: deletingCurrent ? currentPath : String(v.path), sessions } });
        return { sessions };
      }
      case "usage.overview": {
        const bundle = this.settings.bundle();
        const scans =
          v.scope === "all"
            ? this.usageScans(bundle)
            : this.project && !this.project.remote && this.files.dir
              ? [{
                  project: {
                    id: projectId(this.project),
                    name: this.project.name,
                    path: this.project.path,
                  },
                  dir: this.files.dir,
                }]
              : undefined;
        return this.projectRuntime.usageOverview(
          v.range as UsageRange,
          bundle.app.usage?.unbilledProviders ?? [],
          scans,
        );
      }
      case "library.pin":
      case "library.archiveSession":
      case "library.archiveProject": {
        if (route === "library.pin") this.library.setSessionPinned(String(v.path), v.pinned === true);
        else if (route === "library.archiveSession") this.library.setSessionArchived(String(v.path), v.archived === true);
        else this.library.setProjectArchived(String(v.id), v.archived === true);
        return {
          // Only a locally open project has a live list here; a remote workspace
          // keeps the list the renderer already holds, and every mark still rides
          // back on the decorated project groups.
          sessions: this.project && !this.project.remote ? await this.sessions() : undefined,
          projects: this.projectGroups(),
        };
      }
      case "agent.control": {
        const owner = this.project ? projectId(this.project) : "";
        const startsWork = ["prompt", "promptAt", "steer", "followUp", "bash", "compact"].includes(String(v.action));
        if (startsWork && this.gitSwitches.has(owner)) throw new Error("Wait for the Git branch switch to finish");
        if (startsWork) this.pendingAgentControls.set(owner, (this.pendingAgentControls.get(owner) ?? 0) + 1);
        try {
          const { result: r, entry } = await this.controlAgent(v as unknown as AgentControl);
          if (request === this.viewRequest && r && typeof r === "object" && "projection" in r && entry && this.registry.isActive(entry)) {
            this.current = r as SessionSnapshot;
            // Mutating actions append entries after the last agent event (e.g.
            // the node-footer usage record written when a prompt settles), and
            // the invoke reply only reaches the page that started the action —
            // a page reloaded mid-run loses it. Broadcast so every attached
            // renderer converges on the settled state. A background run's reply
            // carries its own snapshot and never drives the view.
            this.emit({ type: "sessions", payload: { current: this.current } });
          }
          return r;
        } finally {
          if (startsWork) {
            const remaining = this.pendingAgentControls.get(owner)! - 1;
            if (remaining) this.pendingAgentControls.set(owner, remaining);
            else this.pendingAgentControls.delete(owner);
          }
        }
      }
      case "workspace.tree":
        return this.workspace.tree(String(v.path ?? ""));
      case "workspace.directories":
        return this.workspace.directories(String(v.path));
      case "workspace.open": {
        const path = this.workspace.directories(String(v.path)).path;
        this.configure(path);
        return { path };
      }
      case "workspace.read":
        return this.workspace.read(String(v.path));
      case "workspace.write":
        return this.workspace.write(String(v.path), String(v.content));
      case "git.status":
        return this.git.status();
      case "git.branches":
        return this.git.branches();
      case "git.switch": {
        const project = this.project!;
        if (v.cwd !== project.path) throw new Error("Project changed; choose the Git branch again");
        const owner = projectId(project);
        if (this.gitSwitches.has(owner)) throw new Error("Wait for the Git branch switch to finish");
        if (this.registry.hasBusy(owner) || this.pendingAgentControls.has(owner))
          throw new Error("Stop running tasks in this project before switching Git branches");
        this.gitSwitches.add(owner);
        try {
          return await new GitService(project.path).switchBranch(String(v.branch));
        } finally { this.gitSwitches.delete(owner); }
      }
      case "git.diff":
        return this.git.diff(v.path as string | undefined, Boolean(v.staged));
      case "changes.read": {
        const runtime = this.activeEntry()?.runtime;
        if (!runtime) throw new Error("No Pi session open");
        const snapshot = runtime.snapshot();
        if (snapshot.session.path !== v.session) throw new Error("Session changed; reopen the file change");
        return readFileChange(snapshot.session.path, snapshot.entries, String(v.ref));
      }
      case "shell.run": {
        const command = String(v.command);
        const trust =
          this.settings.bundle().effective.defaultProjectTrust ?? "ask";
        if (trust === "never") throw new Error("Shell is disabled for this project");
        if (
          trust !== "always" &&
          !(await this.platform.confirm("Run this command?", command))
        )
          return {
            id: "",
            command,
            output: "",
            exitCode: null,
            cancelled: true,
            truncated: false,
          };
        return this.shell.run(command);
      }
      case "shell.abort":
        return { aborted: this.shell.abort(String(v.id)) };
      case "terminal.create": {
        const trust =
          this.settings.bundle().effective.defaultProjectTrust ?? "ask";
        if (trust === "never")
          throw new Error("Terminal is disabled for this project");
        return this.shell.create(Number(v.cols), Number(v.rows));
      }
      case "terminal.write":
        this.shell.writeTerminal(String(v.id), String(v.data));
        return { ok: true };
      case "terminal.resize":
        this.shell.resizeTerminal(String(v.id), Number(v.cols), Number(v.rows));
        return { ok: true };
      case "terminal.kill":
        return { killed: this.shell.killTerminal(String(v.id)) };
      case "settings.get":
        return this.settings.bundle();
      case "settings.update": {
        const previousDir = this.project
          ? configuredSessionDir(this.project.path, this.settings.bundle())
          : null;
        const b =
          v.scope === "app"
            ? this.settings.update(v.patch as Record<string, unknown>)
            : await this.settings.updatePi(
                v.scope as "global" | "project",
                v.patch as Record<string, unknown>,
              );
        if (v.scope === "project" && this.project) {
          const project = this.project;
          const d = configuredSessionDir(project.path, b);
          this.files = new SessionFiles(project.path, d);
          if (d !== previousDir) {
            // Entries point at the old directory; they cannot survive the move.
            // Awaiting keeps the view from restoring an entry that is closing,
            // and the drain may outlast a switch to another project.
            await this.registry.disposeProject(projectId(project)).catch(() => {});
            if (this.project === project) {
              this.projectRuntime.setProject(project.path, d);
              this.current = this.restoreCurrent();
            }
          }
        }
        return b;
      }
      case "settings.reset":
        return v.scope === "app"
          ? this.settings.reset()
          : await this.settings.resetPi(v.scope as "global" | "project");
      case "layout.save":
        this.settings.saveLayout(v.layout as LayoutState);
        return { ok: true };
    }
  }
  /** Graceful shutdown: flush pending history, abort runs, release ownership. */
  closeSessions(): Promise<void> {
    this.flushBackgroundRefresh();
    return this.registry.disposeAll();
  }
  /** Full shutdown: local sessions and every pooled host, awaited together. */
  closeAll(): Promise<void> {
    return Promise.all([this.closeSessions(), this.pool.closeAllRemote()]).then(() => {});
  }
  dispose() {
    this.progress.clear();
    this.shell.dispose();
    void this.closeAll().catch(() => {});
  }
}
