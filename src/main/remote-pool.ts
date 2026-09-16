import { posix } from "node:path";
import { debugLog } from "./debug-log.js";
import type {
  AgentControl,
  BrokerModel,
  DesktopEvent,
  ProjectGroup,
  ProjectInfo,
  RemoteConnectStage,
  RuntimeState,
  SessionSnapshot,
  SessionSummary,
  SettingsBundle,
  TerminalSession,
} from "../shared/types.js";
import { projectId } from "../shared/types.js";
import type { ProjectRoute } from "../shared/remote-protocol.js";
import { WslHostClient } from "./wsl-host-client.js";
import { brokerOptions } from "./model-broker.js";
import type { PiRuntime } from "./pi-runtime.js";
import type { SettingsService } from "./services.js";
import type { Platform } from "./controller.js";

/** Session-scoped control actions whose runtime moves to a new session file. */
const SESSION_MIGRATING_ACTIONS = ["fork", "clone"];
export const migratesSession = (action: unknown) =>
  action === "newSession" || (SESSION_MIGRATING_ACTIONS as readonly unknown[]).includes(action);
export const unavailable = (): RuntimeState => ({
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
/** One pooled remote workspace: the host stays alive while another project is in view. */
export interface RemoteSlot {
  client: WslHostClient;
  project: ProjectInfo;
  settings: SettingsBundle;
  /** The session the desktop last viewed on this host, restored on reactivation. */
  activePath: string;
  stopEvents: () => void;
  stopDisconnect: () => void;
  lastActivity: number;
}
/** A connect attempt between the client handshake and the committed slot. */
export interface PendingRemote {
  client: WslHostClient;
  project: ProjectInfo;
  abort: AbortController;
}
/**
 * The view state pooled workspaces drive: the project in view, its current
 * snapshot, and the request counter that invalidates stale flows. The
 * controller stays their only owner; the pool goes through this port.
 */
export interface RemoteView {
  /** Allocates the next request; every project or session switch takes one. */
  nextRequest(): number;
  /** The request an incoming route rides on without switching anything itself. */
  request(): number;
  /** Whether a request still owns the view. */
  isCurrent(request: number): boolean;
  project(): ProjectInfo | null;
  current(): SessionSnapshot | undefined;
  setCurrent(snapshot: SessionSnapshot | undefined): void;
  /** Adopts a committed workspace's project, restoring the registry's session for it. */
  enter(project: ProjectInfo): SessionSnapshot | undefined;
  /** Adopts a reactivated pooled project with no session; its own restore follows. */
  enterEmpty(project: ProjectInfo): void;
}
/** Controller-owned collaborators and bookkeeping the pooled workspaces use. */
export interface RemotePoolHost {
  emit(e: DesktopEvent): void;
  /** The desktop shell: destructive remote actions confirm through it. */
  platform: Platform;
  /** The view-independent runtime serving model actions and the broker stream. */
  projectRuntime: PiRuntime;
  settings: SettingsService;
  /** Decorated history rows for bootstrap and broadcast replies. */
  projectGroups(): ProjectGroup[];
  rememberProject(sessions: SessionSummary[], project: ProjectInfo | null): ProjectGroup[];
  rememberSnapshot(project: ProjectInfo | null, snapshot: SessionSnapshot): void;
  view: RemoteView;
}
/** Host workspace paths may differ from the slot's by a trailing slash. */
const sameHostPath = (a: string, b: string) => a.replace(/\/+$/u, "") === b.replace(/\/+$/u, "");

export class RemoteWorkspacePool {
  private readonly remotePool = new Map<string, RemoteSlot>();
  private remoteRecycleTimer?: NodeJS.Timeout;
  private remoteAttempt?: AbortController;
  private pendingRemote?: PendingRemote;
  private readonly brokerModels = new WeakMap<WslHostClient, Set<string>>();
  constructor(private readonly host: RemotePoolHost) {}

  /** The slot of the remote workspace in view, pooled or freshly connected. */
  active(): RemoteSlot | undefined {
    const project = this.host.view.project();
    return project?.remote ? this.remotePool.get(projectId(project)) : undefined;
  }
  slot(id: string): RemoteSlot | undefined {
    return this.remotePool.get(id);
  }
  brokerModelsFor(client: WslHostClient): Set<string> | undefined {
    return this.brokerModels.get(client);
  }
  remoteEvent(event: DesktopEvent, project: ProjectInfo | null = this.host.view.project()) {
    if (!project) return;
    const slot = this.remotePool.get(projectId(project));
    if (!slot) return;
    const active = slot === this.active();
    if (event.type === "sessions") {
      const payload = event.payload as { current?: SessionSnapshot; sessions?: SessionSummary[]; projects?: ProjectGroup[]; deletedPath?: string };
      // A host's history uses host-local project ids; only this workspace's
      // rows belong to the slot, never to the project currently on screen.
      const sessions = payload.sessions ?? payload.projects?.find(record =>
        !record.project.remote && sameHostPath(record.project.path, project.path))?.sessions;
      if (sessions) this.host.rememberProject(sessions, project);
      if (payload.current) this.host.rememberSnapshot(project, payload.current);
      if (sessions || payload.current)
        this.host.emit({ type: "sessions", payload: { projects: this.host.projectGroups() } });
      if (!active) return;
      if (payload.deletedPath) {
        if (payload.deletedPath === slot.activePath) {
          slot.activePath = "";
          this.host.view.setCurrent(undefined);
        }
        // The deletion broadcast carries the surviving rows; without them it
        // would wipe the project's list in the renderer, so it is dropped.
        if (sessions) this.host.emit({ type: "sessions", payload: { deletedPath: payload.deletedPath, sessions } });
        return;
      }
      if (payload.current) {
        if (payload.current.session.path !== slot.activePath) return;
        this.host.view.setCurrent(payload.current);
      } else if (payload.projects || payload.sessions) return;
    }
    // Background hosts replay their own progress on session.snapshot. Keeping
    // it here by path would conflate identical paths on different machines,
    // and their notices are dropped too: an invisible workspace must not toast.
    if (!active) return;
    if (event.type === "agent") {
      const graphId = (event.payload as { graphId?: string } | null)?.graphId;
      if (graphId && graphId !== this.host.view.current()?.graph?.id) return;
    }
    this.host.emit(event);
  }
  private mergedWslSettings(remote: SettingsBundle) {
    const local = this.host.settings.bundle();
    return {
      ...remote,
      app: local.app,
      paths: { ...remote.paths, app: local.paths.app },
    };
  }
  async wslBootstrap() {
    const request = this.host.view.request();
    const slot = this.active();
    if (!slot) throw new Error("Remote host is not connected");
    if (!slot.client.connected && slot.settings) {
      const project = this.host.view.project();
      const record = this.host.projectGroups().find((record) => record.id === projectId(project!));
      const viewed = this.host.view.current();
      return {
        project,
        sessions: record?.sessions ?? [],
        projects: this.host.projectGroups(),
        settings: this.mergedWslSettings(slot.settings),
        layout: this.host.settings.layout(),
        current: viewed ? { ...viewed, runtime: unavailable() } : undefined,
      };
    }
    const [sessions, settings] = await Promise.all([
      slot.client.request("session.list"),
      slot.client.request<SettingsBundle>("settings.get"),
    ]);
    if (!this.host.view.isCurrent(request) || slot !== this.active()) throw new Error("Project selection changed");
    slot.settings = settings;
    slot.lastActivity = Date.now();
    const projects = this.host.rememberProject(sessions as SessionSummary[], slot.project);
    // A window reload lands here while the host may still be running the
    // session this workspace last showed; restore it like a reactivation.
    const current = await this.restoreSlotSession(slot, request);
    if (!this.host.view.isCurrent(request) || slot !== this.active()) throw new Error("Project selection changed");
    return {
      project: this.host.view.project(),
      sessions,
      projects,
      settings: {
        ...this.mergedWslSettings(settings),
        app: this.host.settings.bundle().app,
      },
      layout: this.host.settings.layout(),
      current,
    };
  }
  private async syncModelBroker(client: WslHostClient) {
    const models = await this.host.projectRuntime.control({ action: "getModels", broker: true }) as BrokerModel[];
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
  private async attachModelBroker(client: WslHostClient) {
    client.setModelBroker(async (request, signal) => {
      if (!this.brokerModels.get(client)?.has(`${request.provider}\0${request.modelId}`))
        throw new Error("The remote host requested a model that is not enabled locally");
      const runtime = await this.host.projectRuntime.modelRuntime();
      const model = runtime.getModel(request.provider, request.modelId);
      if (!model) throw new Error("The requested desktop model was not found");
      return runtime.streamSimple(model, request.context, {
        ...brokerOptions(request.options),
        signal,
      });
    });
    await this.syncModelBroker(client);
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
    const slot: RemoteSlot = { client, project, settings, activePath: "", lastActivity: Date.now(), stopEvents: () => {}, stopDisconnect: () => {} };
    slot.stopEvents = client.onEvent(event => {
      slot.lastActivity = Date.now();
      if (this.remotePool.get(id) === slot) this.remoteEvent(event, slot.project);
    });
    slot.stopDisconnect = client.onDisconnect(error => {
      if (this.remotePool.get(id) !== slot) return;
      // The slot stays until replaced or recycled so a degraded bootstrap can
      // still present the project's remembered rows and a reconnect banner.
      const project = this.host.view.project();
      const current = this.host.view.current();
      if (project && projectId(project) === id && current)
        this.host.view.setCurrent({ ...current, runtime: unavailable() });
      this.host.emit({ type: "remote.connection", payload: {
        projectId: id, connected: false, message: error.message,
      } });
    });
    this.remotePool.set(id, slot);
    this.scheduleRemoteRecycle();
    return slot;
  }
  async dropSlot(slot: RemoteSlot, dispose: boolean) {
    slot.stopEvents();
    slot.stopDisconnect();
    for (const [id, pooled] of this.remotePool) if (pooled === slot) this.remotePool.delete(id);
    if (dispose) await slot.client.dispose().catch(() => {});
  }
  /** Detaches the active remote workspace; pooled hosts of other projects keep serving them. */
  async closeWsl() {
    await this.cancelRemote();
    const slot = this.active();
    if (slot) await this.dropSlot(slot, true);
  }
  /** Quit-time teardown: every pooled host goes away. */
  async closeAllRemote(): Promise<void> {
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
      void this.recycleRemote().catch(e => debugLog("remote-pool: recycle", e));
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
    const project = this.host.view.project();
    const activeId = project ? projectId(project) : "";
    const idle = [...this.remotePool.values()]
      .filter(slot => projectId(slot.project) !== activeId)
      .sort((a, b) => b.lastActivity - a.lastActivity);
    const victims = idle.filter((slot, index) =>
      index >= this.maxRemoteConnections || !slot.client.connected
      || Date.now() - slot.lastActivity >= this.remoteIdleMs);
    for (const slot of victims) {
      // Confirmed running work counts as activity: the next liveness probe
      // waits a full idle window instead of firing every tick.
      if (slot.client.connected && await this.slotBusy(slot)) {
        slot.lastActivity = Date.now();
        continue;
      }
      await this.dropSlot(slot, true);
    }
    this.scheduleRemoteRecycle();
  }
  async slotBusy(slot: RemoteSlot): Promise<boolean> {
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
  /** Workspace browsing on a connected-but-uncommitted client. */
  browseDirectories(v: Record<string, unknown>) {
    if (!this.pendingRemote) throw new Error("Connect to a remote host first");
    return this.pendingRemote.client.request("workspace.directories", v);
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
    const request = browse ? undefined : this.host.view.nextRequest();
    // A pooled workspace for this project is reused: spawning a second host
    // would trip the graph ownership lock the first one still holds. Browsing
    // keeps going through the connect flow — the user may pick another folder.
    const pooled = this.remotePool.get(projectId({ name: "", path: cwd, remote }));
    if (!browse && pooled?.client.connected) {
      await this.cancelRemote();
      return this.activatePooled(pooled, request!);
    }
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
          if (!abort.signal.aborted) this.host.emit({ type: "remote.progress", payload: { stage } });
        },
      };
      client = remote.kind === "ssh"
        ? await WslHostClient.connectSsh(remote.host, cwd, options)
        : await WslHostClient.installed({ distro: remote.distro, cwd, ...options });
      abort.signal.throwIfAborted();
      const connectedClient = client;
      abort.signal.addEventListener("abort", () => { void connectedClient.dispose(); }, { once: true });
      const path = client.hello.cwd;
      const candidate: PendingRemote = { client, abort, project: {
        name: posix.basename(path.replace(/\/+$/u, "")) || path,
        path,
        remote,
      } };
      this.pendingRemote = candidate;
      if (browse) return { project: candidate.project };
      return await this.commitRemote(candidate, request!);
    } catch (error) {
      await client?.dispose();
      if (this.remoteAttempt === abort) {
        this.remoteAttempt = undefined;
        this.pendingRemote = undefined;
      }
      throw error;
    }
  }
  /** Reopens the session this workspace last showed; empty when it is gone. */
  private async restoreSlotSession(slot: RemoteSlot, request: number): Promise<SessionSnapshot | undefined> {
    if (!slot.activePath) return undefined;
    try {
      const current = await slot.client.request("session.open", { path: slot.activePath }) as SessionSnapshot;
      if (this.host.view.isCurrent(request)) this.host.view.setCurrent(current);
      return current;
    } catch {
      return undefined;
    }
  }
  /** Switches the view back to a pooled workspace without touching its host. */
  private async activatePooled(slot: RemoteSlot, request: number) {
    const [sessions, settings] = await Promise.all([
      slot.client.request<SessionSummary[]>("session.list"),
      slot.client.request<SettingsBundle>("settings.get"),
    ]);
    if (!this.host.view.isCurrent(request)) throw new Error("Project selection changed");
    slot.settings = settings;
    this.host.settings.rememberProject(slot.project, sessions);
    slot.lastActivity = Date.now();
    this.host.view.enterEmpty(slot.project);
    // Restore the session this workspace last showed, mirroring the local
    // registry's per-project restore.
    const current = await this.restoreSlotSession(slot, request);
    if (!this.host.view.isCurrent(request)) throw new Error("Project selection changed");
    return {
      project: slot.project, sessions, projects: this.host.projectGroups(),
      settings: this.mergedWslSettings(slot.settings),
      layout: this.host.settings.layout(), current,
    };
  }
  private async commitRemote(candidate: PendingRemote, request: number) {
    const { client, abort, project } = candidate;
    abort.signal.throwIfAborted();
    if (!this.host.view.isCurrent(request)) throw new Error("Project selection changed");
    // The request path may differ in spelling from the host's canonical cwd;
    // if the pool already holds this project, adopt it — a second host would
    // trip the graph ownership lock the pooled one still holds.
    const pooled = this.remotePool.get(projectId(project));
    if (pooled && pooled.client !== client && pooled.client.connected) {
      await client.dispose();
      this.pendingRemote = undefined;
      this.remoteAttempt = undefined;
      return this.activatePooled(pooled, request);
    }
    this.host.emit({ type: "remote.progress", payload: { stage: "loading" } });
    await this.attachModelBroker(client);
    const [sessions, settings] = await Promise.all([
      client.request<SessionSummary[]>("session.list"),
      client.request<SettingsBundle>("settings.get"),
    ]);
    abort.signal.throwIfAborted();
    if (!this.host.view.isCurrent(request)) throw new Error("Project selection changed");
    if (!client.connected) throw new Error("Remote host disconnected before the workspace was ready");
    this.host.settings.rememberProject(project, sessions);
    this.pendingRemote = undefined;
    this.remoteAttempt = undefined;
    // The previously active client stays pooled: its host keeps serving its
    // project's background runs.
    this.installSlot(client, project, settings);
    this.host.view.enter(project);
    return {
      project, sessions, projects: this.host.projectGroups(),
      settings: this.mergedWslSettings(settings),
      layout: this.host.settings.layout(), current: undefined,
    };
  }
  async openRemoteProject(path: string) {
    const candidate = this.pendingRemote;
    if (!candidate) {
      const remote = this.host.view.project()?.remote;
      if (!remote) throw new Error("Remote host is not connected");
      return this.connectRemote(remote, path, false);
    }
    candidate.abort.signal.throwIfAborted();
    const request = this.host.view.nextRequest();
    const selected = await candidate.client.request<{ path: string }>("workspace.open", { path });
    candidate.project = { ...candidate.project,
      name: posix.basename(selected.path.replace(/\/+$/u, "")) || selected.path,
      path: selected.path,
    };
    return this.commitRemote(candidate, request);
  }
  async invokeWsl(route: ProjectRoute, v: Record<string, unknown>, request = this.host.view.request()) {
    const slot = this.active();
    if (!slot) throw new Error("Remote host is not connected");
    const { client, project } = slot;
    slot.lastActivity = Date.now();
    const remoteSettings = async () => {
      const settings = await client.request<SettingsBundle>(route, v);
      slot.settings = settings;
      return this.mergedWslSettings(settings);
    };
    if (route === "agent.control") {
      const action = String(v.action);
      if (action === "getProviders" || action === "getModels" || action === "getCustomModels")
        return this.host.projectRuntime.control(v as unknown as AgentControl);
      if (action === "loginApiKey" || action === "loginOAuth" || action === "refreshModels" || action === "addCustomModel" || action === "updateCustomModel") {
        const result = await this.host.projectRuntime.control(v as unknown as AgentControl);
        await this.syncModelBroker(client);
        return result;
      }
      if (action === "logout") {
        const result = await this.host.projectRuntime.control(v as unknown as AgentControl);
        await this.syncModelBroker(client);
        return result;
      }
    }
    if (route === "session.delete") {
      if (
        v.confirmed !== true &&
        this.host.settings.bundle().app.confirmDestructiveActions &&
        !(await this.host.platform.confirm("Delete this Pi session in WSL?", String(v.path)))
      )
        return { cancelled: true, sessions: await client.request("session.list") };
    } else if (route === "shell.run") {
      const command = String(v.command);
      const trust = slot.settings.effective.defaultProjectTrust ?? "ask";
      if (trust === "never") throw new Error("Shell is disabled for this WSL project");
      if (
        trust !== "always" &&
        !(await this.host.platform.confirm("Run this command in WSL?", command))
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
      const trust = slot.settings.effective.defaultProjectTrust ?? "ask";
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
            ? this.host.settings.update(v.patch as Record<string, unknown>)
            : this.host.settings.reset();
        return { ...this.mergedWslSettings(slot.settings), app: local.app };
      }
      return remoteSettings();
    }
    const result = await client.request(route, v);
    if (this.remotePool.get(projectId(project)) !== slot) return result;
    if (route === "session.list" && Array.isArray(result))
      this.host.rememberProject(result as SessionSummary[], project);
    else if (
      result &&
      typeof result === "object" &&
      "sessions" in result &&
      Array.isArray((result as { sessions: unknown }).sessions)
    )
      this.host.rememberProject((result as { sessions: SessionSummary[] }).sessions, project);
    else if (
      result &&
      typeof result === "object" &&
      "session" in result
    ) {
      const snapshot = result as SessionSnapshot;
      // Selection replies and path-migrating actions move the slot's session; a
      // prompt reply can finish long after the desktop has moved elsewhere.
      if (snapshot.projection && snapshot.session?.path && slot === this.active()
        && this.host.view.isCurrent(request)) {
        if (route === "session.open" || (route === "agent.control" && migratesSession(v.action)))
          slot.activePath = snapshot.session.path;
        if (snapshot.session.path === slot.activePath) this.host.view.setCurrent(snapshot);
      }
      this.host.rememberSnapshot(project, snapshot);
    }
    return result;
  }
}
