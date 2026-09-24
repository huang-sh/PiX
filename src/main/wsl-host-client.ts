import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { debugLog } from "./debug-log.js";
import {
  PIX_REMOTE_PROTOCOL,
  MAX_REMOTE_PAYLOAD,
  type HostHandle,
  type HostHello,
  type HostMessage,
  type HostModelRequest,
  type ProjectRoute,
} from "../shared/remote-protocol.js";
import type { DesktopEvent, WslDistribution } from "../shared/types.js";
import { brokerEvent } from "./model-broker.js";
import { sessionEventDecoder } from "../shared/session-updates.js";
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
/** The ssh transport options shared by spawn and reattach connections. */
const SSH_TRANSPORT_OPTIONS = [
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
] as const;

/** Reattachment failed because the server itself cannot be reached; a lingering host there must be left alone. */
export class RemoteHostUnreachable extends Error {}

/**
 * The host started and reported READY, but the link to it died before the
 * WebSocket handshake (e.g. an SSH reset between the two). The host is
 * alive and listening; carrying its handle lets the caller redial instead
 * of wasting it.
 */
export class HostStarted extends Error {
  constructor(
    message: string,
    readonly hostHandle: HostHandle,
  ) {
    super(message);
  }
}

/**
 * The launcher script that starts a host as a detached process and reports
 * readiness on stdout: the host survives the ssh/wsl session that launched
 * it, so unplanned disconnects leave its running work alive.
 */
export function launcherScript(v: {
  exe: string;
  cwd: string;
  port: number;
  base: string;
  deployCredentials?: boolean;
}) {
  const flags = `--cwd ${v.cwd} --port ${v.port} --ready-file "$F"` +
    (v.deployCredentials ? " --allow-credential-deploy" : "");
  return [
    `B=${v.base}; F=$B/host-${v.port}.ready; L=$B/host-${v.port}.log`,
    `C="${v.exe} serve ${flags}"`,
    // Newlines, not semicolons: a ";" right after the backgrounding "&" is a
    // POSIX shell syntax error, and dash enforces it.
    "(command -v setsid >/dev/null 2>&1 && setsid $C || nohup $C) </dev/null >>$L 2>&1 &",
    "i=0; while [ ! -s \"$F\" ] && [ \"$i\" -lt 140 ]; do sleep 0.2; i=$((i+1)); done",
    "if [ ! -s \"$F\" ]; then echo pix-agent-host failed to start; tail -n 5 \"$L\" 2>/dev/null; fi",
    "cat \"$F\" 2>/dev/null; rm -f \"$F\"",
  ].join("\n");
}

export class WslHostClient {
  private nextId = 0;
  private decodeSessionEvent = sessionEventDecoder(() => this.request("session.snapshot"));
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<(event: DesktopEvent) => void>();
  private readonly modelRequests = new Map<string, AbortController>();
  private modelBroker?: ModelBroker;
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private disconnectError?: Error;
  private intentionalDisconnect = false;
  private stopping?: Promise<void>;
  private stderrTail = "";
  private readonly heartbeat: ReturnType<typeof setInterval>;

