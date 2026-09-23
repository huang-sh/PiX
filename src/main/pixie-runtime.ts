import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DesktopEvent, PixieSettings, PromptImage, RawSessionEntry, RuntimeState, SessionSnapshot } from "../shared/types.js";
import { projectSession, summarizeSession } from "../shared/session.js";
import { PIXIE_IDENTITY } from "../shared/pixie-prompt.js";
import { debugLog } from "./debug-log.js";
import { pixAgentDir } from "./paths.js";
import { piPixieSystemPrompt } from "./pi-runtime.js";
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

/** Pixie's sessions can predate the RPC substrate, so both dirs are scanned. */
function sessionDirs(): string[] {
  return [join(pixieWorkspace(), "sessions"), cliSessionDir(pixieWorkspace())];
}

/** The newest session file, preferring ones that already hold a conversation. */
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
  private readonly rpc = new PixieRpc();
  private starting?: Promise<SessionSnapshot>;
  /** Cumulative assistant content by part index, rebuilt from wire deltas. */
  private parts = new Map<number, { kind: "text" | "thinking"; body: string }>();
  private idleWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  /** The in-flight turn's timing: prompt dispatch → first delta → settle. */
  private turnTiming?: { promptAt: number; firstDeltaAt?: number };

  constructor(
    private readonly emit: (event: DesktopEvent) => void,
    private readonly settings: () => PixieSettings,
  ) {
    // Before any clear-or-boot can touch the session dirs: clearing first
    // and migrating afterwards would resurrect the wiped conversations.
    migrateLegacyWorkspace();
    this.rpc.onEvent(event => this.onWireEvent(event));
    // A dead subprocess must fail the in-flight turn, not hang its waiters.
    this.rpc.onExit(error => {
      for (const waiter of this.idleWaiters) waiter.reject(error);
      this.idleWaiters.clear();
    });
  }

  private onWireEvent(event: RpcLine) {
    if (event.type === "message_update") {
      if (this.turnTiming && !this.turnTiming.firstDeltaAt) this.turnTiming.firstDeltaAt = Date.now();
      this.emitAgent(this.cumulativeUpdate(event));
      return;
    }
    if (event.type === "message_start" || event.type === "message_end") {
      const role = (event.message as { role?: string } | undefined)?.role;
      if (role === "assistant") this.parts.clear();
    } else if (event.type === "agent_settled" || event.type === "agent_start") {
      this.parts.clear();
    } else if (event.type === "extension_ui_request") {
      // PiX renders no extension dialogs yet; answer immediately so an
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
    if (this.rpc.running) return this.snapshot();
    return (this.starting ??= this.boot().finally(() => {
      this.starting = undefined;
    }));
  }

  /**
   * Boots the subprocess with the system prompt set directly: Pi's own
   * generated default with only the identity line swapped — the user's, or
   * the built-in Pixie one. The subprocess still appends skills, context
   * files, and the working directory to whatever text this sets.
   */
  private async startAgent(): Promise<void> {
    const identity = this.settings().systemPrompt?.trim() || PIXIE_IDENTITY;
    const prompt = await piPixieSystemPrompt(pixieWorkspace(), identity);
    await this.rpc.start(pixieWorkspace(), { PI_CODING_AGENT_DIR: pixAgentDir() }, [
      "--system-prompt", prompt,
    ]);
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
    const list = entries.entries ?? [];
    return {
      session: {
        ...summarizeSession(state.sessionFile ?? "", null, list, new Date().toISOString()),
        id: state.sessionId,
        name: state.sessionName,
        cwd: pixieWorkspace(),
      },
      entries: list,
      projection: projectSession(list, entries.leafId ?? null),
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
  }): Promise<SessionSnapshot> {
    await this.ensure();
    // Session-scoped switches, like the plain chat's promptAt: the profile
    // default stays put, so changing the Pixie model never leaks into new
    // graph sessions.
    const state = await this.rpc.request({ type: "get_state" }) as RpcState;
    if (input.provider && input.modelId &&
      (state.model?.provider !== input.provider || state.model?.id !== input.modelId))
      await this.rpc.request({ type: "set_model", provider: input.provider, modelId: input.modelId });
    if (input.thinkingLevel && state.thinkingLevel !== input.thinkingLevel)
      await this.rpc.request({ type: "set_thinking_level", level: input.thinkingLevel });
    const timing: { promptAt: number; firstDeltaAt?: number } = { promptAt: Date.now() };
    this.turnTiming = timing;
    const idle = this.whenIdle();
    try {
      await this.rpc.request({ type: "prompt", message: input.text, ...(input.images?.length ? { images: input.images } : {}) });
    } catch (error) {
      // The turn never started; its idle waiter must not outlive the send.
      this.idleWaiters.clear();
      throw error;
    }
    await idle;
    this.turnTiming = undefined;
    const first = timing.firstDeltaAt ? `, first delta ${timing.firstDeltaAt - timing.promptAt}ms` : "";
    debugLog(`pixie: turn ${Date.now() - timing.promptAt}ms${first}`);
    return this.snapshot();
  }

  async stop(): Promise<void> {
    await this.ensure();
    await this.rpc.request({ type: "abort" });
  }

  async newSession(): Promise<SessionSnapshot> {
    await this.ensure();
    await this.rpc.request({ type: "new_session" });
    await this.applyDefaultModel();
    return this.snapshot();
  }

  /** Deletes every Pixie conversation and boots a fresh one. */
  async clearHistory(): Promise<SessionSnapshot> {
    if (this.rpc.running) {
      const state = await this.rpc.request({ type: "get_state" }).catch(() => undefined) as RpcState | undefined;
      if (state?.isStreaming || state?.isCompacting)
        throw new Error("Stop Pixie before clearing its conversations");
      await this.rpc.stop();
    }
    for (const dir of sessionDirs()) rmSync(dir, { recursive: true, force: true });
    return this.ensure();
  }

  /**
   * Neither prompt nor catalog changes can be pushed into the subprocess (the
   * RPC protocol has no reload), so an idle Pixie restarts into the same
   * session file; a busy one picks the change up on its next lifecycle.
   */
  async reload(): Promise<void> {
    if (!this.rpc.running || this.starting) return;
    const state = await this.rpc.request({ type: "get_state" }).catch(() => undefined) as RpcState | undefined;
    if (state?.isStreaming || state?.isCompacting) return;
    const resume = state?.sessionFile;
    await this.rpc.stop();
    await this.startAgent();
    if (resume) await this.rpc.request({ type: "switch_session", sessionPath: resume });
  }

  close(): Promise<void> {
    this.rpc.write({ type: "abort" });
    return this.rpc.stop();
  }
}
