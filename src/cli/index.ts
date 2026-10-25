import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { connectLocalHost, type HostClient } from "../host/client.js";
import { agentMessageContent } from "../shared/agent-stream.js";
import type { ExtensionDialog, SessionSnapshot, SessionSummary } from "../shared/types.js";

const help = `PiX — shared agent host for the desktop and terminal

Usage: pix [command] [arguments] [options]

  chat                         Interactive conversation (default)
  run [prompt]                 Run a task; read prompt from stdin when piped
  resume <session> [prompt]    Resume interactively, or run the supplied prompt
  fork <node> [prompt]         Continue from a node in --session
  new                          Create a session
  sessions                     List this project's sessions
  tree [session]               Show the existing PiX session tree
  stop [session]               Stop a session, or one --branch / --run-id
  models                       List available chat models
  dialogs                      List pending extension input requests
  respond <id> [value]         Answer a pending input request
  host <status|stop>           Inspect or stop the shared background host

  --cwd <path>                 Project directory (default: current directory)
  --session <id-or-path>       Select a session (required for tree/stop/fork)
  --node <node-id>             Start from this completed node
  --root                       Start a new branch without inherited messages
  --model <provider/model>     Model for this turn
  --thinking <level>           Thinking level for this turn
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
  help: { type: "boolean", short: "h" },
} });
const options = parsed.values;
const args = [...parsed.positionals];
const command = args.shift() ?? "chat";
const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Run = NonNullable<SessionSnapshot["graph"]>["runs"][number];

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
  if (options.json) { print({ type: "tree", snapshot }); return; }
  process.stdout.write(`Session: ${snapshot.session.path}\n`);
  const children = new Map<string | null, typeof snapshot.projection.nodes>();
  for (const node of snapshot.projection.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node); children.set(node.parentId, siblings);
  }
  const stack = [...(children.get(null) ?? [])].reverse().map(node => ({ node, prefix: "" }));
  while (stack.length) {
    const { node, prefix } = stack.pop()!;
    process.stdout.write(`${prefix}${node.running ? "●" : node.hasError ? "!" : "○"} ${node.title.replace(/[\r\n]/g, " ")}  [${node.id}] (${node.branchId ?? "main"})\n`);
    for (const child of [...(children.get(node.id) ?? [])].reverse()) stack.push({ node: child, prefix: prefix + "  " });
  }
}

async function runTask(client: HostClient, before: SessionSnapshot, text: string, node: string | null,
  onDialog?: (dialog: ExtensionDialog) => Promise<string | undefined>) {
  const path = before.session.path;
  const requestId = options["request-id"] ?? randomUUID();
  let run: Run | undefined;
  let disconnected: Error | undefined;
  let interrupted = false;
  let wroteOutput = false;
  let partialText = "";
  const buffered: Record<string, any>[] = [];
  const emitAgent = (payload: Record<string, any>) => {
    if (payload.graphId !== path || payload.runId !== run?.runId) return;
    if (options.json) print({ type: "agent", session: path, event: payload });
    else if (["message_start", "message_update", "message_end"].includes(payload.type) && payload.message?.role === "assistant") {
      if (payload.type === "message_start") partialText = "";
      const output = agentMessageContent(payload.message, "text");
      if (output.startsWith(partialText) && output.length > partialText.length) {
        process.stdout.write(output.slice(partialText.length)); wroteOutput = true;
      }
      partialText = output;
      if (payload.type === "message_end" && output) process.stdout.write("\n");
    } else if (payload.type === "tool_execution_start") process.stderr.write(`[${payload.toolName}]\n`);
  };
  const unsubscribe = client.onEvent(event => {
    if (event.type === "agent") {
      const payload = event.payload as Record<string, any>;
      if (!run) buffered.push(payload); else emitAgent(payload);
    } else if (event.type === "notice") {
      if (options.json) print({ type: "notice", notice: event.payload });
      else process.stderr.write(`${(event.payload as { message?: string }).message ?? ""}\n`);
    }
  });
  const removeDisconnect = client.onDisconnect(error => { disconnected = error; });
  const abort = () => {
    interrupted = true;
    if (run) void client.invoke("agent.control", { action: "branchAbort", branchId: run.branchId, runId: run.runId }, path).catch(() => {});
  };
  process.once("SIGINT", abort);
  try {
    const model = options.model;
    const slash = model?.indexOf("/") ?? -1;
    if (model && (slash < 1 || slash === model.length - 1)) throw new Error("Use --model provider/model");
    const snapshot = await client.invoke<SessionSnapshot>("agent.control", {
      action: "promptAt", requestId, nodeId: node, text,
      ...(model ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) } : {}),
      ...(options.thinking ? { thinkingLevel: options.thinking } : {}),
    }, path);
    run = snapshot.graph?.runs.find(item => item.requestId === requestId);
    if (!run) throw new Error("This request was already saved or handled without starting a run. Inspect pix tree before submitting new work.");
    const submission = { type: "submitted", session: path, requestId, branchId: run.branchId, runId: run.runId };
    if (options.json || options.detach) print(submission);
    else process.stderr.write(`Session: ${path}\nRun: ${run.branchId}/${run.runId}\n`);
    for (const event of buffered) emitAgent(event);
    if (options.detach) return { snapshot, nodeId: run.nodeId };
    if (interrupted) abort();
    const deadline = options.timeout ? Date.now() + Number(options.timeout) * 1000 : Infinity;
    if (options.timeout && (!Number.isFinite(Number(options.timeout)) || Number(options.timeout) <= 0)) throw new Error("--timeout must be a positive number of seconds");
    const handledDialogs = new Set<string>();
    let current = snapshot;
    for (;;) {
      if (disconnected) throw disconnected;
      const latest = current.graph?.runs.find(item => item.runId === run!.runId);
      if (!latest) throw new Error("The run changed; inspect the session before continuing");
      if (latest.status !== "running") {
        const target = current.projection.nodes.find(item => item.id === latest.nodeId);
        const own = new Set(target?.rawEntryIds ?? []);
        const messages = current.entries.filter(entry => own.has(entry.id) && entry.type === "message")
          .map(entry => entry.message as Record<string, any>);
        const failed = messages.find(message => message.role === "assistant" && ["error", "aborted"].includes(message.stopReason));
        const error = latest.error ?? (failed ? failed.errorMessage || `Agent ${failed.stopReason}` : undefined);
        if (error || current.graph?.storageError || latest.status === "interrupted")
          throw new Error(error ?? current.graph?.storageError ?? "Agent execution was interrupted");
        if (!wroteOutput && !options.json) {
          const output = messages.filter(message => message.role === "assistant").map(message => agentMessageContent(message, "text")).filter(Boolean).join("\n");
          if (output) process.stdout.write(output + "\n");
        }
        if (options.json) print({ type: "result", session: path, requestId, branchId: latest.branchId,
          runId: latest.runId, nodeId: latest.nodeId, status: latest.status, snapshot: current });
        if (interrupted) process.exitCode = 130;
        return { snapshot: current, nodeId: latest.nodeId };
      }
      if (Date.now() >= deadline) throw new Error(`Stopped waiting; task is still running. Session: ${path}; run: ${run.runId}`);
      const dialogs = await client.invoke<ExtensionDialog[]>("ui.pending");
      const ownFile = run.branchId === "main" ? path : `${path}.pix-tree/${run.branchId}.jsonl`;
      for (const dialog of dialogs.filter(dialog => dialog.sessionPath === ownFile && !handledDialogs.has(dialog.id))) {
        if (!onDialog) throw new Error(`Agent needs input: ${dialog.title}. Task remains pending; use pix dialogs and pix respond ${dialog.id}, or answer in the GUI.`);
        handledDialogs.add(dialog.id);
        await client.invoke("ui.respond", { id: dialog.id, value: await onDialog(dialog) });
      }
      await delay(200);
      current = await client.invoke<SessionSnapshot>("session.snapshot", undefined, path);
    }
  } catch (error) {
    if (interrupted && error instanceof Error) Object.assign(error, { exitCode: 130 });
    throw error;
  } finally { unsubscribe(); removeDisconnect(); process.removeListener("SIGINT", abort); }
}

async function interactive(client: HostClient, snapshot: SessionSnapshot) {
  if (!process.stdin.isTTY) throw new Error("Interactive mode needs a terminal. Use pix run with a prompt or stdin.");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let node = options.root ? null : options.node ?? snapshot.projection.activeNodeId;
  let taskRunning = false;
  let closed = false;
  rl.on("close", () => { closed = true; });
  rl.on("SIGINT", () => {
    if (taskRunning) process.emit("SIGINT");
    else rl.close();
  });
  process.stderr.write(`PiX · ${snapshot.session.path}\n/tree shows the graph; /exit detaches.\n`);
  try {
    while (!closed) {
      const text = (await rl.question("pix> ")).trim();
      if (!text) continue;
      if (text === "/exit" || text === "/quit") break;
      if (text === "/tree") { showTree(snapshot); continue; }
      if (text.startsWith("/node ")) {
        const id = text.slice(6).trim();
        if (!snapshot.projection.nodes.some(item => item.id === id && item.forkable)) { process.stderr.write("Choose a completed node from /tree\n"); continue; }
        node = id; continue;
      }
      taskRunning = true;
      try {
        const outcome = await runTask(client, snapshot, text, node, async dialog => {
          const suffix = dialog.options?.length ? ` [${dialog.options.join(" / ")}]` : "";
          return (await rl.question(`${dialog.title}${suffix}: `)).trim() || undefined;
        });
        snapshot = outcome.snapshot;
        node = outcome.nodeId ?? node;
      } catch (error) {
        if (!client.connected) throw error;
        process.stderr.write(`pix: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = undefined;
        snapshot = await client.invoke<SessionSnapshot>("session.snapshot", undefined, snapshot.session.path);
      } finally { taskRunning = false; }
    }
  } finally { rl.close(); }
}

