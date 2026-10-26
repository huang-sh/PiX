import { commandStatus, installCommand, uninstallCommand } from "../main/cli-command.js";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { connectLocalHost, type HostClient } from "../host/client.js";
import { runTask } from "./run.js";
import { GRAPH_FILTERS, graphFilterIds, matchesGraphFilter } from "../shared/graph-filter.js";
import type { GraphFilter, SessionSnapshot, SessionSummary } from "../shared/types.js";

const help = `PiX — shared agent host for the desktop and terminal

Usage: pix [command] [arguments] [options]

  chat                         Interactive conversation (default)
  run [prompt]                 Run a task; read prompt from stdin when piped
  resume <session> [prompt]    Resume interactively, or run the supplied prompt
  fork <node> [prompt]         Continue from a node in --session
  new                          Create a session
  sessions                     List this project's sessions
  tree [session]               Show the existing PiX session tree
  label <node> [text]          Set a task label; omit text to remove it
  stop [session]               Stop a session, or one --branch / --run-id
  models                       List available chat models
  dialogs                      List pending extension input requests
  respond <id> [value]         Answer a pending input request
  host <status|stop>           Inspect or stop the shared background host
  command <install|uninstall|status>  Manage the terminal command and PATH

  --cwd <path>                 Project directory (default: current directory)
  --session <id-or-path>       Select a session (required for tree/stop/fork)
  --node <node-id>             Start from this non-running node
  --root                       Start a new branch without inherited messages
  --model <provider/model>     Model for this turn
  --thinking <level>           Thinking level for this turn
  --filter <mode>              Tree filter: all, labeled, running, errors
  --json                       Emit NDJSON events and a final result
  --detach                     Submit a task and exit; the host keeps running
  --timeout <seconds>          Stop waiting after this time; task keeps running
  --request-id <id>            Stable submission ID for safe retries
  --branch <id> --run-id <id>  Stop exactly one run
  --help                       Show this help

GUI and CLI share ~/.pix and the same JSONL + .pix-tree files.
Closing a client leaves accepted tasks running. Ctrl+C stops this CLI's run.
Concurrent branches share project files; use worktrees for file isolation.
`;
const parsed = parseArgs({ allowPositionals: true, options: {
  cwd: { type: "string" }, session: { type: "string" }, node: { type: "string" },
  model: { type: "string" }, thinking: { type: "string" }, json: { type: "boolean" },
  detach: { type: "boolean" }, timeout: { type: "string" }, "request-id": { type: "string" },
  branch: { type: "string" }, "run-id": { type: "string" }, root: { type: "boolean" },
  filter: { type: "string" },
  help: { type: "boolean", short: "h" },
} });
const options = parsed.values;
const args = [...parsed.positionals];
const command = args.shift() ?? "chat";
const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");

async function selectSession(client: HostClient, selector: string | undefined, create: boolean) {
  if (!selector) {
    if (!create) throw new Error("Specify --session <id-or-path>");
    return client.invoke<SessionSnapshot>("agent.control", { action: "newSession" });
  }
  const sessions = await client.invoke<SessionSummary[]>("session.list");
  const matches = sessions.filter(session => session.id === selector || session.path === resolve(selector) || session.path === selector);
  if (matches.length !== 1) throw new Error(matches.length ? "Session ID is ambiguous; use its full path" : "Session not found in this project");
  const snapshot = await client.invoke<SessionSnapshot>("session.open", { path: matches[0]!.path });
  if (!snapshot.runtime.available) throw new Error("Session is read-only; close the other owner or recover its storage first");
  return snapshot;
}

function showTree(snapshot: SessionSnapshot) {
  const filter = (options.filter ?? "all") as GraphFilter;
  const visible = graphFilterIds(snapshot.projection.nodes, filter);
  if (options.json) { print({ type: "tree", snapshot, filter, visibleNodeIds: [...visible],
    matchingNodeIds: snapshot.projection.nodes.filter(node => matchesGraphFilter(node, filter)).map(node => node.id) }); return; }
  process.stdout.write(`Session: ${snapshot.session.path}\n`);
  const children = new Map<string | null, typeof snapshot.projection.nodes>();
  for (const node of snapshot.projection.nodes) {
    if (!visible.has(node.id)) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node); children.set(node.parentId, siblings);
  }
  const stack = [...(children.get(null) ?? [])].reverse().map(node => ({ node, prefix: "" }));
  while (stack.length) {
    const { node, prefix } = stack.pop()!;
    process.stdout.write(`${prefix}${node.running ? "●" : node.hasError ? "!" : "○"} ${node.title.replace(/[\r\n]/g, " ")}${node.label ? `  #${node.label}` : ""}${matchesGraphFilter(node, filter) ? "" : " (ancestor)"}  [${node.id}] (${node.branchId ?? "main"})\n`);
    for (const child of [...(children.get(node.id) ?? [])].reverse()) stack.push({ node: child, prefix: prefix + "  " });
  }
}


