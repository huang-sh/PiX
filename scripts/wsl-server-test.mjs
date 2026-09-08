import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MainController } from "../out-test/src/main/controller.js";
import { WslHostClient } from "../out-test/src/main/wsl-host-client.js";

if (process.platform !== "win32") {
  console.error("test:wsl requires Windows: it drives a WSL distribution through wsl.exe.");
  process.exit(1);
}

const distributions = await WslHostClient.distributions();
const distro = process.env.PIX_WSL_DISTRO || distributions[0]?.name;
if (!distro) throw new Error("No WSL distribution is installed");
const runWsl = (...args) =>
  new Promise((accept, reject) => {
    const child = spawn(
      "wsl.exe",
      ["-d", distro, "--exec", ...args],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? accept(stdout.trim())
        : reject(new Error(`WSL command failed: ${stderr.trim()}`)),
    );
  });

const cwd = await runWsl("mktemp", "-d", "/tmp/pix-wsl-test-XXXXXX");
const localHome = mkdtempSync(join(tmpdir(), "pix-wsl-controller-"));
process.env.PIX_HOME = localHome;
const localProject = fileURLToPath(new URL("../test/workspace", import.meta.url));
const platform = {
  async pickProject() {},
  async pickSession() {},
  async confirm() { return true; },
  async openExternal() {},
  quit() {},
};
const controller = new MainController(localProject, platform);
try {
  const connected = await controller.invoke("wsl.connect", { distro, cwd });
  assert.deepEqual(connected.project.remote, { kind: "wsl", distro });
  assert.equal(controller.wsl.hello.platform, "linux");
  assert.equal(controller.wsl.hello.cwd, cwd);
  const hello = controller.wsl.hello;

  await controller.invoke("workspace.write", {
    path: "hello.txt",
    content: "hello from PiX WSL\n",
  });
  const file = await controller.invoke("workspace.read", { path: "hello.txt" });
  assert.equal(file.content, "hello from PiX WSL\n");

  const shell = await controller.invoke("shell.run", { command: "uname -s" });
  assert.match(shell.output, /Linux/);
  const tree = await controller.invoke("workspace.tree");
  assert.ok(tree.some((entry) => entry.path === "hello.txt"));

  await controller.invoke("shell.run", { command: "mkdir -p .pi/sessions" });
  await controller.invoke("workspace.write", {
    path: ".pi/sessions/rename.jsonl",
    content: `${JSON.stringify({
      type: "session",
      version: 3,
      id: "01a066b6-f68d-76c3-9f31-4062c699c219",
      timestamp: "2026-09-03T00:00:00.000Z",
      cwd,
    })}\n`,
  });
  const sessions = await controller.invoke("session.list");
  assert.equal(sessions.length, 1);
  await controller.invoke("session.rename", {
    path: sessions[0].path,
    name: "Remote renamed",
  });
  assert.equal((await controller.invoke("session.list"))[0].name, "Remote renamed");
  const projectState = await controller.invoke("app.bootstrap");
  assert.equal(projectState.projects.find((project) => project.id.startsWith("wsl:"))?.connected, true);
  const created = await controller.invoke("agent.control", { action: "newSession" });
  assert.equal(created.session.cwd, cwd);
  const disconnected = await controller.invoke("wsl.disconnect");
  assert.equal(disconnected.project.path, localProject);
  assert.equal(disconnected.project.remote, undefined);
  assert.equal(disconnected.projects.find((project) => project.id.startsWith("wsl:"))?.connected, false);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      distro,
      host: hello,
      workspace: cwd,
      checks: ["controller", "websocket", "workspace", "shell", "pi-session", "session-rename", "project-session-create", "connection-state", "disconnect"],
    })}\n`,
  );
} finally {
  controller.dispose();
  await runWsl(
    "sh",
    "-lc",
    'case "$1" in /tmp/pix-wsl-test-*) rm -rf -- "$1" ;; *) exit 2 ;; esac',
    "sh",
    cwd,
  );
  rmSync(localHome, { recursive: true, force: true });
}
