import { existsSync, realpathSync } from "node:fs";
import { basename, posix, resolve } from "node:path";
import type {
  AgentControl,
  DesktopEvent,
  DesktopRoute,
  ProjectGroup,
  ProjectInfo,
  BrokerModel,
  RuntimeState,
  SessionSnapshot,
  SessionSummary,
  SettingsBundle,
  TerminalSession,
  RemoteConnectStage,
} from "../shared/types.js";
import { projectId } from "../shared/types.js";
import { validateRouteInput } from "../shared/contracts.js";
import { isProjectRoute, type ProjectRoute } from "../shared/remote-protocol.js";
import { projectSession } from "../shared/session.js";
import { sessionEventEncoder } from "../shared/session-updates.js";
import { agentProgressKey, isAgentProgress, pruneAgentProgress } from "../shared/agent-updates.js";
import { PiRuntime, MODEL_ACTIONS } from "./pi-runtime.js";
import { GraphRuntime } from "./graph-runtime.js";
import { SessionRegistry, type SessionEntry } from "./session-registry.js";
import { LibraryService } from "./library.js";
import { readFileChange } from "./file-changes.js";
import { WslHostClient } from "./wsl-host-client.js";
import { brokerOptions } from "./model-broker.js";
import { listSshHosts } from "./ssh-host-installer.js";
import {
  configuredSessionDir,
  GitService,
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
  showItemInFolder(path: string): void;
  quit(): void;
}
/** One pooled remote workspace: the host stays alive while another project is in view. */
export interface RemoteSlot {
  client: WslHostClient;
  project: ProjectInfo;
  settings: SettingsBundle;
  stopEvents: () => void;
  stopDisconnect: () => void;
  lastActivity: number;
}
const unavailable = (): RuntimeState => ({
  available: false,
  model: null,
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  isStreaming: false,
  isCompacting: false,
  isRetrying: false,
  autoCompactionEnabled: true,
  autoRetryEnabled: true,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  pendingMessageCount: 0,
});
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
  private readonly remotePool = new Map<string, RemoteSlot>();
  private remoteRecycleTimer?: NodeJS.Timeout;
  private remoteAttempt?: AbortController;
  private pendingRemote?: { client: WslHostClient; project: ProjectInfo; abort: AbortController };
  /** The remote session the desktop last opened; other host sessions stay background. */
  private remoteActivePath = "";
  private readonly brokerModels = new WeakMap<WslHostClient, Set<string>>();
  listeners = new Set<(e: DesktopEvent) => void>();
  private readonly liveProgress = new Map<string, DesktopEvent>();
  private readonly liveProgressEpochs = new Map<string, string | undefined>();
  /** The client of the remote workspace in view, pooled or freshly connected. */
  get wsl(): WslHostClient | undefined {
    return this.activeSlot()?.client;
  }
  get wslSettings(): SettingsBundle | undefined {
    return this.activeSlot()?.settings;
  }
  get remoteBrokerModels(): Set<string> {
    const slot = this.activeSlot();
    return (slot && this.brokerModels.get(slot.client)) ?? new Set<string>();
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
    const pushed = e as DesktopEvent;
    if (pushed.type !== "agent") {
      if (pushed.type === "sessions") {
        const current = (pushed.payload as { current?: SessionSnapshot })?.current;
        if (current && !this.registry.isActive(entry)) {
          // A background session settled: refresh history and the list, never the view.
          this.noteEpoch(current);
          this.scheduleBackgroundRefresh(entry);
          return;
        }
        if (current) this.current = current;
      }
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
    else this.recordProgress(routed);   // token streams of background runs are recorded for their return, never forwarded
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
      } catch {}
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
      const snapshot = this.registry.snapshotOf(entry);
      if (snapshot) this.rememberSnapshot(entry.project, snapshot);
      // Decorated project groups carry running markers and fresh rows for
      // every project, not just the one in view.
      try { this.emit({ type: "sessions", payload: { projects: this.projectGroups() } }); } catch {}
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
  /** Routes a control action: model actions to the project runtime, everything else to the active session. */
  private async controlAgent(input: AgentControl): Promise<{ result: unknown; entry?: SessionEntry }> {
    if (input.action === "newSession") {
      const entry = this.activeEntry();
      // A failed node deletion recovers by reusing the old close-and-create
      // semantics on the same runtime; otherwise a new session is a new entry
      // and the previous one keeps running in the background.
      if (entry?.runtime?.recovering) return { result: await entry.runtime.control(input), entry };
      if (!this.project) throw new Error("Open a project first");
      const result = await this.registry.create(
        this.project,
        configuredSessionDir(this.project.path, this.settings.bundle()),
        // Canonicalize through the session files service so junctioned and
        // symlinked projects key and look up the same entry.
        async () => this.files.managed(await this.projectRuntime.createSessionFile()),
      );
      return { result, entry: this.registry.entry((result as SessionSnapshot).session.path) };
    }
    if ((MODEL_ACTIONS as readonly string[]).includes(input.action))
      return { result: await this.projectRuntime.control(input) };
    const entry = this.activeEntry();
    if (!entry?.runtime) throw new Error("Open a session first");
    return { result: await entry.runtime.control(input), entry };
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
    this.recordProgress(e);
    if (e.type === "sessions") {
      this.noteEpoch((e.payload as { current?: SessionSnapshot }).current);
    } else if (e.type === "remote.connection" && !(e.payload as { connected: boolean }).connected) {
      // A dropped host's runs are dead; local sessions keep their baselines.
      for (const key of [...this.liveProgress.keys()]) {
        const graphId = (JSON.parse(key) as unknown[])[0];
        if (typeof graphId === "string" && !this.registry.entry(graphId)) this.liveProgress.delete(key);
      }
    }
    this.listeners.forEach((f) => f(e));
  }
  /**
   * Progress baselines are keyed by graph id (= session path), so sessions
   * running in the background keep theirs across view switches; they are
   * replayed only when their session becomes the view again.
   */
  private recordProgress(e: DesktopEvent) {
    pruneAgentProgress(e, this.liveProgress);
    if (isAgentProgress(e)) this.liveProgress.set(agentProgressKey(e.payload as Record<string, unknown>), e);
  }
  /** A restarted session (new epoch) invalidates its own baselines, not other sessions'. */
  private noteEpoch(current: SessionSnapshot | undefined) {
    const graph = current?.graph;
    if (!graph?.id) return;
    const known = this.liveProgressEpochs.get(graph.id);
    if (known !== undefined && known !== graph.epoch) {
      for (const key of [...this.liveProgress.keys()])
        if ((JSON.parse(key) as unknown[])[0] === graph.id) this.liveProgress.delete(key);
    }
    this.liveProgressEpochs.set(graph.id, graph.epoch);
  }
  remoteEvent(event: DesktopEvent, project: ProjectInfo | null = this.project) {
    const current = (event.payload as { current?: SessionSnapshot } | null)?.current;
    if (event.type === "sessions" && current?.session.path) {
      // Only the session the desktop opened may drive the view; anything else
      // the host still streams belongs to a background run.
      if (current.session.path !== this.remoteActivePath) {
        this.rememberSnapshot(project, current);
        return;
      }
      this.current = current;
      this.rememberSnapshot(project, current);
    }
    if (event.type === "agent") {
      const graphId = (event.payload as { graphId?: string } | null)?.graphId;
      // Current hosts gate their own background sessions; older ones do not,
      // so events of a session the desktop is not viewing only keep their
      // progress baseline for the switch back.
      if (graphId && graphId !== this.current?.graph?.id) {
        this.recordProgress(event);
        return;
      }
    }
    this.emit(event);
  }
  configure(path: string | null) {
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
    this.files.set(path, dir);
    this.projectRuntime.setProject(path, dir);
    // Session entries survive project switches; the view restores whatever was
    // last active in the project being entered.
    this.current = this.restoreCurrent();
  }
  mergedWslSettings(remote: SettingsBundle) {
    const local = this.settings.bundle();
    return {
      ...remote,
      app: local.app,
      paths: { ...remote.paths, app: local.paths.app },
    };
  }
  async wslBootstrap() {
    const slot = this.activeSlot();
    if (!slot) throw new Error("Remote host is not connected");
    if (!slot.client.connected && slot.settings) {
      const record = this.projectGroups().find((record) => record.id === projectId(this.project!));
      return {
        project: this.project,
        sessions: record?.sessions ?? [],
        projects: this.projectGroups(),
        settings: this.mergedWslSettings(slot.settings),
        layout: this.settings.layout(),
        current: this.current ? { ...this.current, runtime: unavailable() } : undefined,
      };
    }
    const [sessions, settings] = await Promise.all([
      slot.client.request("session.list"),
      slot.client.request<SettingsBundle>("settings.get"),
    ]);
    slot.settings = settings;
    slot.lastActivity = Date.now();
    const projects = this.rememberProject(sessions as SessionSummary[]);
    return {
      project: this.project,
      sessions,
      projects,
      settings: {
        ...this.mergedWslSettings(settings),
        app: this.settings.bundle().app,
      },
      layout: this.settings.layout(),
      current: undefined,
    };
  }
  async syncModelBroker(client: WslHostClient) {
    const models = await this.projectRuntime.control({ action: "getModels", broker: true }) as BrokerModel[];
    const allowed = new Set(
      models.map((model) => `${model.provider}\0${model.id}`),
    );
    await client.request("agent.control", {
      action: "setBrokerProviders",
      providers: [...new Set(models.map((model) => model.provider))],
      models,
    });
    this.brokerModels.set(client, allowed);
  }
  async attachModelBroker(client: WslHostClient) {
    client.setModelBroker(async (request, signal) => {
      if (!this.brokerModels.get(client)?.has(`${request.provider}\0${request.modelId}`))
        throw new Error("The remote host requested a model that is not enabled locally");
      const runtime = await this.projectRuntime.modelRuntime();
      const model = runtime.getModel(request.provider, request.modelId);
      if (!model) throw new Error("The requested desktop model was not found");
      return runtime.streamSimple(model, request.context, {
        ...brokerOptions(request.options),
        signal,
      });
    });
    await this.syncModelBroker(client);
  }
  private activeSlot(): RemoteSlot | undefined {
    return this.project?.remote ? this.remotePool.get(projectId(this.project)) : undefined;
  }
  private slotOf(client: WslHostClient): RemoteSlot | undefined {
    for (const slot of this.remotePool.values()) if (slot.client === client) return slot;
    return undefined;
  }
  /**
   * Subscribes a connected client as a pooled workspace. Switching projects
   * never disposes a slot; only explicit disconnect, recycling, or quitting
   * does. Also the seam through which tests adopt a pre-existing connection.
   */
  installSlot(client: WslHostClient, project: ProjectInfo, settings: SettingsBundle): RemoteSlot {
    const id = projectId(project);
    const previous = this.remotePool.get(id);
    if (previous && previous.client !== client) void this.dropSlot(previous, true);
    const slot: RemoteSlot = { client, project, settings, lastActivity: Date.now(), stopEvents: () => {}, stopDisconnect: () => {} };
    slot.stopEvents = client.onEvent(event => {
      slot.lastActivity = Date.now();
      this.remoteEvent(event, project);
    });
    slot.stopDisconnect = client.onDisconnect(error => {
      if (this.remotePool.get(id) !== slot) return;
      // The slot stays until replaced or recycled so a degraded bootstrap can
      // still present the project's remembered rows and a reconnect banner.
      if (this.project && projectId(this.project) === id && this.current)
        this.current = { ...this.current, runtime: unavailable() };
      this.emit({ type: "remote.connection", payload: {
        projectId: id, connected: false, message: error.message,
      } });
    });
    this.remotePool.set(id, slot);
    this.scheduleRemoteRecycle();
    return slot;
  }
  private async dropSlot(slot: RemoteSlot, dispose: boolean) {
    slot.stopEvents();
    slot.stopDisconnect();
    for (const [id, pooled] of this.remotePool) if (pooled === slot) this.remotePool.delete(id);
    if (dispose) await slot.client.dispose().catch(() => {});
  }
  /** Detaches the active remote workspace; pooled hosts of other projects keep serving them. */
  async closeWsl() {
    await this.cancelRemote();
    const slot = this.activeSlot();
    if (slot) await this.dropSlot(slot, true);
  }
  /** Quit-time teardown: every pooled host goes away. */
  private async closeAllRemote(): Promise<void> {
    if (this.remoteRecycleTimer) {
      clearTimeout(this.remoteRecycleTimer);
      this.remoteRecycleTimer = undefined;
    }
    await this.cancelRemote();
    for (const slot of [...this.remotePool.values()]) await this.dropSlot(slot, true);
  }
  private get maxRemoteConnections(): number {
    return Math.min(16, Math.max(1, Number.parseInt(process.env.PIX_MAX_REMOTE_CONNECTIONS ?? "2", 10) || 2));
  }
  private get remoteIdleMs(): number {
    return Math.max(1_000, Number.parseInt(process.env.PIX_REMOTE_IDLE_MS ?? "300000", 10) || 300_000);
  }
  private scheduleRemoteRecycle() {
    if (this.remoteRecycleTimer || !this.remotePool.size) return;
    const timer = setTimeout(() => {
      this.remoteRecycleTimer = undefined;
      void this.recycleRemote();
    }, Math.min(5_000, this.remoteIdleMs));
    timer.unref();
    this.remoteRecycleTimer = timer;
  }
  /**
   * Idle recycling: the workspace in view and hosts with running work are
   * never disposed, and liveness is confirmed by the host itself rather than
   * any cached flag.
   */
  private async recycleRemote(): Promise<void> {
    const activeId = this.project ? projectId(this.project) : "";
    const idle = [...this.remotePool.values()]
      .filter(slot => projectId(slot.project) !== activeId)
      .sort((a, b) => b.lastActivity - a.lastActivity);
    const victims = idle.filter((slot, index) =>
      index >= this.maxRemoteConnections || !slot.client.connected
      || Date.now() - slot.lastActivity >= this.remoteIdleMs);
    for (const slot of victims) {
      if (slot.client.connected && await this.slotBusy(slot)) continue;
      await this.dropSlot(slot, true);
    }
    this.scheduleRemoteRecycle();
  }
  private async slotBusy(slot: RemoteSlot): Promise<boolean> {
    try {
      const sessions = await slot.client.request<SessionSummary[]>("session.list");
      return Boolean(sessions.some(session => session.running));
    } catch {
      return true;   // cannot prove the host is idle
    }
  }
  async connectWsl(distro: string, cwd: string, browse = false) {
    return this.connectRemote({ kind: "wsl", distro }, cwd, browse);
  }
  async connectSsh(host: string, cwd: string, browse = false) {
    return this.connectRemote({ kind: "ssh", host }, cwd, browse);
  }
  async cancelRemote() {
    const attempt = this.remoteAttempt;
    const pending = this.pendingRemote;
    this.remoteAttempt = undefined;
    this.pendingRemote = undefined;
    attempt?.abort(new Error("Remote connection cancelled"));
    await pending?.client.dispose();
    return { cancelled: true };
  }
  private async connectRemote(remote: NonNullable<ProjectInfo["remote"]>, cwd: string, browse: boolean) {
    // A pooled workspace for this project is reused: spawning a second host
    // would trip the graph ownership lock the first one still holds.
    const pooled = this.remotePool.get(projectId({ name: "", path: cwd, remote }));
    if (pooled?.client.connected) return this.activatePooled(pooled);
    // Install the new attempt synchronously, so overlapping requests cannot
    // finish out of order and replace a newer connection.
    const cancelled = this.cancelRemote();
    const abort = new AbortController();
    this.remoteAttempt = abort;
    let client: WslHostClient | undefined;
    try {
      await cancelled;
      abort.signal.throwIfAborted();
      const options = {
        signal: abort.signal,
        onProgress: (stage: RemoteConnectStage) => {
          if (!abort.signal.aborted) this.emit({ type: "remote.progress", payload: { stage } });
        },
      };
      client = remote.kind === "ssh"
        ? await WslHostClient.connectSsh(remote.host, cwd, options)
        : await WslHostClient.installed({ distro: remote.distro, cwd, ...options });
      abort.signal.throwIfAborted();
      const connectedClient = client;
      abort.signal.addEventListener("abort", () => { void connectedClient.dispose(); }, { once: true });
      const path = client.hello.cwd;
      const candidate = { client, abort, project: {
        name: posix.basename(path.replace(/\/+$/u, "")) || path,
        path,
        remote,
      } };
      this.pendingRemote = candidate;
      if (browse) return { project: candidate.project };
      return await this.commitRemote(candidate);
    } catch (error) {
      await client?.dispose();
      if (this.remoteAttempt === abort) {
        this.remoteAttempt = undefined;
        this.pendingRemote = undefined;
      }
      throw error;
    }
  }
  /** Switches the view back to a pooled workspace without touching its host. */
  private async activatePooled(slot: RemoteSlot) {
    const sessions = await slot.client.request<SessionSummary[]>("session.list");
    this.settings.rememberProject(slot.project, sessions);
    slot.lastActivity = Date.now();
    this.project = slot.project;
    this.remoteActivePath = "";
    this.current = this.restoreCurrent();
    return {
      project: slot.project, sessions, projects: this.projectGroups(),
      settings: this.mergedWslSettings(slot.settings),
      layout: this.settings.layout(), current: undefined,
    };
  }
  private async commitRemote(candidate: NonNullable<MainController["pendingRemote"]>) {
    const { client, abort, project } = candidate;
    abort.signal.throwIfAborted();
    this.emit({ type: "remote.progress", payload: { stage: "loading" } });
    await this.attachModelBroker(client);
    const [sessions, settings] = await Promise.all([
      client.request<SessionSummary[]>("session.list"),
      client.request<SettingsBundle>("settings.get"),
    ]);
    abort.signal.throwIfAborted();
    if (!client.connected) throw new Error("Remote host disconnected before the workspace was ready");
    this.settings.rememberProject(project, sessions);
    this.pendingRemote = undefined;
    this.remoteAttempt = undefined;
    // The previously active client stays pooled: its host keeps serving its
    // project's background runs.
    this.installSlot(client, project, settings);
    this.project = project;
    this.remoteActivePath = "";
    this.current = this.restoreCurrent();
    return {
      project, sessions, projects: this.projectGroups(),
      settings: this.mergedWslSettings(settings),
      layout: this.settings.layout(), current: undefined,
    };
  }
  async openRemoteProject(path: string) {
    const candidate = this.pendingRemote;
    if (!candidate) {
      const remote = this.project?.remote;
      if (!remote) throw new Error("Remote host is not connected");
      return this.connectRemote(remote, path, false);
    }
    candidate.abort.signal.throwIfAborted();
    const selected = await candidate.client.request<{ path: string }>("workspace.open", { path });
    candidate.project = { ...candidate.project,
      name: posix.basename(selected.path.replace(/\/+$/u, "")) || selected.path,
      path: selected.path,
    };
    return this.commitRemote(candidate);
  }
  async invokeWsl(route: ProjectRoute, v: Record<string, unknown>) {
    const client = this.wsl;
    if (!client) throw new Error("Remote host is not connected");
    const slot = this.slotOf(client);
    if (slot) slot.lastActivity = Date.now();
    const remoteSettings = async () => {
      const settings = await client.request<SettingsBundle>(route, v);
      if (slot) slot.settings = settings;
      return this.mergedWslSettings(settings);
    };
    if (route === "agent.control") {
      const action = String(v.action);
      if (action === "getProviders" || action === "getModels" || action === "getCustomModels")
        return this.projectRuntime.control(v as unknown as AgentControl);
      if (action === "loginApiKey" || action === "loginOAuth" || action === "refreshModels" || action === "addCustomModel" || action === "updateCustomModel") {
        const result = await this.projectRuntime.control(v as unknown as AgentControl);
        await this.syncModelBroker(client);
        return result;
      }
      if (action === "logout") {
        const result = await this.projectRuntime.control(v as unknown as AgentControl);
        await this.syncModelBroker(client);
        return result;
      }
    }
    if (route === "session.delete") {
      if (
        v.confirmed !== true &&
        this.settings.bundle().app.confirmDestructiveActions &&
        !(await this.platform.confirm("Delete this Pi session in WSL?", String(v.path)))
      )
        return { cancelled: true, sessions: await client.request("session.list") };
    } else if (route === "shell.run") {
      const command = String(v.command);
      const trust = slot?.settings.effective.defaultProjectTrust ?? "ask";
      if (trust === "never") throw new Error("Shell is disabled for this WSL project");
      if (
        trust !== "always" &&
        !(await this.platform.confirm("Run this command in WSL?", command))
      )
        return {
          id: "",
          command,
          output: "",
          exitCode: null,
          cancelled: true,
          truncated: false,
        };
    } else if (route === "terminal.create") {
      const trust = slot?.settings.effective.defaultProjectTrust ?? "ask";
      if (trust === "never") throw new Error("Terminal is disabled for this remote project");
      const session = await client.request<TerminalSession>(route, v);
      if (!session?.id)
        throw new Error(
          "Remote host returned an invalid terminal session. Disconnect and reconnect the remote workspace.",
        );
      return session;
    } else if (route === "settings.get") {
      return remoteSettings();
    } else if (route === "settings.update" || route === "settings.reset") {
      if (v.scope === "app") {
        const local =
          route === "settings.update"
            ? this.settings.update(v.patch as Record<string, unknown>)
            : this.settings.reset();
        return slot
          ? { ...this.mergedWslSettings(slot.settings), app: local.app }
          : local;
      }
      return remoteSettings();
    }
    const result = await client.request(route, v);
    if (route === "session.list" && Array.isArray(result))
      this.rememberProject(result as SessionSummary[]);
    else if (
      result &&
      typeof result === "object" &&
      "sessions" in result &&
      Array.isArray((result as { sessions: unknown }).sessions)
    )
      this.rememberProject((result as { sessions: SessionSummary[] }).sessions);
    else if (
      result &&
      typeof result === "object" &&
      "session" in result
    ) {
      const snapshot = result as SessionSnapshot;
      // Snapshots from the host mark the session the desktop now shows; only
      // its events may drive the view.
      if (snapshot.projection && snapshot.session?.path)
        this.remoteActivePath = snapshot.session.path;
      this.rememberSnapshot(this.project, snapshot);
    }
    return result;
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
        ? Boolean(this.remotePool.get(record.id)?.client.connected)
        : record.id === active,
      archived: archivedProjects.has(record.id) || undefined,
      // History snapshots embed whatever flags were current when remembered;
      // the library sidecar is the source of truth, so reapply it here.
      sessions: record.sessions.map((session) => ({
        ...session,
        pinned: pinned.has(session.path) || undefined,
        archived: archivedSessions.has(session.path) || undefined,
        running: running.has(session.path) || undefined,
      })),
    }));
  }
  rememberProject(sessions: SessionSummary[]) {
    if (!this.project) return this.projectGroups();
    this.settings.rememberProject(this.project, sessions);
    return this.projectGroups();
  }
  rememberSnapshot(project: ProjectInfo | null, snapshot: SessionSnapshot) {
    if (!project) return;
    const old = this.settings.projectHistory().find(
      (record) => record.id === projectId(project),
    )?.sessions ?? [];
    this.settings.rememberProject(project, [
      snapshot.session,
      ...old.filter((session) => session.path !== snapshot.session.path),
    ]);
  }
  async sessions() {
    const running = this.registry.runningPaths();
    const decorate = (list: SessionSummary[]) => {
      const marks = this.library.marks();
      const pinned = new Set(marks.pinned),
        archivedSessions = new Set(marks.archivedSessions);
      return list.map((x) => ({
        ...x,
        active: x.path === this.current?.session.path,
        running: running.has(x.path) || undefined,
        pinned: pinned.has(x.path) || undefined,
        archived: archivedSessions.has(x.path) || undefined,
      }));
    };
    try {
      const s = await this.projectRuntime.list();
      return decorate(s.length ? s : this.files.list());
    } catch {
      return decorate(this.files.list());
    }
  }
  fallback(path: string): SessionSnapshot {
    const x = this.files.read(path),
      summary = this.files.list().find((s) => s.path === resolve(path)) ?? {
        id: String(x.header?.id ?? path),
        path: resolve(path),
        cwd: String(x.header?.cwd ?? this.project?.path ?? path),
        created: String(x.header?.timestamp ?? new Date().toISOString()),
        modified: new Date().toISOString(),
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
    if (route === "wsl.list") return WslHostClient.distributions();
    if (route === "wsl.names") return WslHostClient.names();
    if (route === "ssh.list") return listSshHosts();
    if (route === "remote.cancel") return this.cancelRemote();
    if (route === "remote.directories") {
      if (!this.pendingRemote) throw new Error("Connect to a remote host first");
      return this.pendingRemote.client.request("workspace.directories", v);
    }
    if (route === "wsl.connect")
      return this.connectWsl(String(v.distro), String(v.cwd), Boolean(v.browse));
    if (route === "ssh.connect")
      return this.connectSsh(String(v.host), String(v.cwd), Boolean(v.browse));
    if (route === "remote.openProject")
      return this.openRemoteProject(String(v.path));
    if (route === "app.openProject") {
      const record = this.settings.projectHistory().find(
        (item) => item.id === String(v.id),
      );
      if (!record || record.project.remote)
        throw new Error("Local project is not in the project history");
      // The remote workspace stays pooled; its host keeps serving it.
      this.configure(record.project.path);
      const sessions = await this.sessions();
      return {
        project: this.project,
        sessions,
        projects: this.rememberProject(sessions),
        settings: this.settings.bundle(),
        layout: this.settings.layout(),
        current: this.current,
      };
    }
    if (route === "app.forgetProject") {
      const id = String(v.id);
      if (this.project && id === projectId(this.project))
        throw new Error("The open project cannot be removed from the list");
      this.settings.forgetProject(id);
      return this.projectGroups();
    }
    if (route === "wsl.disconnect" || route === "remote.disconnect") {
      await this.closeWsl();
      this.configure(this.localProjectPath);
      const sessions = await this.sessions();
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
    if (this.wsl && isProjectRoute(route)) return this.invokeWsl(route, v);
    if (
      !this.project &&
      [
        "session.list",
        "session.open",
        "session.stop",
        "session.import",
        "session.rename",
        "session.delete",
        "workspace.tree",
        "workspace.read",
        "workspace.write",
        "git.status",
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
        if (this.wsl) return this.wslBootstrap();
        const last = this.settings.bundle().app.lastProject;
        if (last && existsSync(last) && resolve(last) !== this.project?.path)
          this.configure(last);
        const sessions = this.project ? await this.sessions() : [];
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
        const sessions = await this.sessions();
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
          this.rememberProject(sessions);
          return sessions;
        });
      case "session.snapshot": {
        const entry = this.activeEntry();
        const current = entry?.runtime ? entry.runtime.snapshot() : this.current;
        if (current) {
          this.current = current;
          this.emit({ type: "sessions", payload: { current, resync: true } });
          // Replay only the session in view; other buckets wait for their turn.
          const graphId = current.graph?.id;
          for (const progress of this.liveProgress.values())
            if ((progress.payload as { graphId?: string }).graphId === graphId) this.emit(progress);
        }
        return current;
      }
      case "session.open": {
        const p = this.files.managed(String(v.path));
        const project = this.project!;
        this.current = await this.registry.open(
          project,
          configuredSessionDir(project.path, this.settings.bundle()),
          p,
          error => {
            this.emit({
              type: "notice",
              payload: {
                level: "warning",
                message: `Read-only session: ${error instanceof Error ? error.message : String(error)}`,
              },
            });
            return this.fallback(p);
          },
        );
        this.rememberSnapshot(project, this.current);
        return this.current;
      }
      case "session.import": {
        const p = await this.platform.pickSession();
        if (!p) return null;
        try {
          await this.projectRuntime.validate(p);
        } catch {}
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
        const currentPath = this.current?.session.path;
        const deletingCurrent = Boolean(currentPath && realpathSync(currentPath) === p);
        if (resolved?.entry && this.registry.busy(resolved.entry))
          throw new Error("Stop the running session before deleting it");
        if (resolved?.entry) {
          await this.registry.dispose(p);
          this.rememberOwnerProject(resolved.entry, sessions => sessions.filter(
            session => session.path !== p && session.path !== String(v.path),
          ));
        }
        this.files.deleteAt(p);
        if (deletingCurrent) this.current = undefined;
        const sessions = await this.sessions();
        this.rememberProject(sessions);
        this.emit({ type: "sessions", payload: { deletedPath: deletingCurrent ? currentPath : String(v.path), sessions } });
        return { sessions };
      }
      case "session.stop": {
        const entry = this.entryFor(String(v.path))?.entry;
        if (!entry?.runtime) return { stopped: false };
        const runs = entry.runtime.snapshot().graph?.runs.filter(run => run.status === "running") ?? [];
        await Promise.allSettled(runs.map(run => entry.runtime!.control({ action: "branchAbort", branchId: run.branchId, runId: run.runId })));
        return { stopped: Boolean(runs.length) };
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
        const { result: r, entry } = await this.controlAgent(v as unknown as AgentControl);
        if (r && typeof r === "object" && "projection" in r && entry && this.registry.isActive(entry)) {
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
          const d = configuredSessionDir(this.project.path, b);
          this.files.set(this.project.path, d);
          if (d !== previousDir) {
            // Entries point at the old directory; they cannot survive the move.
            void this.registry.disposeProject(projectId(this.project)).catch(() => {});
            this.projectRuntime.setProject(this.project.path, d);
            this.current = this.restoreCurrent();
          }
        }
        return b;
      }
      case "settings.reset":
        return v.scope === "app"
          ? this.settings.reset()
          : await this.settings.resetPi(v.scope as "global" | "project");
      case "layout.save":
        this.settings.saveLayout(v.layout as unknown as any);
        return { ok: true };
    }
  }
  /** Graceful shutdown: flush pending history, abort runs, release ownership. */
  closeSessions(): Promise<void> {
    this.flushBackgroundRefresh();
    return this.registry.disposeAll();
  }
  dispose() {
    this.liveProgress.clear();
    void this.closeAllRemote();
    this.shell.dispose();
    void this.closeSessions().catch(() => {});
  }
}
