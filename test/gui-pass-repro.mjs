// GUI repro: capture the agent event sequence for consecutive prompts and the
// live panel's pass display, to diagnose "处理中 · 第 2 轮" on every message.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = join(root, "artifacts");
const testHome = join(artifacts, "gui-pass-home");
const workspace = join(artifacts, "gui-pass-workspace");
rmSync(testHome, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });
mkdirSync(join(testHome, ".pix", "agent"), { recursive: true });
mkdirSync(join(workspace, ".pi", "sessions"), { recursive: true });
writeFileSync(join(testHome, ".pix", "agent", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));

// Isolated local model fixture; slow enough to sample the live panel mid-run.
const server = createServer(async (request, response) => {
  for await (const _chunk of request) { /* consume the model request */ }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (text, finish = null) => `data: ${JSON.stringify({ id: "pix-pass", choices: [{
    index: 0, delta: { role: "assistant", content: text }, finish_reason: finish,
  }] })}\n\n`;
  response.write(chunk("FIRST_TOKEN"));
  setTimeout(() => response.end(chunk(" SECOND_TOKEN") + chunk("", "stop") + "data: [DONE]\n\n"), 5000);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const modelPort = server.address().port;

const electron = electronBinary(root);
const port = 9795;
const child = spawn(electron, [
  "--no-sandbox", "--disable-gpu", `--user-data-dir=${join(testHome, "electron")}`,
  `--remote-debugging-port=${port}`, join(root, "out", "main", "index.js"),
], {
  cwd: root,
  env: {
    ...process.env, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "",
    PIX_HOME: testHome, PIX_PROJECT: workspace, PI_OFFLINE: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });

class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.id = 0; this.pending = new Map(); }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
  }
  async send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  }
}

async function retry(fn, timeout = 60_000) {
  const start = Date.now();
  let error;
  while (Date.now() - start < timeout) {
    try { return await fn(); } catch (cause) { error = cause; await new Promise(resolve => setTimeout(resolve, 150)); }
  }
  throw error;
}

let cdp;
const report = { runs: [] };
try {
  await retry(async () => {
    if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode})\n${stderr}`);
    const response = await fetch(`http://127.0.0.1:${port}/json`);
    const pages = (await response.json()).filter(item => item.type === "page" && item.webSocketDebuggerUrl);
    if (!pages.length) throw new Error("no pages yet");
    for (const page of pages) {
      const probe = new Cdp(page.webSocketDebuggerUrl);
      await probe.open().catch(() => {});
      const ready = await probe.evaluate("window.__pixTest?.state().loading === false && Boolean(document.querySelector('.shell'))").catch(() => false);
      if (ready) { cdp = probe; return; }
      await probe.close().catch(() => {});
    }
    throw new Error("app still booting");
  });

  await cdp.evaluate(`(async () => {
    if (window.__pixTest.state().layout.collapsed.chat) window.__pixTest.toggle('chat');
    await window.pix.invoke('agent.control', { action: 'newSession' });
    await window.pix.invoke('agent.control', { action: 'addCustomModel',
      provider: 'pix-pass-fixture', modelId: 'live', name: 'pass fixture',
      baseUrl: 'http://127.0.0.1:${modelPort}/v1', api: 'openai-completions', apiKey: 'local-test-only',
      reasoning: false, imageInput: false, contextWindow: 64000, maxTokens: 128 });
    await window.pix.invoke('agent.control', { action: 'setModel', provider: 'pix-pass-fixture', modelId: 'live' });
    window.__evts = [];
    window.pix.onEvent(event => { if (event?.type === 'agent') window.__evts.push({ ...event.payload, __t: Date.now() }); });
  })()`);
  await retry(() => cdp.evaluate(`window.__pixTest.state().current?.runtime.model?.provider === 'pix-pass-fixture'`));

  for (const run of [{ text: "first message" }, { text: "second message" },
    { text: "steer base", steerText: "urgent steer", expectPass: 2 }]) {
    const invokeMs = await cdp.evaluate(`(() => { const t0 = Date.now(); window.__invokeMs = null;
      window.pix.invoke('agent.control', { action: 'prompt', text: ${JSON.stringify(run.text)} }).then(() => window.__invokeMs = Date.now() - t0, () => {}); return 'fired'; })()`);
    // Poll the live panel while the fixture streams (answers after 5s).
    const samples = [];
    for (let tick = 0; tick < 15; tick++) {
      await new Promise(resolve => setTimeout(resolve, 400));
      if (run.steerText && tick === 3)
        await cdp.evaluate(`window.pix.invoke('agent.control', { action: 'steer', text: ${JSON.stringify(run.steerText)} }).catch(() => {})`);
      samples.push(await cdp.evaluate(`(() => ({
        summary: document.querySelector('.agent-process.live summary')?.textContent?.trim() ?? null,
        pass: (() => {
          const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
          const store = pinia._s.get('session');
          return Math.max(store.activity?.pass ?? 0,
            ...Object.values(store.branchActivities).map(entry => entry?.activity?.pass ?? 0));
        })(),
      }))()`));
    }
    const live = {
      summaries: [...new Set(samples.map(sample => sample.summary).filter(Boolean))],
      maxPass: Math.max(0, ...samples.map(sample => sample.pass)),
      invokeMs: await cdp.evaluate('window.__invokeMs'),
    };
    await retry(() => cdp.evaluate(`window.__pixTest.state().current?.graph
      ? window.__pixTest.state().current.graph.runs.every(r => r.status !== "running")
      : window.__pixTest.state().current?.projection.nodes.length > ${report.runs.length + 1}`), 120_000);
    const diag = await cdp.evaluate(`(() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const store = pinia._s.get('session');
      return { runs: JSON.parse(JSON.stringify(store.current?.graph?.runs ?? null)),
        rawEventTypes: window.__evts.map(e => e?.type).slice(0, 40),
        notices: JSON.parse(JSON.stringify(pinia._s.get('layout')?.notices ?? [])) };
    })()`);
    const events = await cdp.evaluate(`window.__evts.splice(0).map(e => ({ type: e?.type, branchId: e?.branchId, runId: e?.runId, role: e?.message?.role, t: e?.__t }))`);
    report.runs.push({ prompt: run.text, steerText: run.steerText ?? null, expectPass: run.expectPass ?? 1, invokeMs, ...live, events, diag });
  }
  console.log(JSON.stringify(report, null, 2));
  for (const run of report.runs)
    if (run.maxPass !== run.expectPass)
      throw new Error(`turn pass mismatch (want ${run.expectPass}, got ${run.maxPass}): ${JSON.stringify({ prompt: run.prompt, steerText: run.steerText, summaries: run.summaries })}`);
  function live2(run) { return { summaries: run.summaries, maxPass: run.maxPass }; }
} finally {
  try { await cdp?.close(); } catch { /* the socket may already be gone */ }
  child.kill("SIGKILL");
  server.close();
  spawn("pkill", ["-9", "-f", testHome]);
  await new Promise(resolve => { child.once("exit", resolve); setTimeout(resolve, 1500); });
}
process.exit(0);
