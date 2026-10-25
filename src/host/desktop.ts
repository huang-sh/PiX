import { SettingsService } from "../main/services.js";
import type { Platform } from "../main/controller.js";
import type { DesktopEvent, DesktopRoute, SessionSnapshot } from "../shared/types.js";
import { connectLocalHost, type HostClient } from "./client.js";

/** Electron retains OS integration while the independent host owns execution. */
export class DesktopHostController {
  readonly settings: SettingsService;
  private listeners = new Set<(event: DesktopEvent) => void>();
  private sessionPath?: string;
  private disposed = false;
  private reconnecting?: Promise<void>;
  private constructor(private client: HostClient, path: string | null, private platform: Platform) {
    this.settings = new SettingsService(path);
    this.bind(client);
  }
  static async connect(path: string | null, platform: Platform) {
    return new DesktopHostController(await connectLocalHost(path, platform), path, platform);
  }
  private bind(client: HostClient) {
    client.onEvent(event => {
      const current = (event.payload as { current?: SessionSnapshot } | undefined)?.current;
      if (current) this.sessionPath = current.session.path;
      this.emit(event);
    });
    client.onDisconnect(error => {
      if (this.disposed || this.client !== client) return;
      this.emit({ type: "notice", payload: { level: "warning", message: error.message } });
      void this.reconnect().catch(failure => this.emit({ type: "notice", payload: { level: "error", message: String(failure) } }));
    });
  }
  private reconnect() {
    return this.reconnecting ??= (async () => {
      // Restore subscriptions and snapshots; never replay an execution command.
      const client = await connectLocalHost(this.settings.project, this.platform);
      if (this.disposed) { client.close(); return; }
      this.client = client;
      this.bind(client);
      if (this.sessionPath) {
        const current = await client.invoke<SessionSnapshot>("session.open", { path: this.sessionPath });
        this.emit({ type: "sessions", payload: { current, resync: true } });
      }
    })().finally(() => { this.reconnecting = undefined; });
  }
  async invoke(route: DesktopRoute, input?: unknown) {
    if (!this.client.connected) await this.reconnect();
    const result = await this.client.invoke<any>(route, input);
    if (result && "project" in Object(result)) {
      this.settings.setProject(result.project?.remote ? null : result.project?.path ?? null);
      this.sessionPath = result.current?.session.path;
    } else if (result?.session?.path) this.sessionPath = result.session.path;
    return result;
  }
  onEvent(listener: (event: DesktopEvent) => void, _patches = false) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: DesktopEvent) { for (const listener of this.listeners) listener(event); }
  detach() { this.disposed = true; this.client.close(); return Promise.resolve(); }
  dispose() { this.disposed = true; this.client.close(); this.listeners.clear(); }
}
