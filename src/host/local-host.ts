import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { MainController, type Platform } from "../main/controller.js";
import { pixHome, canonicalPath } from "../main/paths.js";
import { bootstrapPixProfile } from "../main/services.js";
import { installHttpProxy } from "../main/http-proxy.js";
import { PIX_HOST_VERSION, MAX_REMOTE_PAYLOAD } from "../shared/remote-protocol.js";
import { LOCAL_HOST_PROTOCOL, type HostAddress, type LocalRequest } from "../shared/host-protocol.js";
import type { DesktopEvent } from "../shared/types.js";

export const hostRunDir = () => join(pixHome(), ".pix", "run");
export const hostAddressFile = () => join(hostRunDir(), "host.json");

export const headlessPlatform: Platform = {
  async pickProject() { throw new Error("Specify a project path"); },
  async pickSession() { throw new Error("Specify a session path"); },
  async confirm() { return false; },
  async openExternal() { throw new Error("This operation needs a desktop client"); },
  async resolveProxy() { return "DIRECT"; },
  async openPath() { throw new Error("This operation needs a desktop client"); },
  async openWith() { throw new Error("This operation needs a desktop client"); },
  async openWithApps() { return []; },
  async openWithApp() { throw new Error("This operation needs a desktop client"); },
  showItemInFolder() { throw new Error("This operation needs a desktop client"); },
  quit() {},
};

