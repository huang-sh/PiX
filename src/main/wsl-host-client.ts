import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import {
  PIX_REMOTE_PROTOCOL,
  MAX_REMOTE_PAYLOAD,
  type HostHello,
  type HostMessage,
  type HostModelRequest,
  type ProjectRoute,
} from "../shared/remote-protocol.js";
import type { DesktopEvent, WslDistribution } from "../shared/types.js";
import { brokerEvent } from "./model-broker.js";
import {
  ensureSshHostInstalled,
  ensureWslHostInstalled,
  sshProjectPath,
  validateSshHost,
  type RemoteConnectOptions,
} from "./ssh-host-installer.js";

interface HostReady {
  protocol: number;
  port: number;
  token: string;
  pid: number;
}

export interface WslHostOptions extends RemoteConnectOptions {
  distro?: string;
  cwd: string;
  executable: string;
  connectTimeoutMs?: number;
}

type ModelBroker = (
  request: HostModelRequest,
  signal: AbortSignal,
) => Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;

const READY_MARKER = "PIX_AGENT_HOST_READY ";

export class WslHostClient {
  private nextId = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<(event: DesktopEvent) => void>();
  private readonly modelRequests = new Map<string, AbortController>();
  private modelBroker?: ModelBroker;
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private disconnectError?: Error;
  private stopping?: Promise<void>;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  private constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly socket: WebSocket,
    readonly hello: HostHello,
    readonly extraChildren: ChildProcessWithoutNullStreams[] = [],
  ) {
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("close", () => this.disconnected(new Error("Remote host disconnected")));
    socket.on("error", (error) => this.disconnected(error));
    child.on("exit", (code) =>
      this.disconnected(new Error(`Remote host exited with code ${code ?? "unknown"}`)),
    );
    child.on("error", (error) => this.disconnected(error));
    let alive = true;
    socket.on("pong", () => { alive = true; });
    this.heartbeat = setInterval(() => {
      if (!alive || socket.readyState !== WebSocket.OPEN) {
        this.disconnected(new Error("Remote host heartbeat timed out"));
        return;
      }
      alive = false;
      socket.ping(undefined, undefined, (error) => {
        if (error) this.disconnected(error);
      });
    }, 15_000);
    this.heartbeat.unref();
  }

  private static runWsl(args: string[], timeoutMs = 15_000, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return new Promise<Buffer>((accept, reject) => {
      const child = spawn("wsl.exe", args, { windowsHide: true, signal });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Timed out querying WSL"));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) accept(Buffer.concat(stdout));
        else
          reject(
            new Error(
              Buffer.concat(stderr).toString("utf8").replaceAll("\0", "").trim() ||
                `WSL exited with code ${code ?? "unknown"}`,
            ),
          );
      });
    });
  }

  private static text(buffer: Buffer) {
    return buffer.includes(0)
      ? buffer.toString("utf16le").replaceAll("\0", "").trim()
      : buffer.toString("utf8").trim();
  }

  static async names(): Promise<string[]> {
    if (process.platform !== "win32") return [];
    const output = this.text(await this.runWsl(["--list", "--quiet"]));
    return output.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  }

  static async home(name: string, signal?: AbortSignal): Promise<string> {
    return this.text(
      await this.runWsl(["-d", name, "--exec", "sh", "-lc", 'printf %s "$HOME"'], 15_000, signal),
    );
  }

  static async distributions(): Promise<WslDistribution[]> {
    const names = await this.names();
    return Promise.all(
      names.map(async (name) => ({ name, home: await this.home(name) })),
    );
  }

  static async installed(options: Omit<WslHostOptions, "executable">) {
    options.onProgress?.("checking");
    const distro = options.distro;
    if (!distro) throw new Error("Select a WSL distribution");
    await ensureWslHostInstalled(distro, false, options);
    const home = await this.home(distro, options.signal);
    return this.connect({
      ...options,
      distro,
      cwd: options.cwd || home,
      executable: `${home}/.pix/server/current/bin/pix-agent-host`,
    });
  }

  static async connect(options: WslHostOptions) {
    options.signal?.throwIfAborted();
    options.onProgress?.("starting");
    const args = [
      ...(options.distro ? ["-d", options.distro] : []),
      "--exec",
      options.executable,
      "serve",
      "--cwd",
      options.cwd,
      "--exit-on-disconnect",
    ];
    const child = spawn("wsl.exe", args, { windowsHide: true });
    const timeout = options.connectTimeoutMs ?? 30_000;
    try {
      const ready = await this.waitForReady(child, timeout, options.signal);
      if (ready.protocol !== PIX_REMOTE_PROTOCOL)
        throw new Error(`Unsupported WSL host protocol ${ready.protocol}`);
      options.onProgress?.("handshake");
      const { socket, hello } = await this.openSocket(ready, timeout, options.signal);
      return new WslHostClient(child, socket, hello);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  static async connectSsh(hostInput: string, cwd: string, options: RemoteConnectOptions = {}) {
    const host = validateSshHost(hostInput);
    await ensureSshHostInstalled(host, false, options);
    const remoteCwd = sshProjectPath(cwd);
    const timeout = 30_000;
    const localPort = await this.availableLocalPort();
    const start = async () => {
      options.signal?.throwIfAborted();
      options.onProgress?.("starting");
      const remotePort = randomInt(30_000, 60_000);
      const command =
        `"$HOME/.pix/server/current/bin/pix-agent-host" serve --cwd ${remoteCwd}` +
        ` --port ${remotePort} --exit-on-disconnect`;
      const child = spawn(
        "ssh",
        [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=15",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=2",
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
          host,
          command,
        ],
        { windowsHide: true },
      );
      try {
        return {
          child,
          remotePort,
          ready: await this.waitForReady(child, timeout, options.signal),
        };
      } catch (error) {
        child.kill();
        throw error;
      }
    };
    let started: Awaited<ReturnType<typeof start>>;
    try {
      started = await start();
      if (started.ready.protocol !== PIX_REMOTE_PROTOCOL) {
        started.child.kill();
        throw new Error(`Unsupported SSH host protocol ${started.ready.protocol}`);
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (!/(?:pix-agent-host[^\r\n]*(?:not found|no such file)|(?:not found|no such file)[^\r\n]*pix-agent-host|cannot find module|unsupported ssh host protocol)/iu.test(message))
        throw error;
      await ensureSshHostInstalled(host, true, options);
      started = await start();
    }
    const { child, ready } = started;
    try {
      if (ready.protocol !== PIX_REMOTE_PROTOCOL)
        throw new Error(`Unsupported SSH host protocol ${ready.protocol}`);
      if (ready.port !== started.remotePort)
        throw new Error("SSH host listened on an unexpected port");
      options.onProgress?.("handshake");
      const { socket, hello } = await this.openSocket(
        { ...ready, port: localPort },
        timeout,
        options.signal,
      );
      return new WslHostClient(child, socket, hello);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  private static availableLocalPort() {
    return new Promise<number>((accept, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close((error) => (error ? reject(error) : accept(port)));
      });
    });
  }

  private static waitForReady(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HostReady> {
    signal?.throwIfAborted();
    return new Promise((accept, reject) => {
      let stdout = "";
      let stderr = "";
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("error", fail);
        child.off("exit", onExit);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const onAbort = () => fail(new Error("Remote connection cancelled"));
      const onExit = (code: number | null) => fail(new Error(
        `Remote host exited before startup (${code ?? "unknown"}): ${stderr.trim()}`,
      ));
      const timer = setTimeout(() => fail(new Error(`Timed out starting remote host: ${stderr.trim()}`)), timeoutMs);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_384); });
      child.stdout.setEncoding("utf8");
      const onData = (chunk: string) => {
        stdout += chunk;
        let newline: number;
        while ((newline = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, newline).trimEnd();
          stdout = stdout.slice(newline + 1);
          if (!line.startsWith(READY_MARKER)) continue;
          try {
            const ready = JSON.parse(line.slice(READY_MARKER.length)) as HostReady;
            if (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65_535 || typeof ready.token !== "string" || !ready.token)
              throw new Error("Invalid remote host startup response");
            cleanup();
            accept(ready);
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
        stdout = stdout.slice(-65_536);
      };
      child.stdout.on("data", onData);
      child.once("error", fail);
      child.once("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private static async openSocket(ready: HostReady, timeoutMs: number, signal?: AbortSignal) {
    const url = `ws://127.0.0.1:${ready.port}/?token=${encodeURIComponent(ready.token)}`;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        return await new Promise<{ socket: WebSocket; hello: HostHello }>(
          (accept, reject) => {
          const socket = new WebSocket(url, {
            handshakeTimeout: Math.min(2_000, timeoutMs),
            maxPayload: MAX_REMOTE_PAYLOAD,
          });
          const timer = setTimeout(
            () => fail(new Error("Timed out waiting for remote host handshake")),
            Math.min(2_000, timeoutMs),
          );
          const fail = (error: Error) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            socket.terminate();
            reject(error);
          };
          const onAbort = () => fail(new Error("Remote connection cancelled"));
          signal?.addEventListener("abort", onAbort, { once: true });
          socket.once("error", fail);
          socket.once("message", (data) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            try {
              const message = JSON.parse(data.toString()) as HostMessage;
              if (
                message.type !== "hello" ||
                message.protocol !== PIX_REMOTE_PROTOCOL
              )
                throw new Error("Invalid remote host handshake");
              accept({ socket, hello: message });
              socket.off("error", fail);
              // Keep errors handled until the client takes ownership next tick.
              socket.on("error", () => {});
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          });
        },
        );
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        await delay(200, undefined, { signal });
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Unable to connect to remote host WebSocket");
  }

  private receive(raw: string) {
    if (this.disconnectError) return;
    let message: HostMessage;
    try {
      message = JSON.parse(raw) as HostMessage;
    } catch {
      return;
    }
    if (message.type === "model.request") {
      void this.runModelRequest(message);
      return;
    }
    if (message.type === "model.cancel") {
      this.modelRequests.get(message.id)?.abort();
      return;
    }
    if (message.type === "event") {
      this.listeners.forEach((listener) => listener(message.event));
      return;
    }
    if (message.type !== "response") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error.message));
  }

  request<T = unknown>(route: ProjectRoute, input?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.connected)
      return Promise.reject(new Error("Remote host is not connected"));
    // Long-running work is monitored by the transport heartbeat; timing it out
    // would leave an ambiguous operation running on the host.
    const action = (input as { action?: string } | undefined)?.action;
    timeoutMs ??= route === "shell.run" || (route === "agent.control" &&
      ["prompt", "compact", "bash", "navigateTree", "reload"].includes(action ?? "")) ? 0 : 30_000;
    const id = String(++this.nextId);
    return new Promise<T>((accept, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else accept(value as T);
      };
      const timer = timeoutMs ? setTimeout(() => finish(new Error(
        `Remote request timed out (${route}). The operation may still be running; check its state before retrying.`,
      )), timeoutMs) : undefined;
      this.pending.set(id, {
        resolve: (value) => finish(undefined, value),
        reject: (error) => finish(error),
      });
      try {
        this.socket.send(JSON.stringify({ type: "request", id, route, input }), (error) => {
          if (error) this.disconnected(error);
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  get connected() {
    return !this.disconnectError && this.socket.readyState === WebSocket.OPEN;
  }

  onDisconnect(listener: (error: Error) => void) {
    this.disconnectListeners.add(listener);
    if (this.disconnectError) listener(this.disconnectError);
    return () => this.disconnectListeners.delete(listener);
  }

  private disconnected(error: Error) {
    if (this.disconnectError) return;
    this.disconnectError = error;
    clearInterval(this.heartbeat);
    this.failPending(error);
    for (const request of this.modelRequests.values()) request.abort();
    this.modelRequests.clear();
    this.socket.terminate();
    // Closing the socket lets the host persist its aborted turn. Killing
    // wsl.exe immediately can kill Linux before that flush has happened.
    this.stopping = Promise.all([this.child, ...this.extraChildren].map((child) =>
      new Promise<void>((accept) => {
        if (child.exitCode != null || child.signalCode != null) { accept(); return; }
        const finish = () => { clearTimeout(timer); child.off("exit", finish); accept(); };
        const timer = setTimeout(() => {
          if (!child.killed) child.kill();
          finish();
        }, 5_000);
        timer.unref();
        child.once("exit", finish);
      }),
    )).then(() => undefined);
    this.disconnectListeners.forEach((listener) => listener(error));
  }

  onEvent(listener: (event: DesktopEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setModelBroker(broker: ModelBroker) {
    this.modelBroker = broker;
  }

  private async runModelRequest(request: HostModelRequest) {
    const controller = new AbortController();
    this.modelRequests.set(request.id, controller);
    try {
      if (!this.modelBroker) throw new Error("Desktop model broker is unavailable");
      const stream = await this.modelBroker(request, controller.signal);
      for await (const event of stream) {
        if (this.socket.readyState !== WebSocket.OPEN) break;
        this.socket.send(JSON.stringify({
          type: "model.event",
          id: request.id,
          event: brokerEvent(event),
        }));
      }
    } catch (error) {
      if (this.socket.readyState === WebSocket.OPEN)
        this.socket.send(JSON.stringify({
          type: "model.failure",
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        }));
    } finally {
      this.modelRequests.delete(request.id);
    }
  }

  private failPending(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async dispose() {
    this.disconnected(new Error("Remote host client disposed"));
    await this.stopping;
    this.listeners.clear();
    this.disconnectListeners.clear();
  }
}
