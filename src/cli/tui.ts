import { homedir } from "node:os";
import { resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent, DynamicBorder, ExtensionInputComponent, ExtensionSelectorComponent,
  getMarkdownTheme, getSelectListTheme, initTheme, ToolExecutionComponent, TreeSelectorComponent,
  UserMessageComponent, type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider, Container, Editor, fuzzyFilter, Input, KeybindingsManager, Loader, matchesKey, ProcessTerminal,
  SelectList, setKeybindings, Spacer, Text, TUI_KEYBINDINGS, TuiMainScreen,
  type Component, type Focusable, type SelectItem, type TerminalColors, type TUI,
} from "@earendil-works/pi-tui";
import type { HostClient } from "../host/client.js";
import type { ExtensionDialog, GraphFilter, RawSessionEntry, RuntimeCommand, RuntimeModel, SessionSnapshot, SessionSummary } from "../shared/types.js";
import { GRAPH_FILTERS, graphFilterIds, matchesGraphFilter } from "../shared/graph-filter.js";
import { runTask, type Run, type RunOptions } from "./run.js";

interface InteractiveOptions extends RunOptions { cwd?: string; node?: string; root?: boolean; }
const commands = [
  { name: "tree", description: "Navigate the session tree and choose a branch" },
  { name: "sessions", description: "Search and resume a project session" },
  { name: "model", description: "Choose a model" },
  { name: "thinking", description: "Choose a thinking level" },
  { name: "new", description: "Start a new session" },
  { name: "node", description: "Continue from a node ID, or root" },
  { name: "stop", description: "Stop this terminal's task" },
  { name: "theme", description: "Choose the light or dark Pi theme" },
  { name: "help", description: "Commands and keyboard shortcuts" },
  { name: "exit", description: "Detach; accepted tasks continue in the Host" },
];
const shortPath = (path: string) => path.startsWith(homedir() + "/") ? "~" + path.slice(homedir().length) : path;
const branchName = (id?: string) => !id || id === "main" ? "main" : `branch ${id.slice(0, 8)}`;

/** Project just the selected GraphRuntime ancestry, never a sibling branch. */
export function conversationEntries(snapshot: SessionSnapshot, nodeId: string | null): RawSessionEntry[] {
  const nodes = new Map(snapshot.projection.nodes.map(node => [node.id, node]));
  const entries = new Map(snapshot.entries.map(entry => [entry.id, entry]));
  const path = [], seen = new Set<string>();
  for (let node = nodeId ? nodes.get(nodeId) : undefined; node && !seen.has(node.id); node = node.parentId ? nodes.get(node.parentId) : undefined) {
    seen.add(node.id); path.unshift(node);
  }
  const ids = new Set<string>();
  return path.flatMap(node => node.rawEntryIds.flatMap(id => {
    const entry = entries.get(id);
    if (!entry || ids.has(id)) return [];
    ids.add(id); return [entry];
  }));
}

/** Pi's tree selector presents PiX graph nodes; it never owns persistence. */
export function graphTree(snapshot: SessionSnapshot, filter: GraphFilter = "all"): SessionTreeNode[] {
  const visible = graphFilterIds(snapshot.projection.nodes, filter);
  const nodes = new Map(snapshot.projection.nodes.filter(node => visible.has(node.id)).map(node => [node.id, {
    label: node.label,
    entry: { id: node.id, parentId: node.parentId, timestamp: node.timestamp, type: "message" as const,
      message: { role: "user" as const, content: `${node.running ? "● " : node.hasError ? "! " : ""}${node.title}  · ${branchName(node.branchId)}${matchesGraphFilter(node, filter) ? "" : " (ancestor)"}`, timestamp: Date.parse(node.timestamp) } },
    children: [] as SessionTreeNode[],
  }]));
  const roots: SessionTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.entry.parentId ? nodes.get(node.entry.parentId) : undefined;
    (parent?.children ?? roots).push(node);
  }
  return roots;
}

