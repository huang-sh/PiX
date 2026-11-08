import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PixieTasks, taskCompletionPrompt, taskSummary, taskDetails, type PixieTaskHost, type PixieTaskSource, type PixieTaskTarget } from "./pixie-tasks.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanvasCommand } from "../shared/canvas.js";
import type { DesktopEvent, PixiePromptCustomization, PixieSettings, PromptImage, ProjectInfo, RawSessionEntry, RuntimeState, SessionSnapshot } from "../shared/types.js";
import { projectSession, summarizeSession } from "../shared/session.js";
import { debugLog } from "./debug-log.js";
import { canonicalPath, pixAgentDir } from "./paths.js";
import { composePixieSystemPrompt } from "./pi-runtime.js";
import { PixieRpc, type RpcLine } from "./pixie-rpc.js";

export const pixieWorkspace = () => join(pixAgentDir(), "pixie");

/** Where pi's CLI files new sessions for a given cwd (getDefaultSessionDirPath). */
const cliSessionDir = (cwd: string) =>
  join(pixAgentDir(), "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

/**
 * The workspace was ~/.pix/agent/assistant before the rename; it and its
 * pre-RPC session dir move once so existing conversations follow along.
 * Best-effort: a locked directory (an old instance still running, an AV
 * scan) skips the move and retries on the next launch — nothing is lost.
 */
function migrateLegacyWorkspace(): void {
  const legacy = join(pixAgentDir(), "assistant");
  try {
    if (existsSync(legacy) && !existsSync(pixieWorkspace()))
      renameSync(legacy, pixieWorkspace());
    const legacySessions = cliSessionDir(legacy);
    if (existsSync(legacySessions) && !existsSync(cliSessionDir(pixieWorkspace())))
      renameSync(legacySessions, cliSessionDir(pixieWorkspace()));
  } catch (error) {
    debugLog("pixie: workspace migration", error);
  }
}

/** Include pre-RPC sessions and both cwd spellings: the child resolves symlinks. */
function sessionDirs(): string[] {
  const workspace = pixieWorkspace();
  return [...new Set([
    join(workspace, "sessions"),
    cliSessionDir(workspace),
    cliSessionDir(canonicalPath(workspace)),
  ])];
}

/** The most recently modified session file across every spelling of the workspace. */
function latestSession(): string | undefined {
  const candidates: Array<{ path: string; modified: number }> = [];
  for (const dir of sessionDirs()) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        candidates.push({ path, modified: statSync(path).mtimeMs });
      } catch { /* raced deletion */ }
    }
  }
  candidates.sort((a, b) => b.modified - a.modified);
  return candidates[0]?.path;
}

interface RpcState {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  model?: { provider: string; id: string; name?: string; contextWindow?: number; reasoning?: boolean; input?: Array<"text" | "image"> };
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  pendingMessageCount?: number;
}

/**
 * The Pixie runtime: one Pi agent in its own subprocess, driven through pi's
 * RPC protocol (the officially designated embedding surface). It is app-level
 * and local-only — never a graph session, never re-pointed at the project in
 * view, so remote (WSL/SSH) workspaces leave it running on the local host.
 *
 * The wire protocol streams assistant text as deltas; the renderer consumes
 * cumulative snapshots like every other chat surface, so message_update events
 * are rebuilt cumulatively here before they are forwarded.
 */
export class PixieRuntime {
  private canvas?: (command: CanvasCommand) => Promise<unknown>;
  private sending = false;
  private lifecycle = false;
  private reloadPending = false;
  private readonly rpc = new PixieRpc(command => this.canvasCommand(command));
  private taskJournal?: PixieTasks;
  private readonly taskFile: string;
  private source?: PixieTaskSource;
  private monitor?: ReturnType<typeof setInterval>;
  private checkingTasks = false;
  private closed = false;
  private followUpsPaused = false;
  private journalNoticeShown = false;
  private review?: { id: string; revision: number };
  /** The last failed review's identity and consecutive-failure count. */
  private reviewFailure?: { key: string; count: number };

