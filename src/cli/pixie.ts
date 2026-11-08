// The terminal side of Pixie: one-shot prompts, a slim conversational TUI and
// the delegation list. All state lives in the host's single Pixie runtime, so
// terminal and desktop share one conversation and one task journal.
import { resolve } from "node:path";
import {
  Container, Editor, Loader, ProcessTerminal, Spacer, Text, TuiMainScreen, setKeybindings,
  KeybindingsManager, TUI_KEYBINDINGS, matchesKey,
} from "@earendil-works/pi-tui";
import type { HostClient } from "../host/client.js";
import type { SessionSnapshot } from "../shared/types.js";
import { Conversation, getMarkdownTheme, getSelectListTheme, initTheme, UserMessageComponent } from "./tui.js";

export interface PixieOptions { json?: boolean; liveCanvas?: boolean; cwd?: string }

interface PixieEvent { type?: string; payload?: unknown }

/** Pixie snapshots and agent turns arrive re-tagged as desktop "pixie" events. */
export function pixieEvents(client: HostClient, handle: (event: PixieEvent) => void) {
  return client.onEvent(wire => {
    if (wire.type === "pixie") handle(wire.payload as PixieEvent);
  });
}

const canvasMode = (options: PixieOptions) => options.liveCanvas ? "live" : "headless";

interface PixieTaskRow {
  id: string; state: string; revision: number; parentTaskId?: string; nodeId?: string;
  error?: string; notification?: string; purpose: string; createdAt: string; updatedAt: string;
}

export async function pixieTasks(client: HostClient, json?: boolean) {
  const { tasks } = await client.invoke<{ tasks: PixieTaskRow[] }>("pixie.tasks");
  if (json) { process.stdout.write(JSON.stringify(tasks) + "\n"); return tasks; }
  if (!tasks.length) { process.stdout.write("No delegations.\n"); return tasks; }
  const rows = tasks.map(task => ({
    id: task.id.slice(0, 8),
    state: task.state === "running" ? "●" : task.state === "settled" ? "○" : task.state === "cancelled" ? "✕" : task.state === "uncertain" ? "?" : "!",
    followUp: task.notification === "pending" ? "follow-up pending" : "",
    purpose: task.purpose.replace(/\s+/g, " ").slice(0, 72),
  }));
  process.stdout.write("ID       ST  PURPOSE                                                            FOLLOW-UP\n");
  for (const row of rows)
    process.stdout.write(`${row.id}  ${row.state}  ${row.purpose.padEnd(68).slice(0, 68)}${row.followUp ? `  ${row.followUp}` : ""}\n`);
  process.stdout.write(`(${tasks.length} delegation${tasks.length === 1 ? "" : "s"}; pix tree shows the session tree)\n`);
  return tasks;
}

