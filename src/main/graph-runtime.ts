import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Worker as ExportWorker } from "node:worker_threads";
import { PiRuntime } from "./pi-runtime.js";
import { GraphFiles, durableWrite, encodeSession, type BranchRecord, type SessionData } from "./graph-files.js";
import { projectSession } from "../shared/session.js";
import type { AgentControl, RawSessionEntry, RuntimeModel, SessionSnapshot } from "../shared/types.js";

type PromptAt = Extract<AgentControl, { action: "promptAt" }>;
type Worker = { pi: PiRuntime; work?: Promise<void>; snapshot?: SessionSnapshot; before?: Set<string> };
function snapshotParent(id: string, entries: Map<string, RawSessionEntry>): string | null {
  const seen = new Set<string>();
  let entry = entries.get(id);
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id);
    if (entry.type === "message" && (entry.message as { role?: string })?.role === "user") return `turn:${entry.id}`;
    entry = entry.parentId ? entries.get(entry.parentId) : undefined;
  }
  return null;
}

/** One owner per graph; SDK runtimes themselves remain independent. */
export class GraphRuntime extends PiRuntime {
  graph?: GraphFiles;
  private workers = new Map<string, Worker>();
  private admission: Promise<unknown> = Promise.resolve();
  private mainWork?: Promise<void>;
  private accepted = new Map<string, Promise<SessionSnapshot>>();
  private storageError?: string;
  private revision = 0;
  private epoch = randomUUID();
  private stopping = false;
  private lastMain?: SessionSnapshot;
  private rootRunId = "";
  private rootBefore = new Set<string>();
  private rootRequest?: PromptAt;
  private deltaCache = new WeakMap<SessionSnapshot, RawSessionEntry[]>();
  private aggregateCache?: { key: string; entries: RawSessionEntry[]; projection: SessionSnapshot["projection"] };

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const result = this.admission.then(job, job);
    this.admission = result.catch(() => {});
    return result;
  }
  private notify() {
    if (!this.runtime && !this.lastMain) return;
    try { this.emit({ type: "sessions", payload: { current: this.snapshot() } }); } catch {}
  }
  private data(pi: PiRuntime): SessionData {
    const manager = pi.runtime.session.sessionManager;
    return structuredClone({ header: manager.getHeader(), entries: manager.getEntries() });
  }
  override open(path: string): Promise<SessionSnapshot> {
    return this.exclusive(() => this.openInternal(path));
  }
  private async openInternal(path: string) {
    if (this.graph?.main === path && this.runtime) return this.snapshot();
    await this.closeInternal();
    this.stopping = false;
    const graph = new GraphFiles(path);
    graph.acquire();
    try {
      graph.load();
      this.storageError = graph.recoveryMessages.join("; ") || undefined;
      const pi = await this.pi();
      const data = graph.readMain(entries => {
        const manager = pi.SessionManager.inMemory(this.cwd, undefined, entries);
        return { header: manager.getHeader(), entries: manager.getEntries() };
      });
      const leaf = graph.hasSavedLeaf && (graph.leafId === null || data.entries.some(e => e.id === graph.leafId))
        ? graph.leafId : data.entries.at(-1)?.id ?? null;
      this.graph = graph;
      await super.openAt(path, leaf);
      for (const record of graph.records.values()) {
        try {
          const data = graph.readBranch(record);
          this.workers.set(record.id, { pi: this.child(record), snapshot: this.fileSnapshot(record, data) });
        } catch (error) {
          record.error = String(error);
        }
      }
      this.storageError = graph.recoveryMessages.join("; ") || undefined;
      return this.snapshot();
    } catch (error) { graph.release(); this.graph = undefined; throw error; }
  }
  override create(): Promise<SessionSnapshot> {
    return this.exclusive(async () => {
      await this.closeInternal();
      this.stopping = false;
      const pi = await this.pi();
      const manager = pi.SessionManager.create(this.cwd, this.dir);
      const path = manager.getSessionFile();
      // Open an explicitly persisted header: SDK otherwise defers the first user input.
      durableWrite(path, encodeSession({ header: manager.getHeader(), entries: [] }));
      return this.openInternal(path);
    });
  }
  private child(record: BranchRecord) {
    const child = new PiRuntime(this.cwd, this.dir, event => {
      if (this.stopping) return;
      const value = event as { type: string; payload: { type?: string } };
      try { this.emit(event); } catch {}
      if (["message_end", "agent_settled", "entry_appended", "compaction_end"].includes(value.payload?.type ?? "")) {
        const worker = this.workers.get(record.id);
        if (worker?.pi.runtime) {
          try { worker.snapshot = worker.pi.snapshot(); this.notify(); } catch {}
        }
      }
    }, this.openExternal);
    child.mod = this.mod;
    child.factory = this.factory.bind(this);
    child.modelBroker = this.modelBroker;
    child.brokerProviders = new Set(this.brokerProviders);
    child.brokerModels = this.brokerModels;
    child.eventScope = { graphId: this.graph!.main, branchId: record.id, runId: record.runId };
    return child;
  }
  private fileSnapshot(record: BranchRecord, data: SessionData): SessionSnapshot {
    return { session: { id: String(data.header.id), path: this.graph!.path(record.id), cwd: String(data.header.cwd),
      created: String(data.header.timestamp), modified: String(data.header.timestamp), messageCount: data.entries.length, firstMessage: record.request.text },
      entries: data.entries, projection: projectSession(data.entries, data.entries.at(-1)?.id ?? null),
      runtime: { ...super.state(), isStreaming: false, isCompacting: false, isRetrying: false } };
  }
  override snapshot(): SessionSnapshot {
    const main = this.runtime ? super.snapshot() : this.lastMain;
    if (!main || !this.graph) return main ?? super.snapshot();
    this.lastMain = main;
    const entries = new Map(main.entries.map(e => [e.id, e]));
    const owners = new Map<string, string>();
    const runs: NonNullable<SessionSnapshot["graph"]>["runs"] = [];
    const mainNode = main.projection.nodes.find(n => n.id === main.projection.activeNodeId);
    const mainPending = Boolean(this.mainWork && (!mainNode || this.rootBefore.has(mainNode.userEntryId)));
    runs.push({ branchId: "main", runId: this.rootRunId, requestId: this.rootRequest?.requestId, nodeId: mainPending ? null : main.projection.activeNodeId,
      ...(mainPending && this.rootRequest ? { pending: { text: this.rootRequest.text, parentNodeId: this.rootRequest.nodeId, images: this.rootRequest.images } } : {}),
      status: this.mainWork || main.runtime.isStreaming ? "running" : "idle", runtime: main.runtime });
    const active = new Set<string>();
    if (this.mainWork || main.runtime.isStreaming) {
      const current = main.projection.nodes.find(n => n.id === main.projection.activeNodeId);
      if (current && !this.rootBefore.has(current.userEntryId)) active.add(current.id);
    }
    for (const record of this.graph.records.values()) {
      const worker = this.workers.get(record.id);
      const snap = worker?.snapshot;
      if (!snap) continue;
      let delta: RawSessionEntry[];
      try {
        delta = this.deltaCache.get(snap) ?? this.graph.delta(record, { header: {}, entries: snap.entries });
        this.deltaCache.set(snap, delta);
      }
      catch (error) {
        runs.push({ branchId: record.id, runId: record.runId, nodeId: null, status: "interrupted", error: String(error) });
        continue;
      }
      for (const entry of delta) {
        owners.set(entry.id, record.id);
        if (!entries.has(entry.id)) entries.set(entry.id, entry);
      }
      const node = snap.projection.activeNodeId;
      const ownNode = node && !Object.hasOwn(record.inherited, node.slice(5))
        && (!worker.work || !worker.before?.has(node.slice(5)));
      const nodeId = ownNode ? `turn:${this.graph.canonical(record, node!.slice(5))}` : null;
      const running = Boolean(worker?.work);
      if (running && nodeId) active.add(nodeId);
      runs.push({ branchId: record.id, runId: record.runId, requestId: record.requestId, nodeId,
        ...(!nodeId && running ? { pending: { text: record.request.text, parentNodeId: record.request.nodeId ?? (record.forkEntryId ? snapshotParent(record.forkEntryId, entries) : null), images: record.request.images } } : {}),
        status: running ? "running" : record.status === "interrupted" ? "interrupted" : "idle",
        error: record.error, runtime: snap.runtime });
    }
    const key = `${main.session.path}:${main.entries.length}:${main.projection.leafId}:` + [...this.workers].map(([id, w]) => `${id}:${w.snapshot?.entries.length ?? 0}`).join(";");
    if (this.aggregateCache?.key !== key) {
      const values = [...entries.values()];
      this.aggregateCache = { key, entries: values, projection: projectSession(values, main.projection.leafId) };
      const sourceNodes = new Map<string, SessionSnapshot["projection"]["nodes"][number]>();
      for (const record of this.graph.records.values())
        for (const node of this.workers.get(record.id)?.snapshot?.projection.nodes ?? [])
          if (owners.get(this.graph.canonical(record, node.userEntryId)) === record.id)
            sourceNodes.set(this.graph.canonical(record, node.userEntryId), node);
      this.aggregateCache.projection = { ...this.aggregateCache.projection, nodes: this.aggregateCache.projection.nodes.map(node => {
        const branchId = owners.get(node.userEntryId) ?? "main";
        const record = this.graph!.records.get(branchId);
        const sourceNode = record && sourceNodes.get(node.userEntryId);
        // Setup records for a new child can hang off an existing prompt. They must
        // not move that ancestor's fork point into the child's private session.
        const rawEntryIds = sourceNode && record ? sourceNode.rawEntryIds.map(id => this.graph!.canonical(record, id))
          : node.rawEntryIds.filter(id => !owners.has(id));
        const owned = rawEntryIds.map(id => entries.get(id)).filter((e): e is RawSessionEntry => !!e);
        const calls = new Set<string>(), results = new Set<string>();
        let hasAssistant = false;
        for (const entry of owned) {
          const message = entry.message as { role?: string; toolCallId?: string; content?: Array<{ type?: string; id?: string }> } | undefined;
          if (message?.role === "assistant") {
            hasAssistant = true;
            if (Array.isArray(message.content)) for (const item of message.content) if (item.type === "toolCall" && item.id) calls.add(item.id);
          }
          if (message?.role === "toolResult" && message.toolCallId) results.add(message.toolCallId);
        }
        return { ...node, ...(sourceNode ? { footer: sourceNode.footer, preview: sourceNode.preview } : {}), rawEntryIds,
          leafEntryId: rawEntryIds.at(-1) ?? node.userEntryId, branchId, running: false,
          forkable: hasAssistant && [...calls].every(id => results.has(id)),
        };
      }) };
    }
    const projection = { ...this.aggregateCache.projection, nodes: this.aggregateCache.projection.nodes.map(node =>
      active.has(node.id) ? { ...node, running: true, forkable: false } : node) };
    return { ...main, entries: this.aggregateCache.entries, projection,
      graph: { id: this.graph.main, epoch: this.epoch, revision: ++this.revision, runs, storageError: this.storageError,
        recoveredInputs: this.graph.recoveredInputs } };
  }
  override control(input: AgentControl): Promise<unknown> {
    if (input.action === "newSession") return this.create();
    if (this.stopping && this.runtime && !["abort", "branchAbort"].includes(input.action))
      return Promise.reject(new Error("Session is closing"));
    if (input.action === "branchAbort") {
      if (input.branchId === "main") {
        if (input.runId !== this.rootRunId) return Promise.reject(new Error("This run has already ended"));
        return super.control({ action: "abort" });
      }
      const record = this.graph?.records.get(input.branchId);
      if (!record || record.runId !== input.runId) return Promise.reject(new Error("Unknown or stale run"));
      return this.workers.get(record.id)?.pi.control({ action: "abort" }).then(() => this.snapshot()) ?? Promise.resolve(this.snapshot());
    }
    if (input.action === "promptAt") return this.acceptAt(input);
    if (input.action === "exportJsonl" || input.action === "exportHtml")
      return this.exclusive(async () => ({ work: this.exportTree(input.action === "exportHtml" ? input : { action: "exportJsonl" }) })).then(({ work }) => work);
    if (["abort", "abortBash", "abortCompaction", "abortRetry", "getModels", "getProviders", "commands"].includes(input.action))
      return super.control(input);
    // Prompt lifetime stays outside admission, so creating a sibling never waits for it.
    if (input.action === "prompt") return this.exclusive(async () => {
      if (this.mainWork) throw new Error("Main session is already running");
      const work = super.control(input);
      this.mainWork = work.then(() => {}, () => {});
      void work.finally(() => { this.mainWork = undefined; }).catch(() => {});
      return { work };
    }).then(({ work }) => work);
    return this.exclusive(async () => {
      const result = await super.control(input);
      if ((input.action === "fork" || input.action === "clone") && this.runtime)
        return this.openInternal(this.runtime.session.sessionFile);
      if (this.graph && this.runtime) this.graph.saveLeaf(this.runtime.session.sessionManager.getLeafId());
      return result;
    });
  }
  private acceptAt(input: PromptAt): Promise<SessionSnapshot> {
    try {
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.requestId)) throw new Error("Invalid request ID");
      const graph = this.graph;
      if (this.stopping || !graph) throw new Error("Open a writable graph first");
      const file = join(graph.dir, `request-${input.requestId}.json`);
      const pending = this.accepted.get(file);
      if (pending) return pending;
      if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, "utf8"));
        if (saved.state !== "queued") return Promise.resolve(this.snapshot());
        // A retry must preserve the input already acknowledged on disk.
        input = { ...saved, action: "promptAt" };
      } else {
        durableWrite(file, JSON.stringify({ ...input, state: "queued" }) + "\n");
      }
      const request = this.exclusive(async () => {
        if (this.graph !== graph) throw new Error("Session changed; submitted input has been retained");
        return this.startAt(input);
      });
      this.accepted.set(file, request);
      void request.finally(() => this.accepted.delete(file)).catch(() => {});
      return request;
    } catch (error) { return Promise.reject(error); }
  }
  private async startAt(input: PromptAt) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.requestId)) throw new Error("Invalid request ID");
    if (this.stopping || !this.graph || !this.runtime) throw new Error("Open a writable graph first");
    const graph = this.graph;
    const duplicate = [...graph.records.values()].find(r => r.requestId === input.requestId);
    const intentFile = join(graph.dir, `request-${input.requestId}.json`);
    if (duplicate) return this.snapshot();
    const snapshot = this.snapshot();
    const node = input.nodeId ? snapshot.projection.nodes.find(n => n.id === input.nodeId) : undefined;
    if (input.nodeId && (!node || !node.forkable)) throw new Error("Choose a completed node to branch from");
    const limit = Math.min(64, Math.max(1, Number.parseInt(process.env.PIX_MAX_PARALLEL_RUNS ?? "8", 10) || 8));
    if ([...this.workers.values()].filter(w => w.work).length + (this.mainWork ? 1 : 0) >= limit)
      throw new Error(`${limit} branches are running. Stop one before starting another.`);
    const root = super.snapshot();
    const onMain = !this.mainWork && !root.runtime.isStreaming && (input.nodeId === root.projection.activeNodeId || (!input.nodeId && !root.entries.some(e => e.type === "message")));
    if (onMain) {
      durableWrite(intentFile, JSON.stringify({ ...input, state: "prepared" }) + "\n");
      this.rootRunId = randomUUID();
      this.rootRequest = input;
      this.rootBefore = new Set(root.entries.map(e => e.id));
      this.eventScope = { graphId: graph.main, branchId: "main", runId: this.rootRunId };
      await this.configurePrompt(this, input);
      const work = super.control({ action: "prompt", text: input.text, images: input.images });
      this.mainWork = work.then(() => {}, () => {});
      void work.then(() => {
        graph.sealMain(this.data(this));
        durableWrite(intentFile, JSON.stringify({ ...input, state: "settled" }) + "\n");
      },
        error => { this.storageError = String(error); }).finally(() => {
        this.mainWork = undefined;
        if (this.runtime) graph.saveLeaf(this.runtime.session.sessionManager.getLeafId());
        this.notify();
      }).catch(error => { this.storageError = String(error); });
      return this.snapshot();
    }
    const parentId = node?.branchId ?? "main";
    const parent = parentId === "main" ? root : this.workers.get(parentId)?.snapshot;
    if (!parent) throw new Error("Branch source is unavailable");
    const parentRecord = graph.records.get(parentId);
    if (parentRecord && !parentRecord.error && !this.workers.get(parentId)?.work && parent.projection.activeNodeId
      && input.nodeId === `turn:${graph.canonical(parentRecord, parent.projection.activeNodeId.slice(5))}`) {
      parentRecord.requestId = input.requestId; parentRecord.request = input; parentRecord.runId = randomUUID();
      return this.launchBranch(parentRecord, input, node?.footer?.model ?? parent.runtime.model, node?.footer?.thinkingLevel ?? parent.runtime.thinkingLevel);
    }
    const localLeaf = node ? parent.entries.find(e => (parentRecord ? graph.canonical(parentRecord, e.id) : e.id) === node.leafEntryId)?.id : null;
    if (node && !localLeaf) throw new Error("Branch point was not found in source session");
    const pi = await this.pi();
    const sourceData: SessionData = parentId === "main" ? this.data(this) : {
      header: { type: "session", version: 3, id: parent.session.id, cwd: this.cwd, timestamp: parent.session.created }, entries: parent.entries,
    };
    const manager = pi.SessionManager.inMemory(this.cwd, undefined, structuredClone([sourceData.header, ...sourceData.entries]));
    if (localLeaf) manager.createBranchedSession(localLeaf);
    else manager.newSession({ parentSession: graph.main });
    const data: SessionData = { header: { ...manager.getHeader(), parentSession: parent.session.path }, entries: manager.getEntries() };
    const inherited: Record<string, string> = {};
    const sourceIds = new Set(parent.entries.map(e => e.id));
    for (const e of data.entries) inherited[e.id] = sourceIds.has(e.id)
      ? parentRecord ? graph.canonical(parentRecord, e.id) : e.id
      : node?.leafEntryId ?? "";
    const record: BranchRecord = { id: randomUUID(), parentId, forkEntryId: node?.leafEntryId ?? "", requestId: input.requestId,
      request: input, inherited, header: data.header, baseline: structuredClone(data.entries), status: "prepared", runId: randomUUID() };
    graph.create(record, data);
    const child = this.child(record);
    const worker: Worker = { pi: child, snapshot: this.fileSnapshot(record, data) };
    this.workers.set(record.id, worker);
    return this.launchBranch(record, input, node?.footer?.model ?? parent.runtime.model, node?.footer?.thinkingLevel ?? parent.runtime.thinkingLevel);
  }
  private async launchBranch(record: BranchRecord, input: PromptAt, model: RuntimeModel | null | undefined, thinkingLevel: string) {
    const graph = this.graph!;
    const worker = this.workers.get(record.id)!;
    const child = worker.pi;
    record.status = "prepared";
    graph.save(record);
    const intentFile = join(graph.dir, `request-${input.requestId}.json`);
    durableWrite(intentFile, JSON.stringify({ ...input, branchId: record.id, runId: record.runId, state: "prepared" }) + "\n");
    try {
      child.eventScope = { graphId: graph.main, branchId: record.id, runId: record.runId };
      await child.open(graph.path(record.id));
      await this.configurePrompt(child, { ...input,
        provider: input.provider ?? model?.provider,
        modelId: input.modelId ?? model?.id,
        thinkingLevel: input.thinkingLevel ?? thinkingLevel,
      });
      worker.before = new Set(child.runtime.session.sessionManager.getEntries().map((e: RawSessionEntry) => e.id));
      record.status = "running"; graph.save(record);
      worker.work = this.executeBranch(worker, record);
      void worker.work.catch(error => { this.storageError = String(error); this.notify(); });
      return this.snapshot();
    } catch (error) {
      try { await child.close(); } catch {}
      record.status = "interrupted"; record.error = String(error); graph.save(record);
      throw error;
    }
  }
  private async configurePrompt(pi: PiRuntime, input: PromptAt) {
    if (input.provider && input.modelId) await PiRuntime.prototype.control.call(pi, { action: "setModel", provider: input.provider, modelId: input.modelId });
    if (input.thinkingLevel) await PiRuntime.prototype.control.call(pi, { action: "setThinking", level: input.thinkingLevel });
  }
  private async executeBranch(worker: Worker, record: BranchRecord) {
    const graph = this.graph!;
    try {
      await worker.pi.control({ action: "prompt", text: record.request.text, images: record.request.images });
      await worker.pi.waitForWrites();
      const manager = worker.pi.runtime.session.sessionManager;
      graph.seal(record, this.data(worker.pi));
      worker.snapshot = worker.pi.snapshot();
      await worker.pi.close();
      // Shutdown extensions can append records; seal the final on-disk state.
      const data = graph.seal(record, structuredClone({ header: manager.getHeader(), entries: manager.getEntries() }));
      worker.snapshot = this.fileSnapshot(record, data);
      record.status = "idle";
      durableWrite(join(graph.dir, `request-${record.requestId}.json`), JSON.stringify({ ...record.request, requestId: record.requestId,
        branchId: record.id, runId: record.runId, state: "settled" }) + "\n");
    } catch (error) {
      record.status = "interrupted"; record.error = String(error);
      try { worker.snapshot = worker.pi.snapshot(); await worker.pi.close(); } catch {}
    } finally {
      worker.work = undefined;
      graph.save(record);
      this.notify();
    }
  }
  private exportTree(input: Extract<AgentControl, { action: "exportHtml" }> | { action: "exportJsonl" }) {
    const graph = this.graph;
    if (!graph || !this.runtime) throw new Error("Open a session before exporting");
    if (graph.recoveryMessages.length || [...graph.records.values()].some(r => r.error))
      throw new Error("Some source data needs recovery; export cancelled to avoid omitting data. Original files are retained.");
    // Capture completed SDK entries in one synchronous turn. Streaming partial
    // tokens are not session records yet. No runtime is closed or source rewritten.
    const branches = [...graph.records.values()].map(record => {
      const worker = this.workers.get(record.id);
      if (!worker?.snapshot) throw new Error(`Branch source unavailable: ${record.id}`);
      return { record, data: worker.pi.runtime ? this.data(worker.pi) : {
        header: record.header, entries: worker.snapshot.entries,
      } };
    });
    const outputPath = input.action === "exportHtml" && input.outputPath
      ? resolve(this.cwd ?? ".", input.outputPath) : join(this.cwd ?? resolve(graph.main, ".."), `pix-tree-${randomUUID()}.${input.action === "exportHtml" ? "html" : "jsonl"}`);
    if (existsSync(outputPath)) throw new Error("Export destination already exists; choose a new file");
    return new Promise<{ path: string }>((resolve, reject) => {
      const worker = new ExportWorker(new URL("./graph-export-worker.js", import.meta.url), {
        workerData: { main: graph.main, data: this.data(this), branches,
          leafId: this.runtime.session.sessionManager.getLeafId(), outputPath, html: input.action === "exportHtml" },
      });
      let delivered = false;
      worker.once("message", message => {
        delivered = true;
        if (message.error) reject(new Error(message.error)); else resolve(message.result);
      });
      worker.once("error", reject);
      worker.once("exit", code => { if (!delivered) reject(new Error(`Export worker exited (${code})`)); });
    });
  }
  override close(): Promise<void> {
    this.stopping = true;
    return this.exclusive(() => this.closeInternal());
  }
  private async closeInternal() {
    this.stopping = true;
    await Promise.allSettled([...this.workers.values()].map(async worker => {
      await worker.pi.close();
      await worker.work;
    }));
    if (this.graph && this.runtime) this.graph.saveLeaf(this.runtime.session.sessionManager.getLeafId());
    await super.close();
    await this.mainWork;
    this.mainWork = undefined;
    this.graph?.release();
    this.graph = undefined; this.workers.clear(); this.lastMain = undefined; this.aggregateCache = undefined;
    this.rootRunId = ""; this.rootRequest = undefined; this.rootBefore.clear(); this.eventScope = undefined;
  }
  override dispose() { void this.close().catch(() => {}); }
  override setProject(cwd: string | null, dir: string | null) {
    this.stopping = true;
    void this.exclusive(async () => {
      await this.closeInternal();
      this.cwd = cwd; this.dir = dir; this.modelServices = undefined;
      this.stopping = false;
    }).catch(error => { this.storageError = String(error); });
  }
}
