// CLI Pixie e2e: a terminal-driven turn dispatches a delegation through the
// headless canvas, the graph agent settles it, the host's review turn runs,
// and `pixie tasks` lists the journal — all against the real local host.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(join(root, "server/dist/cli/index.js")))
  throw new Error("PiX CLI is not built. Run npm run build:cli first.");

const home = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pix-cli-pixie-")));
const cwd = join(home, "workspace");
const agent = join(home, ".pix", "agent");
mkdirSync(cwd, { recursive: true });
mkdirSync(join(agent, "extensions"), { recursive: true });
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "pixie-e2e" }));
writeFileSync(join(agent, "extensions", "pixie-e2e.js"), `
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};
export default pi => {
  const faux = fauxProvider({ models: [{ id: "pixie-e2e", contextWindow: 128000 }] });
  pi.registerProvider(faux.provider);
  const respond = async context => {
    faux.appendResponses([respond]);
    const user = [...context.messages].reverse().find(message => message.role === "user");
    const json = JSON.stringify(user);
    const roles = context.messages.map(message => message.role);
    const last = roles.lastIndexOf("toolResult") > roles.lastIndexOf("user")
      ? context.messages[roles.lastIndexOf("toolResult")] : undefined;
    if (last?.isError) return fauxAssistantMessage("Canvas tool failed: " + JSON.stringify(last));
    const state = last ? JSON.parse(last.content.find(part => part.type === "text").text) : undefined;
    if (json.includes("PIXIE-E2E-DELEGATE")) {
      if (state?.task) return fauxAssistantMessage("Delegated; tracking.");
      if (state?.session) return fauxAssistantMessage([fauxToolCall("canvas_delegate", { context: state.context, text: "Graph work item", purpose: "Complete the item", acceptance: "Report done" })], { stopReason: "toolUse" });
      if (state?.context) return fauxAssistantMessage([fauxToolCall("canvas_new_session", { context: state.context })], { stopReason: "toolUse" });
      return fauxAssistantMessage([fauxToolCall("canvas_inspect", {})], { stopReason: "toolUse" });
    }
    if (json.includes("Graph work item")) return fauxAssistantMessage("Task done.");
    return fauxAssistantMessage("ok.");
  };
  faux.setResponses([respond]);
}
`);
const env = { ...process.env, PIX_HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1", PIX_HOST_LINGER_MS: "90000" };
const journal = join(agent, "pixie", "delegations.json");
const readJournal = () => { try { return JSON.parse(readFileSync(journal, "utf8")).tasks ?? []; } catch { return []; } };
const cli = (entry, args) => new Promise(resolve => {
  const child = spawn(process.execPath, [join(root, entry), "--cwd", cwd, ...args],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  child.on("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});
const until = async (check, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 200)); }
  throw new Error("Timed out waiting for the Pixie delegation cycle");
};

try {
  // 1. A terminal turn dispatches a fresh delegation through the headless canvas.
  const dispatch = await cli("bin/pixie.mjs", ["PIXIE-E2E-DELEGATE please"]);
  if (dispatch.code !== 0) throw new Error(`pixie one-shot failed: ${dispatch.stderr}`);
  if (!/Delegated/.test(dispatch.stdout)) throw new Error(`no dispatch reply: ${JSON.stringify(dispatch)}`);
  const task = await until(() => {
    const found = readJournal().find(task => task.purpose === "Complete the item");
    return found && ["running", "settled"].includes(found.state) ? found : undefined;
  });
  // 2. The graph agent settles and the host's automatic review delivers.
  const settled = await until(() => readJournal().find(entry => entry.id === task.id && entry.notification === "delivered"));
  if (settled.state !== "settled") throw new Error(`unexpected state: ${settled.state}`);

  // 3. The delegation list is readable from the terminal.
  const tasks = await cli("bin/pixie.mjs", ["tasks"]);
  if (tasks.code !== 0 || !/Complete the item/.test(tasks.stdout))
    throw new Error(`pixie tasks failed: ${JSON.stringify(tasks)}`);

  // 4. The shared entry (`pix pixie ...`) reaches the same Pixie.
  const shared = await cli("bin/pix.mjs", ["pixie", "hello there"]);
  if (shared.code !== 0 || !/ok\./.test(shared.stdout))
    throw new Error(`pix pixie failed: ${JSON.stringify(shared)}`);

  // 5. Saved conversations list from the terminal, and switching repoints Pixie.
  const sessions = await cli("bin/pixie.mjs", ["sessions"]);
  if (sessions.code !== 0 || !/● .{8}  .*(PIXIE-E2E-DELEGATE please|hello there)/.test(sessions.stdout))
    throw new Error(`pixie sessions failed: ${JSON.stringify(sessions)}`);
  const id = sessions.stdout.match(/● (.{8})/)?.[1];
  if (!id) throw new Error(`no live conversation listed: ${JSON.stringify(sessions.stdout)}`);
  const switched = await cli("bin/pixie.mjs", ["switch", id]);
  if (switched.code !== 0 || !/Switched to/.test(switched.stdout))
    throw new Error(`pixie switch failed: ${JSON.stringify(switched)}`);
  const refused = await cli("bin/pixie.mjs", ["switch", "no-such-conversation"]);
  if (refused.code === 0 || !/No such conversation/.test(refused.stderr))
    throw new Error(`pixie switch accepted an unknown id: ${JSON.stringify(refused)}`);

  console.log("cli pixie e2e passed: headless dispatch, automatic review, tasks listing, shared entry, session switch");
} finally {
  await cli("bin/pix.mjs", ["host", "stop"]).catch(() => {});
  await new Promise(r => setTimeout(r, 500));
  rmSync(home, { recursive: true, force: true });
}
