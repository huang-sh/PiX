// Opt-in real-agent A/B: the SAME task prompt runs once from the GUI (project A,
// live canvas) and once from the CLI (project B, headless canvas), each from a
// fresh conversation over an empty canvas. Compares tool sequences, delegation
// outcomes, delivery semantics and reported data.
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
const markerGui = `REALMARK-GUI-${randomUUID().slice(0, 6)}`;
const markerCli = `REALMARK-CLI-${randomUUID().slice(0, 6)}`;

const home = mkdtempSync(join(tmpdir(), "pixie-real-ab-"));
chmodSync(home, 0o700);
mkdirSync(join(home, ".pix"), { recursive: true });
const agent = join(home, ".pix", "agent");
mkdirSync(agent, { recursive: true, mode: 0o700 });
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
// Two identical fresh projects; only the file (and its marker) differ.
const wsGui = join(home, "ws-gui"), wsCli = join(home, "ws-cli");
for (const [ws, marker] of [[wsGui, markerGui], [wsCli, markerCli]]) {
  mkdirSync(ws);
  writeFileSync(join(ws, "input.txt"), `真实标记行：${marker}\n`);
}
const prompt = file => `请在当前工作区派一个任务给执行代理：读取 ${file} 文件，并在报告中原样引用其中的标记行。任务完成结果到达后，把标记内容告诉我。`;

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
const cli = (ws, args) => new Promise(resolve => {
  const child = spawn(process.execPath, [join(root, "bin/pixie.mjs"), "--cwd", ws, ...args],
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
/** The turn's tool sequence + reply text, read from the shared conversation. */
const turnView = async (cdp, fromIndex) => cdp.evaluate(`(async () => {
  const snapshot = await window.pix.invoke("pixie.ensure");
  const fresh = snapshot.entries.slice(${fromIndex});
  const tools = fresh.filter(e => e.type === "message" && e.message?.role === "toolResult").map(e => e.message.toolName);
  const reply = fresh.filter(e => e.type === "message" && e.message?.role === "assistant")
    .map(e => (e.message.content ?? []).filter(p => p.type === "text").map(p => p.text).join("")).join("\\n").trim();
  return { tools, reply };
})()`);

let desktop;
const phases = {};
try {
  const electron = electronBinary(root);
  const port = 9965;
  desktop = spawn(electron, ["--no-sandbox", "--disable-gpu", `--user-data-dir=${join(home, "electron")}`,
    `--remote-debugging-port=${port}`, root], { cwd: root, env: { ...env, PIX_PROJECT: wsGui }, windowsHide: true });
  const cdp = await until(async () => {
    if (desktop.exitCode !== null) throw new Error(`desktop exited ${desktop.exitCode}`);
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find(item => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page) return;
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    return (await cdp.evaluate("Boolean(window.__pixTest && window.pix)")) ? cdp : undefined;
  }, 40_000, "GUI to mount");

  // --- Phase 1: the task from the GUI over project A --------------------------
  let baseline = await cdp.evaluate(`(async () => (await window.pix.invoke("pixie.ensure")).entries.length)()`);
  const startedGui = Date.now();
  await cdp.evaluate(`window.pix.invoke("pixie.send", { text: ${JSON.stringify(prompt("input.txt"))} })`);
  const guiTask = await until(() => {
    const task = readJournal().find(task => task.notification === "delivered");
    return task?.state === "settled" ? task : undefined;
  }, 240_000, "GUI phase to finish");
  const guiView = await turnView(cdp, baseline);
  phases.gui = { tools: guiView.tools, markerReported: guiView.reply.includes(markerGui),
    crossContamination: guiView.reply.includes(markerCli), seconds: Math.round((Date.now() - startedGui) / 1000),
    task: { state: guiTask.state, revision: guiTask.revision, parent: guiTask.parentTaskId ?? null, purpose: guiTask.purpose } };

  // Reset the conversation so phase 2 starts from the same fresh context.
  await cdp.evaluate(`window.pix.invoke("pixie.newSession")`);

  // --- Phase 2: the same task from the CLI over project B ---------------------
  baseline = await cdp.evaluate(`(async () => (await window.pix.invoke("pixie.ensure")).entries.length)()`);
  const startedCli = Date.now();
  const cliRun = await cli(wsCli, [prompt("input.txt")]);
  const cliTask = await until(() => {
    const task = readJournal().find(task => task.id !== guiTask.id && task.notification === "delivered");
    return task?.state === "settled" ? task : undefined;
  }, 240_000, "CLI phase to finish");
  const cliView = await turnView(cdp, baseline);
  phases.cli = { tools: cliView.tools, markerReported: (cliRun.stdout + cliView.reply).includes(markerCli),
    crossContamination: (cliRun.stdout + cliView.reply).includes(markerGui),
    seconds: Math.round((Date.now() - startedCli) / 1000), exitCode: cliRun.code,
    task: { state: cliTask.state, revision: cliTask.revision, parent: cliTask.parentTaskId ?? null, purpose: cliTask.purpose } };
  phases.cliToolsEchoed = [...cliRun.stderr.matchAll(/→ (\S+)/g)].map(match => match[1]);
} finally {
  if (desktop && desktop.exitCode === null) { desktop.kill("SIGKILL"); await sleep(400); }
  await cli(wsCli, ["host", "stop"]).catch(() => {});
}

const report = { markerGui, markerCli, phases };
console.log(JSON.stringify(report, null, 2));
const sequenceEqual = JSON.stringify(phases.gui.tools) === JSON.stringify(phases.cli.tools.filter(tool => tool !== undefined));
const ok = phases.gui.markerReported && phases.cli.markerReported
  && !phases.gui.crossContamination && !phases.cli.crossContamination
  && phases.gui.task.state === phases.cli.task.state
  && phases.gui.task.parent === phases.cli.task.parent
  && phases.gui.tools.includes("canvas_delegate") && phases.cli.tools.includes("canvas_delegate");
console.log(`\ntool sequence identical: ${sequenceEqual}`);
console.log(`gui: ${phases.gui.tools.join(" -> ")}`);
console.log(`cli: ${phases.cli.tools.join(" -> ")}`);
console.log(ok ? "\nSAME-TASK A/B: PASS" : "\nSAME-TASK A/B: FAIL");
process.exit(ok ? 0 : 1);
