// Wiki lifecycle: queueing, deduplication, budgets, retries and cancellation
// for background branch summaries. One wiki per workspace; tasks are keyed by
// session file. The deterministic layer (wiki-compiler) is synchronous; the
// only async gap is the model call, and every publish is re-verified against
// disk before anything is written.
import { existsSync } from "node:fs";
import { type WikiGraphEvent, type WikiAppSettings, type WikiStatus, type WikiBranchStatus } from "../shared/wiki.js";
import {
  WikiPublishError, WIKI_SYSTEM_PROMPT, parseModelSummary, prepareCompile, publishSummary, readManifest,
  refreshSessionWiki, removeSessionWiki,
} from "./wiki-compiler.js";

export interface WikiModelReply { text: string; usage: { inputTokens: number | null; outputTokens: number | null; cost: number | null } | null }
export type WikiModelCaller = (request: {
  provider: string; modelId: string; systemPrompt: string; userPrompt: string; maxTokens: number; signal: AbortSignal;
}) => Promise<WikiModelReply>;

export interface WikiServiceDeps {
  /** Workspace wiki root (one per project); null when no local project is open. */
  wikiRoot: () => string | null;
  settings: () => WikiAppSettings;
  defaultModel: () => { provider: string; id: string } | null;
  callModel: WikiModelCaller;
  emit: (status: WikiStatus) => void;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  /** Shorter backoff for tests; production keeps the default ladder. */
  retryDelaysMs?: number[];
}

interface BranchTask {
  branchId: string;
  queued: boolean;
  running: boolean;
  /** A new turn settled while this task was running; re-run afterwards. */
  again: boolean;
  failures: number;
  error?: string;
  timer?: ReturnType<typeof setTimeout>;
}
interface SessionTasks {
  tasks: Map<string, BranchTask>;
  cancelled: boolean;
  /** Wiki root this session's tasks belong to, bound at enqueue time. */
  root?: string;
}

const RETRY_DELAYS_MS = [5_000, 20_000, 60_000];

export class WikiService {
  private sessions = new Map<string, SessionTasks>();
  private queue: Array<{ main: string; branchId: string }> = [];
  private draining = false;
  private aborts = new Map<string, AbortController>();
  private readonly retries: number[];
  constructor(private deps: WikiServiceDeps) {
    this.retries = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  }

  /**
   * GraphRuntime persistence hooks. Never awaited by the caller. The event
   * carries the session's OWNING project wiki root; null means the runtime
   * belongs to a remote project, which keeps no local wiki.
   */
  handleGraphEvent(main: string, event: WikiGraphEvent, wikiRoot?: string | null) {
    try {
      if (wikiRoot === null) return;
      if (wikiRoot) this.sessionOf(main).root = wikiRoot;
      if (event.kind === "opened") this.onOpened(main);
      else if (event.kind === "settled") this.onSettled(main, event.branchId);
      else if (event.kind === "deleted") this.onDeleted(main);
    } catch { /* wiki must never break the runtime */ }
  }

  /** The wiki root bound to this session; the current project only as a fallback. */
  private rootOf(main: string): string | null {
    return this.sessions.get(main)?.root ?? this.deps.wikiRoot();
  }

  /** Deterministic refresh plus re-enqueue of anything not yet covered. */
  private onOpened(main: string) {
    const root = this.rootOf(main);
    if (!root || !existsSync(main)) return;
    let result: ReturnType<typeof refreshSessionWiki> | null = null;
    try { result = refreshSessionWiki(root, main); } catch { /* broken sources keep the last state */ }
    this.emitStatus(main);
    if (!this.deps.settings().enabled || !result) return;
    // Branches without a fresh page include those never summarized at all.
    const sid = result.snap.session.id;
    for (const branchId of Object.keys(result.manifest.sessions[sid]?.sources ?? {}))
      if (result.manifest.pageStatus[`sessions/${sid}/branches/${branchId}.md`] !== "fresh") this.enqueue(main, branchId);
  }
  private onSettled(main: string, branchId: string) {
    if (this.deps.settings().enabled) this.enqueue(main, branchId);
  }
  private onDeleted(main: string) {
    const root = this.rootOf(main);
    if (!root || !existsSync(main)) return;
    // Deleted turns make affected pages invalid; compile treats invalid as a
    // full rebuild. Fresh branches cost nothing (no model call).
    let result: ReturnType<typeof refreshSessionWiki> | null = null;
    try { result = refreshSessionWiki(root, main); } catch { /* broken sources keep the last state */ }
    if (this.deps.settings().enabled && result)
      for (const branchId of Object.keys(result.manifest.sessions[result.snap.session.id]?.sources ?? {}))
        this.enqueue(main, branchId);
    this.emitStatus(main);
  }

