// Build first. Pass a real session path; all writes and locks use a temporary copy.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { HostClient } from "../out-test/src/host/client.js";
import { electronBinary } from "./lib/electron-binary.mjs";

const source = process.argv[2];
assert.ok(source && existsSync(source), "Pass an existing image-heavy session.jsonl path");
const root = process.cwd(), home = mkdtempSync(join(tmpdir(), "pix-image-benchmark-"));
const project = join(home, "project"), directory = join(project, ".pi", "sessions");
mkdirSync(directory, { recursive: true }); mkdirSync(join(home, ".pix"));
const path = join(directory, basename(source));
cpSync(source, path);
if (existsSync(`${source}.pix-tree`)) {
  cpSync(`${source}.pix-tree`, `${path}.pix-tree`, { recursive: true });
  rmSync(join(`${path}.pix-tree`, "owner.json"), { force: true });
}
const small = join(directory, `2026-10-28T00-00-00-000Z_${randomUUID()}.jsonl`);
writeFileSync(small, [
  { type: "session", version: 3, id: randomUUID(), timestamp: "2026-10-28T00:00:00Z", cwd: project },
  { type: "message", id: "small", parentId: null, timestamp: "2026-10-28T00:00:00Z", message: { role: "user", content: "Small comparison session" } },
].map(value => JSON.stringify(value)).join("\n") + "\n");
writeFileSync(join(home, ".pix", "gui.settings.json"), JSON.stringify({ openLastSessionOnStartup: false, closeToTray: false }));
const port = 12000 + Math.floor(Math.random() * 1000);
const child = spawn(electronBinary(root), ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${join(home, "electron")}`, root], {
  cwd: root, env: { ...process.env, ELECTRON_RENDERER_URL: "", PIX_HOME: home, PIX_PROJECT: project, PI_OFFLINE: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "", socket, sequence = 0;
child.stderr.on("data", data => { stderr += data; });
const pending = new Map(), clients = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
  return reply.result.value;
}
async function until(expression) {
  const deadline = Date.now() + 60000;
  while (!await evaluate(expression)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Timed out: ${expression}\n${stderr.slice(-3000)}`);
    await sleep(100);
  }
}
const timing = async fn => { const start = performance.now(); const value = await fn(); return { ms: +(performance.now() - start).toFixed(1), value }; };
const sha = image => createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex");
let address;
try {
  let page; const deadline = Date.now() + 30000;
  while (!page && Date.now() < deadline) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(value => value.type === "page"); } catch {}
    if (!page) await sleep(100);
  }
  assert.ok(page, stderr);
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise(resolve => socket.once("open", resolve));
  socket.on("message", data => {
    const message = JSON.parse(data); const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  await until("window.__pixTest && !__pixTest.state().loading");
  const cold = await evaluate(`(async () => { const t=performance.now(); await __pixTest.openSession(${JSON.stringify(path)}); return performance.now()-t; })()`);
  assert.equal(await evaluate("__pixTest.state().current.runtime.available"), true, "session must be writable, rather than fallback");
  address = JSON.parse(readFileSync(join(home, ".pix", "run", "host.json"), "utf8"));
  const raw = await HostClient.connect(address, project); clients.push(raw);
  const lean = await HostClient.connect(address, project, undefined, undefined, true); clients.push(lean);
  const results = { coldOpenMs: +cold.toFixed(1), rawRoundtripMs: [], referencedRoundtripMs: [], guiSwitchMs: [] };
  let original, referenced;
  for (let i = 0; i < 3; i++) {
    const before = await timing(() => raw.invoke("session.open", { path })); original = before.value;
    const after = await timing(() => lean.invoke("session.open", { path })); referenced = after.value;
    results.rawRoundtripMs.push(before.ms); results.referencedRoundtripMs.push(after.ms);
  }
  results.originalSnapshotBytes = Buffer.byteLength(JSON.stringify(original));
  results.referencedSnapshotBytes = Buffer.byteLength(JSON.stringify(referenced));
  assert.ok(results.referencedSnapshotBytes < results.originalSnapshotBytes / 5);
  for (let i = 0; i < 3; i++) {
    await evaluate(`__pixTest.openSession(${JSON.stringify(small)})`);
    results.guiSwitchMs.push(await evaluate(`(async () => { const t=performance.now(); await __pixTest.openSession(${JSON.stringify(path)}); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); return +(performance.now()-t).toFixed(1); })()`));
  }
  const entries = new Map(original.entries.map(entry => [entry.id, entry]));
  const images = referenced.entries.flatMap(entry => Array.isArray(entry.message?.content)
    ? entry.message.content.filter(image => image?.reference) : []);
  assert.ok(images.length);
  let preview;
  for (const image of images) {
    assert.ok(image.reference);
    const actual = await lean.invoke("session.image", image.reference);
    const expected = entries.get(image.reference.entryId).message.content[image.reference.index];
    assert.equal(sha(actual), sha(expected), "every original must match the persisted image bytes");
    preview ??= image;
  }
  results.originalsVerified = images.length;
  const thumbnail = await evaluate(`window.pix.invoke('session.image', ${JSON.stringify({ ...preview.reference, thumbnail: true })})`);
  const originalImage = await lean.invoke("session.image", preview.reference);
  results.originalImageBytes = Buffer.from(originalImage.data, "base64").length;
  results.thumbnailBytes = Buffer.from(thumbnail.data, "base64").length;
  results.thumbnailDimensions = await evaluate(`new Promise((resolve,reject)=>{ const img=new Image(); img.onload=()=>resolve([img.naturalWidth,img.naturalHeight]); img.onerror=reject; img.src=${JSON.stringify(`data:${thumbnail.mimeType};base64,${thumbnail.data}`)}; })`);
  assert.ok(results.thumbnailDimensions[0] <= 192 && results.thumbnailDimensions[1] <= 152);
  await evaluate("__pixTest.toggle('chat')");
  await until("document.querySelector('.branch-messages')");
  console.log("Measured payloads and original images:", JSON.stringify(results));
  await until("[...document.querySelectorAll('.branch-history .message-images button')].some(el=>el.getClientRects().length)");
  await send("Page.bringToFront");
  await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  await evaluate("(() => { const button=[...document.querySelectorAll('.branch-history .message-images button')].find(el=>el.getClientRects().length); button.scrollIntoView({block:'center'}); button.closest('.branch-messages').dispatchEvent(new Event('scroll')); })()");
  await until("(() => { const button=[...document.querySelectorAll('.branch-history .message-images button')].find(el=>el.getClientRects().length); if (!button) return false; button.scrollIntoView({block:'center'}); button.closest('.branch-messages').dispatchEvent(new Event('scroll')); return [...document.querySelectorAll('.branch-history .message-images img')].some(img=>img.complete && img.naturalWidth > 0); })()");
  await evaluate("[...document.querySelectorAll('.branch-history .message-images img')].find(img=>img.complete && img.naturalWidth > 0).closest('button').click()");
  await until("document.querySelector('[data-image-preview] img')?.naturalWidth > 0");
  results.previewDimensions = await evaluate("[document.querySelector('[data-image-preview] img').naturalWidth,document.querySelector('[data-image-preview] img').naturalHeight]");
  assert.ok(Math.max(...results.previewDimensions) > Math.max(...results.thumbnailDimensions), "preview loads the full original, rather than stretching the thumbnail");
  results.screenshot = join(root, "artifacts", "session-image-preview.png");
  mkdirSync(join(root, "artifacts"), { recursive: true });
  const screenshot = await send("Page.captureScreenshot"); writeFileSync(results.screenshot, Buffer.from(screenshot.data, "base64"));
  writeFileSync(join(root, "artifacts", "session-image-benchmark.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    try { console.error("GUI diagnostics", await evaluate(`JSON.stringify({current:__pixTest.state().current?.session.path,focused:__pixTest.state().focusedNode,chat:__pixTest.state().layout.collapsed.chat,images:[...document.querySelectorAll('.branch-messages .message-images')].map(el=>({buttons:el.querySelectorAll("button").length,loaded:el.querySelectorAll("img").length}))})`)); } catch {}
  }
  throw error;
} finally {
  socket?.close(); clients.forEach(client => client.close()); child.kill("SIGKILL");
  if (address) {
    try {
      const cleanup = await HostClient.connect(address, project);
      try { await cleanup.request({ method: "shutdown" }, 5000); }
      finally { cleanup.close(); }
    } catch { try { process.kill(address.pid, "SIGTERM"); } catch {} }
  }
  await sleep(500); rmSync(home, { recursive: true, force: true });
}