/** One-shot: send a prompt, stream the reply, exit when the turn settles. */
export async function pixieOnce(client: HostClient, text: string, options: PixieOptions) {
  if (options.json) {
    const snapshot = await client.invoke<SessionSnapshot>("pixie.send", { text, canvas: canvasMode(options) });
    return snapshot;
  }
  await client.invoke("pixie.ensure");
  let printed = "";
  let inReply = false;
  const unsubscribe = pixieEvents(client, event => {
    if (event.type === "agent") {
      const payload = event.payload as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
      if (payload.type === "message_update" && payload.message?.role === "assistant") {
        const full = (payload.message.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("");
        if (full.startsWith(printed)) process.stdout.write(full.slice(printed.length));
        else if (full) process.stdout.write(`\n${full}`);
        printed = full;
        inReply = true;
      } else if (payload.type === "tool_execution_start") {
        const name = (payload as { toolName?: string }).toolName ?? "tool";
        process.stderr.write(`→ ${name}\n`);
        if (inReply) { process.stdout.write("\n"); printed = ""; inReply = false; }
      }
    } else if (event.type === "notice") {
      const notice = event.payload as { level?: string; message?: string };
      if (notice.level === "error" && notice.message) process.stderr.write(`${notice.message}\n`);
    }
  });
  try {
    return await client.invoke<SessionSnapshot>("pixie.send", { text, canvas: canvasMode(options) });
  } finally { unsubscribe(); }
}

const commands = [
  { name: "new", description: "Start a new Pixie conversation" },
  { name: "stop", description: "Stop the running reply" },
  { name: "tasks", description: "List tracked delegations" },
  { name: "exit", description: "Leave Pixie" },
];

/** A slim linear chat: the desktop card's terminal counterpart. */
export async function pixieInteractive(client: HostClient, options: PixieOptions) {
  initTheme("dark");
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
  const terminal = new ProcessTerminal();
  const ui = new TuiMainScreen(terminal, true);
  const cwd = resolve(options.cwd ?? process.cwd());
  let busy = false, closed = false;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const header = new Text("", 1, 1);
  const conversation = new Conversation(ui, cwd);
  const status = new Container();
  const notices = new Text("", 1);
  const editorSlot = new Container();
  const editor = new Editor(ui, { borderColor: text => getMarkdownTheme().hr(text), selectList: getSelectListTheme() }, { paddingX: 1 });
  const footer = new Text("", 1);
  const loader = new Loader(ui, text => getMarkdownTheme().link(text), text => getMarkdownTheme().quote(text), "Pixie is replying… esc stops");
  loader.stop();
  ui.addChild(header); ui.addChild(conversation); ui.addChild(new Spacer(1));
  ui.addChild(status); ui.addChild(notices); ui.addChild(editorSlot); ui.addChild(footer);
  editorSlot.addChild(editor);

  const render = () => {
    const md = getMarkdownTheme();
    header.setText(`${md.heading(md.bold("Pixie"))}  ${md.quote("Coordination agent · shared with the desktop")}\n${md.quote(cwd)}`);
    footer.setText(md.quote(`${canvasMode(options)} canvas · ${busy ? "working" : "ready"} · enter send · /tasks delegations · ctrl+d exit`));
    ui.requestRender();
  };
  const notice = (text: string) => { if (!closed && text) { notices.setText(getMarkdownTheme().quote(text)); ui.requestRender(); } };
  const load = (snapshot: SessionSnapshot) => {
    conversation.load(snapshot.entries);
    render();
  };
  function stop() {
    if (busy) { void client.invoke("pixie.stop").catch(error => notice(String(error))); notice("Stopping Pixie…"); }
    else notice("Pixie is not replying.");
  }
  function close() {
    if (closed) return;
    closed = true;
    loader.stop(); finish();
  }

  const unsubscribe = pixieEvents(client, event => {
    if (closed) return;
    if (event.type === "agent") {
      conversation.event(event.payload as Record<string, unknown>);
      ui.requestRender();
    } else if (event.type === "snapshot") {
      load(event.payload as SessionSnapshot);
    } else if (event.type === "notice") {
      const payload = event.payload as { level?: string; message?: string };
      if (payload.level === "error" && payload.message) notice(payload.message);
    }
  });
  const disconnected = client.onDisconnect(error => { if (!closed) notice(error.message + " · /exit to detach"); });
  const shutdown = client.onEvent(event => { if (event.type === "host.shutdown") close(); });

  const initial = await client.invoke<SessionSnapshot>("pixie.ensure");
  load(initial);
  if (!conversation.children.length)
    conversation.addChild(new Text(getMarkdownTheme().quote("Talk to Pixie. Delegated work runs in the session tree; completions arrive here automatically."), 1));
  ui.setFocus(editor);
  render();

  async function send(text: string) {
    busy = true; notices.setText("");
    conversation.addChild(new UserMessageComponent(text));
    status.addChild(loader); loader.start(); render();
    try {
      load(await client.invoke<SessionSnapshot>("pixie.send", { text, canvas: canvasMode(options) }));
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      loader.stop(); status.clear();
      render();
      if (!closed) ui.setFocus(editor);
    }
  }

  editor.onSubmit = async raw => {
    const text = raw.trim();
    if (!text || closed) return;
    if (text === "/exit" || text === "/quit") { close(); return; }
    if (busy) { editor.setText(raw); notice("Pixie is replying. Esc stops it; your draft stays in the editor."); return; }
    if (text === "/help") { notice(commands.map(item => `/${item.name}  ${item.description}`).join("\n")); return; }
    if (text === "/new") {
      try { load(await client.invoke<SessionSnapshot>("pixie.newSession")); notice("New conversation"); }
      catch (error) { notice(error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (text === "/stop") { stop(); return; }
    if (text === "/tasks") {
      const tasks = await client.invoke<{ tasks: PixieTaskRow[] }>("pixie.tasks").then(result => result.tasks).catch(() => []);
      notice(tasks.length
        ? tasks.slice(0, 6).map(task => `${task.id.slice(0, 8)} ${task.state} ${task.purpose.replace(/\s+/g, " ").slice(0, 60)}`).join("\n")
        : "No delegations.");
      return;
    }
    if (text.startsWith("/")) { notice(`Unknown command: ${commands.map(item => `/${item.name}`).join(" ")}`); return; }
    await send(text);
  };
  ui.addInputListener(data => {
    if (matchesKey(data, "ctrl+d") && !editor.getText()) { close(); return { consume: true }; }
    if (matchesKey(data, "ctrl+c")) {
      if (busy) stop();
      else if (editor.getText()) { editor.setText(""); ui.requestRender(); }
      else close();
      return { consume: true };
    }
    if (matchesKey(data, "escape") && busy && !editor.isShowingAutocomplete()) { stop(); return { consume: true }; }
    if (matchesKey(data, "ctrl+o")) { conversation.toggleTools(); ui.requestRender(); return { consume: true }; }
    if (matchesKey(data, "ctrl+t")) { conversation.toggleThinking(); ui.requestRender(); return { consume: true }; }
    return undefined;
  });
  const signal = () => close();
  process.once("SIGTERM", signal); process.once("SIGHUP", signal);
  ui.start();
  try {
    await finished;
  } finally {
    closed = true;
    loader.stop(); unsubscribe(); disconnected(); shutdown();
    process.removeListener("SIGTERM", signal); process.removeListener("SIGHUP", signal);
    await terminal.drainInput(200);
    ui.stop();
    process.stdout.write("\nRelaunch with: pixie\n");
  }
}