  get tasks(): PixieTasks {
    return this.taskJournal ??= new PixieTasks(this.taskFile);
  }
  registerTaskHost(host: PixieTaskHost) { return this.tasks.addHost(host); }

  private async canvasCommand(command: CanvasCommand): Promise<unknown> {
    if (command.action === "tasks") {
      if (command.taskId) return taskDetails(this.tasks.get(command.taskId));
      const tasks = this.tasks.list().reverse(), offset = command.offset ?? 0, limit = command.limit ?? 30;
      return { tasks: tasks.slice(offset, offset + limit).map(({ id, purpose, state, revision, parentTaskId, target, notification }) =>
        ({ id, purpose, state, revision, parentTaskId, target, notification })), total: tasks.length,
        nextOffset: offset + limit < tasks.length ? offset + limit : null };
    }
    if (command.action === "read" && command.taskId) {
      const { task, ancestors, output } = await this.tasks.read(command.taskId, command.limit);
      return { task: taskDetails(task), ancestors: ancestors.map(({ id, purpose, acceptance, state, revision }) =>
        ({ id, purpose, acceptance, state, revision })), output };
    }
    if (this.review) {
      const task = this.tasks.get(this.review.id);
      if ((task.state === "cancelled" && command.action !== "stop") || task.revision !== this.review.revision)
        throw new Error("The delegation changed while you were reviewing it; read its latest state before taking further action");
    }
    if (command.action === "updateTask") {
      const task = this.tasks.update(command);
      if (this.review?.id === task.id) this.review.revision = task.revision;
      return { ...taskSummary(task), purpose: task.purpose, acceptance: task.acceptance };
    }
    if (command.action === "delegate") {
      if (!this.source) throw new Error("No Pixie request is active");
      let target: PixieTaskTarget;
      if (command.taskId) {
        const parent = this.tasks.get(command.taskId);
        if (parent.state === "cancelled") throw new Error("This delegation was cancelled");
        target = parent.target;
        command = { ...command, nodeId: command.nodeId === undefined ? parent.nodeId : command.nodeId };
      } else {
        if (!this.canvas) throw new Error("Inspect a connected desktop canvas to start a new delegation");
        const view = await this.canvas({ action: "inspect" }) as { context: string; project?: ProjectInfo; session?: { path: string } };
        if (!view.project || !view.session?.path || view.context !== command.context)
          throw new Error("The canvas session changed; inspect again before delegating");
        target = { project: view.project, session: view.session.path };
      }
      const result = await this.tasks.delegate(command, this.source, target, command.taskId);
      return { ...result, task: taskSummary(result.task) };
    }
    if (command.taskId && ["steer", "followUp", "stop"].includes(command.action)) {
      if (!this.source) throw new Error("No Pixie request is active");
      const result = await this.tasks.control(command, this.source);
      return { ...result, task: taskSummary(result.task) };
    }
    if (!this.canvas) throw new Error("This background turn has no live canvas; use taskId to address the original delegation");
    return this.canvas(command);
  }

  private startMonitoring() {
    if (this.monitor || this.closed) return;
    this.monitor = setInterval(() => { void this.checkTasks(); }, 2_000);
    this.monitor.unref();
  }

  /** One notice when the saved journal was quarantined: its follow-ups were lost with it. */
  private reportJournalProblem() {
    if (this.journalNoticeShown) return;
    const error = this.tasks.loadError;
    if (!error) return;
    this.journalNoticeShown = true;
    this.emit({ type: "pixie", payload: { type: "notice", payload: { level: "error",
      message: `Pixie delegations were reset after a journal read failure (${error.message}); tracked follow-ups will not resume. The previous file was kept as delegations.json.corrupt` } } });
  }

