import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { pixHome } from "../main/paths.js";
import { isNewerVersion } from "../main/update-check.js";
import type { Platform } from "../main/controller.js";
import { PIX_HOST_VERSION, MAX_REMOTE_PAYLOAD } from "../shared/remote-protocol.js";
import { LOCAL_HOST_PROTOCOL, type HostAddress, type HostConnectionState, type LocalMessage, type LocalRequest } from "../shared/host-protocol.js";
import { sessionEventDecoder } from "../shared/session-updates.js";
import type { DesktopEvent, DesktopRoute } from "../shared/types.js";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const runDir = () => join(pixHome(), ".pix", "run");
const addressFile = () => join(runDir(), "host.json");
class StaleHostAddress extends Error {}
class OutdatedHost extends Error {}
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
  /** Authenticated management connection; does not attach a desktop or project. */
  static async open(address: HostAddress, platform?: Platform) {
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
    return new HostClient(socket, address, platform);
  }
  static async stopOutdated(address: HostAddress) {
    const client = await HostClient.open(address);
    try {
      const status = await client.request<{ clients: number }>({ method: "status" }, 5000);
      if (status?.clients !== 1) throw new Error("Close other PiX windows and terminal clients before upgrading the host");
      const result = await client.request<{ stopped: boolean }>({ method: "shutdown" }, 5000);
      if (result?.stopped !== true) throw new Error("PiX host did not confirm shutdown");
    } finally { await client.close(); }
  }
  static async connect(address: HostAddress, cwd: string | null, platform?: Platform, clientId?: string, imageReferences = false, legacyClientId?: string) {
    const client = await HostClient.open(address, platform);
    if (address.protocol !== LOCAL_HOST_PROTOCOL || address.version !== PIX_HOST_VERSION) {
      await client.close();
      const ErrorType = address.protocol === LOCAL_HOST_PROTOCOL && isNewerVersion(PIX_HOST_VERSION, address.version) ? OutdatedHost : Error;
      throw new ErrorType("The running PiX host has a different version. Stop it after its tasks finish, then reconnect.");
    }
    if (legacyClientId && address.desktopViewMigration !== true) {
      await client.close();
      throw new Error("The running PiX host cannot migrate the previous desktop view. Finish its tasks using the previous client, then stop the host and reopen PiX.");
    }
    try { await client.request({ method: "attach", cwd, platform: Boolean(platform),
      keepAwake: typeof platform?.setKeepAwake === "function", clientId, imageReferences, legacyClientId }); }
    catch (error) { await client.close(); throw error; }
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
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => this.socket.terminate(), 1000);
      this.socket.once("close", () => { clearTimeout(timer); resolve(); });
      this.socket.close();
    });
  }
}

const hostId = (address: HostAddress) => createHash("sha256").update(JSON.stringify(address)).digest("hex");
interface HostStatus {
  pid: number; version: string; protocol: number; clients: number; running: string[];
  pending?: boolean; stopping?: boolean; remoteConnections?: number; commands?: number; terminals?: number;
}
async function verifiedStatus(client: HostClient) {
  const status = await client.request<HostStatus>({ method: "status" }, 5000);
  if (status?.pid !== client.address.pid || status.version !== client.address.version || status.protocol !== client.address.protocol)
    throw new Error("The PiX host identity changed. Retry the connection before restarting it.");
  return status;
}
export async function inspectLocalHost() {
  const address = readAddress();
  if (!address) return;
  const client = await HostClient.open(address);
  try { return { id: hostId(address), status: await verifiedStatus(client) }; }
  finally { await client.close(); }
}
export async function localHostStatus(): Promise<HostConnectionState> {
  const state: HostConnectionState = { connected: false, version: PIX_HOST_VERSION };
  const address = readAddress();
  if (!address) return state;
  state.host = { id: hostId(address), version: address.version, verified: false };
  try {
    const inspected = await inspectLocalHost();
    if (!inspected) { delete state.host; return state; }
    const { id, status } = inspected;
    state.host = { id, version: status.version, verified: true, clients: Math.max(0, status.clients - 1),
      running: status.running.length, pending: status.pending, stopping: status.stopping, remoteConnections: status.remoteConnections,
      commands: status.commands, terminals: status.terminals };
  } catch (error) { state.error = error instanceof Error ? error.message : String(error); }
  return state;
}