class SearchSelector extends Container implements Focusable {
  private input = new Input({ placeholder: "Type to filter…", placeholderStyle: text => getMarkdownTheme().quote(text) });
  private list!: SelectList;
  private listSlot = new Container();
  get focused() { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  constructor(title: string, private items: SelectItem[], private rows: number, private select: (value: string) => void, private cancel: () => void) {
    super();
    this.filter();
    this.input.onEscape = cancel;
    this.input.onSubmit = () => { const item = this.list.getSelectedItem(); if (item) select(item.value); };
    this.addChild(new DynamicBorder());
    this.addChild(new Text(getMarkdownTheme().bold(title), 1));
    this.addChild(this.input); this.addChild(new Spacer(1)); this.addChild(this.listSlot);
    this.addChild(new Text(getMarkdownTheme().quote("↑↓ select · enter confirm · esc back"), 1));
    this.addChild(new DynamicBorder());
  }
  handleInput(data: string) {
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) this.list.handleInput(data);
    else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (before !== this.input.getValue()) this.filter();
    }
  }
  private filter() {
    const items = fuzzyFilter(this.items, this.input.getValue(), item => `${item.label} ${item.description ?? ""} ${item.value}`);
    this.list = new SelectList(items, Math.max(3, Math.min(12, this.rows - 12)), {
      ...getSelectListTheme(), noMatch: () => getMarkdownTheme().quote("  No matches"),
    });
    this.list.onSelect = item => this.select(item.value);
    this.list.onCancel = this.cancel;
    this.listSlot.clear(); this.listSlot.addChild(this.list);
  }
}

/** Pi navigation over task nodes, with PiX task filters and durable labels. */
export class GraphSelector extends Container implements Focusable {
  private selector!: TreeSelectorComponent;
  private body = new Container();
  private search = new Text("", 1);
  private heading = new Text("", 1);
  private error = new Text("", 1);
  private input?: Input;
  private saving = false;
  private empty = false;
  private _focused = false;
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; if (this.input) this.input.focused = value; else this.selector.focused = value; }
  constructor(private snapshot: SessionSnapshot, private node: string | null, private rows: number,
    private select: (id: string) => void, private cancel: () => void, private filter: GraphFilter,
    private onFilter: (filter: GraphFilter) => void,
    private saveLabel: (id: string, label: string) => Promise<SessionSnapshot>, private requestRender: () => void = () => {}) {
    super();
    this.addChild(new DynamicBorder()); this.addChild(this.heading);
    this.addChild(new Text(getMarkdownTheme().quote("↑↓ move · alt/ctrl+←→ fold · enter choose · esc back"), 1));
    this.addChild(new Text(getMarkdownTheme().quote("shift+l label · ctrl+a all · ctrl+l labeled · ctrl+r running · ctrl+e errors · ctrl+o cycle"), 1));
    this.addChild(this.search); this.addChild(new Spacer(1)); this.addChild(this.body); this.addChild(this.error);
    this.addChild(new DynamicBorder()); this.rebuild();
  }
  update(snapshot: SessionSnapshot) { this.snapshot = snapshot; if (!this.input && !this.saving) this.rebuild(); }
  private rebuild(selected = this.selector?.getTreeList().getSelectedNode()?.entry.id) {
    const query = this.selector?.getTreeList().getSearchQuery() ?? "";
    const tree = graphTree(this.snapshot, this.filter);
    this.empty = !tree.length;
    const source = tree.length ? tree : graphTree(this.snapshot);
    if (!source.length) { this.cancel(); return; }
    this.selector = new TreeSelectorComponent(source, this.node, this.rows,
      this.select, this.cancel, undefined, selected ?? this.node ?? undefined, "user-only");
    if (query) this.selector.handleInput(query);
    this.selector.focused = this.focused;
    this.body.clear(); if (!this.empty) this.body.addChild(this.selector.getTreeList());
    const count = this.snapshot.projection.nodes.filter(node => matchesGraphFilter(node, this.filter)).length;
    this.heading.setText(getMarkdownTheme().bold(`Session Tree · ${this.filter} · ${count} matches`));
    this.search.setText(getMarkdownTheme().quote(`Type to search: ${query}`));
    if (!count) this.body.addChild(new Text(getMarkdownTheme().quote("No matching tasks. Ctrl+A shows all tasks."), 1));
  }
  private editLabel() {
    const id = this.selector.getTreeList().getSelectedNode()?.entry.id;
    const node = this.snapshot.projection.nodes.find(node => node.id === id);
    if (!node || this.empty) return;
    const running = this.snapshot.graph?.runs.some(run => run.branchId === (node.branchId ?? "main") && run.status === "running");
    if (!this.snapshot.runtime.available || running || node.running) {
      this.error.setText("Wait for this branch to finish; labels require a writable session."); return;
    }
    this.input = new Input(); this.input.setValue(node.label ?? ""); this.input.focused = this.focused;
    this.body.clear(); this.body.addChild(new Text("Label (empty removes it) · enter save · esc cancel", 1)); this.body.addChild(this.input);
    this.input.onEscape = () => { this.input = undefined; this.rebuild(id); };
    this.input.onSubmit = label => {
      this.saving = true; this.error.setText("Saving label…");
      void this.saveLabel(node.userEntryId, label).then(snapshot => {
        this.snapshot = snapshot; this.input = undefined; this.error.setText("");
      }).catch(error => { this.error.setText(String(error.message ?? error)); }).finally(() => {
        this.saving = false; if (!this.input) this.rebuild(id); this.requestRender();
      });
    };
  }
  handleInput(data: string) {
    if (this.saving) return;
    this.error.setText("");
    if (this.input) { this.input.handleInput(data); return; }
    if (matchesKey(data, "shift+l") || data === "L") { this.editLabel(); return; }
    const keys = ["ctrl+a", "ctrl+l", "ctrl+r", "ctrl+e"] as const;
    const index = keys.findIndex(key => matchesKey(data, key));
    if (index >= 0 || matchesKey(data, "ctrl+o")) {
      this.filter = GRAPH_FILTERS[index >= 0 ? index : (GRAPH_FILTERS.indexOf(this.filter) + 1) % GRAPH_FILTERS.length]!;
      this.onFilter(this.filter); this.rebuild(); return;
    }
    if (this.empty) { if (matchesKey(data, "escape")) this.cancel(); return; }
    this.selector.handleInput(data);
    this.search.setText(getMarkdownTheme().quote(`Type to search: ${this.selector.getTreeList().getSearchQuery()}`));
  }
}

