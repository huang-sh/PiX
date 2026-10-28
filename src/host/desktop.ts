import { SettingsService } from "../main/services.js";
import { randomUUID } from "node:crypto";
import type { Platform } from "../main/controller.js";
import type { DesktopEvent, DesktopRoute, SessionSnapshot } from "../shared/types.js";
import { sessionEventEncoder } from "../shared/session-updates.js";
import { connectLocalHost, type HostClient } from "./client.js";
import { debugLog } from "../main/debug-log.js";

/** Electron retains OS integration while the independent host owns execution. */
export class DesktopHostController {
  readonly settings: SettingsService;
  private listeners = new Set<(event: DesktopEvent) => void>();
  private sessionPath?: string;
  private disposed = false;
  private reconnecting?: Promise<void>;
  private constructor(private client: HostClient, path: string | null, private platform: Platform, private readonly clientId: string) {
    this.settings = new SettingsService(path);
    this.bind(client);
  }
  static async connect(path: string | null, platform: Platform, clientId: string = randomUUID()) {
    return new DesktopHostController(await connectLocalHost(path, platform, true, clientId, true), path, platform, clientId);
  }
  private bind(client: HostClient) {
    client.onEvent(event => {
      const current = (event.payload as { current?: SessionSnapshot } | undefined)?.current;
      if (current) this.sessionPath = current.session.path;
      this.emit(event);
    });
    client.onDisconnect(error => {
      if (this.disposed || this.client !== client) return;
      void this.releaseKeepAwake();
      this.emit({ type: "notice", payload: { level: "warning", message: error.message } });
      void this.reconnect().catch(failure => this.emit({ type: "notice", payload: { level: "error", message: String(failure) } }));
    });
  }
  private reconnect() {
    return this.reconnecting ??= (async () => {
      // Restore subscriptions and snapshots; never replay an execution command.
      const client = await connectLocalHost(this.settings.project, this.platform, true, this.clientId, true);
      if (this.disposed) { client.close(); return; }
      this.client = client;
      this.bind(client);
      const path = this.sessionPath;
      const restored = await client.invoke<any>("app.bootstrap");
      this.settings.setProject(restored.project?.remote ? null : restored.project?.path ?? null);
      if (restored.current || path) {
        const current = restored.current ?? await client.invoke<SessionSnapshot>("session.open", { path });
        this.sessionPath = current.session.path;
        this.emit({ type: "sessions", payload: { current, resync: true } });
        await client.invoke("session.snapshot");
      }
    })().finally(() => { this.reconnecting = undefined; });
  }
  async invoke(route: DesktopRoute, input?: unknown) {
    if (route === "app.quit") {
      await this.platform.quit();
      return { ok: true };
    }
    if (!this.client.connected) await this.reconnect();
    const result = await this.client.invoke<any>(route, input);
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
  detach() { this.disposed = true; this.client.close(); return this.releaseKeepAwake(); }
  dispose() { this.disposed = true; this.client.close(); void this.releaseKeepAwake(); this.listeners.clear(); }
}
