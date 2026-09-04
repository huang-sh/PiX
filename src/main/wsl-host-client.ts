import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt } from "node:crypto";
import { createServer } from "node:net";
import WebSocket from "ws";
import {
  PIX_REMOTE_PROTOCOL,
  type HostHello,
  type HostMessage,
  type HostModelRequest,
  type ProjectRoute,
} from "../shared/remote-protocol.js";
import type { DesktopEvent, WslDistribution } from "../shared/types.js";
import { brokerEvent } from "./model-broker.js";
import {
  ensureSshHostInstalled,
  sshProjectPath,
  validateSshHost,
} from "./ssh-host-installer.js";

interface HostReady {
  protocol: number;
  port: number;
  token: string;
  pid: number;
}

export interface WslHostOptions {
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

  private constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly socket: WebSocket,
    readonly hello: HostHello,
    readonly extraChildren: ChildProcessWithoutNullStreams[] = [],
  ) {
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("close", () => this.failPending(new Error("Remote host disconnected")));
    socket.on("error", (error) => this.failPending(error));
    child.on("exit", (code) =>
      this.failPending(new Error(`Remote host exited with code ${code ?? "unknown"}`)),
    );
  }

  private static runWsl(args: string[], timeoutMs = 15_000) {
    return new Promise<Buffer>((accept, reject) => {
      const child = spawn("wsl.exe", args, { windowsHide: true });
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

  static async home(name: string): Promise<string> {
    return this.text(
      await this.runWsl(["-d", name, "--exec", "sh", "-lc", 'printf %s "$HOME"']),
    );
  }

  static async distributions(): Promise<WslDistribution[]> {
    const names = await this.names();
    return Promise.all(
      names.map(async (name) => ({ name, home: await this.home(name) })),
    );
  }

  static async installed(options: Omit<WslHostOptions, "executable">) {
    const distros = await this.distributions();
    const distro = distros.find((item) => item.name === options.distro);
    if (!distro) throw new Error(`WSL distribution is not installed: ${options.distro}`);
    return this.connect({
      ...options,
      distro: distro.name,
      executable: `${distro.home}/.pix/server/current/bin/pix-agent-host`,
    });
  }

  static async connect(options: WslHostOptions) {
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
      const ready = await this.waitForReady(child, timeout);
      if (ready.protocol !== PIX_REMOTE_PROTOCOL)
        throw new Error(`Unsupported WSL host protocol ${ready.protocol}`);
      const { socket, hello } = await this.openSocket(ready, timeout);
      return new WslHostClient(child, socket, hello);
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  static async connectSsh(hostInput: string, cwd: string) {
    const host = validateSshHost(hostInput);
    await ensureSshHostInstalled(host);
    const remoteCwd = sshProjectPath(cwd);
    const timeout = 30_000;
    const localPort = await this.availableLocalPort();
    const start = async () => {
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
          ready: await this.waitForReady(child, timeout),
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
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|no such file|cannot find module|unsupported ssh host protocol/iu.test(message))
        throw error;
      await ensureSshHostInstalled(host, true);
      started = await start();
    }
    const { child, ready } = started;
    try {
      if (ready.protocol !== PIX_REMOTE_PROTOCOL)
        throw new Error(`Unsupported SSH host protocol ${ready.protocol}`);
      if (ready.port !== started.remotePort)
        throw new Error("SSH host listened on an unexpected port");
      const { socket, hello } = await this.openSocket(
        { ...ready, port: localPort },
        timeout,
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
  ): Promise<HostReady> {
    return new Promise((accept, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(
        () => reject(new Error(`Timed out starting WSL host: ${stderr.trim()}`)),
        timeoutMs,
      );
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.startsWith(READY_MARKER)) continue;
          clearTimeout(timer);
          try {
            accept(JSON.parse(line.slice(READY_MARKER.length)) as HostReady);
          } catch (error) {
            reject(error);
          }
          return;
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `WSL host exited before startup (${code ?? "unknown"}): ${stderr.trim()}`,
          ),
        );
      });
    });
  }

  private static async openSocket(ready: HostReady, timeoutMs: number) {
    const url = `ws://127.0.0.1:${ready.port}/?token=${encodeURIComponent(ready.token)}`;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await new Promise<{ socket: WebSocket; hello: HostHello }>(
          (accept, reject) => {
          const socket = new WebSocket(url, {
            handshakeTimeout: Math.min(2_000, timeoutMs),
            maxPayload: 16 * 1024 * 1024,
          });
          const timer = setTimeout(
            () => fail(new Error("Timed out waiting for remote host handshake")),
            Math.min(2_000, timeoutMs),
          );
          const fail = (error: Error) => {
            clearTimeout(timer);
            socket.terminate();
            reject(error);
          };
          socket.once("error", fail);
          socket.once("message", (data) => {
            clearTimeout(timer);
            socket.off("error", fail);
            try {
              const message = JSON.parse(data.toString()) as HostMessage;
              if (
                message.type !== "hello" ||
                message.protocol !== PIX_REMOTE_PROTOCOL
              )
                throw new Error("Invalid remote host handshake");
              accept({ socket, hello: message });
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          });
        },
        );
      } catch (error) {
        lastError = error;
        await new Promise((accept) => setTimeout(accept, 200));
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Unable to connect to WSL host WebSocket");
  }

  private receive(raw: string) {
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

  request<T = unknown>(route: ProjectRoute, input?: unknown): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Remote host is not connected"));
    const id = String(++this.nextId);
    return new Promise<T>((accept, reject) => {
      this.pending.set(id, {
        resolve: (value) => accept(value as T),
        reject,
      });
      this.socket.send(JSON.stringify({ type: "request", id, route, input }));
    });
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
    this.failPending(new Error("Remote host client disposed"));
    for (const request of this.modelRequests.values()) request.abort();
    this.modelRequests.clear();
    if (this.socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((accept) => {
        const timer = setTimeout(accept, 1_000);
        this.socket.once("close", () => {
          clearTimeout(timer);
          accept();
        });
        this.socket.close();
      });
    }
    if (!this.child.killed) this.child.kill();
    for (const child of this.extraChildren)
      if (!child.killed) child.kill();
  }
}
