// Opt-in real-remote Pixie check: connect the GUI to a real SSH server
// (the repo's established test host) and delegate from the Pixie card onto the
// remote session tree; the agent runs remotely with the remote's own
// credentials. Set PIX_REAL_PROVIDER/PIX_REAL_MODEL (local Pixie brain) and
// optionally PIX_KEEP_REMOTE=1 to preserve the workspace for inspection.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const provider = process.env.PIX_REAL_PROVIDER, model = process.env.PIX_REAL_MODEL;
if (!provider || !model) throw new Error("Set PIX_REAL_PROVIDER and PIX_REAL_MODEL (local Pixie brain)");
const HOST = "stempdac.hpc4ai.unito.it";
const SSH = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", HOST];
const ssh = (command, timeout = 60_000) => spawnSync("ssh", [...SSH, command], { encoding: "utf8", timeout });
const marker = `REMOTEMARK-${randomUUID().slice(0, 8)}`;
const keep = process.env.PIX_KEEP_REMOTE === "1";

const home = mkdtempSync(join(tmpdir(), "pixie-real-remote-"));
chmodSync(home, 0o700);
mkdirSync(join(home, ".pix"), { recursive: true });
const agent = join(home, ".pix", "agent");
mkdirSync(agent, { recursive: true, mode: 0o700 });
const source = join(homedir(), ".pix", "agent");
const credentials = JSON.parse(readFileSync(join(source, "auth.json"), "utf8"));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ [provider]: credentials[provider] }), { mode: 0o600 });
if (existsSync(join(source, "models.json"))) copyFileSync(join(source, "models.json"), join(agent, "models.json"));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel: model,
  defaultThinkingLevel: "off", defaultProjectTrust: "always", retry: { enabled: false } }));
writeFileSync(join(home, ".pix", "gui.settings.json"), JSON.stringify({ language: "zh-CN", closeToTray: false,
  pixie: { defaultModel: `${provider}/${model}`, restoreLastConversation: true } }));
const remoteWorkspace = String(ssh(`mktemp -d /tmp/pix-remote-pixie-XXXXXX`).stdout).trim();
if (!/^\/tmp\/pix-remote-pixie-[A-Za-z0-9]+$/.test(remoteWorkspace)) throw new Error(`workspace failed: ${remoteWorkspace}`);
ssh(`printf '真实远程标记行：%s\\n' '${marker}' > '${remoteWorkspace}/input.txt'`);
process.once("exit", () => {
  rmSync(join(agent, "auth.json"), { force: true });
  rmSync(home, { recursive: true, force: true });
  if (!keep) ssh(`rm -rf -- '${remoteWorkspace}'`, { timeout: 30_000 });
});

const env = { ...process.env, PIX_HOME: home, PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: "1" };
const journal = join(agent, "pixie", "delegations.json");
const readJournal = () => { try { return JSON.parse(readFileSync(journal, "utf8")).tasks ?? []; } catch { return []; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, timeout, what) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch { /* retry */ } await sleep(1000); }
  throw new Error(`timeout waiting for ${what}`);
};
class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.id = 0; this.pending = new Map(); }
  async open() {
    await new Promise((res, rej) => { this.socket.addEventListener("open", res, { once: true }); this.socket.addEventListener("error", rej, { once: true }); });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
}
const snapshotView = cdp => cdp.evaluate(`(async () => {
  const snapshot = await window.pix.invoke("pixie.ensure");
  const tools = snapshot.entries
    .filter(e => e.type === "message" && e.message?.role === "toolResult")
    .map(e => {
      const text = (e.message.content ?? []).map(p => p.text ?? "").join("");
      if (e.message.toolName === "canvas_read") {
        try {
          const parsed = JSON.parse(text);
          return "canvas_read task.state=" + parsed.task?.state
            + " output=" + JSON.stringify(parsed.output)?.slice(0, 500)
            + " ancestors=" + (parsed.ancestors?.length ?? 0);
        } catch { return "canvas_read unparsable: " + text.slice(0, 300); }
      }
      return e.message.toolName + (e.message.isError ? " ERROR: " : " → ") + text.slice(0, 200);
    });
  const replies = snapshot.entries.filter(e => e.type === "message" && e.message?.role === "assistant")
    .map(e => (e.message.content ?? []).filter(p => p.type === "text").map(p => p.text).join("")).join("\\n");
  return { tools, replies };
})()`);

let desktop;
const results = { marker, remoteWorkspace };
try {
  const port = 9969;
  desktop = spawn(electronBinary(root), ["--no-sandbox", "--disable-gpu", `--user-data-dir=${join(home, "electron")}`,
    `--remote-debugging-port=${port}`, root], { cwd: root, env, windowsHide: true });
  let cdp = await until(async () => {
    if (desktop.exitCode !== null) throw new Error(`desktop exited ${desktop.exitCode}`);
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find(item => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page) return;
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    return (await cdp.evaluate("Boolean(window.__pixTest && window.pix)")) ? cdp : undefined;
  }, 40_000, "GUI to mount");

  await cdp.evaluate(`window.pix.invoke("ssh.connect", ${JSON.stringify({ host: HOST, cwd: remoteWorkspace, browse: false })})`);
  await cdp.evaluate(`window.pix.invoke("remote.openProject", { path: ${JSON.stringify(remoteWorkspace)} })`);
  // Entering a project is renderer-side hydration; a reload re-bootstraps the
  // now-current remote workspace exactly like a real app start.
  await cdp.evaluate("location.reload()");
  await sleep(4000);
  cdp = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find(item => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page) return;
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    if (!(await cdp.evaluate("Boolean(window.__pixTest && window.pix)"))) return;
    return (await cdp.evaluate("window.__pixTest.state().project?.remote")) ? cdp : undefined;
  }, 120_000, "remote workspace to become the current view");
  results.enteredRemote = true;

  await cdp.evaluate(`window.pix.invoke("pixie.send", { text: ${JSON.stringify(
    `当前画布连接的是远程服务器上的工作区。请派一个任务（模型指定 deepseek/deepseek-chat）：读取工作区根目录的 input.txt，并在报告中原样引用其中的标记行。任务结果到达后，把标记内容告诉我。`)} })`);
  const task = await until(() => {
    const found = readJournal().find(task => task.notification === "delivered");
    return found?.state === "settled" ? found : undefined;
  }, 420_000, "remote delegation to settle and be reviewed");
  const view = await snapshotView(cdp);
  results.task = { state: task.state, purpose: task.purpose.slice(0, 60), target: task.target.session };
  results.markerReported = view.replies.includes(marker);
  results.toolTrace = view.tools;
  results.remoteSessionFiles = String(ssh(`ls '${remoteWorkspace}/.pi/sessions/' 2>/dev/null | head -3`).stdout).trim().split("\n").filter(Boolean);
} catch (error) {
  results.error = String(error.message ?? error);
} finally {
  if (desktop && desktop.exitCode === null) { desktop.kill("SIGKILL"); await sleep(500); }
}

console.log(JSON.stringify(results, null, 2));
const ok = results.markerReported === true
  && results.remoteSessionFiles?.length > 0
  && results.task?.target.startsWith(results.remoteWorkspace);
console.log(ok ? "\nREAL REMOTE PIXIE: PASS" : "\nREAL REMOTE PIXIE: FAIL");
process.exit(ok ? 0 : 1);
