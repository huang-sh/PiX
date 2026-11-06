import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chownSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
class StoppingHost extends Error {}
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
  private shutdownEvent?: DesktopEvent;
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
          if (event?.type === "host.shutdown") {
            if (this.shutdownEvent) return;
            this.shutdownEvent = event;
          }
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
  get shutdownRequested() { return Boolean(this.shutdownEvent); }
  private send(message: unknown) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  private fail(error: Error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  /** Authenticated management connection; does not attach a desktop or project. */
  static async open(address: HostAddress, platform?: Platform, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/?token=${encodeURIComponent(address.token)}`, { maxPayload: MAX_REMOTE_PAYLOAD });
    const abort = () => socket.terminate();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const client = await new Promise<HostClient>((resolve, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(new Error("PiX host connection timed out")); }, 5000);
        socket.once("open", () => {
          clearTimeout(timer);
          // Handshake data may already contain events. Bind before yielding.
          resolve(new HostClient(socket, address, platform));
        });
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
      signal?.throwIfAborted();
      return client;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally { signal?.removeEventListener("abort", abort); }
  }
  static async stopOutdated(address: HostAddress, signal?: AbortSignal) {
    const client = await HostClient.open(address, undefined, signal);
    const abort = () => client.socket.terminate();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const status = await client.request<{ clients: number }>({ method: "status" }, 5000);
      signal?.throwIfAborted();
      if (status?.clients !== 1) throw new Error("Close other PiX windows and terminal clients before upgrading the host");
      // Once committed, let the host acknowledge graceful shutdown.
      signal?.removeEventListener("abort", abort);
      const result = await client.request<{ stopped: boolean }>({ method: "shutdown" }, 5000);
      if (result?.stopped !== true) throw new Error("PiX host did not confirm shutdown");
    } catch (error) {
      if (signal?.aborted) { abort(); signal.throwIfAborted(); }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      await client.close();
    }
  }
  static async connect(address: HostAddress, cwd: string | null, platform?: Platform, clientId?: string, imageReferences = false, legacyClientId?: string, signal?: AbortSignal) {
    const client = await HostClient.open(address, platform, signal);
    const abort = () => client.socket.terminate();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      if (client.shutdownRequested) return client;
      if (address.protocol !== LOCAL_HOST_PROTOCOL || address.version !== PIX_HOST_VERSION) {
        const ErrorType = address.protocol === LOCAL_HOST_PROTOCOL && isNewerVersion(PIX_HOST_VERSION, address.version) ? OutdatedHost : Error;
        throw new ErrorType("The running PiX host has a different version. Stop it after its tasks finish, then reconnect.");
      }
      if (legacyClientId && address.desktopViewMigration !== true) {
        throw new Error("The running PiX host cannot migrate the previous desktop view. Finish its tasks using the previous client, then stop the host and reopen PiX.");
      }
      try { await client.request({ method: "attach", cwd, platform: Boolean(platform),
        keepAwake: typeof platform?.setKeepAwake === "function", clientId, imageReferences, legacyClientId }); }
      catch (error) {
        if (client.shutdownRequested) {
          signal?.throwIfAborted();
          return client;
        }
        let stopping = false;
        try { if (!signal?.aborted && client.connected) stopping = (await verifiedStatus(client)).stopping === true; }
        catch { /* Preserve the original attach failure if status is unavailable. */ }
        if (stopping) throw new StoppingHost(error instanceof Error ? error.message : String(error), { cause: error });
        throw error;
      }
      signal?.throwIfAborted();
      return client;
    } catch (error) {
      if (signal?.aborted) abort();
      await client.close();
      signal?.throwIfAborted();
      // A shutdown frame can arrive while the failed handshake is closing.
      if (client.shutdownRequested) return client;
      throw error;
    } finally { signal?.removeEventListener("abort", abort); }
  }
  request<T = unknown>(request: Omit<LocalRequest, "id" | "type">, timeoutMs = 300_000): Promise<T> {
    if (this.shutdownRequested && request.method !== "status" && request.method !== "shutdown")
      return Promise.reject(new Error("PiX host is shutting down"));
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("PiX host is disconnected"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("PiX host request timed out; execution may still be running. Inspect the session before retrying.")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: "request", id, ...request });
    });
  }
  invoke<T = unknown>(route: DesktopRoute, input?: unknown, sessionPath?: string) {
    if (route.startsWith("pixie.") && this.address.pixieRpc !== true)
      return Promise.reject(new Error("The running PiX host does not support Pixie. Close older PiX clients and restart the host with this build, or use a separate PIX_HOME for this instance."));
    return this.request<T>({ method: "invoke", route, input, sessionPath });
  }
  onEvent(listener: (event: DesktopEvent) => void) {
    this.listeners.add(listener);
    let subscribed = true;
    const shutdown = this.shutdownEvent;
    // Quit is terminal state: a client subscribing after attach must still see
    // it. Defer delivery until the caller has initialized its unsubscribe handle.
    if (shutdown) queueMicrotask(() => {
      if (!subscribed) return;
      try { listener(shutdown); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    return () => { subscribed = false; this.listeners.delete(listener); };
  }
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
  pending?: boolean; stopping?: boolean; remoteConnections?: number; remoteRunning?: number; commands?: number; terminals?: number;
  terminalUnknown?: number; remoteUnknown?: number; installGuard?: boolean; terminalActivity?: boolean; remoteActivity?: boolean;
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
      remoteRunning: status.remoteRunning, remoteUnknown: status.remoteUnknown,
      commands: status.commands, terminals: status.terminals, terminalUnknown: status.terminalUnknown };
  } catch (error) { state.error = error instanceof Error ? error.message : String(error); }
  return state;
}

/** Force is only used after an explicit user choice, against the inspected host. */
export async function stopLocalHost(expectedId: string, force = false, quitClients = false, install = false) {
  const address = readAddress();
  if (!address) return;
  if (hostId(address) !== expectedId) throw new Error("The PiX host changed. Review its current status before restarting it.");
  const client = await HostClient.open(address);
  try {
    const status = await verifiedStatus(client);
    if (install && !force && status.terminals && !status.terminalActivity)
      throw new Error("This older PiX host cannot verify commands in interactive terminals. Close its terminals, then retry installation.");
    if (install && !force && status.remoteConnections && !status.remoteActivity)
      throw new Error("This older PiX host cannot verify commands in remote workspaces. Disconnect its remote workspaces, then retry installation.");
    if (install && !force && !status.installGuard && (status.clients !== 1 || status.remoteConnections || status.terminals))
      throw new Error("This older PiX host cannot close idle connections during installation. Quit PiX completely, then retry installation.");
    if (!force && !install && status.clients !== 1) throw new Error("Close other PiX windows and terminal clients before restarting the host");
    try {
      const result = await client.request<{ stopped: boolean }>({ method: "shutdown", force, quitClients, install }, 5000);
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
export function restartLocalHost(id: string, force = false, signal?: AbortSignal) {
  return connectLocalHost(null, undefined, true, undefined, false, undefined, { id, force }, signal);
}

/** Keep every starter out while an installer replaces the executable. */
export function withStoppedLocalHost<T>(id: string | undefined, force: boolean, install: () => Promise<T>, quitClients = false, installer = false) {
  return withStartupLock(Date.now() + 35_000, async () => {
    if (id) await stopLocalHost(id, force, quitClients, installer);
    if (readAddress()) throw new Error("The PiX host changed. Review its current status before installing.");
    if (installer) writeFileSync(join(runDir(), "starting", "installer"), randomUUID(), { mode: 0o600 });
    return install();
  });
}

export interface InstallReservation { home: string; ownerPid: number; token: string }

/** This marker is published only after a verified host has stopped. */
export function localHostInstallInProgress() {
  const lock = join(runDir(), "starting");
  try {
    const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
    const token = readFileSync(join(lock, "installer"), "utf8");
    return pid > 0 && Number.isInteger(pid) && /^[\da-f-]{36}$/i.test(token) && alive(pid) && !readAddress();
  } catch { return false; }
}

/** The native installer owns the lock after this helper exits, freeing its executable for replacement. */
export async function reserveLocalHostForInstall(id: string | undefined, force: boolean, ownerPid: number): Promise<InstallReservation> {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid || !alive(ownerPid))
    throw new Error("The installer is no longer running");
  const token = randomUUID();
  if (process.getuid?.() === 0) {
    const { uid, gid } = statSync(pixHome());
    for (const path of [join(pixHome(), ".pix"), runDir()]) {
      if (!existsSync(path)) { mkdirSync(path, { mode: 0o700 }); chownSync(path, uid, gid); }
    }
  }
  return withStartupLock(Date.now() + 35_000, async () => {
    if (id) await stopLocalHost(id, force, true, true);
    if (readAddress()) throw new Error("The PiX host changed. Check again before installing.");
    return { home: pixHome(), ownerPid, token };
  }, { ownerPid, token });
}

export function releaseInstallReservation(reservation: InstallReservation) {
  const lock = join(reservation.home, ".pix", "run", "starting");
  try {
    if (readFileSync(join(lock, "pid"), "utf8") === String(reservation.ownerPid)
      && readFileSync(join(lock, "installer"), "utf8") === reservation.token)
      rmSync(lock, { recursive: true, force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Attempt every profile before reporting failures; callers retain the receipt on failure. */
export function releaseInstallReservations(reservations: InstallReservation[], release = releaseInstallReservation) {
  const errors: Error[] = [];
  for (const reservation of reservations) {
    try { release(reservation); }
    catch (error) { errors.push(new Error(`${reservation.home}: ${String(error)}`, { cause: error })); }
  }
  if (errors.length) throw new AggregateError(errors,
    `Could not release PiX installation locks:\n${errors.map(error => error.message).join("\n")}`);
}

async function withStartupLock<T>(deadline: number, action: () => Promise<T>, transfer?: { ownerPid: number; token: string }, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const lock = join(runDir(), "starting");
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
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
    let transferred = false;
    try {
      writeFileSync(join(lock, "pid"), String(process.pid));
      signal?.throwIfAborted();
      const result = await action();
      if (transfer) {
        if (!alive(transfer.ownerPid)) throw new Error("The installer is no longer running");
        writeFileSync(join(lock, "installer"), transfer.token, { mode: 0o600 });
        writeFileSync(join(lock, "pid"), String(transfer.ownerPid));
        if (process.getuid?.() === 0) {
          const { uid, gid } = statSync(runDir());
          for (const path of [lock, join(lock, "pid"), join(lock, "installer")]) chownSync(path, uid, gid);
        }
        transferred = true;
      }
      return result;
    } finally { if (!transferred) rmSync(lock, { recursive: true, force: true }); }
  }
  throw new Error("Timed out waiting for another PiX host starter");
}

/** All entry points discover the same per-profile host; startup is serialized. */
export async function connectLocalHost(cwd: string | null, platform?: Platform, start = true, clientId?: string, imageReferences = false, legacyClientId?: string, restart?: { id: string; force: boolean }, signal?: AbortSignal): Promise<HostClient> {
  signal?.throwIfAborted();
  let staleAddress: string | undefined;
  const deadline = Date.now() + 35_000;
  const waitForShutdown = async (address: HostAddress, cancellable: boolean) => {
    while (JSON.stringify(readAddress()) === JSON.stringify(address)) {
      if (cancellable) signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the previous PiX host to finish shutting down");
      await delay(50);
    }
  };
  const connect = async (upgrade = false, cancellable = true): Promise<HostClient | undefined> => {
    if (cancellable) signal?.throwIfAborted();
    const address = readAddress();
    if (!address || JSON.stringify(address) === staleAddress) return;
    for (let attempt = 0; ; attempt++) {
      if (cancellable) signal?.throwIfAborted();
      try {
        const connected = await HostClient.connect(address, cwd, platform, clientId, imageReferences, legacyClientId, cancellable ? signal : undefined);
        if (cancellable && signal?.aborted) { await connected.close(); signal.throwIfAborted(); }
        return connected;
      }
      catch (error) {
        if (cancellable) signal?.throwIfAborted();
        if (error instanceof StoppingHost && start) {
          await waitForShutdown(address, cancellable);
          return connect(upgrade, cancellable);
        }
        if (error instanceof OutdatedHost && start) {
          if (!upgrade) return;
          // Only the startup lock holder may stop an older host. The host's
          // shutdown guard preserves pending tasks and remote connections.
          try { await HostClient.stopOutdated(address, cancellable ? signal : undefined); }
          catch (cause) {
            if (cancellable) signal?.throwIfAborted();
            throw new Error(`${error.message} ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
          }
          await waitForShutdown(address, cancellable);
          return connect(false, cancellable);
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
    signal?.throwIfAborted();
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
      // Once spawned, retain the lock until the child is discoverable, even
      // if this caller quits; another starter must not race its initialization.
      client = await connect(false, false);
      if (client) {
        if (signal?.aborted) { await client.close(); signal.throwIfAborted(); }
        return client;
      }
      if (child.exitCode !== null) throw new Error(`PiX host failed to start. See ${join(runDir(), "host.log")}`);
      await delay(50);
    }
    child.kill();
    throw new Error(`PiX host startup timed out. See ${join(runDir(), "host.log")}`);
  }, undefined, signal);
}
