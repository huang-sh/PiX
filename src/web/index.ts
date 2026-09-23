import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { MainController } from "../main/controller.js";
import { debugLog } from "../main/debug-log.js";
import { pixHome } from "../main/paths.js";
import { bootstrapPixProfile } from "../main/services.js";
import { UpdateChecker } from "../main/update-check.js";
import type { DesktopEvent, DesktopRoute } from "../shared/types.js";
import type { ClientMessage, HostMessage, WebConfirmReply } from "../shared/web-protocol.js";
import { createWebPlatform, openUrl } from "./platform.js";

const dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(dir, "..", "..");
const rendererDir = join(root, "out", "renderer");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function send(socket: WebSocket, message: HostMessage) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function serveStatic(urlPath: string, res: import("node:http").ServerResponse) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const file = resolve(rendererDir, relative);
  if (!file.startsWith(rendererDir)) {
    res.writeHead(403).end();
    return;
  }
  const target =
    existsSync(file) && statSync(file).isFile()
      ? file
      : join(rendererDir, "index.html");
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "Content-Type": MIME[extname(target)] ?? "application/octet-stream",
    }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

async function main() {
  bootstrapPixProfile(pixHome());
  const initial = process.env.PIX_PROJECT ? resolve(process.env.PIX_PROJECT) : null;
  const confirms = new Map<
    string,
    { resolve: (value: boolean) => void; socket: WebSocket }
  >();
  let activeSocket: WebSocket | undefined;
  const controller = new MainController(
    initial,
    createWebPlatform(async (message, detail) => {
      const socket = activeSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      const id = randomUUID();
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          confirms.delete(id);
          resolve(false);
        }, 60_000);
        confirms.set(id, {
          socket,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        });
        send(socket, {
          type: "platform",
          id,
          method: "confirm",
          message,
          ...(detail ? { detail } : {}),
        });
      });
    }),
  );
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  new UpdateChecker({
    version: () => pkg.version,
    skipped: () => controller.settings.bundle().app.updateSkippedVersion,
    emit: (event) => controller.emit(event),
  }).start();

  const host = option("--host") ?? process.env.PIX_HOST ?? "127.0.0.1";
  const port = Number(option("--port") ?? process.env.PIX_PORT ?? 5173);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("--port must be an integer between 0 and 65535");

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, path: "/pix" });
  const dev = process.env.PIX_DEV === "1" || process.argv.includes("--dev");
  let vite:
    | Awaited<ReturnType<typeof import("vite")["createServer"]>>
    | undefined;
  if (dev) {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      configFile: join(root, "vite.config.ts"),
      appType: "spa",
      server: { middlewareMode: true, hmr: { server: httpServer } },
    });
  } else if (!existsSync(join(rendererDir, "index.html"))) {
    throw new Error("Renderer build not found. Run `npm run build` or `npm run dev`.");
  }

  httpServer.on("request", (req, res) => {
    if (vite) {
      vite.middlewares(req, res, () => {
        res.writeHead(404).end();
      });
      return;
    }
    void serveStatic(req.url ?? "/", res);
  });

  controller.onEvent((event: DesktopEvent) => {
    const message: HostMessage = { type: "event", event };
    for (const client of wss.clients) send(client, message);
  }, true);

  wss.on("connection", (socket) => {
    socket.on("message", async (data) => {
      let requestId = "";
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        if (message.type === "platform.reply") {
          const pending = confirms.get(message.id);
          if (pending && pending.socket === socket) {
            confirms.delete(message.id);
            pending.resolve((message as WebConfirmReply).result === true);
          }
          return;
        }
        if (message.type !== "request" || typeof message.id !== "string")
          throw new Error("Invalid request");
        requestId = message.id;
        activeSocket = socket;
        const result = await controller.invoke(
          message.route as DesktopRoute,
          message.input,
        );
        send(socket, { type: "response", id: requestId, ok: true, result });
      } catch (error) {
        send(socket, {
          type: "response",
          id: requestId,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (activeSocket === socket) activeSocket = undefined;
      }
    });
    socket.on("close", () => {
      for (const [id, pending] of confirms) {
        if (pending.socket === socket) {
          confirms.delete(id);
          pending.resolve(false);
        }
      }
    });
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const timeout = setTimeout(() => process.exit(1), 5_000);
    timeout.unref();
    try {
      await vite?.close();
      controller.shell.dispose();
      await controller.closeAll();
    } catch (error) {
      process.stderr.write(`Shutdown failed: ${String(error)}\n`);
      process.exitCode = 1;
    } finally {
      controller.dispose();
      wss.close();
      httpServer.close(() => {
        clearTimeout(timeout);
        process.exit(process.exitCode ?? 0);
      });
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise<void>((accept, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, accept);
  });
  const address = httpServer.address() as AddressInfo;
  const url = `http://${address.address === "::" ? "127.0.0.1" : address.address}:${address.port}/`;
  process.stdout.write(`PiX web UI: ${url}\n`);
  if (process.env.PIX_NO_OPEN !== "1") {
    try {
      openUrl(url);
    } catch {}
  }
}

void main().catch((error) => {
  debugLog("web: startup", error);
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