  enqueue(main: string, branchId: string) {
    const session = this.sessionOf(main);
    const root = this.rootOf(main);
    if (session.cancelled || !root || !existsSync(main)) return;
    // Bind the owning root at enqueue time: executing later under another
    // project's view must never redirect this session's tasks.
    if (!session.root) session.root = root;
    let task = session.tasks.get(branchId);
    if (!task) {
      task = { branchId, queued: false, running: false, again: false, failures: 0 };
      session.tasks.set(branchId, task);
    }
    if (task.timer) { clearTimeout(task.timer); task.timer = undefined; }
    if (task.running) task.again = true;
    else if (!task.queued) {
      task.queued = true;
      this.queue.push({ main, branchId });
      this.drain();
    }
  }

  private drain() {
    if (this.draining) return;
    this.draining = true;
    const step = async () => {
      const job = this.queue.shift();
      if (!job) { this.draining = false; return; }
      try { await this.runJob(job.main, job.branchId); }
      finally { void step(); }
    };
    // Kick off out of band: runJob's synchronous snapshot read must never
    // sit on the runtime's settle/notify call stack.
    setTimeout(step, 0);
  }

  private async runJob(main: string, branchId: string) {
    const session = this.sessions.get(main);
    const task = session?.tasks.get(branchId);
    // Only the root bound at enqueue time; never the project currently in view.
    const root = session?.root ?? null;
    if (!session || !task || session.cancelled || !root) return;
    task.running = true;
    task.queued = false;
    task.again = false;
    task.error = undefined;
    this.emitStatus(main);
    try {
      if (!existsSync(main)) throw new WikiPublishError("Session file is gone");
      const plan = prepareCompile(root, main, branchId);
      if (plan) {
        const usage = readManifest(root)?.usage;
        const used = (usage?.input ?? 0) + (usage?.output ?? 0);
        const budget = this.deps.settings().budgetTokens;
        if (budget && used >= budget) {
          task.error = `后台预算已用尽（${used}/${budget} tokens）；程序层继续更新，模型摘要暂停`;
          this.deps.notify?.("Wiki 后台预算已用尽：模型摘要暂停，可在设置中调整预算。", "warning");
          return;
        }
        const config = this.deps.settings();
        const fallback = this.deps.defaultModel();
        const model = config.provider && config.modelId
          ? { provider: config.provider, modelId: config.modelId }
          : fallback ? { provider: fallback.provider, modelId: fallback.id } : null;
        if (!model) {
          task.error = "未配置后台摘要模型；程序层继续更新";
          return;
        }
        const abort = new AbortController();
        this.aborts.set(main, abort);
        try {
          const reply = await this.deps.callModel({
            provider: model.provider, modelId: model.modelId,
            systemPrompt: WIKI_SYSTEM_PROMPT, userPrompt: plan.userPrompt, maxTokens: 1600, signal: abort.signal,
          });
          // A late result must never resurrect a cancelled (deleted) session.
          if (session.cancelled || !existsSync(main)) return;
          const published = publishSummary(root, plan, parseModelSummary(reply.text), {
            inputTokens: reply.usage?.inputTokens ?? null,
            outputTokens: reply.usage?.outputTokens ?? null,
            cost: reply.usage?.cost ?? null,
          });
          // Reuse the publish-time snapshot: nothing can change the sources between
          // that synchronous verification and this refresh.
          const refreshed = refreshSessionWiki(root, main, published.snap);
          // A size-capped batch leaves turns uncovered and the page dirty:
          // keep draining the backlog without waiting for a new event.
          if (refreshed.manifest.pageStatus[plan.pageRel] === "dirty") this.enqueue(main, branchId);
        } finally { this.aborts.delete(main); }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof WikiPublishError || error instanceof SyntaxError) {
        // Validation rejections are deterministic for this input: surface and stop.
        task.error = message;
      } else if (session.cancelled) {
        return;
      } else {
        task.failures += 1;
        const delay = this.retries[Math.min(task.failures - 1, this.retries.length - 1)] ?? this.retries.at(-1)!;
        if (task.failures <= this.retries.length) {
          task.error = `${message}；${Math.round(delay / 1000)}s 后重试（第 ${task.failures} 次）`;
          task.timer = setTimeout(() => {
            task.timer = undefined;
            if (!this.sessions.get(main)?.cancelled) this.enqueue(main, branchId);
          }, delay);
        } else task.error = message;
      }
    } finally {
      task.running = false;
      if (task.again && !task.timer && !session.cancelled) this.enqueue(main, branchId);
      this.emitStatus(main);
    }
  }

