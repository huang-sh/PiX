import { SettingsService } from "../main/services.js";
import { createHash, randomUUID } from "node:crypto";
import type { Platform } from "../main/controller.js";
import type { DesktopEvent, DesktopRoute, SessionSnapshot } from "../shared/types.js";
import { sessionEventEncoder } from "../shared/session-updates.js";
import { connectLocalHost, localHostStatus, restartLocalHost, type HostClient } from "./client.js";
import { debugLog, logFile } from "../main/debug-log.js";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Packaged clients keep their existing identity; dev worktrees own separate views. */
export function desktopClientId(userData: string, appPath: string, isPackaged: boolean) {
  const identity = isPackaged ? userData : JSON.stringify([userData, appPath]);
  return `desktop-${createHash("sha256").update(identity).digest("hex")}`;
}

/** Electron retains OS integration while the independent host owns execution. */
export class DesktopHostController {
  readonly settings: SettingsService;
  private listeners = new Set<(event: DesktopEvent) => void>();
  private sessionPath?: string;
  private disposed = false;
  private reconnecting?: Promise<void>;
  private restarting?: Promise<void>;
  private connectionAbort = new AbortController();
  private connectionError?: string;
  private quitting = false;
  hostShutdownRequested = false;
  private constructor(private client: HostClient | undefined, path: string | null, private platform: Platform, private readonly clientId: string, private legacyClientId?: string) {
    this.settings = new SettingsService(path);
    if (client) this.bind(client);
  }
  /** Create the window independently; a blocked host is recovered inside it. */
  static create(path: string | null, platform: Platform, clientId: string = randomUUID(), legacyClientId?: string) {
    return new DesktopHostController(undefined, path, platform, clientId, legacyClientId);
  }
  static async connect(path: string | null, platform: Platform, clientId: string = randomUUID(), legacyClientId?: string) {
    return new DesktopHostController(await connectLocalHost(path, platform, true, clientId, true, legacyClientId), path, platform, clientId);
  }
  private bind(client: HostClient) {
    client.onEvent(event => {
      if (event.type === "host.shutdown") {
        this.prepareForInstallQuit();
        void Promise.resolve(this.platform.quit()).catch(error => debugLog("desktop: host requested quit", error));
        return;
      }
      const current = (event.payload as { current?: SessionSnapshot } | undefined)?.current;
      if (current) this.sessionPath = current.session.path;
      this.emit(event);
    });
    client.onDisconnect(error => {
      if (this.disposed || this.quitting || this.client !== client) return;
      void this.releaseKeepAwake();
      const recovery = this.reconnect();
      this.emit({ type: "host.connection", payload: { connected: false, reconnecting: true } });
      void recovery.catch(failure => {
        if (this.disposed || this.quitting || this.hostShutdownRequested) return;
        this.emit({ type: "notice", payload: { level: "error", message: String(failure) } });
        this.emit({ type: "host.connection", payload: { connected: false } });
      });
    });
  }
  private reconnect() {
    if (this.reconnecting) return this.reconnecting;
    if (this.disposed || this.quitting || this.hostShutdownRequested) return Promise.resolve();
    const abort = this.connectionAbort;
    return this.reconnecting = (async () => {
      // Restore subscriptions and snapshots; never replay an execution command.
      const restore = Boolean(this.client);
      const client = await connectLocalHost(this.settings.project, this.platform, true, this.clientId, true, this.legacyClientId, undefined, abort.signal);
      if (this.disposed || this.quitting) { await client.close(); return; }
      this.client = client;
      this.legacyClientId = undefined;
      this.connectionError = undefined;
      this.bind(client);
      if (client.shutdownRequested) return;
      if (!restore) {
        this.emit({ type: "host.connection", payload: { connected: true } });
        return;
      }
      const path = this.sessionPath;
      const restored = await client.invoke<any>("app.bootstrap");
      abort.signal.throwIfAborted();
      this.settings.setProject(restored.project?.remote ? null : restored.project?.path ?? null);
      if (restored.current || path) {
        const current = restored.current ?? await client.invoke<SessionSnapshot>("session.open", { path });
        abort.signal.throwIfAborted();
        this.sessionPath = current.session.path;
        this.emit({ type: "sessions", payload: { current, resync: true } });
        await client.invoke("session.snapshot");
        abort.signal.throwIfAborted();
      }
      this.emit({ type: "host.connection", payload: { connected: true } });
    })().catch(error => {
      if (!abort.signal.aborted) this.connectionError = error instanceof Error ? error.message : String(error);
      throw error;
    }).finally(() => { this.reconnecting = undefined; });
  }
  /** Warm the host's shared Pixie and model catalog without delaying the window. */
  prewarmPixie(): void {
    void this.invoke("pixie.ensure").catch(error => debugLog("prewarm: pixie", error));
    void this.invoke("agent.control", { action: "getModels" }).catch(error => debugLog("prewarm: models", error));
  }
  async invoke(route: DesktopRoute, input?: unknown) {
    if (route === "app.quit") {
      await this.platform.quit();
      return { ok: true };
    }
    if (route === "app.revealLogs") {
      const file = logFile();
      mkdirSync(dirname(file), { recursive: true });
      await this.platform.showItemInFolder(existsSync(file) ? file : dirname(file));
      return { ok: true };
    }
    if (route === "app.hostStatus") {
      const state = await localHostStatus();
      return { ...state, connected: Boolean(this.client?.connected), language: this.settings.bundle().app.language,
        error: this.connectionError ?? state.error };
    }
    if (this.disposed || this.quitting) throw new Error("PiX is quitting");
    if (route === "app.hostRestart") {
      const { id, force } = input as { id?: unknown; force?: unknown } ?? {};
      if (typeof id !== "string" || typeof force !== "boolean") throw new Error("Review the host status before restarting it");
      await (this.restarting ??= restartLocalHost(id, force, this.connectionAbort.signal)
        .then(replacement => replacement.close())
        .finally(() => { this.restarting = undefined; }));
      return { stopped: true };
    }
    if (!this.client?.connected) await this.reconnect();
    if (this.disposed || this.quitting) throw new Error("PiX is quitting");
    const result = await this.client!.invoke<any>(route, input);
    if (result && "project" in Object(result)) {
      this.settings.setProject(result.project?.remote ? null : result.project?.path ?? null);
      this.sessionPath = result.current?.session.path;
    } else if (result?.session?.path) this.sessionPath = result.session.path;
    return result;
  }
  onEvent(listener: (event: DesktopEvent) => void, patches = false) {
    // HostClient decodes the host's deltas; each IPC subscriber needs its own encoding.
    const encode = patches ? sessionEventEncoder() : undefined;
    const subscribed = encode ? (event: DesktopEvent) => listener(encode(event)) : listener;
    this.listeners.add(subscribed);
    return () => this.listeners.delete(subscribed);
  }
  emit(event: DesktopEvent) { for (const listener of this.listeners) listener(event); }
  private async releaseKeepAwake() {
    try { await this.platform.setKeepAwake?.(false); }
    catch (error) { debugLog("desktop: release keep awake", error); }
  }
  async detach() {
    this.disposed = true;
    this.connectionAbort.abort(new Error("PiX is quitting"));
    await Promise.all([this.client?.close(), this.releaseKeepAwake()]);
  }
  prepareForInstallQuit() {
    if (this.hostShutdownRequested) return;
    this.hostShutdownRequested = true;
    this.quitting = true;
    this.connectionAbort.abort(new Error("PiX is quitting"));
    this.emit({ type: "host.shutdown", payload: {} });
    void this.client?.close();
  }
  async disconnectForQuit() {
    this.quitting = true;
    this.connectionAbort.abort(new Error("PiX is quitting"));
    // A spawned host must publish its address before Quit inspects it again.
    await Promise.all([this.client?.close(), this.releaseKeepAwake(),
      this.reconnecting?.catch(() => {}), this.restarting?.catch(() => {})]);
  }
  async resumeAfterCancelledQuit() {
    if (this.disposed || this.hostShutdownRequested) return;
    await Promise.all([this.reconnecting?.catch(() => {}), this.restarting?.catch(() => {})]);
    if (this.disposed || this.hostShutdownRequested) return;
    this.connectionAbort = new AbortController();
    this.quitting = false;
    try { await this.reconnect(); }
    catch (error) {
      if (this.disposed || this.quitting || this.hostShutdownRequested) return;
      this.emit({ type: "host.connection", payload: { connected: false } });
      throw error;
    }
  }
  dispose() {
    this.disposed = true;
    this.connectionAbort.abort(new Error("PiX is quitting"));
    this.client?.close();
    void this.releaseKeepAwake();
    this.listeners.clear();
  }
}