  /** Host polling uses no model tokens. Completion reviews run only between Pixie turns. */
  private async checkTasks() {
    if (this.closed || this.checkingTasks) return;
    this.checkingTasks = true;
    try {
      this.reportJournalProblem();
      await this.flushReload();
      await this.tasks.reconcile();
      if (this.closed || this.busy || this.followUpsPaused) return;
      const task = this.tasks.pending();
      if (!task) return;
      this.sending = true;
      this.review = { id: task.id, revision: task.revision };
      try {
        if (this.closed || this.followUpsPaused) return;
        const latest = this.tasks.get(task.id);
        if (latest.state === "cancelled" || latest.revision !== task.revision) return;
        this.tasks.delivery(task.id, task.revision, "delivering");
        const snapshot = await this.sendTurn({ text: taskCompletionPrompt(latest) }, {
          ...task.source, id: `task:${task.id}:${task.revision}`,
        });
        const assistant = [...snapshot.entries].reverse().find(entry => (entry.message as { role?: string } | undefined)?.role === "assistant")?.message as { stopReason?: string; errorMessage?: string } | undefined;
        if (assistant?.stopReason === "error" || assistant?.stopReason === "aborted")
          throw new Error(assistant.errorMessage || "Pixie's task review was interrupted");
        this.tasks.delivery(task.id, this.review.revision, this.closed || this.followUpsPaused ? "pending" : "delivered");
        this.reviewFailure = undefined;
        this.emit({ type: "pixie", payload: { type: "snapshot", payload: snapshot } });
      } catch (error) {
        // A persistent failure retries with backoff and reports each cause
        // once; a changed failure or task is a new error for the person.
        const key = `${task.id}:${this.review!.revision}:${String(error)}`;
        const count = this.reviewFailure?.key === key ? this.reviewFailure.count + 1 : 1;
        this.reviewFailure = { key, count };
        this.tasks.delivery(task.id, this.review!.revision, "pending",
          Date.now() + Math.min(60_000 * 2 ** (count - 1), 30 * 60_000));
        if (count > 1) debugLog("pixie: task follow-up retry deferred", error);
        else this.emit({ type: "pixie", payload: { type: "notice", payload: { level: "error", message: `Pixie task follow-up pending: ${String(error)}` } } });
      } finally {
        this.review = undefined;
        this.source = undefined;
        this.sending = false;
        await this.flushReload();
      }
    } catch (error) { debugLog("pixie: task reconciliation", error); }
    finally { this.checkingTasks = false; }
  }
  private starting?: Promise<SessionSnapshot>;
  /** Cumulative assistant content by part index, rebuilt from wire deltas. */
  private parts = new Map<number, { kind: "text" | "thinking"; body: string }>();
  private idleWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  /** The in-flight turn's timing: prompt dispatch → first delta → settle. */
  private turnTiming?: { promptAt: number; firstDeltaAt?: number };

  get busy(): boolean { return Boolean(this.starting || this.sending || this.turnTiming || this.lifecycle); }

  constructor(
    private readonly emit: (event: DesktopEvent) => void,
    private readonly settings: () => PixieSettings,
  ) {
    // Before any clear-or-boot can touch the session dirs: clearing first
    // and migrating afterwards would resurrect the wiped conversations.
    migrateLegacyWorkspace();
    this.taskFile = join(pixieWorkspace(), "delegations.json");
    this.rpc.onEvent(event => this.onWireEvent(event));
    // A dead subprocess must fail the in-flight turn, not hang its waiters.
    this.rpc.onExit(error => {
      this.turnTiming = undefined;
      for (const waiter of this.idleWaiters) waiter.reject(error);
      this.idleWaiters.clear();
    });
  }

  private onWireEvent(event: RpcLine) {
    if (event.type === "extension_error" && event.event === "send_message") {
      for (const waiter of this.idleWaiters) waiter.reject(new Error(String(event.error)));
      this.idleWaiters.clear();
    }
    if (event.type === "message_update") {
      if (this.turnTiming && !this.turnTiming.firstDeltaAt) this.turnTiming.firstDeltaAt = Date.now();
      this.emitAgent(this.cumulativeUpdate(event));
      return;
    }
    if (event.type === "message_start" || event.type === "message_end") {
      const message = event.message as { role?: string; display?: boolean } | undefined;
      if (message?.role === "custom" && message.display === false) return;
      const role = message?.role;
      if (role === "assistant") this.parts.clear();
    } else if (event.type === "agent_settled" || event.type === "agent_start") {
      this.parts.clear();
    } else if (event.type === "extension_ui_request") {
      // Pixie does not render extension dialogs; answer immediately so an
      // extension fails fast with a visible reason instead of hanging.
      this.rpc.write({ type: "extension_ui_response", id: String(event.id), cancelled: true });
      const title = typeof event.title === "string" ? event.title : typeof event.message === "string" ? event.message : "";
      this.emit({ type: "pixie", payload: { type: "notice", payload: {
        level: "warning",
        message: `Extension dialog unsupported: ${title || String(event.method ?? "")}`,
      } } });
      return;
    }
    this.emitAgent(event);
  }

