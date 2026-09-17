import type { DesktopApi, DesktopEvent, DesktopRoute } from "../shared/types.js";
import type { ClientMessage, HostMessage } from "../shared/web-protocol.js";

declare global {
  interface Window {
    pix?: DesktopApi & { copy?(text: string): Promise<void> };
  }
}

function createWebDesktop(): DesktopApi & { copy(text: string): Promise<void> } {
  let socket: WebSocket | undefined;
  let opening: Promise<WebSocket> | undefined;
  let seq = 0;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(event: DesktopEvent) => void>();

  function connect(): Promise<WebSocket> {
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/pix`);
      ws.addEventListener("open", () => {
        socket = ws;
        opening = undefined;
        resolve(ws);
      });
      ws.addEventListener("error", () => {
        if (opening) {
          opening = undefined;
          reject(new Error("PiX web connection failed"));
        }
      });
      ws.addEventListener("close", () => {
        socket = undefined;
        opening = undefined;
        for (const waiter of pending.values()) waiter.reject(new Error("PiX web connection closed"));
        pending.clear();
      });
      ws.addEventListener("message", (event) => {
        let message: HostMessage;
        try {
          message = JSON.parse(String(event.data)) as HostMessage;
        } catch {
          return;
        }
        if (message.type === "event") {
          for (const listener of listeners) listener(message.event);
          return;
        }
        if (message.type === "platform" && message.method === "confirm") {
          const ok = window.confirm(
            message.detail ? `${message.message}\n\n${message.detail}` : message.message,
          );
          ws.send(JSON.stringify({
            type: "platform.reply",
            id: message.id,
            result: ok,
          } satisfies ClientMessage));
          return;
        }
        if (message.type !== "response") return;
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.ok) waiter.resolve(message.result);
        else waiter.reject(new Error(message.message));
      });
    });
    return opening;
  }

  return {
    async invoke<T>(route: DesktopRoute, input?: unknown) {
      const ws = await connect();
      const id = String(++seq);
      const result = new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });
      ws.send(JSON.stringify({ type: "request", id, route, input } satisfies ClientMessage));
      return result;
    },
    onEvent(listener) {
      listeners.add(listener);
      void connect().catch(() => {});
      return () => {
        listeners.delete(listener);
      };
    },
    filePath() {
      return "";
    },
    async attachFile(file: File) {
      const data = await readBase64(file);
      const result = await this.invoke<{ path: string }>("workspace.attach", {
        name: file.name,
        data,
      });
      return { name: file.name, path: result.path };
    },
    async copy(text: string) {
      await navigator.clipboard.writeText(text);
    },
  };
}

function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

export const desktop = window.pix ?? createWebDesktop();