export async function serveLocalHost() {
  bootstrapPixProfile(pixHome());
  const platforms = new Map<WebSocket, Platform>();
  const desktopViews = new Map<string, { controller: MainController; socket: WebSocket }>();
  const desktopPlatform = () => [...platforms].find(([socket]) => socket.readyState === WebSocket.OPEN)?.[1];
  const proxyRoutes = new Map<string, string>();
  const owner = new MainController(null, {
    ...headlessPlatform,
    async openExternal(url) {
      return (desktopPlatform() ?? headlessPlatform).openExternal(url);
    },
  });
  const closeProxy = installHttpProxy(() => owner.settings.bundle().piGlobal.httpProxy, undefined, process.env, async url => {
    const origin = new URL(url).origin;
    const platform = desktopPlatform();
    if (!platform?.resolveProxy) return proxyRoutes.get(origin) ?? "DIRECT";
    const route = await platform.resolveProxy(url);
    proxyRoutes.delete(origin);
    proxyRoutes.set(origin, route);
    if (proxyRoutes.size > 64) proxyRoutes.delete(proxyRoutes.keys().next().value!);
    return route;
  });
  const token = randomBytes(32).toString("base64url");
  const wss = new WebSocketServer({
    host: "127.0.0.1", port: 0, maxPayload: MAX_REMOTE_PAYLOAD,
    verifyClient: ({ req }, done) => {
      const value = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
      const a = Buffer.from(value), b = Buffer.from(token);
      // Browsers cannot connect through a malicious page with the user's token.
      done(!req.headers.origin && a.length === b.length && timingSafeEqual(a, b), 401);
    },
  });
  const controllers = new Set<MainController>();
  let sequence = 0;
  let lastLive = Date.now();
  let stopping = false;
  const send = (socket: WebSocket, message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const broadcast = (event: DesktopEvent) => {
    for (const socket of wss.clients) send(socket, { type: "event", sequence: ++sequence, event });
  };
  const stopOwnerEvents = owner.onEvent(event => {
    if (event.type === "ui.request" || event.type === "ui.dismiss") broadcast(event);
  });
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(idle);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    stopOwnerEvents();
    for (const controller of controllers) {
      controller.detach();
      await controller.pool.closeAllRemote();
    }
    await owner.closeAll();
    owner.shell.dispose();
    await closeProxy();
    for (const socket of wss.clients) socket.close();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    try {
      const current = JSON.parse(readFileSync(hostAddressFile(), "utf8")) as HostAddress;
      if (current.token === token) rmSync(hostAddressFile(), { force: true });
    } catch { /* Another host may already have replaced a stale address. */ }
  };
  wss.on("connection", socket => {
    lastLive = Date.now();
    let controller: MainController | undefined;
    let clientId: string | undefined;
    let stopEvents: (() => void) | undefined;
    const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    const callPlatform = (method: string, args: unknown[]) => new Promise<any>((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) return reject(new Error("Desktop client disconnected"));
      const id = randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Desktop interaction timed out")); }, 300_000);
      pending.set(id, { resolve, reject, timer });
      send(socket, { type: "platform", id, method, args });
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      stopEvents?.();
      platforms.delete(socket);
      if (clientId && desktopViews.get(clientId)?.socket === socket) {
        // Keep the desktop's selection and remote pool so its next connection
        // takes over the same view, including tasks still running remotely.
        controller?.suspend();
      } else if (controller && (!clientId || desktopViews.get(clientId)?.controller !== controller)) {
        controller.detach();
        void controller.pool.closeAllRemote().catch(error => console.error("PiX host client cleanup", error))
          .finally(() => controllers.delete(controller!));
      }
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Desktop client disconnected")); }
      pending.clear();
      lastLive = Date.now();
    });
    socket.on("message", async data => {
      let request: LocalRequest | undefined;
      try {
        const value = JSON.parse(data.toString());
        if (value.type === "platform.reply") {
          const item = pending.get(value.id);
          if (item) {
            pending.delete(value.id); clearTimeout(item.timer);
            value.error ? item.reject(new Error(String(value.error))) : item.resolve(value.result);
          }
          return;
        }
        request = value;
        if (!request || request.type !== "request" || typeof request.id !== "string") throw new Error("Invalid host request");
        let result: unknown;
        switch (request.method) {
          case "attach": {
            if (controller) throw new Error("Client is already attached");
            const platform = { ...headlessPlatform };
            if (request.platform) {
              for (const name of Object.keys(platform))
                (platform as any)[name] = (...args: unknown[]) => callPlatform(name, args);
            }
            const cwd = request.cwd ? canonicalPath(request.cwd) : null;
            if (cwd && !statSync(cwd).isDirectory()) throw new Error("Project path is not a directory");
            if (request.clientId !== undefined && (!request.platform || typeof request.clientId !== "string" || !/^[\w-]{1,100}$/.test(request.clientId)))
              throw new Error("Invalid desktop client identity");
            clientId = request.clientId;
            const previous = clientId ? desktopViews.get(clientId) : undefined;
            controller = previous?.controller ?? new MainController(cwd, platform, owner);
            // Platform callbacks already captured by remote pools must follow
            // the live socket, too; preserve the object and replace its methods.
            Object.assign(controller.platform, platform);
            if (clientId) desktopViews.set(clientId, { controller, socket });
            if (request.platform) platforms.set(socket, controller.platform);
            previous?.socket.close();
            controllers.add(controller);
            stopEvents = controller.onEvent(event => send(socket, { type: "event", sequence: ++sequence, event }), true);
            result = { protocol: LOCAL_HOST_PROTOCOL, version: PIX_HOST_VERSION, pid: process.pid };
            break;
          }
          case "invoke": {
            if (!controller) throw new Error("Attach a client first");
            if (typeof request.route !== "string") throw new Error("Missing route");
            result = await controller.invoke(request.route, request.input, request.sessionPath);
            break;
          }
          case "status":
            result = { protocol: LOCAL_HOST_PROTOCOL, version: PIX_HOST_VERSION, pid: process.pid,
              clients: wss.clients.size, sessions: owner.registry.liveEntries().length,
              running: [...owner.registry.runningPaths()] };
            break;
          case "shutdown":
            if (owner.hasPendingWork || owner.registry.runningPaths().size || [...controllers].some(c => c.pool.hasConnections))
              throw new Error("Stop running tasks and disconnect remote workspaces before stopping the host");
            result = { stopped: true };
            send(socket, { type: "reply", id: request.id, result });
            void shutdown();
            return;
          default: throw new Error("Unknown host method");
        }
        send(socket, { type: "reply", id: request.id, result });
      } catch (error) {
        send(socket, { type: "reply", id: request?.id ?? "", error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  await new Promise<void>((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); });
  const address: HostAddress = { protocol: LOCAL_HOST_PROTOCOL, version: PIX_HOST_VERSION,
    pid: process.pid, port: (wss.address() as { port: number }).port, token };
  mkdirSync(hostRunDir(), { recursive: true, mode: 0o700 });
  writeFileSync(hostAddressFile(), JSON.stringify(address), { mode: 0o600 });
  let maintaining = false;
  const idle = setInterval(async () => {
    if (maintaining || stopping) return;
    maintaining = true;
    try {
      for (const [id, view] of desktopViews) {
        if (view.socket.readyState !== WebSocket.OPEN && view.controller.pool.hasConnections)
          await view.controller.pool.closeIdleRemote(() => desktopViews.get(id)?.socket.readyState === WebSocket.OPEN);
      }
      if (wss.clients.size || owner.hasPendingWork || owner.registry.runningPaths().size || [...controllers].some(c => c.pool.hasConnections)) lastLive = Date.now();
      else if (Date.now() - lastLive >= Math.max(1000, Number(process.env.PIX_HOST_LINGER_MS) || 600_000)) void shutdown();
    } catch (error) { console.error("PiX host idle maintenance", error); }
    finally { maintaining = false; }
  }, 1000);
  const stop = () => void shutdown();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return { address, shutdown, owner };
}
