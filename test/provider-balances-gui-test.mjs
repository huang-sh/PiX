// Real Electron check with an isolated profile and local billing endpoints.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "pix-balances-gui-"));
const workspace = join(home, "workspace"), agent = join(home, ".pix", "agent");
const artifacts = join(root, "artifacts");
for (const dir of [workspace, agent, artifacts]) mkdirSync(dir, { recursive: true });
const calls = { one: 0, two: 0 };
let unavailable = false;
let delayOne = false, releaseOne, balanceOne = 12.5;
const server = createServer((request, response) => {
  const name = request.url === "/balance/one" ? "one" : request.url === "/balance/two" ? "two" : undefined;
  if (!name) { response.writeHead(404).end(); return; }
  assert.equal(request.headers.authorization, `Bearer fixture-${name}`);
  calls[name]++;
  if (unavailable && name === "one") { response.writeHead(503).end(); return; }
  const respond = () => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: { balance: name === "one" ? balanceOne : 25, alternate: 9 } }));
  };
  if (name === "one" && delayOne) { releaseOne = respond; return; }
  respond();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const queries = Object.fromEntries(["one", "two"].map(id => [id, { url: `${base}/balance/${id}`, path: "data.balance", currency: id === "one" ? "CNY" : "USD", multiplier: 1 }]));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: Object.fromEntries(["one", "two"].map(id => [id, {
  name: id, api: "openai-completions", baseUrl: `${base}/v1`, models: [{ id: "fixture", name: id, contextWindow: 128000, maxTokens: 4096 }],
}])) }));
writeFileSync(join(agent, "auth.json"), JSON.stringify(Object.fromEntries(["one", "two"].map(id => [id, { type: "api_key", key: `fixture-${id}` }]))));
writeFileSync(join(home, ".pix", "gui.settings.json"), JSON.stringify({ language: "zh-CN", closeToTray: false, usage: { balanceQueries: queries } }));
const port = 11000 + Math.floor(Math.random() * 1000);
// One Pixie session (in the coordinator's slotted CLI dir) and one canvas
// session in the project, each with a billed reply, so the statistics tab
// must show the agent split instead of mixing the two into one total.
const nowIso = new Date().toISOString();
const sessionJsonl = (id, cwd, usage) => [
  JSON.stringify({ type: "session", version: 3, id, timestamp: nowIso, cwd }),
  JSON.stringify({ type: "message", id: `${id}-u`, parentId: null, timestamp: nowIso, message: { role: "user", content: "hello" } }),
  JSON.stringify({ type: "message", id: `${id}-a`, parentId: `${id}-u`, timestamp: nowIso, message: { role: "assistant", content: "ok", provider: "zai", model: "glm-5.3", responseModel: "glm-5.3", usage } }),
].join("\n") + "\n";
const pixieDir = join(agent, "sessions", "--" + join(agent, "pixie").replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--");
mkdirSync(join(workspace, ".pi", "sessions"), { recursive: true });
mkdirSync(pixieDir, { recursive: true });
writeFileSync(join(workspace, ".pi", "sessions", "canvas.jsonl"), sessionJsonl("11111111-1111-4111-8111-111111111111", workspace, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } }));
writeFileSync(join(pixieDir, "pixie.jsonl"), sessionJsonl("22222222-2222-4222-8222-222222222222", join(agent, "pixie"), { input: 40, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } }));
const child = spawn(electronBinary(root), ["--no-sandbox", "--disable-gpu", `--user-data-dir=${join(home, "electron")}`, `--remote-debugging-port=${port}`, root], {
  cwd: root, env: { ...process.env, PIX_HOME: home, PIX_PROJECT: workspace, PI_OFFLINE: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
});
let stderr = "", socket, id = 0;
const pending = new Map();
child.stderr.on("data", chunk => { stderr += String(chunk); });
async function retry(fn) {
  const deadline = Date.now() + 30000;
  let last;
  do {
    if (child.exitCode !== null) throw new Error(`Electron exited: ${stderr.slice(-2000)}`);
    try { return await fn(); } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw last;
}
function send(method, params = {}) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(requestId, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
try {
  const target = await retry(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find(page => page.type === "page" && page.webSocketDebuggerUrl);
    assert.ok(page); return page;
  });
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data)), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  await retry(async () => assert.equal(await evaluate("window.__pixTest?.state().loading === false && Boolean(document.querySelector('.shell'))"), true));
  await evaluate("window.__pixTest.settings()");
  await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('[data-settings-category=usage]'))"), true));
  await evaluate("document.querySelector('[data-settings-category=usage]').click()");
  await retry(async () => assert.equal(await evaluate("document.querySelector('[data-usage-tab=statistics]')?.getAttribute('aria-selected')"), "true"));
  assert.deepEqual(calls, { one: 0, two: 0 }, "statistics does not query provider balances");
  // The agent split: Pixie's own session lands in its own row; the canvas
  // session keeps the project's usage; totals keep summing both.
  const split = await retry(async () => {
    const overview = await evaluate("window.pix.invoke('usage.overview', { range: '30d', scope: 'project' })");
    assert.equal(overview.sessionCount, 2);
    return overview;
  });
  const agentRow = (agent) => split.agents.find((row) => row.agent === agent);
  assert.equal(agentRow("pixie").sessions, 1);
  assert.equal(agentRow("pixie").usage.cost, 0.25);
  assert.equal(agentRow("canvas").sessions, 1);
  assert.equal(agentRow("canvas").usage.cost, 1);
  assert.equal(split.totals.cost, 1.25);
  await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('[data-usage-agent=pixie]'))"), true));
  assert.equal(await evaluate("document.querySelector('[data-usage-agent=pixie]').textContent.includes('0.2500')"), true);
  assert.equal(await evaluate("document.querySelector('[data-usage-agent=canvas]').textContent.includes('$1.00')"), true);
  assert.equal(await evaluate("document.querySelector('.usage-card-cost strong').textContent"), "$1.25");
  await evaluate("document.querySelector('[data-usage-tab=balances]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))");
  await retry(async () => assert.equal(await evaluate("document.querySelectorAll('[data-balance-provider] .balance-amount').length"), 2));
  assert.deepEqual(calls, { one: 1, two: 1 });
  await evaluate("document.querySelector('[data-balance-refresh=one]').click()");
  await retry(async () => { assert.deepEqual(calls, { one: 2, two: 1 }); assert.equal(await evaluate("document.querySelector('[data-balance-refresh=one]').disabled"), false); });
  delayOne = true; balanceOne = 11.75;
  await evaluate("document.querySelector('[data-balance-refresh=one]').click()");
  await retry(async () => assert.equal(typeof releaseOne, "function"));
  await evaluate("document.querySelector('[data-usage-tab=statistics]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))");
  await retry(async () => assert.equal(await evaluate("document.querySelector('[data-usage-panel=balances]').hidden"), true));
  await evaluate("document.querySelector('[data-usage-tab=balances]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))");
  await retry(async () => assert.equal(await evaluate("document.querySelector('[data-provider-balances]').getAttribute('aria-busy')"), "true"));
  delayOne = false; releaseOne();
  await retry(async () => assert.equal(await evaluate("document.querySelector('[data-balance-provider=one] .balance-amount').textContent.includes('11.75')"), true));
  assert.deepEqual(calls, { one: 3, two: 1 }, "reopening the tab joins the pending refresh");
  unavailable = true;
  await evaluate("document.querySelector('[data-balance-refresh=one]').click()");
  await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('[data-balance-provider=one] .balance-stale'))"), true));
  assert.equal(await evaluate("document.querySelector('[data-balance-provider=one] .balance-amount').textContent.includes('11.75')"), true);
  assert.equal(await evaluate("Boolean(document.querySelector('[data-balance-provider=one] time'))"), true);
  unavailable = false;
  await evaluate("document.querySelector('[data-balance-configure=one]').click()");
  await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('[data-balance-form]'))"), true));
  await evaluate("(() => { const input = document.querySelector('[data-balance-path]'); input.value = 'data.alternate'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-balance-form]').requestSubmit(); })()");
  await retry(async () => assert.equal(await evaluate("document.querySelector('[data-balance-provider=one] .balance-amount').textContent.includes('9.00')"), true));
  const saved = JSON.parse(readFileSync(join(home, ".pix", "gui.settings.json"), "utf8"));
  assert.equal(saved.usage.balanceQueries.one.path, "data.alternate");
  assert.equal(saved.usage.balanceQueries.two.path, "data.balance");
  assert.ok(!JSON.stringify(saved).includes("fixture-one"));
  for (const [theme, width] of [["light", 1280], ["dark", 900]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 950, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector('[data-settings-category=appearance]').click()");
    await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('[data-setting-path=theme] select'))"), true));
    await evaluate(`(() => { const input = document.querySelector('[data-setting-path=theme] select'); input.value = ${JSON.stringify(theme)}; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await retry(async () => assert.equal(await evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(theme)} && !document.querySelector('[data-setting-path=theme] select').disabled`), true));
    await evaluate("document.querySelector('[data-settings-category=usage]').click()");
    await retry(async () => assert.equal(await evaluate("document.querySelector('[data-usage-tab=statistics]')?.getAttribute('aria-selected')"), "true"));
    await evaluate("document.querySelector('[data-usage-tab=balances]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))");
    await retry(async () => assert.equal(await evaluate("document.querySelectorAll('[data-balance-provider] .balance-amount').length"), 2));
    await evaluate("document.querySelector('[data-balance-configure=one]').click()");
    await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('[data-balance-form]'))"), true));
    const fits = await evaluate("[...document.querySelectorAll('[data-provider-balances], .balance-card, .balance-form input')].every(e => e.scrollWidth <= e.clientWidth + 1)");
    assert.equal(fits, true, `balance layout fits ${width}px`);
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifacts, `provider-balances-${theme}.png`), Buffer.from(screenshot.data, "base64"));
    await evaluate("document.querySelector('[data-usage-tab=statistics]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))");
    await retry(async () => assert.equal(await evaluate("document.querySelector('[data-usage-panel=balances]').hidden"), true));
    const statistics = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(artifacts, `usage-statistics-${theme}.png`), Buffer.from(statistics.data, "base64"));
  }
  await evaluate("document.querySelector('[data-usage-tab=balances]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))");
  await retry(async () => assert.equal(await evaluate("document.querySelector('[data-usage-tab=balances]').getAttribute('aria-selected')"), "true"));
  await evaluate("window.pix.invoke('agent.control', { action: 'logout', provider: 'two' })");
  await evaluate("document.querySelector('[data-balance-refresh=two]').click()");
  await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('[data-balance-provider=two]'))"), false));
  assert.equal(await evaluate("Boolean(document.querySelector('[data-balance-provider=one] .balance-amount'))"), true);
  if (!await evaluate("Boolean(document.querySelector('[data-balance-reset]'))"))
    await evaluate("document.querySelector('[data-balance-configure=one]').click()");
  await retry(async () => assert.equal(await evaluate("Boolean(document.querySelector('[data-balance-reset]'))"), true));
  await evaluate("document.querySelector('[data-balance-reset]').click()");
  await retry(async () => {
    const reset = JSON.parse(readFileSync(join(home, ".pix", "gui.settings.json"), "utf8"));
    assert.equal(reset.usage.balanceQueries.one, undefined);
    assert.equal(reset.usage.balanceQueries.two.path, "data.balance", "resetting one provider preserves other queries");
  });
  console.log(JSON.stringify({ passed: true, calls, screenshots: ["provider-balances-light.png", "provider-balances-dark.png"] }));
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    console.error(await evaluate("document.body.innerText.slice(-3000)").catch(() => ""));
    const screenshot = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (screenshot) writeFileSync(join(artifacts, "provider-balances-failure.png"), Buffer.from(screenshot.data, "base64"));
  }
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) await evaluate("window.pix.invoke('app.quit')").catch(() => {});
  socket?.close();
  if (child.exitCode === null) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM"); await exited;
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}