  private constructor(
    readonly child: ChildProcessWithoutNullStreams | undefined,
    readonly socket: WebSocket,
    readonly hello: HostHello,
    readonly handle: HostHandle,
    /** A reattach's `ssh -N` carries the tunnel: its exit ends the link. */
    private readonly childIsTransport = false,
    /** True when this client attached to a host an earlier link started. */
    readonly reattached = false,
  ) {
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("close", () => this.disconnected(new Error("Remote host disconnected")));
    socket.on("error", (error) => this.disconnected(error));
    if (child) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-4_096);
      });
      if (childIsTransport) {
        child.on("exit", (code) =>
          this.disconnected(new Error(`SSH transport exited with code ${code ?? "unknown"}`)),
        );
      } else {
        // The launcher wrapper exits once the detached host is running; its
        // death says nothing about the host. The socket and heartbeat own
        // liveness from here on.
        child.once("close", (code, signal) => {
          debugLog("wsl-host-client: launcher closed", `requested=${this.intentionalDisconnect} code=${code ?? "none"} signal=${signal ?? "none"}`);
          if (this.stderrTail.trim())
            debugLog("wsl-host-client: stderr tail", this.stderrTail.trim().slice(-1_024));
        });
      }
      child.on("error", (error) => this.disconnected(error));
    }
    // Two missed pongs (~30s) match the SSH tunnel's ServerAliveCountMax=2:
    // the host legitimately blocks its event loop on synchronous session
    // creation (fsync), which is not a dead transport.
    let missedPongs = 0;
    socket.on("pong", () => { missedPongs = 0; });
    this.heartbeat = setInterval(() => {
      if (missedPongs >= 2 || socket.readyState !== WebSocket.OPEN) {
        this.disconnected(new Error("Remote host heartbeat timed out"));
        return;
      }
      missedPongs++;
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
    const distro = options.distro ?? "";
    const base = options.executable.replace(/\/server\/current\/bin\/pix-agent-host$/u, "");
    const port = randomInt(30_000, 60_000);
    const script = launcherScript({
      exe: options.executable,
      cwd: options.cwd,
      port,
      base,
      deployCredentials: options.deployCredentials,
    });
    const child = spawn("wsl.exe",
      [...(options.distro ? ["-d", options.distro] : []), "--exec", "sh", "-c", script],
      { windowsHide: true },
    );
    const timeout = options.connectTimeoutMs ?? 30_000;
    let handle: HostHandle | undefined;
    try {
      const ready = await this.waitForReady(child, timeout, options.signal);
      if (ready.protocol !== PIX_REMOTE_PROTOCOL)
        throw new Error(`Unsupported WSL host protocol ${ready.protocol}`);
      if (ready.port !== port)
        throw new Error("WSL host listened on an unexpected port");
      handle = { kind: "wsl", target: distro, port: ready.port, token: ready.token, pid: ready.pid };
      options.onProgress?.("handshake");
      try {
        const { socket, hello } = await this.openSocket(ready, timeout, options.signal);
        return new WslHostClient(child, socket, hello, handle);
      } catch (error) {
        // The host is up and listening; only the link to it died.
        throw new HostStarted(error instanceof Error ? error.message : String(error), handle);
      }
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
      // Single-quoted so the remote login shell hands the script to sh -c verbatim.
      const script = launcherScript({
        exe: "$HOME/.pix/server/current/bin/pix-agent-host",
        cwd: remoteCwd,
        port: remotePort,
        base: "$HOME/.pix",
        deployCredentials: options.deployCredentials,
      });
      const child = spawn(
        "ssh",
        [
          "-T",
          ...SSH_TRANSPORT_OPTIONS,
          "-L",
          `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
          host,
          `sh -c '${script}'`,
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
    const handle: HostHandle = { kind: "ssh", target: host, port: ready.port, token: ready.token, pid: ready.pid };
    try {
      if (ready.protocol !== PIX_REMOTE_PROTOCOL)
        throw new Error(`Unsupported SSH host protocol ${ready.protocol}`);
      if (ready.port !== started.remotePort)
        throw new Error("SSH host listened on an unexpected port");
      options.onProgress?.("handshake");
      try {
        const { socket, hello } = await this.openSocket(
          { ...ready, port: localPort },
          timeout,
          options.signal,
        );
        return new WslHostClient(child, socket, hello, handle);
      } catch (error) {
        // The host is up and listening; only the tunnel to it died.
        throw new HostStarted(error instanceof Error ? error.message : String(error), handle);
      }
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  /** Attaches to a lingering host from an earlier session; its work survives. */
  static async reattach(handle: HostHandle, options: RemoteConnectOptions & { connectTimeoutMs?: number } = {}) {
    options.onProgress?.("handshake");
    const timeout = options.connectTimeoutMs ?? 15_000;
    if (handle.kind === "wsl") {
      const { socket, hello } = await this.openSocket(handle, timeout, options.signal);
      return new WslHostClient(undefined, socket, hello, handle, false, true);
    }
    const localPort = await this.availableLocalPort();
    const child = spawn(
      "ssh",
      ["-N", "-T", ...SSH_TRANSPORT_OPTIONS, "-L", `127.0.0.1:${localPort}:127.0.0.1:${handle.port}`, handle.target],
      { windowsHide: true },
    );
    try {
      const { socket, hello } = await this.openSocket(
        { ...handle, port: localPort },
        timeout,
        options.signal,
      );
      return new WslHostClient(child, socket, hello, handle, true, true);
    } catch (error) {
      // The tunnel dying means the server is unreachable: the host there may
      // still be running work, so callers must not treat it as stale. ssh's
      // own ConnectTimeout can expire just after ours, so give it a moment
      // to report the exit itself — and our kill below must not count.
      let dead = child.exitCode != null || child.signalCode != null;
      if (!dead && !options.signal?.aborted) {
        await delay(1_500, undefined, { signal: options.signal }).catch(() => {});
        dead = child.exitCode != null || child.signalCode != null;
      }
      child.kill();
      if (dead && !options.signal?.aborted)
        throw new RemoteHostUnreachable(
          error instanceof Error ? error.message : String(error),
        );
      throw error;
    }
  }

  /** Stops a lingering host by pid, verifying the process is really ours. */
  static async killHost(handle: HostHandle): Promise<void> {
    const script =
      `p=$(ps -p ${handle.pid} -o args= 2>/dev/null); ` +
      `case "$p" in *pix-agent-host*) kill ${handle.pid};; esac`;
    if (handle.kind === "wsl") {
      await this.runWsl(["-d", handle.target, "--exec", "sh", "-c", script], 15_000).catch(() => {});
      return;
    }
    await new Promise<void>((resolve) => {
      const child = spawn(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", handle.target, script],
        { windowsHide: true },
      );
      const timer = setTimeout(() => { child.kill(); resolve(); }, 20_000);
      timer.unref();
      child.once("error", () => { clearTimeout(timer); resolve(); });
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
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
      const onStderr = (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onStderr);
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
      child.stderr.on("data", onStderr);
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

  private static async openSocket(ready: Pick<HostReady, "port" | "token">, timeoutMs: number, signal?: AbortSignal) {
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
      void this.runModelRequest(message).catch(e => debugLog("wsl-host-client: model request", e));
      return;
    }
    if (message.type === "model.cancel") {
      this.modelRequests.get(message.id)?.abort();
      return;
    }
    if (message.type === "event") {
      const event = this.decodeSessionEvent(message.event);
      if (event) this.listeners.forEach((listener) => listener(event));
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
      ["prompt", "compact", "bash", "navigateTree", "reload", "newSession"].includes(action ?? "")) ? 0 : 30_000;
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
    // An intentional close lets a queued shutdown message flush before the
    // close frame; anything else tears the transport down right away.
    if (this.intentionalDisconnect && this.socket.readyState === WebSocket.OPEN)
      this.socket.close();
    else
      this.socket.terminate();
    // The host runs detached from its launcher; only a transport child (a
    // reattach tunnel) still needs teardown here.
    const child = this.child;
    this.stopping = new Promise<void>((accept) => {
      if (!child || child.exitCode != null || child.signalCode != null) { accept(); return; }
      // Intentional teardown drops the local child at once: the host is
      // detached, and an ssh -N tunnel would never exit on its own.
      if (this.intentionalDisconnect) {
        if (!child.killed) child.kill();
        accept();
        return;
      }
      const finish = () => { clearTimeout(timer); child.off("exit", finish); accept(); };
      const timer = setTimeout(() => {
        if (!child.killed) child.kill();
        finish();
      }, 5_000);
      timer.unref();
      child.once("exit", finish);
    });
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

  /** Intentional teardown: tells a lingering host to shut down now. */
  async dispose() {
    // Cleanup after a failure must not relabel that failure as a requested exit.
    if (!this.disconnectError) this.intentionalDisconnect = true;
    if (!this.disconnectError && this.socket.readyState === WebSocket.OPEN) {
      // Wait for the frame to leave before the close below can end the link.
      await new Promise<void>((resolve) => {
        try { this.socket.send(JSON.stringify({ type: "shutdown" }), () => resolve()); }
        catch { resolve(); }
      });
    }
    this.disconnected(new Error("Remote host client disposed"));
    await this.stopping;
    this.listeners.clear();
    this.disconnectListeners.clear();
  }

  /** Ends the link but leaves a lingering host running for a later reattach. */
  async abandon() {
    this.disconnected(new Error("Remote connection abandoned"));
    await this.stopping;
    this.listeners.clear();
    this.disconnectListeners.clear();
  }
}
