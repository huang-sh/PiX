// Opt-in real-agent complex scenario: parallel dispatch, steering a RUNNING
// task, an independent verification branch, and a cross-surface computation
// continuation. GUI starts the coordinated work; CLI closes it out.
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
const rateMarker = `REALRATE-${randomUUID().slice(0, 6)}`;
const consumeMarker = `CONSUMED-${randomUUID().slice(0, 6)}`;
const expectedTotalMinor = 3 * 1299 + 2 * 2599 + 499; // 9594
const expectedPoints = expectedTotalMinor * 2; // rate 1 CNY = 2 POINT

const home = mkdtempSync(join(tmpdir(), "pixie-real-cx-"));
chmodSync(home, 0o700);
mkdirSync(join(home, ".pix"), { recursive: true });
const agent = join(home, ".pix", "agent");
const ws = join(home, "ws");
mkdirSync(agent, { recursive: true, mode: 0o700 });
mkdirSync(join(ws, "data"), { recursive: true });
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
writeFileSync(join(ws, "data", "orders.json"), JSON.stringify({
  schemaVersion: 1, currency: "CNY",
  items: [{ quantity: 3, priceMinor: 1299 }, { quantity: 2, priceMinor: 2599 }, { quantity: 1, priceMinor: 499 }],
}, null, 2));
writeFileSync(join(ws, "data", "rates.txt"), `汇率标记行：${rateMarker}，换算规则：totalPoints = totalMinor × 2（分单位直接翻倍，不做单位换算）\n`);
writeFileSync(join(ws, "wait-input.mjs"), `import { existsSync, readFileSync } from 'node:fs';
const start = Date.now();
while (!existsSync('input.json')) {
  if (Date.now() - start > 150000) throw new Error('input never arrived');
  await new Promise(r => setTimeout(r, 250));
}
console.log(readFileSync('input.json', 'utf8'));
`);
writeFileSync(join(ws, "verify.mjs"), `import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const input = JSON.parse(readFileSync('data/orders.json', 'utf8'));
const result = JSON.parse(readFileSync('result.json', 'utf8'));
const expected = input.items.reduce((sum, item) => sum + item.quantity * item.priceMinor, 0);
assert.equal(result.totalMinor, expected);
writeFileSync('verification.json', JSON.stringify({ passed: true, totalMinor: expected }));
console.log('VERIFIED ' + expected);
`);

const env = { ...process.env, PIX_HOME: home, PI_CODING_AGENT_DIR: agent,
  PI_SKIP_VERSION_CHECK: "1", PIX_HOST_LINGER_MS: "300000" };
