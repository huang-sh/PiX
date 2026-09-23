import { spawn, type ChildProcess } from "node:child_process";
import { debugLog } from "./debug-log.js";
import { piCliEntry } from "./pi-runtime.js";

export interface RpcLine {
  type: string;
  [key: string]: unknown;
}

/**
 * Minimal client for pi's RPC protocol: JSONL commands in on stdin, responses
 * and agent events out on stdout (pinned by PiX's package dependency).
 *
 * The package's own RpcClient spawns a PATH `node` binary, which a packaged
 * PiX cannot rely on; this client runs the CLI under PiX's own Electron
 * binary as Node (ELECTRON_RUN_AS_NODE), which works identically in dev and
 * packaged builds with no external runtime requirement.
 */
export class PixieRpc {
  private child?: ChildProcess;
  private pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Set<(event: RpcLine) => void>();
  private exitListeners = new Set<(error: Error) => void>();
  private exitError?: Error;
  private buffer = "";
  private sequence = 0;

  get running(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  onEvent(listener: (event: RpcLine) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notifies subscribers when the process dies; the runtime rejects turn waits here. */
  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async start(cwd: string, env: Record<string, string>, args: string[] = []): Promise<void> {
    if (this.running) return;
    const child = spawn(process.execPath, [piCliEntry(), "--mode", "rpc", ...args], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.exitError = undefined;
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.dispatch(line);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", chunk => debugLog("pixie-rpc:", chunk.toString().trim()));
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.exitError ??= error;
      this.rejectPending(error);
    };
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      const error = this.exitError ??= new Error(`Pixie process exited (code=${code} signal=${signal})`);
      this.rejectPending(error);
      for (const listener of [...this.exitListeners]) listener(error);
    });
    child.once("error", error => fail(new Error(`Pixie process error: ${error.message}`)));
    child.stdin?.on("error", error => fail(new Error(`Pixie process stdin error: ${error.message}`)));
  }

  private dispatch(line: string) {
    let data: RpcLine;
    try {
      data = JSON.parse(line) as RpcLine;
    } catch {
      return;
    }
    const id = typeof data.id === "string" ? data.id : undefined;
    if (data.type === "response" && id) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (data.success === false)
        pending.reject(new Error(typeof data.error === "string" ? data.error : "Pixie command failed"));
      else pending.resolve(data.data);
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(data);
      } catch (error) {
        debugLog("pixie-rpc: event listener", error);
      }
    }
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /** Sends a command and resolves with the response's data payload. */
  request(command: RpcLine, timeoutMs = 30_000): Promise<unknown> {
    const stdin = this.child?.stdin;
    if (!this.running || !stdin || this.exitError)
      return Promise.reject(this.exitError ?? new Error("Pixie process is not running"));
    const id = `pix-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Pixie command timed out"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: data => { clearTimeout(timer); resolve(data); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }

  /** Sends a line that expects no response (e.g. an extension UI cancel). */
  write(line: RpcLine): void {
    this.child?.stdin?.write(`${JSON.stringify(line)}\n`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.rejectPending(new Error("Pixie process was stopped"));
    child.kill();
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