async function main() {
  if (options.help || command === "help") { process.stdout.write(help); return; }
  if (options.node && options.root) throw new Error("Choose either --node or --root");
  if (command === "command") {
    const action = args[0] ?? "status";
    if (action === "install") print(installCommand());
    else if (action === "uninstall") print(uninstallCommand());
    else if (action === "status") print(commandStatus());
    else throw new Error("Use pix command install, uninstall or status");
    return;
  }
  const known = ["chat", "run", "resume", "fork", "new", "sessions", "tree", "label", "stop", "models", "dialogs", "respond", "host"];
  if (!known.includes(command)) throw new Error(`Unknown command: ${command}. See pix --help.`);
  if (options.timeout && (!Number.isFinite(Number(options.timeout)) || Number(options.timeout) <= 0))
    throw new Error("--timeout must be a positive number of seconds");
  if (options["request-id"] && !/^[a-zA-Z0-9-]{1,100}$/.test(options["request-id"]))
    throw new Error("--request-id must contain 1–100 letters, numbers or hyphens");
  if (options.model && !/^[^/]+\/.+/.test(options.model)) throw new Error("Use --model provider/model");
  if ((command === "chat" || (["resume", "fork"].includes(command) && args.length < 2)) && options["request-id"])
    throw new Error("Use --request-id with a single task, not an interactive conversation");
  if (options.filter && !GRAPH_FILTERS.includes(options.filter as GraphFilter))
    throw new Error("Use --filter all, labeled, running, or errors");
  if (options.filter && command !== "tree") throw new Error("--filter is only supported by pix tree");
  const cwd = resolve(options.cwd ?? process.cwd());
  const client = await connectLocalHost(cwd, undefined, command !== "host");
  try {
    if (command === "host") {
      const action = args[0] ?? "status";
      if (action !== "status" && action !== "stop") throw new Error("Use pix host status or pix host stop");
      print(await client.request({ method: action === "stop" ? "shutdown" : "status" })); return;
    }
    if (command === "sessions") {
      const sessions = await client.invoke<SessionSummary[]>("session.list");
      if (options.json) print({ type: "sessions", sessions });
      else for (const session of sessions) process.stdout.write(`${session.running ? "●" : "○"} ${session.id}  ${session.name ?? session.firstMessage ?? "New session"}\n  ${session.path}\n`);
      return;
    }
    if (command === "models") { print(await client.invoke("agent.control", { action: "getModels" })); return; }
    if (command === "dialogs") { print(await client.invoke("ui.pending")); return; }
    if (command === "respond") {
      if (!args[0]) throw new Error("Use pix respond <dialog-id> [value]");
      print(await client.invoke("ui.respond", { id: args[0], value: args[1] })); return;
    }
    let selector = options.session;
    if (["resume", "tree", "stop"].includes(command)) selector ??= args.shift();
    const canCreate = ["chat", "run", "new"].includes(command);
    let snapshot = await selectSession(client, selector, canCreate);
    if (command === "new") { print({ type: "session", session: snapshot.session }); return; }
    if (command === "tree") { showTree(snapshot); return; }
    if (command === "label") {
      const node = snapshot.projection.nodes.find(node => node.id === args[0]);
      if (!node) throw new Error("Use pix label <node-id> [text] --session <session>");
      snapshot = await client.invoke<SessionSnapshot>("agent.control", { action: "setLabel", entryId: node.userEntryId, label: args.slice(1).join(" ") }, snapshot.session.path);
      print({ type: "label", nodeId: node.id, label: snapshot.projection.nodes.find(item => item.id === node.id)?.label ?? null }); return;
    }
    if (command === "stop") {
      if (options.branch || options["run-id"]) {
        if (!options.branch || !options["run-id"]) throw new Error("Specify both --branch and --run-id");
        await client.invoke("agent.control", { action: "branchAbort", branchId: options.branch, runId: options["run-id"] }, snapshot.session.path);
        print({ stopped: true });
      } else print(await client.invoke("session.stop", { path: snapshot.session.path }));
      return;
    }
    const forkNode = command === "fork" ? args.shift() : undefined;
    if (command === "fork" && !forkNode) throw new Error("Use pix fork <node> [prompt] --session <session>");
    let prompt = args.join(" ").trim();
    if (command === "run" && !prompt && !process.stdin.isTTY) {
      for await (const chunk of process.stdin) prompt += String(chunk);
      prompt = prompt.trim();
    }
    const node = options.root ? null : forkNode ?? options.node ?? snapshot.projection.activeNodeId;
    if (node && !snapshot.projection.nodes.some(item => item.id === node && item.forkable))
      throw new Error("Choose a node that is not running from pix tree");
    if (prompt) await runTask(client, snapshot, prompt, node, { ...options, requestId: options["request-id"] });
    else if (command === "run") throw new Error("Provide a prompt or pipe it to pix run");
    else {
      if (forkNode) options.node = forkNode;
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive mode needs a terminal. Use pix run with a prompt or stdin.");
      if (options.json) throw new Error("Use pix run --json for structured output");
      const { interactive } = await import("./tui.js");
      await interactive(client, snapshot, options);
    }
  } finally { client.close(); }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  if (options.json) print({ type: "error", message }); else process.stderr.write(`pix: ${message}\n`);
  process.exitCode = error && typeof error === "object" && "exitCode" in error ? Number(error.exitCode) : 1;
});
