import { randomBytes, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { MainController, type Platform } from "../main/controller.js";
import { enrichLoginPath } from "./login-env.js";
import {
  PIX_HOST_VERSION,
  PIX_REMOTE_PROTOCOL,
  isProjectRoute,
  type ClientMessage,
  type HostMessage,
  type HostRequest,
} from "../shared/remote-protocol.js";
import type { DesktopEvent } from "../shared/types.js";
import { brokerOptions, BrokerModelStream } from "../main/model-broker.js";

const PI_VERSION = "0.84.4";
const READY_MARKER = "PIX_AGENT_HOST_READY ";
const MAX_PAYLOAD = 16 * 1024 * 1024;

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
  const requestedCwd = option("--cwd");
  if (!requestedCwd) throw new Error("--cwd is required");
  const cwd = resolve(requestedCwd);
  try {
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch {
    throw new Error(`Project directory not found: ${cwd}`);
  }
  const exitOnDisconnect = process.argv.includes("--exit-on-disconnect");
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
    quit() {},
  };
  await enrichLoginPath();
  const controller = new MainController(cwd, platform);
  const token = randomBytes(32).toString("base64url");
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port,
    maxPayload: MAX_PAYLOAD,
    verifyClient: ({ req }, done) => done(authorized(req.url, token), 401),
  });
  let sequence = 0;
  let hadClient = false;
  const stopEvents = controller.onEvent((event: DesktopEvent) => {
    const message: HostMessage = { type: "event", sequence: ++sequence, event };
    for (const client of wss.clients) send(client, message);
  });
  const shutdown = () => {
    stopEvents();
    controller.dispose();
    wss.close(() => process.exit(0));
  };

  wss.on("connection", (socket) => {
    hadClient = true;
    const modelStreams = new Map<string, BrokerModelStream>();
    controller.pi.setModelBroker((model, context, options) => {
      const id = randomBytes(16).toString("hex");
      const stream = new BrokerModelStream(model);
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
      piVersion: PI_VERSION,
      platform: process.platform,
      arch: process.arch,
      cwd,
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
          )
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
      controller.pi.setModelBroker(undefined);
      for (const stream of modelStreams.values())
        stream.fail("Desktop model broker disconnected");
      modelStreams.clear();
      if (exitOnDisconnect && hadClient) setImmediate(shutdown);
    });
  });
  wss.on("error", (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  });
  await new Promise<void>((accept) => wss.once("listening", accept));
  const address = wss.address() as AddressInfo;
  process.stdout.write(
    `${READY_MARKER}${JSON.stringify({
      protocol: PIX_REMOTE_PROTOCOL,
      port: address.port,
      token,
      pid: process.pid,
    })}\n`,
  );
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const command = process.argv[2];
if (command === "version") {
  process.stdout.write(
    `${JSON.stringify({ version: PIX_HOST_VERSION, protocol: PIX_REMOTE_PROTOCOL })}\n`,
  );
} else if (command === "serve") {
  void serve().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
} else {
  process.stderr.write("Usage: pix-agent-host <version|serve --cwd PATH>\n");
  process.exitCode = 2;
}
