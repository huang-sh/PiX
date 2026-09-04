import { existsSync } from "node:fs";
import { basename, posix, resolve } from "node:path";
import type {
  AgentControl,
  DesktopEvent,
  DesktopRoute,
  ProjectGroup,
  ProjectInfo,
  RuntimeModel,
  RuntimeState,
  SessionSnapshot,
  SessionSummary,
  SettingsBundle,
  TerminalSession,
} from "../shared/types.js";
import { projectId } from "../shared/types.js";
import { validateRouteInput } from "../shared/contracts.js";
import { isProjectRoute, type ProjectRoute } from "../shared/remote-protocol.js";
import { projectSession } from "../shared/session.js";
import { PiRuntime } from "./pi-runtime.js";
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
  quit(): void;
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
  workspace: WorkspaceService;
  git: GitService;
  shell: ShellService;
  files: SessionFiles;
  pi: PiRuntime;
  current?: SessionSnapshot;
  platform: Platform;
  localProjectPath: string | null;
  wsl?: WslHostClient;
  wslSettings?: SettingsBundle;
  stopWslEvents?: () => void;
  remoteBrokerModels = new Set<string>();
  listeners = new Set<(e: DesktopEvent) => void>();
  constructor(path: string | null, platform: Platform) {
    path = path ? resolve(path) : null;
    this.localProjectPath = path;
    this.project = path ? { name: basename(path), path } : null;
    this.platform = platform;
    this.settings = new SettingsService(path);
    this.settings.applyInstallerLanguage();
    this.workspace = new WorkspaceService(path);
    this.git = new GitService(path);
    this.shell = new ShellService(path, (e) => this.emit(e as DesktopEvent));
    const dir = path
      ? configuredSessionDir(path, this.settings.bundle())
      : null;
    this.files = new SessionFiles(path, dir);
    this.pi = new PiRuntime(path, dir, (e) => {
      this.emit(e as DesktopEvent);
      const p = (e as DesktopEvent).payload as { type?: string };
      if (
        [
          "agent_settled",
          "entry_appended",
          "session_info_changed",
          "compaction_start",
          "compaction_end",
        ].includes(p?.type ?? "")
      ) {
        try {
          this.current = this.pi.snapshot();
          if (p.type !== "entry_appended" && this.current.session.path)
            this.rememberSnapshot(this.current);
          this.emit({ type: "sessions", payload: { current: this.current } });
        } catch {}
      }
    }, (url) => this.platform.openExternal(url));
  }
  onEvent(f: (e: DesktopEvent) => void) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }
  emit(e: DesktopEvent) {
    this.listeners.forEach((f) => f(e));
  }
  remoteEvent(event: DesktopEvent) {
    const current = (event.payload as { current?: SessionSnapshot } | null)?.current;
    if (event.type === "sessions" && current?.session.path)
      this.rememberSnapshot(current);
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
    this.current = undefined;
    this.workspace.setRoot(path);
    this.git.setRoot(path);
    this.shell.setRoot(path);
    const dir = path
      ? configuredSessionDir(path, this.settings.bundle())
      : null;
    this.files.set(path, dir);
    this.pi.setProject(path, dir);
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
    if (!this.wsl) throw new Error("Remote host is not connected");
    const [sessions, settings] = await Promise.all([
      this.wsl.request("session.list"),
      this.wsl.request<SettingsBundle>("settings.get"),
    ]);
    this.wslSettings = settings;
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
    const models = await this.pi.control({ action: "getModels" }) as RuntimeModel[];
    this.remoteBrokerModels = new Set(
      models.map((model) => `${model.provider}\0${model.id}`),
    );
    await client.request("agent.control", {
      action: "setBrokerProviders",
      providers: [...new Set(models.map((model) => model.provider))],
    });
  }
  async attachModelBroker(client: WslHostClient) {
    client.setModelBroker(async (request, signal) => {
      if (!this.remoteBrokerModels.has(`${request.provider}\0${request.modelId}`))
        throw new Error("The remote host requested a model that is not enabled locally");
      const runtime = await this.pi.modelRuntime();
      const model = runtime.getModel(request.provider, request.modelId);
      if (!model) throw new Error("The requested desktop model was not found");
      return runtime.streamSimple(model, request.context, {
        ...brokerOptions(request.options),
        signal,
      });
    });
    await this.syncModelBroker(client);
  }
  async closeWsl() {
    this.stopWslEvents?.();
    this.stopWslEvents = undefined;
    const client = this.wsl;
    this.wsl = undefined;
    this.wslSettings = undefined;
    this.remoteBrokerModels.clear();
    await client?.dispose();
  }
  async connectWsl(distro: string, cwd: string, browse = false) {
    await this.closeWsl();
    const client = await WslHostClient.installed({ distro, cwd });
    this.wsl = client;
    this.stopWslEvents = client.onEvent((event) => this.remoteEvent(event));
    this.current = undefined;
    this.project = {
      name: posix.basename(cwd.replace(/\/+$/, "")) || cwd,
      path: cwd,
      remote: { kind: "wsl", distro },
    };
    if (browse) return { project: this.project };
    try {
      await this.attachModelBroker(client);
      return await this.wslBootstrap();
    } catch (error) {
      await this.closeWsl();
      throw error;
    }
  }
  async connectSsh(host: string, cwd: string, browse = false) {
    await this.closeWsl();
    const client = await WslHostClient.connectSsh(host, cwd);
    this.wsl = client;
    this.stopWslEvents = client.onEvent((event) => this.remoteEvent(event));
    this.current = undefined;
    const remoteCwd = client.hello.cwd;
    this.project = {
      name: posix.basename(remoteCwd.replace(/\/+$/, "")) || remoteCwd,
      path: remoteCwd,
      remote: { kind: "ssh", host },
    };
    if (browse) return { project: this.project };
    try {
      await this.attachModelBroker(client);
      return await this.wslBootstrap();
    } catch (error) {
      await this.closeWsl();
      throw error;
    }
  }
  async openRemoteProject(path: string) {
    const remote = this.project?.remote;
    if (!this.wsl || !remote)
      throw new Error("Remote host is not connected");
    const selected = await this.wsl.request<{ path: string }>("workspace.open", {
      path,
    });
    await this.attachModelBroker(this.wsl);
    this.current = undefined;
    this.project = {
      name: posix.basename(selected.path.replace(/\/+$/u, "")) || selected.path,
      path: selected.path,
      remote,
    };
    return this.wslBootstrap();
  }
  async invokeWsl(route: ProjectRoute, v: Record<string, unknown>) {
    if (!this.wsl) throw new Error("Remote host is not connected");
    if (route === "agent.control") {
      const action = String(v.action);
      if (action === "getProviders" || action === "getModels")
        return this.pi.control(v as unknown as AgentControl);
      if (action === "loginApiKey" || action === "loginOAuth" || action === "refreshModels") {
        const result = await this.pi.control(v as unknown as AgentControl);
        await this.syncModelBroker(this.wsl);
        return result;
      }
      if (action === "logout") {
        const result = await this.pi.control(v as unknown as AgentControl);
        await this.syncModelBroker(this.wsl);
        return result;
      }
    }
    if (route === "session.delete") {
      if (
        v.confirmed !== true &&
        this.settings.bundle().app.confirmDestructiveActions &&
        !(await this.platform.confirm("Delete this Pi session in WSL?", String(v.path)))
      )
        return { cancelled: true, sessions: await this.wsl.request("session.list") };
    } else if (route === "shell.run") {
      const command = String(v.command);
      const trust = this.wslSettings?.effective.defaultProjectTrust ?? "ask";
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
      const trust = this.wslSettings?.effective.defaultProjectTrust ?? "ask";
      if (trust === "never") throw new Error("Terminal is disabled for this remote project");
      const session = await this.wsl.request<TerminalSession>(route, v);
      if (!session?.id)
        throw new Error(
          "Remote host returned an invalid terminal session. Disconnect and reconnect the remote workspace.",
        );
      return session;
    } else if (route === "settings.get") {
      this.wslSettings = await this.wsl.request<SettingsBundle>(route, v);
      return this.mergedWslSettings(this.wslSettings);
    } else if (route === "settings.update" || route === "settings.reset") {
      if (v.scope === "app") {
        const local =
          route === "settings.update"
            ? this.settings.update(
                "app",
                v.patch as Record<string, unknown>,
                v.replace === true,
              )
            : this.settings.reset("app");
        return this.wslSettings
          ? { ...this.mergedWslSettings(this.wslSettings), app: local.app }
          : local;
      }
      this.wslSettings = await this.wsl.request<SettingsBundle>(route, v);
      return this.mergedWslSettings(this.wslSettings);
    }
    const result = await this.wsl.request(route, v);
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
    )
      this.rememberSnapshot(result as SessionSnapshot);
    return result;
  }
  projectGroups(): ProjectGroup[] {
    const active = this.project ? projectId(this.project) : "";
    return this.settings.projectHistory().map((record) => ({
      ...record,
      connected: record.project.remote
        ? Boolean(this.wsl && record.id === active)
        : record.id === active,
    }));
  }
  rememberProject(sessions: SessionSummary[]) {
    if (!this.project) return this.projectGroups();
    this.settings.rememberProject(this.project, sessions);
    return this.projectGroups();
  }
  rememberSnapshot(snapshot: SessionSnapshot) {
    const project = this.project;
    if (!project) return;
    const old = this.settings.projectHistory().find(
      (record) => record.id === projectId(project),
    )?.sessions ?? [];
    this.rememberProject([
      snapshot.session,
      ...old.filter((session) => session.path !== snapshot.session.path),
    ]);
  }
  async sessions() {
    try {
      const s = await this.pi.list();
      return (s.length ? s : this.files.list()).map((x) => ({
        ...x,
        active: x.path === this.current?.session.path,
      }));
    } catch {
      return this.files
        .list()
        .map((x) => ({ ...x, active: x.path === this.current?.session.path }));
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
    if (route === "wsl.list") return WslHostClient.distributions();
    if (route === "wsl.names") return WslHostClient.names();
    if (route === "ssh.list") return listSshHosts();
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
      await this.closeWsl();
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
        "session.import",
        "session.rename",
        "session.delete",
        "workspace.tree",
        "workspace.read",
        "workspace.write",
        "git.status",
        "git.diff",
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
        await this.closeWsl();
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
      case "session.open": {
        const p = this.files.managed(String(v.path));
        try {
          this.current = await this.pi.open(p);
        } catch (e) {
          this.current = this.fallback(p);
          this.emit({
            type: "notice",
            payload: {
              level: "warning",
              message: `Read-only session: ${e instanceof Error ? e.message : String(e)}`,
            },
          });
        }
        this.rememberSnapshot(this.current);
        return this.current;
      }
      case "session.import": {
        const p = await this.platform.pickSession();
        if (!p) return null;
        try {
          await this.pi.validate(p);
        } catch {}
        const imported = this.files.import(p);
        return { imported, sessions: await this.sessions() };
      }
      case "session.rename": {
        const p = this.files.managed(String(v.path)),
          name = String(v.name);
        if (this.current?.session.path === p && this.current.runtime.available)
          this.current = (await this.pi.control({
            action: "setName",
            name,
          })) as SessionSnapshot;
        else
          try {
            await this.pi.rename(p, name);
          } catch {
            this.files.rename(p, name);
          }
        const sessions = await this.sessions();
        this.rememberProject(sessions);
        return { sessions, current: this.current };
      }
      case "session.delete": {
        const p = this.files.managed(String(v.path));
        if (
          v.confirmed !== true &&
          this.settings.bundle().app.confirmDestructiveActions &&
          !(await this.platform.confirm("Delete this Pi session?", p))
        )
          return { cancelled: true, sessions: await this.sessions() };
        if (this.pi.state().sessionFile === p) await this.pi.close();
        this.files.delete(p);
        if (this.current?.session.path === p) this.current = undefined;
        const sessions = await this.sessions();
        this.rememberProject(sessions);
        this.emit({ type: "sessions", payload: { deletedPath: p, sessions } });
        return { sessions };
      }
      case "agent.control": {
        const r = await this.pi.control(v as unknown as AgentControl);
        if (r && typeof r === "object" && "projection" in r) {
          this.current = r as SessionSnapshot;
          // Mutating actions append entries after the last agent event (e.g.
          // the node-footer usage record written when a prompt settles), and
          // the invoke reply only reaches the page that started the action —
          // a page reloaded mid-run loses it. Broadcast so every attached
          // renderer converges on the settled state.
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
        const b = this.settings.update(
          v.scope as "app" | "global" | "project",
          v.patch as Record<string, unknown>,
          v.replace === true,
        );
        if (v.scope === "project" && this.project) {
          const d = configuredSessionDir(this.project.path, b);
          this.files.set(this.project.path, d);
          if (d !== previousDir) {
            this.pi.setProject(this.project.path, d);
            this.current = undefined;
          }
        }
        return b;
      }
      case "settings.reset":
        return this.settings.reset(v.scope as "app" | "global" | "project");
      case "layout.save":
        this.settings.saveLayout(v.layout as unknown as any);
        return { ok: true };
    }
  }
  dispose() {
    void this.closeWsl();
    this.shell.dispose();
    this.pi.dispose();
  }
}
