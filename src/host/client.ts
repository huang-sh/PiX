import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { pixHome } from "../main/paths.js";
import type { Platform } from "../main/controller.js";
import { PIX_HOST_VERSION, MAX_REMOTE_PAYLOAD } from "../shared/remote-protocol.js";
import { LOCAL_HOST_PROTOCOL, type HostAddress, type LocalMessage, type LocalRequest } from "../shared/host-protocol.js";
import { sessionEventDecoder } from "../shared/session-updates.js";
import type { DesktopEvent, DesktopRoute } from "../shared/types.js";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const runDir = () => join(pixHome(), ".pix", "run");
const addressFile = () => join(runDir(), "host.json");
class StaleHostAddress extends Error {}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function readAddress(): HostAddress | undefined {
  try {
    const value = JSON.parse(readFileSync(addressFile(), "utf8")) as HostAddress;
    if (!Number.isInteger(value.pid) || !Number.isInteger(value.port) || typeof value.token !== "string" || !alive(value.pid)) return;
    return value;
  } catch { return; }
}
export function localHostEntry() {
  let dir = dirname(fileURLToPath(import.meta.url));
  if (basename(dir) === "chunks") dir = dirname(dir);
  const candidates = [
    process.env.PIX_HOST_ENTRY,
    join(dir, "pix-host.js"),
    join(dir, "index.js"),
    join(dir, "../../server/dist/host/index.js"),
  ].filter((path): path is string => Boolean(path));
  const entry = candidates.find(path => existsSync(path));
  if (!entry) throw new Error("PiX host build is missing. Run npm run build:cli first.");
  return entry;
}

export class HostClient {
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(event: DesktopEvent) => void>();
  private closeListeners = new Set<(error: Error) => void>();
  readonly address: HostAddress;
  private constructor(private socket: WebSocket, address: HostAddress, private platform?: Platform) {
    this.address = address;
    const decode = sessionEventDecoder(() => this.invoke("session.snapshot"));
    socket.on("message", data => {
      try {
        const message = JSON.parse(data.toString()) as LocalMessage;
        if (message.type === "reply") {
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id); clearTimeout(pending.timer);
            message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
          }
        } else if (message.type === "event") {
          const event = decode(message.event);
          if (event) for (const listener of this.listeners) listener(event);
        } else if (message.type === "platform") {
          void (async () => {
            try {
              const method = this.platform?.[message.method as keyof Platform];
              if (typeof method !== "function" || !Object.hasOwn(this.platform!, message.method)) throw new Error("Desktop capability is unavailable");
              const result = await (method as (...args: unknown[]) => unknown)(...message.args);
              this.send({ type: "platform.reply", id: message.id, result });
            } catch (error) {
              this.send({ type: "platform.reply", id: message.id, error: error instanceof Error ? error.message : String(error) });
            }
          })();
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.on("error", () => {});
    socket.once("close", () => {
      const error = new Error("PiX host disconnected. Reconnect to inspect the saved session before retrying a task.");
      this.fail(error);
      for (const listener of this.closeListeners) listener(error);
    });
  }
  get connected() { return this.socket.readyState === WebSocket.OPEN; }
  private send(message: unknown) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  private fail(error: Error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  static async connect(address: HostAddress, cwd: string | null, platform?: Platform, clientId?: string, imageReferences = false) {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${encodeURIComponent(address.token)}`, { maxPayload: MAX_REMOTE_PAYLOAD });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("PiX host connection timed out")); }, 5000);
      socket.once("open", () => { clearTimeout(timer); resolve(); });
      socket.once("error", error => {
        clearTimeout(timer);
        const code = (error as NodeJS.ErrnoException).code;
        reject(code === "ECONNREFUSED" || code === "ECONNRESET" ? new StaleHostAddress(error.message, { cause: error }) : error);
      });
      socket.once("unexpected-response", (_request, response) => {
        clearTimeout(timer);
        response.resume();
        const message = `Unexpected server response: ${response.statusCode}`;
        // PiX rejects failed authentication with 401. A normal HTTP page or
        // missing endpoint means this port has been reused by another service.
        reject(response.statusCode === 200 || response.statusCode === 404 ? new StaleHostAddress(message) : new Error(message));
        socket.terminate();
      });
    });
    if (address.protocol !== LOCAL_HOST_PROTOCOL || address.version !== PIX_HOST_VERSION) {
      socket.close();
      throw new Error("The running PiX host has a different version. Stop it after its tasks finish, then reconnect.");
    }
    const client = new HostClient(socket, address, platform);
    try { await client.request({ method: "attach", cwd, platform: Boolean(platform),
      keepAwake: typeof platform?.setKeepAwake === "function", clientId, imageReferences }); }
    catch (error) { client.close(); throw error; }
    return client;
  }
  request<T = unknown>(request: Omit<LocalRequest, "id" | "type">, timeoutMs = 300_000): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("PiX host is disconnected"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("PiX host request timed out; execution may still be running. Inspect the session before retrying.")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: "request", id, ...request });
    });
  }
  invoke<T = unknown>(route: DesktopRoute, input?: unknown, sessionPath?: string) {
    return this.request<T>({ method: "invoke", route, input, sessionPath });
  }
  onEvent(listener: (event: DesktopEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onDisconnect(listener: (error: Error) => void) { this.closeListeners.add(listener); return () => { this.closeListeners.delete(listener); }; }
  close() { this.socket.close(); }
}

/** All entry points discover the same per-profile host; startup is serialized. */
export async function connectLocalHost(cwd: string | null, platform?: Platform, start = true, clientId?: string, imageReferences = false): Promise<HostClient> {
  let staleAddress: string | undefined;
  const connect = async () => {
    const address = readAddress();
    if (!address || JSON.stringify(address) === staleAddress) return;
    for (let attempt = 0; ; attempt++) {
      try { return await HostClient.connect(address, cwd, platform, clientId, imageReferences); }
      catch (error) {
        if (!(error instanceof StaleHostAddress)) throw error;
        // Retry a transient handshake reset before replacing the host address.
        if (attempt === 0 && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ECONNRESET") {
          await delay(50); continue;
        }
        staleAddress = JSON.stringify(address);
        return;
      }
    }
  };
  let client = await connect();
  if (client) return client;
  if (!start) throw new Error("PiX host is not running");
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const lock = join(runDir(), "starting");
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    client = await connect();
    if (client) return client;
    try { mkdirSync(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
        if (!alive(pid)) rmSync(lock, { recursive: true, force: true });
      } catch {
        try { if (Date.now() - statSync(lock).mtimeMs > 35_000) rmSync(lock, { recursive: true, force: true }); } catch {}
      }
      await delay(50); continue;
    }
    try {
      writeFileSync(join(lock, "pid"), String(process.pid));
      // Another starter may have published its address just before our mkdir.
      client = await connect();
      if (client) return client;
      const log = openSync(join(runDir(), "host.log"), "a", 0o600);
      const child = spawn(process.execPath, [localHostEntry()], {
        detached: true, windowsHide: true, stdio: ["ignore", log, log],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      closeSync(log);
      let spawnError: Error | undefined;
      child.once("error", error => { spawnError = error; });
      child.unref();
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        client = await connect();
        if (client) return client;
        if (child.exitCode !== null) throw new Error(`PiX host failed to start. See ${join(runDir(), "host.log")}`);
        await delay(50);
      }
      child.kill();
      throw new Error(`PiX host startup timed out. See ${join(runDir(), "host.log")}`);
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  throw new Error("Timed out waiting for another PiX host starter");
}