async function main() {
  if (options.help || command === "help") { process.stdout.write(help); return; }
  if (options.node && options.root) throw new Error("Choose either --node or --root");
  const known = ["chat", "run", "resume", "fork", "new", "sessions", "tree", "stop", "models", "dialogs", "respond", "host"];
  if (!known.includes(command)) throw new Error(`Unknown command: ${command}. See pix --help.`);
  if (options.timeout && (!Number.isFinite(Number(options.timeout)) || Number(options.timeout) <= 0))
    throw new Error("--timeout must be a positive number of seconds");
  if (options["request-id"] && !/^[a-zA-Z0-9-]{1,100}$/.test(options["request-id"]))
    throw new Error("--request-id must contain 1–100 letters, numbers or hyphens");
  if (options.model && !/^[^/]+\/.+/.test(options.model)) throw new Error("Use --model provider/model");
  if ((command === "chat" || (["resume", "fork"].includes(command) && args.length < 2)) && options["request-id"])
    throw new Error("Use --request-id with a single task, not an interactive conversation");
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
      throw new Error("Choose a completed node from pix tree");
    if (prompt) await runTask(client, snapshot, prompt, node);
    else if (command === "run") throw new Error("Provide a prompt or pipe it to pix run");
    else {
      if (forkNode) options.node = forkNode;
      await interactive(client, snapshot);
    }
  } finally { client.close(); }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  if (options.json) print({ type: "error", message }); else process.stderr.write(`pix: ${message}\n`);
  process.exitCode = error && typeof error === "object" && "exitCode" in error ? Number(error.exitCode) : 1;
});