/** Native Pi message and tool components, fed only by Host snapshots/events. */
export class Conversation extends Container {
  private assistant?: AssistantMessageComponent;
  private tools = new Map<string, ToolExecutionComponent>();
  private expanded = false;
  private hideThinking = false;
  constructor(private ui: TUI, private cwd: string) { super(); }
  load(entries: RawSessionEntry[]) {
    this.clear(); this.tools.clear(); this.assistant = undefined;
    for (const entry of entries) if (entry.type === "message") this.message(entry.message as Record<string, any>);
  }
  private tool(name: string, id: string, args: unknown) {
    let component = this.tools.get(id);
    if (!component) {
      component = new ToolExecutionComponent(name, id, args, { showImages: false }, undefined, this.ui, this.cwd);
      component.setExpanded(this.expanded);
      this.tools.set(id, component); this.addChild(component);
    } else if (args) component.updateArgs(args);
    return component;
  }
  private message(message: Record<string, any>) {
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content : (message.content ?? []).map((part: any) => part.type === "image" ? "[image]" : part.text ?? "").join("\n");
      this.addChild(new UserMessageComponent(text));
    } else if (message.role === "assistant") {
      this.assistant = new AssistantMessageComponent(message as AssistantMessage, this.hideThinking);
      this.addChild(this.assistant);
      for (const call of message.content ?? []) if (call.type === "toolCall") this.tool(call.name, call.id, call.arguments).setArgsComplete();
    } else if (message.role === "toolResult") {
      this.tool(message.toolName ?? "tool", message.toolCallId, undefined).updateResult({ content: message.content ?? [], details: message.details, isError: Boolean(message.isError), durationMs: message.durationMs });
    }
  }
  event(event: Record<string, any>) {
    if (event.type === "message_start") {
      if (event.message?.role === "assistant") {
        this.assistant = new AssistantMessageComponent(undefined, this.hideThinking);
        this.addChild(this.assistant);
      }
    }
    if (["message_start", "message_update", "message_end"].includes(event.type) && event.message?.role === "assistant") {
      if (!this.assistant) { this.assistant = new AssistantMessageComponent(undefined, this.hideThinking); this.addChild(this.assistant); }
      this.assistant.updateContent(event.message, event.type !== "message_end");
    }
    if (event.type === "tool_execution_start") {
      const tool = this.tool(event.toolName, event.toolCallId, event.args);
      tool.markExecutionStarted(); tool.setArgsComplete();
    } else if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const result = event.type === "tool_execution_end" ? event.result : event.partialResult;
      this.tool(event.toolName ?? "tool", event.toolCallId, undefined).updateResult({ content: result?.content ?? [],
        details: result?.details, isError: Boolean(event.isError), durationMs: event.durationMs }, event.type !== "tool_execution_end");
    }
  }
  toggleTools() { this.expanded = !this.expanded; for (const tool of this.tools.values()) tool.setExpanded(this.expanded); }
  toggleThinking() {
    this.hideThinking = !this.hideThinking;
    for (const child of this.children) if (child instanceof AssistantMessageComponent) child.setHideThinkingBlock(this.hideThinking);
  }
}

