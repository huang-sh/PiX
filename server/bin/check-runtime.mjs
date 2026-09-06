import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const minimum = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node;
const parts = process.versions.node.split(".").map(Number);
const required = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(minimum)?.slice(1).map(Number);
if (!required || !/^\d+\.\d+\.\d+$/.test(process.versions.node) ||
    process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) ||
    parts[0] < required[0] || (parts[0] === required[0] &&
      (parts[1] < required[1] || (parts[1] === required[1] && parts[2] < required[2])))) {
  throw new Error(`PiX runtime incompatible: requires Linux Node ${minimum}, got ${process.platform} ${process.version}`);
}

const mode = process.argv[2];
if (mode === "--probe") {
  console.log(process.execPath);
} else {
  let recorded = "";
  try { recorded = readFileSync(join(root, "node-version"), "utf8").trim(); } catch {}
  // A system Node upgrade must pass the same checks as a fresh installation.
  if (mode !== "--verify" || recorded !== process.versions.node) {
    await smoke();
    if (mode === "--check") writeFileSync(join(root, "node-version"), `${process.versions.node}\n`);
  }
}

async function smoke() {
  const { default: WebSocket } = await import("ws");
  const home = mkdtempSync(join(tmpdir(), "pix-runtime-check-"));
  const child = spawn(process.execPath, [join(root, "dist/server/index.js"), "serve", "--cwd", home, "--exit-on-disconnect"], {
    env: { ...process.env, PIX_HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi"), PI_OFFLINE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "close").catch(() => undefined);
  let socket;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  try {
    await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(`PiX runtime check timed out: ${stderr}`)), 20_000);
      const fail = (error) => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`PiX runtime check exited ${code}: ${stderr}`)));
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (!line.startsWith("PIX_AGENT_HOST_READY ")) return;
        const ready = JSON.parse(line.slice("PIX_AGENT_HOST_READY ".length));
        socket = new WebSocket(`ws://127.0.0.1:${ready.port}/?token=${ready.token}`);
        socket.on("error", fail);
        socket.on("close", () => fail(new Error("PiX runtime check disconnected")));
        let output = "";
        socket.on("message", (raw) => {
          const message = JSON.parse(raw.toString());
          if (message.type === "hello") {
            socket.send(JSON.stringify({ type: "request", id: "create", route: "terminal.create", input: { cols: 80, rows: 24 } }));
          } else if (message.type === "response") {
            if (!message.ok) return fail(new Error(message.error.message));
            if (message.id === "create") socket.send(JSON.stringify({
              type: "request", id: "write", route: "terminal.write",
              input: { id: message.result.id, data: "printf 'pix-runtime-%s\\n' ok\r" },
            }));
          } else if (message.type === "event" && message.event.type === "terminal") {
            output = (output + (message.event.payload.data ?? "")).slice(-8000);
            if (output.includes("pix-runtime-ok")) { clearTimeout(timer); accept(); }
          }
        });
      });
    });
  } finally {
    socket?.close();
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
    rmSync(home, { recursive: true, force: true });
  }
}