  /** Rebuilds a cumulative message_update from the protocol's delta stream. */
  private cumulativeUpdate(event: RpcLine) {
    const delta = event.assistantMessageEvent as { type?: string; contentIndex?: number; delta?: string } | undefined;
    const index = typeof delta?.contentIndex === "number" ? delta.contentIndex : 0;
    if (delta?.type === "text_delta" || delta?.type === "thinking_delta") {
      const kind = delta.type === "text_delta" ? "text" : "thinking";
      const part = this.parts.get(index);
      if (part && part.kind === kind) part.body += delta.delta ?? "";
      else this.parts.set(index, { kind, body: delta.delta ?? "" });
    }
    const content = [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, part]) => part.kind === "text"
        ? { type: "text", text: part.body }
        : { type: "thinking", thinking: part.body });
    return { type: "message_update", message: { role: "assistant", content } };
  }

  private emitAgent(event: unknown) {
    this.emit({ type: "pixie", payload: { type: "agent", payload: event } });
    if ((event as { type?: string }).type === "agent_settled") {
      for (const waiter of this.idleWaiters) waiter.resolve();
      this.idleWaiters.clear();
    }
  }

  private whenIdle(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.idleWaiters.add({ resolve, reject });
    });
  }

  /** Single-flight boot: repeated toggles, sends, and retries share one start. */
  ensure(): Promise<SessionSnapshot> {
    this.startMonitoring();
    if (this.starting) return this.starting;
    if (this.rpc.running) return this.snapshot();
    return (this.starting ??= this.boot().finally(() => {
      this.starting = undefined;
    }));
  }

  /**
   * Boots the subprocess with the system prompt set directly: the fully
   * customized Pixie prompt — Pi's section structure with Pixie's coordination
   * identity, tools, rules/docs, and canvas guidance; or
   * the user's verbatim text in full-replacement mode. The subprocess appends
   * skills, context files, and the working directory to whatever text this
   * sets.
   */
  private async startAgent(): Promise<void> {
    const prompt = await composePixieSystemPrompt(pixieWorkspace(), this.settings().prompt);
    const adjacent = new URL("./pixie-extension.js", import.meta.url);
    const extension = existsSync(adjacent) ? adjacent : new URL("../pixie-extension.js", import.meta.url);
    await this.rpc.start(pixieWorkspace(), { PI_CODING_AGENT_DIR: pixAgentDir() }, [
      "--extension", fileURLToPath(extension),
      "--system-prompt", prompt,
    ]);
  }

  /**
   * The exact system prompt a boot would use — with the caller's draft when
   * given, otherwise the saved settings. Pure in-memory composition: no
   * subprocess is started and nothing touches disk.
   */
  promptPreview(customization?: PixiePromptCustomization): Promise<string> {
    return composePixieSystemPrompt(pixieWorkspace(), customization ?? this.settings().prompt);
  }

  private async boot(): Promise<SessionSnapshot> {
    const startedAt = Date.now();
    mkdirSync(join(pixieWorkspace(), "sessions"), { recursive: true });
    await this.startAgent();
    // A restored conversation keeps its own model; a fresh boot starts from
    // the Pixie default when one is set.
    const config = this.settings();
    const latest = config.restoreLastConversation === false ? undefined : latestSession();
    if (latest)
      await this.rpc.request({ type: "switch_session", sessionPath: latest });
    else
      await this.applyDefaultModel();
    const snapshot = await this.snapshot();
    debugLog(`pixie: booted in ${Date.now() - startedAt}ms`);
    return snapshot;
  }

  /** "provider/modelId" — the first slash splits; model ids may contain more. */
  private async applyDefaultModel(): Promise<void> {
    const id = this.settings().defaultModel;
    if (!id || id === "default") return;
    const slash = id.indexOf("/");
    if (slash <= 0) return;
    await this.rpc.request({ type: "set_model", provider: id.slice(0, slash), modelId: id.slice(slash + 1) });
  }

  private async snapshot(): Promise<SessionSnapshot> {
    const [state, entries] = await Promise.all([
      this.rpc.request({ type: "get_state" }) as Promise<RpcState>,
      this.rpc.request({ type: "get_entries" }) as Promise<{ entries: RawSessionEntry[]; leafId: string | null }>,
    ]);
    // A reply that lost its payload (a substrate or protocol mismatch) must
    // fail loudly instead of crashing with an opaque TypeError.
    if (!entries || typeof entries !== "object")
      throw new Error("Pixie's session substrate returned no entries");
    const list = entries.entries ?? [];
    const projection = projectSession(list, entries.leafId ?? null);
    const byId = new Map(list.map(entry => [entry.id, entry]));
    // Hidden events start their own reply, rather than merging it into the
    // user's most recent (possibly unrelated) question.
    let eventTurn: string | undefined;
    projection.messages = projection.messages.flatMap(message => {
      const entry = byId.get(message.entryId);
      if (entry?.type === "custom_message" && entry.display === false) {
        eventTurn = `turn:${entry.id}`;
        return [];
      }
      if (message.role === "user") eventTurn = undefined;
      return [{ ...message, ...(eventTurn ? { turnId: eventTurn } : {}) }];
    });
    return {
      session: {
        ...summarizeSession(state.sessionFile ?? "", null, list, new Date().toISOString()),
        id: state.sessionId,
        name: state.sessionName,
        cwd: pixieWorkspace(),
      },
      entries: list,
      projection,
      runtime: this.runtimeState(state),
    };
  }

  private runtimeState(state: RpcState): RuntimeState {
    const model = state.model;
    return {
      available: true,
      model: model ? {
        provider: String(model.provider),
        id: String(model.id),
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: Boolean(model.reasoning),
        ...(model.input ? { input: model.input } : {}),
      } : null,
      thinkingLevel: String(state.thinkingLevel ?? "off"),
      availableThinkingLevels: [String(state.thinkingLevel ?? "off")],
      isStreaming: Boolean(state.isStreaming),
      isCompacting: Boolean(state.isCompacting),
      isRetrying: false,
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      pendingMessageCount: Number(state.pendingMessageCount ?? 0),
    };
  }

  async send(input: {
    text: string;
    images?: PromptImage[];
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
  }, canvas?: (command: CanvasCommand) => Promise<unknown>): Promise<SessionSnapshot> {
    if (this.sending || this.lifecycle) throw new Error("Pixie is already answering another message or changing conversations");
    this.sending = true;
    this.followUpsPaused = false;
    this.canvas = canvas;
    try {
      return await this.sendTurn(input);
    } finally {
      this.canvas = undefined;
      this.source = undefined;
      this.sending = false;
      await this.flushReload();
    }
  }

  private async sendTurn(input: { text: string; images?: PromptImage[]; provider?: string; modelId?: string; thinkingLevel?: string }, source?: PixieTaskSource): Promise<SessionSnapshot> {
    await this.ensure();
    // Session-scoped switches, like the plain chat's promptAt: the profile
    // default stays put, so changing the Pixie model never leaks into new
    // graph sessions.
    const state = await this.rpc.request({ type: "get_state" }) as RpcState;
    this.source = source ?? { id: randomUUID(), text: input.text, sessionId: state.sessionId, sessionFile: state.sessionFile };
    // A session replacement can briefly leave the restored model unresolved;
    // a turn dispatched in that window substitutes pi's "unknown" placeholder
    // and fails. Resolve the configured default first — a restored session
    // with its own model is never touched, and an explicit model below wins.
    if (!input.provider && (!state.model || state.model.provider === "unknown"))
      await this.applyDefaultModel();
    if (input.provider && input.modelId &&
      (state.model?.provider !== input.provider || state.model?.id !== input.modelId))
      await this.rpc.request({ type: "set_model", provider: input.provider, modelId: input.modelId });
    if (input.thinkingLevel && state.thinkingLevel !== input.thinkingLevel)
      await this.rpc.request({ type: "set_thinking_level", level: input.thinkingLevel });
    const timing: { promptAt: number; firstDeltaAt?: number } = { promptAt: Date.now() };
    this.turnTiming = timing;
    const idle = this.whenIdle();
    try {
      await Promise.all([this.rpc.request(source
        ? { type: "pixie.task.event", content: input.text }
        : { type: "prompt", message: input.text, ...(input.images?.length ? { images: input.images } : {}) }), idle]);
    } catch (error) {
      // Neither failed admission nor a failed event turn may retain a busy waiter.
      this.idleWaiters.clear();
      this.turnTiming = undefined;
      throw error;
    }
    this.turnTiming = undefined;
    const first = timing.firstDeltaAt ? `, first delta ${timing.firstDeltaAt - timing.promptAt}ms` : "";
    debugLog(`pixie: turn ${Date.now() - timing.promptAt}ms${first}`);
    return this.snapshot();
  }

  async stop(): Promise<void> {
    this.followUpsPaused = true;
    // A process that is not running has nothing to abort; booting one just to
    // cancel it would waste a cold start.
    if (this.rpc.running) await this.rpc.request({ type: "abort" });
  }

  async newSession(): Promise<SessionSnapshot> {
    if (this.busy) throw new Error("Stop Pixie before starting a new conversation");
    this.lifecycle = true;
    try {
      await this.ensure();
      await this.rpc.request({ type: "new_session" });
      await this.applyDefaultModel();
      return await this.snapshot();
    } finally { this.lifecycle = false; }
  }

  /** Deletes Pixie conversations and pending follow-ups, leaving graph agents alone. */
  async clearHistory(): Promise<SessionSnapshot> {
    if (this.busy) throw new Error("Stop Pixie before clearing its conversations");
    this.lifecycle = true;
    this.followUpsPaused = true;
    try {
      if (this.rpc.running) {
        const state = await this.rpc.request({ type: "get_state" }).catch(() => undefined) as RpcState | undefined;
        if (state?.isStreaming || state?.isCompacting)
          throw new Error("Stop Pixie before clearing its conversations");
        await this.rpc.stop();
      }
      this.tasks.clear();
      for (const dir of sessionDirs()) rmSync(dir, { recursive: true, force: true });
      return await this.ensure();
    } finally { this.lifecycle = false; }
  }

  private async flushReload() {
    if (!this.reloadPending || this.busy || this.closed) return;
    try { await this.reload(); }
    catch (error) {
      this.emit({ type: "pixie", payload: { type: "notice", payload: { level: "error", message: `Pixie reload failed: ${String(error)}` } } });
    }
  }

  /** Defer prompt/catalog changes until idle, preserving the conversation. */
  async reload(): Promise<void> {
    if (this.closed) return;
    this.reloadPending = true;
    if (this.busy) return;
    this.reloadPending = false;
    if (!this.rpc.running) return; // The next boot already reads the latest settings.
    this.lifecycle = true;
    try {
      const state = await this.rpc.request({ type: "get_state" }) as RpcState;
      if (state.isStreaming || state.isCompacting) { this.reloadPending = true; return; }
      const resume = state.sessionFile;
      await this.rpc.stop();
      if (this.closed) return;
      await this.startAgent();
      if (this.closed) { await this.rpc.stop(); return; }
      if (resume) await this.rpc.request({ type: "switch_session", sessionPath: resume });
    } finally { this.lifecycle = false; }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.monitor);
    this.monitor = undefined;
    await this.starting?.catch(() => {});
    this.rpc.write({ type: "abort" });
    await this.rpc.stop();
    this.turnTiming = undefined;
    for (const waiter of this.idleWaiters) waiter.reject(new Error("Pixie was stopped"));
    this.idleWaiters.clear();
  }
}
