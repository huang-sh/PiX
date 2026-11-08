// Dual-surface consistency: one host, one Pixie, two surfaces. The GUI (live
// canvas through the renderer) dispatches a delegation whose graph agent runs
// the REAL read tool; the CLI (headless canvas) then continues the SAME task
// line. Asserts shared conversation, shared journal lineage, real tool data
// flowing across surfaces, and identical delivery semantics.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { electronBinary } from "./lib/electron-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SENTINEL = "SENTINEL-7f3a9c";
const home = join(root, "artifacts", "dual-pixie-home");
rmSync(home, { recursive: true, force: true });
const cwd = join(home, "workspace");
const agent = join(home, ".pix", "agent");
mkdirSync(join(home, ".pix"), { recursive: true });
mkdirSync(join(cwd), { recursive: true });
mkdirSync(join(agent, "extensions"), { recursive: true });
writeFileSync(join(home, ".pix", "gui.settings.json"), JSON.stringify({}));
writeFileSync(join(cwd, "input.txt"), `marker content: ${SENTINEL}\n`);
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "dual" }));
writeFileSync(join(agent, "extensions", "dual-faux.js"), `
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
export default pi => {
  const faux = fauxProvider({ models: [{ id: "dual", contextWindow: 128000 }] });
  pi.registerProvider(faux.provider);
  let guiStage = 0, cliStage = 0, taskId;
  const respond = async context => {
    faux.appendResponses([respond]);
    const user = [...context.messages].reverse().find(message => message.role === "user");
    const json = JSON.stringify(user);
    const roles = context.messages.map(message => message.role);
    const toolIndex = roles.lastIndexOf("toolResult");
    const last = toolIndex > roles.lastIndexOf("user") ? context.messages[toolIndex] : undefined;
    if (last?.isError) return fauxAssistantMessage("Tool failed: " + JSON.stringify(last.content).slice(0, 300));
    const state = last ? JSON.parse(last.content.find(part => part.type === "text").text) : undefined;
    if (json.includes("PIXIE-GUI-FLOW")) {
      if (state?.task) { taskId = state.task.id; return fauxAssistantMessage("GUI delegation dispatched."); }
      if (state?.session) return fauxAssistantMessage([fauxToolCall("canvas_delegate", { context: state.context, text: "Read input.txt and quote its exact content.", purpose: "Quote the file", acceptance: "The exact content is quoted" })], { stopReason: "toolUse" });
      if (state?.context) return fauxAssistantMessage([fauxToolCall("canvas_new_session", { context: state.context })], { stopReason: "toolUse" });
      return fauxAssistantMessage([fauxToolCall("canvas_inspect", {})], { stopReason: "toolUse" });
    }
    if (json.includes("PIXIE-CLI-FLOW")) {
      if (state?.output) {
        const found = JSON.stringify(state).match(/SENTINEL-[0-9a-f]+/);
        globalThis.sentinel = found?.[0] ?? "missing";
        return fauxAssistantMessage([fauxToolCall("canvas_delegate", { taskId, branch: true, text: "Read input.txt again and quote it.", purpose: "Second quote from the CLI line", acceptance: "Quoted again" })], { stopReason: "toolUse" });
      }
      if (state?.task) return fauxAssistantMessage("CLI continuation dispatched; sentinel seen: " + (globalThis.sentinel ?? "none"));
      if (state?.tasks) { taskId = state.tasks[0].id; return fauxAssistantMessage([fauxToolCall("canvas_read", { taskId, limit: 6 })], { stopReason: "toolUse" }); }
      return fauxAssistantMessage([fauxToolCall("canvas_tasks", {})], { stopReason: "toolUse" });
    }
    if (json.includes("Read input.txt")) {
      if (last) {
        const found = JSON.stringify(last).match(/SENTINEL-[0-9a-f]+/);
        return fauxAssistantMessage("The file says: " + (found?.[0] ?? "nothing"));
      }
      return fauxAssistantMessage([fauxToolCall("read", { path: "input.txt" })], { stopReason: "toolUse" });
    }
    if (json.includes("delegated PiX run needs your attention")) return fauxAssistantMessage("Reviewed.");
    return fauxAssistantMessage("ok.");
  };
  faux.setResponses([respond]);
}
`);
const env = { ...process.env, PIX_HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1", PIX_HOST_LINGER_MS: "180000" };
const journal = join(agent, "pixie", "delegations.json");
const readJournal = () => { try { return JSON.parse(readFileSync(journal, "utf8")).tasks ?? []; } catch { return []; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (check, timeout = 90_000, what = "condition") => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch { /* retry */ } await sleep(200); }
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}
const cli = args => new Promise(resolve => {
  const child = spawn(process.execPath, [join(root, "bin/pixie.mjs"), "--cwd", cwd, ...args],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  child.on("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});

let desktop, cdp;
const results = {};
try {
  // --- GUI surface: live canvas through the renderer -------------------------
  const electron = process.env.ELECTRON_BINARY ?? electronBinary(root);
  const port = 9963;
  desktop = spawn(electron, ["--no-sandbox", "--disable-gpu", `--user-data-dir=${join(home, "electron")}`,
    `--remote-debugging-port=${port}`, root], { cwd: root, env: { ...env, PIX_PROJECT: cwd }, windowsHide: true });
  cdp = await until(async () => {
    if (desktop.exitCode !== null) throw new Error(`desktop exited ${desktop.exitCode}`);
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = list.find(item => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page) return;
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Runtime.enable");
    return (await cdp.evaluate("Boolean(window.__pixTest && window.pix)")) ? cdp : undefined;
  }, 40_000, "GUI to mount");

  await cdp.evaluate(`window.pix.invoke("pixie.send", { text: "PIXIE-GUI-FLOW dispatch the read task" })`);
  const guiTask = await until(() => {
    const task = readJournal().find(task => task.purpose === "Quote the file");
    return task?.notification === "delivered" ? task : undefined;
  }, 90_000, "GUI delegation to settle and be reviewed");
  results.guiDispatch = { state: guiTask.state, notification: guiTask.notification };

  // --- CLI surface: headless continuation of the SAME task line --------------
  const cliRun = await cli(["PIXIE-CLI-FLOW continue the shared line"]);
  if (cliRun.code !== 0) throw new Error(`CLI turn failed: ${cliRun.stderr}\n${cliRun.stdout}`);
  results.cliSentinelEchoed = new RegExp(SENTINEL).test(cliRun.stdout);
  let lineage;
  try {
    lineage = await until(() => {
      const tasks = readJournal();
      const child = tasks.find(task => task.purpose === "Second quote from the CLI line");
      return child?.notification === "delivered" ? { child, parent: tasks.find(task => task.id === child.parentTaskId) } : undefined;
    }, 90_000, "CLI continuation to settle and be reviewed");
  } catch (error) {
    console.log("CLI stdout:", cliRun.stdout.slice(-1200));
    console.log("CLI stderr:", cliRun.stderr.slice(-400));
    console.log("journal:", JSON.stringify(readJournal().map(({ id, purpose, state, notification, retryAt, error }) =>
      ({ id: id.slice(0, 8), purpose, state, notification, retryAt, error })), null, 2));
    throw error;
  }
  results.cliLineage = { parentFromGui: lineage.parent?.purpose === "Quote the file",
    childState: lineage.child.state, childNotification: lineage.child.notification };

  // --- Shared conversation: the GUI sees the CLI's turn ----------------------
  const shared = await cdp.evaluate(`(async () => {
    const snapshot = await window.pix.invoke("pixie.ensure");
    return { gui: snapshot.entries.some(e => JSON.stringify(e).includes("PIXIE-GUI-FLOW")),
             cli: snapshot.entries.some(e => JSON.stringify(e).includes("PIXIE-CLI-FLOW")) };
  })()`);
  results.sharedConversation = shared;

  // --- Terminal task listing --------------------------------------------------
  const tasks = await cli(["tasks", "--json"]);
  results.tasksJson = tasks.code === 0 ? JSON.parse(tasks.stdout).length : -1;
} finally {
  if (desktop && desktop.exitCode === null) { desktop.kill("SIGKILL"); await sleep(400); }
  await cli(["host", "stop"]).catch(() => {});
  rmSync(home, { recursive: true, force: true });
}

console.log(JSON.stringify(results, null, 2));
const ok = results.guiDispatch.state === "settled" && results.guiDispatch.notification === "delivered"
  && results.cliSentinelEchoed
  && results.cliLineage.parentFromGui && results.cliLineage.childState === "settled"
  && results.sharedConversation.gui && results.sharedConversation.cli
  && results.tasksJson === 2;
console.log(ok ? "\nDUAL-SURFACE CONSISTENCY: PASS" : "\nDUAL-SURFACE CONSISTENCY: FAIL");
process.exit(ok ? 0 : 1);