/** Force is only used after an explicit user choice, against the inspected host. */
export async function stopLocalHost(expectedId: string, force = false, quitClients = false) {
  const address = readAddress();
  if (!address) return;
  if (hostId(address) !== expectedId) throw new Error("The PiX host changed. Review its current status before restarting it.");
  const client = await HostClient.open(address);
  try {
    const status = await verifiedStatus(client);
    if (!force && status.clients !== 1) throw new Error("Close other PiX windows and terminal clients before restarting the host");
    try {
      const result = await client.request<{ stopped: boolean }>({ method: "shutdown", force, quitClients }, 5000);
      if (result?.stopped !== true) throw new Error("PiX host did not confirm shutdown");
    } catch (error) {
      if (!force) throw error;
      // Older hosts do not understand force. Their SIGTERM handler still
      // cancels work and saves sessions before releasing the profile.
      const current = readAddress();
      if (!current) return;
      if (hostId(current) !== expectedId) throw error;
      if (alive(address.pid)) process.kill(address.pid, "SIGTERM");
    }
    const deadline = Date.now() + 10_000;
    while (true) {
      const current = readAddress();
      if (!current || hostId(current) !== expectedId) break;
      if (Date.now() >= deadline) {
        if (!force) throw new Error("PiX host is still shutting down. Retry in a moment.");
        process.kill(address.pid, "SIGKILL");
        // Never remove an address published by a replacement host.
        const remaining = readAddress();
        if (!remaining || hostId(remaining) === expectedId) rmSync(addressFile(), { force: true });
        return;
      }
      await delay(50);
    }
  } finally { await client.close(); }
}

/** Keep the startup lock until the replacement is ready, so older clients cannot respawn their host. */
export function restartLocalHost(id: string, force = false) {
  return connectLocalHost(null, undefined, true, undefined, false, undefined, { id, force });
}

/** Keep every starter out while an installer replaces the executable. */
export function withStoppedLocalHost<T>(id: string | undefined, force: boolean, install: () => Promise<T>, quitClients = false) {
  return withStartupLock(Date.now() + 35_000, async () => {
    if (id) await stopLocalHost(id, force, quitClients);
    if (readAddress()) throw new Error("The PiX host changed. Review its current status before installing.");
    return install();
  });
}

async function withStartupLock<T>(deadline: number, action: () => Promise<T>): Promise<T> {
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const lock = join(runDir(), "starting");
  while (Date.now() < deadline) {
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
      return await action();
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  throw new Error("Timed out waiting for another PiX host starter");
}

/** All entry points discover the same per-profile host; startup is serialized. */
export async function connectLocalHost(cwd: string | null, platform?: Platform, start = true, clientId?: string, imageReferences = false, legacyClientId?: string, restart?: { id: string; force: boolean }): Promise<HostClient> {
  let staleAddress: string | undefined;
  const deadline = Date.now() + 35_000;
  const connect = async (upgrade = false): Promise<HostClient | undefined> => {
    const address = readAddress();
    if (!address || JSON.stringify(address) === staleAddress) return;
    for (let attempt = 0; ; attempt++) {
      try { return await HostClient.connect(address, cwd, platform, clientId, imageReferences, legacyClientId); }
      catch (error) {
        if (error instanceof OutdatedHost && start) {
          if (!upgrade) return;
          // Only the startup lock holder may stop an older host. The host's
          // shutdown guard preserves pending tasks and remote connections.
          try { await HostClient.stopOutdated(address); }
          catch (cause) {
            throw new Error(`${error.message} ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
          }
          while (JSON.stringify(readAddress()) === JSON.stringify(address)) {
            if (Date.now() >= deadline) throw new Error("Timed out waiting for the previous PiX host to finish shutting down");
            await delay(50);
          }
          return connect();
        }
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
  let client = restart ? undefined : await connect();
  if (client) return client;
  if (!start) throw new Error("PiX host is not running");
  return withStartupLock(deadline, async () => {
    if (restart) {
      await stopLocalHost(restart.id, restart.force);
      restart = undefined;
    }
    // Another starter may have published its address just before our mkdir.
    client = await connect(true);
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
  });
}