export async function interactive(client: HostClient, initial: SessionSnapshot, options: InteractiveOptions) {
  initTheme("dark");
  setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
    "app.tree.foldOrUp": { defaultKeys: ["alt+left", "ctrl+left"], description: "Fold branch or move up" },
    "app.tree.unfoldOrDown": { defaultKeys: ["alt+right", "ctrl+right"], description: "Unfold branch or move down" },
  }));
  const terminal = new ProcessTerminal();
  const ui = new TuiMainScreen(terminal, true);
  const cwd = resolve(options.cwd ?? process.cwd());
  let snapshot = initial;
  let node = options.root ? null : options.node ?? snapshot.projection.activeNodeId;
  let busy = false, closed = false, selectedTheme: string | undefined;
  let abort: AbortController | undefined;
  let dialogReject: ((error: Error) => void) | undefined;
  let dismissDialog: (() => void) | undefined;
  let dialogId: string | undefined;
  let panelCancel: (() => void) | undefined;
  let treePanel: GraphSelector | undefined;
  let treeFilter: GraphFilter = "all";
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const header = new Text("", 1, 1);
  const conversation = new Conversation(ui, cwd);
  const status = new Container();
  const notices = new Text("", 1);
  const editorSlot = new Container();
  const editor = new Editor(ui, { borderColor: text => getMarkdownTheme().hr(text), selectList: getSelectListTheme() }, { paddingX: 1, autocompleteMaxVisible: 7 });
  const footer = new Text("", 1);
  const hints = new Text("", 1);
  const loader = new Loader(ui, text => getMarkdownTheme().link(text), text => getMarkdownTheme().quote(text), "Working… esc / ctrl+c stops this task");
  loader.stop();
  ui.addChild(header); ui.addChild(conversation); ui.addChild(new Spacer(1));
  ui.addChild(status); ui.addChild(notices); ui.addChild(editorSlot); ui.addChild(footer); ui.addChild(hints);
  editorSlot.addChild(editor);

  function selectedRuntime() {
    const branch = snapshot.projection.nodes.find(item => item.id === node)?.branchId ?? "main";
    return snapshot.graph?.runs.find(run => run.branchId === branch)?.runtime ?? snapshot.runtime;
  }
  function renderStatus() {
    const md = getMarkdownTheme();
    const target = snapshot.projection.nodes.find(item => item.id === node);
    const runtime = selectedRuntime();
    const configured = runtime.model?.provider === "unknown" && runtime.model.id === "unknown" ? null : runtime.model;
    const model = options.model ?? (configured ? `${configured.provider}/${configured.id}` : "No model · /model to choose");
    header.setText(`${md.heading(md.bold("PiX"))}  ${md.quote("Agent workspace")}\n${md.quote(shortPath(cwd))}`);
    const running = snapshot.graph?.runs.filter(run => run.status === "running").length ?? 0;
    const usage = target?.footer?.contextUsage?.percent;
    footer.setText(md.quote(`${model} · thinking ${options.thinking ?? runtime.thinkingLevel} · ${branchName(target?.branchId)} · ${snapshot.projection.nodes.length} turns${usage == null ? "" : ` · context ${Math.round(usage)}%`}${running ? ` · ${running} running` : ""} · ${busy ? "working" : "ready"}`));
    hints.setText(md.quote("enter send · shift+enter new line · tab complete · /tree branches · ctrl+d exit"));
    ui.requestRender();
  }
  function notice(text: string) { if (!closed) { notices.setText(getMarkdownTheme().quote(text)); ui.requestRender(); } }
  function loadHistory() {
    conversation.load(conversationEntries(snapshot, node));
    if (!conversation.children.length) {
      conversation.addChild(new Text(getMarkdownTheme().bold("What would you like to work on?"), 1, 1));
      conversation.addChild(new Text(getMarkdownTheme().quote("Ask about this project, describe a change, or type / for commands.\n/tree  branches    /sessions  resume    /model  choose model"), 1));
    }
    renderStatus();
  }
  async function refresh() {
    snapshot = await client.invoke<SessionSnapshot>("session.snapshot", undefined, snapshot.session.path);
    renderStatus();
  }
  function restoreEditor() {
    panelCancel = undefined; treePanel = undefined;
    editorSlot.clear(); editorSlot.addChild(editor); ui.setFocus(editor); ui.requestRender();
  }
  function panel(component: Component, cancel: () => void) {
    panelCancel = cancel;
    editorSlot.clear(); editorSlot.addChild(component); ui.setFocus(component); ui.requestRender();
  }
  function choose(title: string, items: SelectItem[], select: (value: string) => Promise<void> | void) {
    panel(new SearchSelector(title, items, terminal.rows, value => {
      restoreEditor();
      void Promise.resolve().then(() => select(value)).catch(error => notice(String(error.message ?? error)));
    }, restoreEditor), restoreEditor);
  }
  function stop() {
    if (busy) { abort?.abort(); notice("Stopping this task…"); }
    else notice("No task from this terminal is running.");
  }
  function close() {
    if (closed) return;
    closed = true;
    dialogReject?.(new Error("Terminal detached; input request remains pending in the Host"));
    loader.stop(); finish();
  }
  function showDialog(dialog: ExtensionDialog): Promise<string | undefined> {
    if (closed) return Promise.reject(new Error("Terminal detached"));
    panelCancel?.();
    return new Promise((resolve, reject) => {
      let component: ExtensionInputComponent | ExtensionSelectorComponent;
      const complete = (value: string | undefined, error?: Error) => {
        if (dialogId !== dialog.id) return;
        component.dispose();
        dialogId = undefined; dialogReject = undefined; dismissDialog = undefined;
        restoreEditor();
        if (error) reject(error); else resolve(value);
      };
      dialogId = dialog.id;
      dialogReject = error => complete(undefined, error);
      dismissDialog = () => complete(undefined);
      if (dialog.kind === "input") component = new ExtensionInputComponent(dialog.title, dialog.placeholder, complete,
        () => complete(undefined), { tui: ui, description: dialog.message });
      else component = new ExtensionSelectorComponent(dialog.title, dialog.kind === "confirm" ? ["Cancel", "Continue"] : dialog.options ?? [],
        value => complete(dialog.kind === "confirm" ? (value === "Continue" ? "yes" : undefined) : value), () => complete(undefined),
        { tui: ui, description: dialog.message });
      panel(component, () => complete(undefined));
    });
  }
  async function submit(text: string) {
    text = text.trim();
    if (!text || closed) return;
    const [command, ...rest] = text.split(/\s+/), argument = rest.join(" ");
    if (command === "/exit" || command === "/quit") { close(); return; }
    if (command === "/stop") { stop(); return; }
    if (command === "/tree") {
      await refresh();
      if (!snapshot.projection.nodes.length) { notice("The session tree is empty. Send a task to create its first node."); return; }
      treePanel = new GraphSelector(snapshot, node, terminal.rows, id => {
        restoreEditor();
        if (busy) { notice("This terminal has a task running. Stop it first, or use another terminal for a parallel branch."); return; }
        const target = snapshot.projection.nodes.find(item => item.id === id);
        if (!target?.forkable) { notice("Choose a node that is not running to continue from."); return; }
        node = id; loadHistory(); notice(`Continue from: ${target.title}`);
      }, restoreEditor, treeFilter, value => { treeFilter = value; }, async (entryId, label) => {
        const current = await client.invoke<SessionSnapshot>("agent.control", { action: "setLabel", entryId, label }, snapshot.session.path);
        snapshot = current; return current;
      }, () => ui.requestRender());
      panel(treePanel, restoreEditor);
      return;
    }
    if (busy) { notice("A task is running. Esc stops it; /exit detaches without stopping it."); return; }
    if (command === "/help") {
      notice(commands.map(item => `/${item.name}  ${item.description}`).join("\n") + "\nctrl+o expand tools · ctrl+t show/hide thinking · ctrl+c clear input / stop task · ctrl+d exit"); return;
    }
    if (command === "/theme") {
      const apply = (value: string) => { selectedTheme = value; initTheme(value); ui.invalidate(); loadHistory(); };
      if (["light", "dark"].includes(argument)) apply(argument);
      else choose("Theme", ["dark", "light"].map(value => ({ value, label: value })), apply);
      return;
    }
    if (command === "/sessions" || command === "/resume") {
      const sessions = await client.invoke<SessionSummary[]>("session.list");
      if (!sessions.length) { notice("No sessions in this project."); return; }
      choose("Resume session", sessions.map(session => ({ value: session.path, label: session.name ?? session.firstMessage ?? "New session",
        description: `${session.running ? "● " : ""}${session.id}` })), async path => {
        const next = await client.invoke<SessionSnapshot>("session.open", { path });
        if (!next.runtime.available) throw new Error("Session is read-only; close the other owner or recover its storage first");
        snapshot = next; node = next.projection.activeNodeId; loadHistory();
      }); return;
    }
    if (command === "/new") {
      snapshot = await client.invoke<SessionSnapshot>("agent.control", { action: "newSession" });
      node = snapshot.projection.activeNodeId; loadHistory(); notice("New session"); return;
    }
    if (command === "/node") {
      await refresh();
      if (argument === "root") node = null;
      else if (snapshot.projection.nodes.some(item => item.id === argument && item.forkable)) node = argument;
      else { notice("Choose a node that is not running from /tree, or use /node root."); return; }
      loadHistory(); notice(node ? `Continue from: ${snapshot.projection.nodes.find(item => item.id === node)?.title}` : "Continue from session root"); return;
    }
    if (command === "/model" || command === "/thinking") {
      if (command === "/model") {
        const models = await client.invoke<RuntimeModel[]>("agent.control", { action: "getModels" }, snapshot.session.path);
        const apply = async (value: string) => {
          const model = models.find(model => `${model.provider}/${model.id}` === value);
          if (!model) throw new Error("Choose an available provider/model");
          options.model = value;
          if (options.thinking && !model.thinkingLevels?.includes(options.thinking)) options.thinking = "off";
          renderStatus(); notice(`Model: ${value}`);
        };
        if (argument) await apply(argument);
        else choose("Select model", models.map(model => ({ value: `${model.provider}/${model.id}`, label: model.name ?? model.id,
          description: `${model.provider}/${model.id}` })), apply);
      } else {
        const levels = options.model ? (await client.invoke<RuntimeModel[]>("agent.control", { action: "getModels" })).find(model => `${model.provider}/${model.id}` === options.model)?.thinkingLevels : selectedRuntime().availableThinkingLevels;
        const values = levels?.length ? levels : ["off"];
        const apply = (value: string) => { if (!values.includes(value)) throw new Error("Choose an available thinking level"); options.thinking = value; renderStatus(); };
        if (argument) apply(argument); else choose("Thinking level", values.map(value => ({ value, label: value })), apply);
      }
      return;
    }
    busy = true; abort = new AbortController();
    notices.setText("");
    conversation.addChild(new UserMessageComponent(text));
    status.addChild(loader); loader.start();
    renderStatus();
    try {
      const outcome = await runTask(client, snapshot, text, node, options, {
        signal: abort.signal,
        agent: event => { if (!closed) { conversation.event(event); ui.requestRender(); } },
        notice,
        snapshot: (current: SessionSnapshot, run: Run) => { snapshot = current; node = run.nodeId ?? node; if (!closed) renderStatus(); },
        dialog: showDialog,
      });
      snapshot = outcome.snapshot; node = outcome.nodeId ?? node;
      if (!closed) notice("Ready");
    } catch (error) {
      if (!closed) { notice(error instanceof Error ? error.message : String(error)); if (client.connected) await refresh(); }
    } finally {
      busy = false; abort = undefined;
      loader.stop(); status.clear();
      if (!closed) { loadHistory(); if (!panelCancel) ui.setFocus(editor); }
    }
  }
  editor.onSubmit = text => {
    if (busy && !["/exit", "/quit", "/stop", "/tree"].includes(text.trim())) {
      editor.setText(text);
      notice("A task is running. Esc stops it; your draft stays in the editor."); return;
    }
    editor.addToHistory(text);
    void submit(text).catch(error => notice(error instanceof Error ? error.message : String(error)));
  };
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, cwd));
  const unsubscribe = client.onEvent(event => {
    if (closed) return;
    if (event.type === "ui.dismiss" && (event.payload as { id?: string }).id === dialogId) dismissDialog?.();
    if (event.type !== "sessions") return;
    const current = (event.payload as { current?: SessionSnapshot }).current;
    if (current?.session.path !== snapshot.session.path) return;
    snapshot = current; treePanel?.update(current);
    if (!busy) loadHistory(); else renderStatus();
  });
  const disconnected = client.onDisconnect(error => { notice(error.message + " · /exit to detach and reconnect"); });
  ui.addInputListener(data => {
    if (matchesKey(data, "ctrl+d") && !panelCancel && !editor.getText()) { close(); return { consume: true }; }
    if (matchesKey(data, "ctrl+c")) {
      if (panelCancel) panelCancel();
      else if (busy) stop();
      else if (editor.getText()) { editor.setText(""); ui.requestRender(); }
      else close();
      return { consume: true };
    }
    if (matchesKey(data, "escape") && busy && !panelCancel && !editor.isShowingAutocomplete()) { stop(); return { consume: true }; }
    if (!panelCancel && matchesKey(data, "ctrl+o")) { conversation.toggleTools(); ui.requestRender(); return { consume: true }; }
    if (!panelCancel && matchesKey(data, "ctrl+t")) { conversation.toggleThinking(); ui.requestRender(); return { consume: true }; }
    return undefined;
  });
  const signal = () => close();
  process.once("SIGTERM", signal); process.once("SIGHUP", signal);
  try {
    loadHistory(); ui.setFocus(editor); ui.start();
    const applyColors = (colors: TerminalColors) => {
      if (closed || selectedTheme || !colors.background) return;
      const { r, g, b } = colors.background;
      initTheme(0.2126 * r + 0.7152 * g + 0.0722 * b > 127.5 ? "light" : "dark");
      ui.invalidate();
      if (busy) renderStatus(); else loadHistory();
    };
    void ui.queryTerminalColors({ timeoutMs: 500, onLateReply: applyColors }).then(applyColors).catch(() => {});
    void client.invoke<RuntimeCommand[]>("agent.control", { action: "commands" }, snapshot.session.path).then(extra => {
      if (!closed) editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...commands, ...extra.filter(item => !commands.some(command => command.name === item.name))], cwd));
    }).catch(() => {});
    await finished;
  } finally {
    closed = true; loader.stop(); unsubscribe(); disconnected();
    process.removeListener("SIGTERM", signal); process.removeListener("SIGHUP", signal);
    await terminal.drainInput(200);
    ui.stop();
    // Do not wait for or cancel a detached run. Closing the Host socket in the
    // caller releases a pending monitor while execution continues in the Host.
    process.stdout.write(`\nResume: pix --cwd ${JSON.stringify(cwd)} resume ${snapshot.session.id}\n`);
  }
}
