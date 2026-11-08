// Opt-in real-agent dual-surface check: set PIX_REAL_PROVIDER/PIX_REAL_MODEL
// (credentials are read from ~/.pix/agent/auth.json, copied into a throwaway
// home and deleted on exit). GUI: a real LLM decides how to delegate through
// the live canvas; CLI: the same model continues that task line headlessly.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const provider = process.env.PIX_REAL_PROVIDER, model = process.env.PIX_REAL_MODEL;
if (!provider || !model) throw new Error("Set PIX_REAL_PROVIDER and PIX_REAL_MODEL to opt in to external model calls");
const source = process.env.PIX_REAL_AGENT_DIR ?? join(homedir(), ".pix", "agent");
const marker = `REALMARK-${randomUUID().slice(0, 8)}`;

const home = mkdtempSync(join(tmpdir(), "pixie-real-dual-"));
chmodSync(home, 0o700);
const workspace = join(home, "workspace"), agent = join(home, ".pix", "agent");
mkdirSync(join(home, ".pix"), { recursive: true });
mkdirSync(workspace); mkdirSync(agent, { recursive: true, mode: 0o700 });
process.once("exit", () => { rmSync(join(agent, "auth.json"), { force: true }); rmSync(home, { recursive: true, force: true }); });
const credentials = JSON.parse(readFileSync(join(source, "auth.json"), "utf8"));
if (!credentials[provider]) throw new Error(`No saved credentials for ${provider}`);
writeFileSync(join(agent, "auth.json"), JSON.stringify({ [provider]: credentials[provider] }), { mode: 0o600 });
if (existsSync(join(source, "models.json"))) {
  const config = JSON.parse(readFileSync(join(source, "models.json"), "utf8"));
  if (config.providers?.[provider]) writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { [provider]: config.providers[provider] } }), { mode: 0o600 });
}
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel: model,
  defaultThinkingLevel: "off", defaultProjectTrust: "always", retry: { enabled: false } }));
writeFileSync(join(home, ".pix", "gui.settings.json"), JSON.stringify({ language: "zh-CN", closeToTray: false,
  pixie: { defaultModel: `${provider}/${model}`, restoreLastConversation: true } }));
writeFileSync(join(workspace, "input.txt"), `真实标记行：${marker}\n`);

const env = { ...process.env, PIX_HOME: home, PI_CODING_AGENT_DIR: agent,
  PI_SKIP_VERSION_CHECK: "1", PIX_HOST_LINGER_MS: "180000" };
const journal = join(agent, "pixie", "delegations.json");
const readJournal = () => { try { return JSON.parse(readFileSync(journal, "utf8")).tasks ?? []; } catch { return []; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, timeout, what) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch { /* retry */ } await sleep(500); }
  throw new Error(`timeout waiting for ${what}`);
};
const cli = args => new Promise(resolve => {
  const child = spawn(process.execPath, [join(root, "bin/pixie.mjs"), "--cwd", workspace, ...args],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
  child.on("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});
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

let desktop;
const results = { marker };
try {
  const electron = electronBinary(root);
  const port = 9964;
  desktop = spawn(electron, ["--no-sandbox", "--disable-gpu", `--user-data-dir=${join(home, "electron")}`,
    `--remote-debugging-port=${port}`, root], { cwd: root, env: { ...env, PIX_PROJECT: workspace }, windowsHide: true });
  const cdp = await until(async () => {
    if (desktop.exitCode !== null) throw new Error(`desktop exited ${desktop.exitCode}`);
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find(item => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page) return;
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    return (await cdp.evaluate("Boolean(window.__pixTest && window.pix)")) ? cdp : undefined;
  }, 40_000, "GUI to mount");

  // --- GUI surface: a real model decides how to delegate ---------------------
  await cdp.evaluate(`window.pix.invoke("pixie.send", { text: ${JSON.stringify(
    `请在当前工作区派一个任务给执行代理：读取 input.txt 文件，并在报告中原样引用其中的标记行。任务完成结果到达后，把标记内容告诉我。`)} })`);
  const guiPhase = await until(async () => {
    const task = readJournal().find(task => task.notification === "delivered");
    if (!task) return;
    const conversation = await cdp.evaluate(`(async () => {
      const snapshot = await window.pix.invoke("pixie.ensure");
      const text = snapshot.entries.map(entry => JSON.stringify(entry)).join("\\n");
      return { reported: text.includes(${JSON.stringify(marker)}), turns: snapshot.entries.filter(e => e.type === "message").length };
    })()`);
    return { task, ...conversation };
  }, 240_000, "GUI delegation, execution and review");
  results.gui = { taskState: guiPhase.task.state, purpose: guiPhase.task.purpose.slice(0, 60),
    markerReported: guiPhase.reported, conversationTurns: guiPhase.turns };

  // --- CLI surface: the same model continues the same line headlessly --------
  const cliRun = await cli(["接续刚才那条任务线：先读取它的结果，再派一个子任务重新读一次 input.txt 确认标记，最后把标记原样告诉我。"]);
  results.cliTurn = { code: cliRun.code, markerInReply: cliRun.stdout.includes(marker) };
  if (cliRun.code !== 0) results.cliTurn.stderr = cliRun.stderr.slice(-300);
  const lineage = await until(() => {
    const tasks = readJournal();
    const child = tasks.find(task => tasks.some(other => other.id === task.parentTaskId) && task.notification === "delivered" && task.id !== guiPhase.task.id);
    return child ? { count: tasks.length, childParent: tasks.find(task => task.id === child.parentTaskId)?.purpose === guiPhase.task.purpose } : undefined;
  }, 240_000, "CLI continuation to be delivered");
  results.cliLineage = lineage;

  const tasks = await cli(["tasks"]);
  results.tasksListed = /purpose|ID|delegation/i.test(tasks.stdout) ? tasks.stdout.split("\n").length - 2 : -1;
} finally {
  if (desktop && desktop.exitCode === null) { desktop.kill("SIGKILL"); await sleep(400); }
  await cli(["host", "stop"]).catch(() => {});
}

console.log(JSON.stringify(results, null, 2));
const ok = results.gui?.taskState === "settled" && results.gui?.markerReported
  && results.cliTurn?.code === 0 && results.cliTurn?.markerInReply
  && results.cliLineage?.childParent;
console.log(ok ? "\nREAL AGENT DUAL-SURFACE: PASS" : "\nREAL AGENT DUAL-SURFACE: FAIL");
process.exit(ok ? 0 : 1);
