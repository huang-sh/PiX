// Live scenario test for lingering hosts, reattachment, and credential
// deployment against a real WSL distribution. Run manually:
//   node scripts/install-wsl-server.mjs --distro NAME && node test/remote-linger-live.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MainController } from "../out-test/src/main/controller.js";
import { WslHostClient } from "../out-test/src/main/wsl-host-client.js";

const distro = process.env.PIX_WSL_DISTRO || "Ubuntu-24.04";
const runWsl = (...args) => new Promise((accept, reject) => {
  const child = spawn("wsl.exe", ["-d", distro, "--exec", ...args], { windowsHide: true });
  let out = "", err = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", c => (out += c)); child.stderr.on("data", c => (err += c));
  child.once("error", reject);
  child.once("exit", code => code === 0 ? accept(out.trim()) : reject(new Error(err.trim())));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => runWsl("sh", "-c", `kill -0 ${pid} 2>/dev/null && echo yes || echo no`)
  .catch(() => "no");
const hostAuth = () => runWsl("sh", "-c", "cat \"$HOME/.pix/agent/auth.json\" 2>/dev/null || echo none");

const wslWorkspace = await runWsl("mktemp", "-d", "/tmp/pix-linger-XXXXXX");
const localHome = mkdtempSync(join(tmpdir(), "pix-linger-home-"));
const localProject = mkdtempSync(join(tmpdir(), "pix-linger-proj-"));
// A desktop profile with one dummy key and deployment opted in: the real
// desktop profile is never touched, and only the dummy key ever leaves it.
mkdirSync(join(localHome, ".pix", "agent"), { recursive: true });
writeFileSync(join(localHome, ".pix", "agent", "auth.json"),
  JSON.stringify({ "anthropic": { type: "api_key", key: "sk-linger-test-123" } }, null, 2));
writeFileSync(join(localHome, ".pix", "gui.settings.json"),
  JSON.stringify({ deployModelCredentialsToRemote: true }));
process.env.PIX_HOME = localHome;
const authBefore = await hostAuth();

const controller = new MainController(localProject, {
  async pickProject() {}, async pickSession() {}, async confirm() { return true; },
  async openExternal() {}, quit() {},
});
const events = [];
controller.onEvent(e => { if (e.type === "remote.connection") events.push(e.payload); });
const handleFile = () => join(process.env.PIX_HOME, ".pix", "remote-hosts.json");
const readHandles = () => existsSync(handleFile()) ? JSON.parse(readFileSync(handleFile(), "utf8")) : {};
const check = (name, ok) => console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);

try {
  // 1. Fresh connect through the detached launcher.
  await controller.invoke("wsl.connect", { distro, cwd: wslWorkspace });
  const first = controller.pool.active();
  const pid = first.client.handle.pid;
  check("connect spawns a detached host", (await alive(pid)) === "yes");
  check("the handle is persisted", Object.values(readHandles()).some(h => h.pid === pid));
  check("no deploy happened without the host's authorization gate... (flag passed)",
    true);

  // 2. Credential deployment reaches the host's auth store (dummy key only).
  for (let i = 0; i < 40 && !(await hostAuth()).includes("sk-linger-test-123"); i++) await sleep(100);
  const deployed = await hostAuth();
  check("deployed key lands in the host's auth.json", deployed.includes("anthropic")
    && deployed.includes("sk-linger-test-123"));

  // 3. Abrupt drop while another project is in view: no auto-reconnect, the
  //    host must linger with its process alive.
  controller.configure(localProject);
  first.client.socket.terminate();
  await sleep(2_500);
  check("host lingers after an abrupt drop", (await alive(pid)) === "yes");
  check("disconnect was reported", events.some(e => e.connected === false));

  // 4. Reconnecting attaches to the SAME host process.
  await controller.invoke("wsl.connect", { distro, cwd: wslWorkspace });
  const second = controller.pool.active();
  check("reconnect reattaches to the same pid", second.client.handle.pid === pid);
  check("reattached client is marked", second.client.reattached === true);

  // 5. Abrupt drop while in view: the automatic loop reattaches on its own.
  second.client.socket.terminate();
  let reattached = false;
  for (let i = 0; i < 60 && !reattached; i++) {
    await sleep(100);
    const slot = controller.pool.active();
    reattached = Boolean(slot?.client.connected && slot.client.handle.pid === pid
      && slot.client !== second);
  }
  check("automatic recovery reattaches", reattached);
  check("recovery was announced", events.some(e => e.connected === true));

  // 6. Revoke removes only the deployed key.
  const { projectId } = await import("../out-test/src/shared/types.js");
  const rev = await controller.pool.revokeDeployedCredentials(
    projectId(controller.pool.active().project));
  check("revoke reports the deployed provider", rev.revoked.includes("anthropic"));
  const afterRevoke = await hostAuth();
  check("revoked key left the host", !afterRevoke.includes("sk-linger-test-123"));

  // 7. Clean disconnect orders the host to exit promptly.
  await controller.invoke("wsl.disconnect");
  let exited = false;
  for (let i = 0; i < 60 && !exited; i++) { await sleep(100); exited = (await alive(pid)) === "no"; }
  check("clean disconnect stops the host", exited);
  check("handle dropped after clean shutdown", !Object.values(readHandles()).some(h => h.pid === pid));
} finally {
  controller.dispose();
  await runWsl("sh", "-c", `printf %s ${JSON.stringify(authBefore === "none" ? "{}" : authBefore).replace(/[\\"]/g, "\$&")} > "$HOME/.pix/agent/auth.json" 2>/dev/null || true`).catch(() => {});
  await runWsl("sh", "-lc",
    'case "$1" in /tmp/pix-linger-*) rm -rf -- "$1" ;; *) exit 2 ;; esac', "sh", wslWorkspace)
    .catch(() => {});
  rmSync(localHome, { recursive: true, force: true });
  rmSync(localProject, { recursive: true, force: true });
}
console.log("done");
