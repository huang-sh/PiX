import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { MainController, type Platform } from "../main/controller.js";
import { setDebugLogEnabled } from "../main/debug-log.js";
import { pixHome } from "../main/paths.js";
import { bootstrapPixProfile } from "../main/services.js";
import { enrichLoginPath } from "./login-env.js";
import {
  PIX_HOST_VERSION,
  PIX_REMOTE_PROTOCOL,
  MAX_REMOTE_PAYLOAD,
  isProjectRoute,
  type ClientMessage,
  type HostMessage,
  type HostRequest,
} from "../shared/remote-protocol.js";
import type { DesktopEvent } from "../shared/types.js";
import { brokerOptions, BrokerModelStream } from "../main/model-broker.js";

const READY_MARKER = "PIX_AGENT_HOST_READY ";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function send(socket: WebSocket, message: HostMessage) {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
}

function authorized(url: string | undefined, token: string) {
  const candidate = new URL(url ?? "/", "ws://127.0.0.1").searchParams.get(
    "token",
  );
  if (!candidate) return false;
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function serve() {
  // Shared hosts keep their diagnostics on stderr; the desktop owns the log file.
  setDebugLogEnabled(false);
  const requestedCwd = option("--cwd");
  if (!requestedCwd) throw new Error("--cwd is required");
  // Match workspace.directories: both the controller and hello must use the
  // real directory, so a symlink alias cannot create a second pooled owner.
  // Let filesystem errors retain their code and path (e.g. EACCES or ELOOP).
  const cwd = realpathSync(resolve(requestedCwd)).split(sep).join("/");
  if (!statSync(cwd).isDirectory())
    throw new Error(`Project path is not a directory: ${cwd}`);
  const readyFile = option("--ready-file");
  // Credential deployment is a desktop decision: the host accepts
  // loginApiKey/logout only when the desktop started it with this flag.
  const allowCredentialDeploy = process.argv.includes("--allow-credential-deploy");
  const port = Number(option("--port") ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("--port must be an integer between 0 and 65535");
  const platform: Platform = {
    async pickProject() {
      return undefined;
    },
    async pickSession() {
      return undefined;
    },
    async confirm() {
      return true;
    },
    async openExternal() {
      throw new Error("Opening local URLs is unavailable on the remote host");
    },
    async openPath() {
      throw new Error("Opening files with local applications is unavailable on the remote host");
    },
    async openWith() {
      throw new Error("Opening files with local applications is unavailable on the remote host");
    },
    async openWithApps() {
      throw new Error("Opening files with local applications is unavailable on the remote host");
    },
    async openWithApp() {
      throw new Error("Opening files with local applications is unavailable on the remote host");
    },
    showItemInFolder() {
      throw new Error("Opening the file manager is unavailable on the remote host");
    },
    quit() {},
  };
  await enrichLoginPath();
  bootstrapPixProfile(pixHome());
  const controller = new MainController(cwd, platform);
  const { VERSION: piVersion } = await controller.projectRuntime.pi();
  const token = randomBytes(32).toString("base64url");
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port,
    maxPayload: MAX_REMOTE_PAYLOAD,
    verifyClient: ({ req }, done) => done(authorized(req.url, token), 401),
  });
  let sequence = 0;
  // Refreshed by connections and running work; a lingering host exits once
  // this stops advancing for the whole linger window.
  let lastLive = Date.now();
  // The connection whose broker the runtime currently uses. A dead socket's
  // close event can land after a replacement connected; only the owner's
  // close may clear the broker.
  let brokerOwner: WebSocket | undefined;
  const stopEvents = controller.onEvent((event: DesktopEvent) => {
    const message: HostMessage = { type: "event", sequence: ++sequence, event };
    for (const client of wss.clients) send(client, message);
  }, true);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopEvents();
    const timeout = setTimeout(() => process.exit(1), 5_000);
    timeout.unref();
    try {
      controller.shell.dispose();
      // An interrupted first turn may exist only in memory until its error
      // response is appended. Drain it before disposing or exiting.
      await controller.closeAll();
    } catch (error) {
      process.stderr.write(`Remote shutdown failed: ${String(error)}\n`);
      process.exitCode = 1;
    } finally {
      controller.dispose();
      wss.close(() => { clearTimeout(timeout); process.exit(process.exitCode ?? 0); });
    }
  };

  wss.on("connection", (socket) => {
    // ws emits 'error' right before 'close'; without a listener the event
    // throws and kills the host. The 'close' handler below does the cleanup.
    socket.on("error", () => {});
    lastLive = Date.now();
    const modelStreams = new Map<string, BrokerModelStream>();
    brokerOwner = socket;
    controller.projectRuntime.setModelBroker((model, context, options) => {
      const id = randomBytes(16).toString("hex");
      const stream = new BrokerModelStream(model);
      // A lingering host serves sessions between desktop connections; a
      // brokered call with no live socket must fail fast instead of hanging.
      if (socket.readyState !== WebSocket.OPEN) {
        stream.fail("Desktop model broker is not connected");
        return stream;
      }
      const abort = () => send(socket, { type: "model.cancel", id });
      modelStreams.set(id, stream);
      options?.signal?.addEventListener("abort", abort, { once: true });
      void stream.result().finally(() => {
        modelStreams.delete(id);
        options?.signal?.removeEventListener("abort", abort);
      });
      send(socket, {
        type: "model.request",
        id,
        provider: String(model.provider),
        modelId: String(model.id),
        context,
        options: brokerOptions(options),
      });
      return stream;
    });
    send(socket, {
      type: "hello",
      protocol: PIX_REMOTE_PROTOCOL,
      hostVersion: PIX_HOST_VERSION,
      piVersion,
      platform: process.platform,
      arch: process.arch,
      cwd,
      allowCredentialDeploy,
    });
    socket.on("message", async (data) => {
      let request: HostRequest | undefined;
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        if (message.type === "model.event") {
          modelStreams.get(message.id)?.push(message.event);
          return;
        }
        if (message.type === "model.failure") {
          modelStreams.get(message.id)?.fail(message.error);
          return;
        }
        if (message.type === "shutdown") {
          // The desktop's intentional teardown: drain and exit now instead of
          // waiting out the linger window.
          socket.close();
          setImmediate(shutdown);
          return;
        }
        request = message;
        if (
          request.type !== "request" ||
          typeof request.id !== "string" ||
          !isProjectRoute(request.route)
        )
          throw new Error("Invalid remote request");
        if (
          (request.route === "settings.update" ||
            request.route === "settings.reset") &&
          (request.input as { scope?: unknown } | undefined)?.scope === "app"
        )
          throw new Error("App settings are local-only");
        if (
          request.route === "agent.control" &&
          ["loginApiKey", "logout"].includes(
            String((request.input as { action?: unknown } | undefined)?.action),
          ) &&
          !allowCredentialDeploy
        )
          throw new Error("Model credentials are desktop-only");
        const result = await controller.invoke(request.route, request.input);
        send(socket, {
          type: "response",
          id: request.id,
          ok: true,
          result,
        });
      } catch (error) {
        send(socket, {
          type: "response",
          id: request?.id ?? "",
          ok: false,
          error: {
            code: "REMOTE_REQUEST_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });
    socket.on("close", () => {
      // A superseded connection must not clear its replacement's broker.
      if (brokerOwner === socket) {
        brokerOwner = undefined;
        controller.projectRuntime.setModelBroker(undefined);
      }
      for (const stream of modelStreams.values())
        stream.fail("Desktop model broker disconnected");
      modelStreams.clear();
      // The host lingers on: unplanned disconnects leave running work alive,
      // and the idle check below reaps it once nothing runs and nobody
      // reconnects within the linger window.
    });
  });
  wss.on("error", (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  });
  await new Promise<void>((accept) => wss.once("listening", accept));
  const address = wss.address() as AddressInfo;
  // A lingering host outlives its desktop connection: an unplanned disconnect
  // leaves running work alive. It exits once nobody is connected and nothing
  // has run for the whole linger window.
  const lingerMs = Math.max(
    30_000,
    Number.parseInt(process.env.PIX_HOST_LINGER_MS ?? "600000", 10) || 600_000,
  );
  const idleCheck = setInterval(() => {
    if (wss.clients.size > 0) {
      lastLive = Date.now();
      return;
    }
    void (async () => {
      try {
        const sessions = await controller.invoke("session.list") as { running?: boolean }[];
        if (sessions.some((session) => session.running)) lastLive = Date.now();
        else if (Date.now() - lastLive >= lingerMs) {
          clearInterval(idleCheck);
          await shutdown();
        }
      } catch {
        // A busy check that cannot run must not become a shutdown reason.
        lastLive = Date.now();
      }
    })();
  }, 30_000);
  idleCheck.unref();
  const readyLine =
    `${READY_MARKER}${JSON.stringify({
      protocol: PIX_REMOTE_PROTOCOL,
      port: address.port,
      token,
      pid: process.pid,
    })}\n`;
  process.stdout.write(readyLine);
  if (readyFile) writeFileSync(readyFile, readyLine, { mode: 0o600 });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const command = process.argv[2];
function report(error: unknown) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
}
if (command === "version") {
  process.stdout.write(
    `${JSON.stringify({ version: PIX_HOST_VERSION, protocol: PIX_REMOTE_PROTOCOL })}\n`,
  );
} else if (command === "serve") {
  // Node aborts the process on unhandled rejections and on stream 'error'
  // events with no listener (e.g. an extension writing to a dead helper
  // socket). A remote host runs third-party extension code, and its death
  // costs the user the whole workspace — the desktop (Electron) survives the
  // same faults, so the host logs and lives too. stderr is its diagnostics channel.
  process.on("unhandledRejection", report);
  process.on("uncaughtException", report);
  void serve().catch((error) => {
    report(error);
    process.exitCode = 1;
  });
} else {
  process.stderr.write("Usage: pix-agent-host <version|serve --cwd PATH>\n");
  process.exitCode = 2;
}
