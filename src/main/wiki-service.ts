// Wiki lifecycle: queueing, deduplication, budgets, retries and cancellation
// for background branch summaries. The deterministic layer (wiki-compiler) is
// synchronous; the only async gap is the model call, and every publish is
// re-verified against disk before anything is written.
import { existsSync } from "node:fs";
import { type WikiGraphEvent, type WikiAppSettings, type WikiStatus, type WikiBranchStatus } from "../shared/wiki.js";
import {
  WikiPublishError, parseModelSummary, prepareCompile, publishSummary, readManifest, refreshWiki, wikiDir,
  WIKI_SYSTEM_PROMPT,
} from "./wiki-compiler.js";

export interface WikiModelReply { text: string; usage: { inputTokens: number | null; outputTokens: number | null; cost: number | null } | null }
export type WikiModelCaller = (request: {
  provider: string; modelId: string; systemPrompt: string; userPrompt: string; maxTokens: number; signal: AbortSignal;
}) => Promise<WikiModelReply>;

export interface WikiServiceDeps {
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
interface SessionTasks { tasks: Map<string, BranchTask>; cancelled: boolean }

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

  /** GraphRuntime persistence hooks. Never awaited by the caller. */
  handleGraphEvent(main: string, event: WikiGraphEvent) {
    try {
      if (event.kind === "opened") this.onOpened(main);
      else if (event.kind === "settled") this.onSettled(main, event.branchId);
      else if (event.kind === "deleted") this.onDeleted(main);
    } catch { /* wiki must never break the runtime */ }
  }

  /** Deterministic refresh plus re-enqueue of anything not yet covered. */
  private onOpened(main: string) {
    if (!existsSync(main)) return;
    let result: ReturnType<typeof refreshWiki> | null = null;
    try { result = refreshWiki(wikiDir(main)); } catch { /* broken sources keep the last state */ }
    this.emitStatus(main);
    if (!this.deps.settings().enabled || !result) return;
    // Branches without a fresh page include those never summarized at all.
    const covered = new Set(Object.entries(result.manifest.pageStatus)
      .filter(([, state]) => state === "fresh").map(([rel]) => rel));
    for (const id of Object.keys(result.manifest.sources))
      if (!covered.has(`branches/${id}.md`)) this.enqueue(main, id);
  }
  private onSettled(main: string, branchId: string) {
    if (this.deps.settings().enabled) this.enqueue(main, branchId);
  }
  private onDeleted(main: string) {
    // Deleted turns make affected pages invalid; compile treats invalid as a
    // full rebuild. Fresh branches cost nothing (no model call).
    if (!existsSync(main)) return;
    try {
      const result = refreshWiki(wikiDir(main));
      if (this.deps.settings().enabled)
        for (const id of Object.keys(result.manifest.sources)) this.enqueue(main, id);
    } catch { /* broken sources keep the last state */ }
    this.emitStatus(main);
  }

  enqueue(main: string, branchId: string) {
    const session = this.sessionOf(main);
    if (session.cancelled || !existsSync(main)) return;
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
    if (!session || !task || session.cancelled) return;
    task.running = true;
    task.queued = false;
    task.again = false;
    task.error = undefined;
    this.emitStatus(main);
    const wiki = wikiDir(main);
    try {
      if (!existsSync(main)) throw new WikiPublishError("Session file is gone");
      const plan = prepareCompile(wiki, branchId);
      if (plan) {
        const usage = readManifest(wiki)?.usage;
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
          publishSummary(wiki, plan, parseModelSummary(reply.text), {
            inputTokens: reply.usage?.inputTokens ?? null,
            outputTokens: reply.usage?.outputTokens ?? null,
            cost: reply.usage?.cost ?? null,
          });
        } finally { this.aborts.delete(main); }
        refreshWiki(wiki);
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
    try { refreshWiki(wikiDir(main)); } catch { /* keep the persisted state */ }
    return this.emitStatus(main);
  }
  /** Manual update: enqueue dirty (or one) branch even when auto-update is off. */
  update(main: string, branchId?: string): WikiStatus {
    if (!existsSync(main)) return this.emitStatus(main);
    let result: ReturnType<typeof refreshWiki> | null = null;
    try { result = refreshWiki(wikiDir(main)); } catch { /* keep the persisted state */ }
    if (result) {
      const targets = branchId ? [branchId] : Object.keys(result.manifest.sources);
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
    const manifest = existsSync(main) ? readManifest(wikiDir(main)) : null;
    const session = this.sessions.get(main);
    const usage = manifest?.usage ?? { input: 0, output: 0, calls: 0, cost: null };
    const used = usage.input + usage.output;
    const paused = Boolean(settings.budgetTokens && used >= settings.budgetTokens);
    const branches: WikiBranchStatus[] = Object.entries(manifest?.sources ?? {}).map(([id, info]) => {
      const rel = `branches/${id}.md`;
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
      available: existsSync(main),
      ...(!existsSync(main) ? { reason: "session-missing" } : {}),
      enabled: Boolean(settings.enabled),
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