  /** Manual deterministic refresh; safe regardless of the auto-update setting. */
  refresh(main: string): WikiStatus {
    const root = this.rootOf(main);
    if (root && existsSync(main)) {
      try { refreshSessionWiki(root, main); } catch { /* keep the persisted state */ }
    }
    return this.emitStatus(main);
  }
  /** Manual update: enqueue dirty (or one) branch even when auto-update is off. */
  update(main: string, branchId?: string): WikiStatus {
    const root = this.rootOf(main);
    if (!root || !existsSync(main)) return this.emitStatus(main);
    let result: ReturnType<typeof refreshSessionWiki> | null = null;
    try { result = refreshSessionWiki(root, main); } catch { /* keep the persisted state */ }
    if (result) {
      const sid = result.snap.session.id;
      const sources = result.manifest.sessions[sid]?.sources ?? {};
      const targets = branchId ? [branchId] : Object.keys(sources);
      for (const id of targets) this.enqueue(main, id);
    } else if (branchId) this.enqueue(main, branchId);
    return this.emitStatus(main);
  }
  retry(main: string, branchId: string): WikiStatus {
    const task = this.sessions.get(main)?.tasks.get(branchId);
    if (task) { task.failures = 0; task.error = undefined; }
    this.enqueue(main, branchId);
    return this.emitStatus(main);
  }
  /** Stop all tasks for a session and forbid result publication for it. */
  cancel(main: string) {
    const session = this.sessions.get(main);
    if (!session) return;
    session.cancelled = true;
    for (const task of session.tasks.values()) {
      if (task.timer) clearTimeout(task.timer);
      task.queued = false;
      task.again = false;
    }
    this.queue = this.queue.filter(job => job.main !== main);
    this.aborts.get(main)?.abort(new Error("Session is being deleted"));
    this.aborts.delete(main);
    this.sessions.delete(main);
  }
  /** A deleted session leaves the workspace wiki entirely. */
  forget(main: string) {
    // Capture the owning root before cancel() drops the session record.
    const root = this.rootOf(main);
    this.cancel(main);
    if (!root) return;
    try { removeSessionWiki(root, main); } catch { /* keep the last state */ }
  }
  dispose() {
    for (const main of [...this.sessions.keys()]) this.cancel(main);
  }

  state(main: string): WikiStatus {
    return this.buildStatus(main);
  }
  emitStatus(main: string): WikiStatus {
    const status = this.buildStatus(main);
    try { this.deps.emit(status); } catch { /* listeners must not break tasks */ }
    return status;
  }
  private buildStatus(main: string): WikiStatus {
    const settings = this.deps.settings();
    const root = this.rootOf(main);
    const manifest = root && existsSync(main) ? readManifest(root) : null;
    const session = this.sessions.get(main);
    const entry = manifest && Object.entries(manifest.sessions).find(([, value]) => value.path === main);
    const usage = manifest?.usage ?? { input: 0, output: 0, calls: 0, cost: null };
    const used = usage.input + usage.output;
    const paused = Boolean(settings.budgetTokens && used >= settings.budgetTokens);
    const branches: WikiBranchStatus[] = Object.entries(entry?.[1].sources ?? {}).map(([id, info]) => {
      const rel = `sessions/${entry![0]}/branches/${id}.md`;
      const receipt = manifest?.pages?.[rel];
      const task = session?.tasks.get(id);
      const status: WikiBranchStatus["status"] = task?.running ? "updating"
        : task?.queued || task?.timer ? "queued"
          : task?.error ? "failed"
            : manifest?.pageStatus?.[rel] ?? "dirty";
      return {
        branchId: id, status,
        coveredTurns: receipt?.coveredTurns?.length ?? 0,
        totalTurns: info.turns.length,
        ...(task?.error ? { error: task.error } : {}),
      };
    });
    const model = settings.provider && settings.modelId
      ? { provider: settings.provider, id: settings.modelId }
      : this.deps.defaultModel();
    return {
      sessionPath: main,
      available: Boolean(root) && existsSync(main),
      ...(!root ? { reason: "no-project" } : !existsSync(main) ? { reason: "session-missing" } : {}),
      enabled: Boolean(settings.enabled),
      ...(entry ? { sessionKey: entry[0] } : {}),
      ...(model ? { model } : { model: null }),
      ...(settings.budgetTokens ? { budgetTokens: settings.budgetTokens } : {}),
      ...(paused ? { paused: true } : {}),
      usage, branches,
      updatedAt: new Date().toISOString(),
    };
  }

  private sessionOf(main: string): SessionTasks {
    let session = this.sessions.get(main);
    if (!session || session.cancelled) {
      session = { tasks: new Map(), cancelled: false };
      this.sessions.set(main, session);
    }
    return session;
  }
}