const journal = join(agent, "pixie", "delegations.json");
const readJournal = () => { try { return JSON.parse(readFileSync(journal, "utf8")).tasks ?? []; } catch { return []; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, timeout, what) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch { /* retry */ } await sleep(500); }
  throw new Error(`timeout waiting for ${what}; journal: ${JSON.stringify(readJournal().map(t => [t.purpose.slice(0, 30), t.state, t.notification]))}`);
};
const cli = args => new Promise(resolve => {
  const child = spawn(process.execPath, [join(root, "bin/pixie.mjs"), "--cwd", ws, ...args],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 420_000);
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
const conversationText = cdp => cdp.evaluate(`(async () => {
  const snapshot = await window.pix.invoke("pixie.ensure");
  return snapshot.entries.filter(e => e.type === "message" && e.message?.role === "assistant")
    .map(e => (e.message.content ?? []).filter(p => p.type === "text").map(p => p.text).join("")).join("\\n");
})()`);

let desktop;
const results = { expectedTotalMinor, expectedPoints };
try {
  const electron = electronBinary(root);
  const port = 9966;
  desktop = spawn(electron, ["--no-sandbox", "--disable-gpu", `--user-data-dir=${join(home, "electron")}`,
    `--remote-debugging-port=${port}`, root], { cwd: root, env: { ...env, PIX_PROJECT: ws }, windowsHide: true });
  const cdp = await until(async () => {
    if (desktop.exitCode !== null) throw new Error(`desktop exited ${desktop.exitCode}`);
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find(item => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page) return;
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    return (await cdp.evaluate("Boolean(window.__pixTest && window.pix)")) ? cdp : undefined;
  }, 40_000, "GUI to mount");

  // Phase 1: one coordinated instruction — parallel dispatch + dependent verify.
  const t0 = Date.now();
  await cdp.evaluate(`window.pix.invoke("pixie.send", { text: ${JSON.stringify(
    "请并行派出三个任务：①读取 data/orders.json，用整数分计算全部 quantity×priceMinor 之和，写入 result.json（字段严格为 schemaVersion:1 和 totalMinor）；②读取 data/rates.txt，原样报告其中的汇率标记行；③运行 node wait-input.mjs，等外部输入到达后把其内容原样写入 consumed.txt。①完成后再派一个独立验证任务运行 node verify.mjs 核验 result.json。所有任务结束并收到结果后，向我汇总：总额、汇率标记行原文、consumed.txt 内容、验证结论。")} })`);
  await until(() => readJournal().length >= 3, 180_000, "three parallel dispatches");

  // Phase 2: while task ③ waits for its input, steer it from the GUI.
  await until(() => readJournal().some(task => task.state === "running"), 120_000, "a running task to steer");
  await cdp.evaluate(`window.pix.invoke("pixie.send", { text: ${JSON.stringify(
    "给正在等待外部输入的那个运行中任务发一条 steer：输入文件马上就绪，请继续等待不要超时退出。")} })`);
  results.steerTurnAccepted = true;
  await sleep(4000);
  writeFileSync(join(ws, "input.json"), `外部输入内容：${consumeMarker}\n`);

  await until(() => {
    const tasks = readJournal();
    return tasks.length >= 4 && tasks.every(task => task.notification === "delivered" && ["settled", "cancelled"].includes(task.state));
  }, 420_000, "all phase-1 tasks (incl. verification) to settle and be reviewed");
  results.phase1Seconds = Math.round((Date.now() - t0) / 1000);
  results.files = {
    result: existsSync(join(ws, "result.json")) ? JSON.parse(readFileSync(join(ws, "result.json"), "utf8")).totalMinor : null,
    verification: existsSync(join(ws, "verification.json")),
    consumed: existsSync(join(ws, "consumed.txt")) ? readFileSync(join(ws, "consumed.txt"), "utf8").trim() : null,
  };
  const guiSummary = await conversationText(cdp);
  results.guiSummary = {
    total: guiSummary.includes(String(expectedTotalMinor)),
    rateMarker: guiSummary.includes(rateMarker),
    consumeMarker: guiSummary.includes(consumeMarker),
    verdict: /通过|VERIFIED|passed|验证成功|一致/.test(guiSummary),
  };

  // Phase 3: the CLI closes out with a dependent computation + its own verify.
  const t1 = Date.now();
  const cliRun = await cli(["读取 rates.txt 的换算规则，把 result.json 的 totalMinor 按规则换算成 totalPoints 写入 converted.json（整数，不换算单位），并派独立验证核验后向我汇报最终数字。"]);
  await until(() => {
    const tasks = readJournal();
    return tasks.filter(task => task.notification === "delivered" && task.state === "settled").length >= readJournal().length
      && readJournal().length >= 6 && existsSync(join(ws, "converted.json"));
  }, 420_000, "CLI computation and its verification");
  results.phase3Seconds = Math.round((Date.now() - t1) / 1000);
  // The final number arrives in the automatic review turn after the one-shot
  // exits; read it from the shared conversation the GUI still holds.
  const cliSummary = await conversationText(cdp);
  results.cli = {
    exitCode: cliRun.code,
    converted: existsSync(join(ws, "converted.json")) ? JSON.parse(readFileSync(join(ws, "converted.json"), "utf8")).totalPoints : null,
    summaryHasPoints: cliSummary.includes(String(expectedPoints)),
    dispatchReplyHasPoints: cliRun.stdout.includes(String(expectedPoints)),
    stderrTail: cliRun.stderr.slice(-200),
  };
  results.taskCount = readJournal().length;
  results.taskStates = readJournal().map(task => [task.purpose.slice(0, 24), task.state, task.notification]);
} finally {
  if (desktop && desktop.exitCode === null) { desktop.kill("SIGKILL"); await sleep(400); }
  await cli(["host", "stop"]).catch(() => {});
}

console.log(JSON.stringify(results, null, 2));
const ok = results.files.result === expectedTotalMinor && results.files.verification
  && results.files.consumed?.includes(consumeMarker)
  && results.guiSummary.total && results.guiSummary.rateMarker && results.guiSummary.consumeMarker && results.guiSummary.verdict
  && results.cli.exitCode === 0 && results.cli.converted === expectedPoints && results.cli.summaryHasPoints
  && results.taskCount >= 6;
console.log(ok ? "\nCOMPLEX SCENARIO: PASS" : "\nCOMPLEX SCENARIO: FAIL");
process.exit(ok ? 0 : 1);
