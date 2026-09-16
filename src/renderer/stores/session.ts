import { defineStore } from "pinia";
import { markRaw } from "vue";
import type {
  AgentActivity,
  BranchMessage,
  ProjectGroup,
  ProjectInfo,
  RuntimeCommand,
  RuntimeModel,
  PromptImage,
  SessionSnapshot,
  SessionSummary,
  SettingsBundle,
} from "../../shared/types";
import { projectId } from "../../shared/types";
import { reduceAgentActivity } from "../../shared/agent-stream";
import { entryAnchorForNode, isSessionRunning } from "../../shared/session";
import { desktop } from "../api";
import { i18n } from "../i18n";
import { track, trackEvent } from "./history";
import { useLayoutStore } from "./layout";
import { useWorkspaceStore } from "./workspace";
import { createBranchMessageCache, reuseGraphProjection } from "../lib/session-view";

// Display name for a session row, falling back to the raw path when the
// session has never been named or prompted.
function displayName(session: SessionSummary): string {
  return session.name || session.firstMessage || session.id;
}
const TRUNCATE = 24;
function truncate(text: string): string {
  return text.length > TRUNCATE ? `${text.slice(0, TRUNCATE)}…` : text;
}

const messageCaches = new WeakMap<object, ReturnType<typeof createBranchMessageCache>>();

// Per-node lookups shared by the focus getters and per-panel bindings: the
// primary chat column resolves the focused node, pinned columns their own id.
function focusId(session: { focusedNode: string | null; current?: SessionSnapshot }) {
  return session.focusedNode ?? session.current?.projection.activeNodeId ?? null;
}
function runForId(current: SessionSnapshot | undefined, id: string | null) {
  return current?.graph?.runs.find(run => run.nodeId === id || `pending:${run.runId}` === id);
}
function activityForId(
  session: { current?: SessionSnapshot; activity?: AgentActivity; branchActivities: Record<string, { runId: string; activity?: AgentActivity }> },
  id: string | null,
): AgentActivity | undefined {
  if (!session.current?.graph) return session.activity;
  const run = runForId(session.current, id);
  const value = run && session.branchActivities[run.branchId];
  return value && value.runId === run?.runId && run.status === "running" ? value.activity : undefined;
}
function nodeForId(current: SessionSnapshot | undefined, id: string | null) {
  return current?.projection.nodes.find(node => node.id === id);
}

interface PendingPrompt {
  message: BranchMessage;
  knownEntryIds: string[];
  targetNodeId: string | null;
  model?: RuntimeModel | null;
  thinkingLevel?: string;
}

export const useSessionStore = defineStore("session", {
  state: () => ({
    loading: true,
    viewRequest: 0,
    sessions: [] as SessionSummary[],
    projects: [] as ProjectGroup[],
    activeProjectId: "",
    current: undefined as SessionSnapshot | undefined,
    focusedNode: null as string | null,
    // Card a plain graph click highlighted: presentation only, but it is the
    // node commands act on. The primary chat column follows focusedNode.
    highlightedNode: null as string | null,
    // Last explicit pick, used when a draft has no parent thinking setting.
    userThinking: undefined as string | undefined,
    query: "",
    // Archived projects and sessions rejoin the lists while this is on.
    showArchived: false,
    // Library marks are display metadata: adopted from decorated project
    // payloads and applied when the lists are read, so surfaces that carry no
    // marks (remote replies, raw runtime snapshots) can never erase them.
    marks: { pinned: [] as string[], archivedSessions: [] as string[] },
    commands: [] as RuntimeCommand[],
    commandRequest: 0,
    models: [] as RuntimeModel[],
    activity: undefined as AgentActivity | undefined,
    branchActivities: {} as Record<string, { runId: string; activity?: AgentActivity }>,
    pendingPrompt: undefined as PendingPrompt | undefined,
    deletingNode: false,
  }),
  getters: {
    deleteBlockedReason(state): string | undefined {
      const current = state.current;
      if (!current?.graph || !current.runtime.available) return "graph.blockedReadonly";
      if (state.deletingNode) return "graph.deletingNode";
      if (state.pendingPrompt || current.graph.runs.some(run => run.status === "running")
        || current.runtime.isStreaming || current.runtime.isCompacting || current.runtime.isRetrying
        || current.runtime.pendingMessageCount) return "graph.deleteBlockedRunning";
      return undefined;
    },
    selectedRun(state) {
      return runForId(state.current, focusId(state));
    },
    selectedActivity(state): AgentActivity | undefined {
      return activityForId(state, focusId(state));
    },
    filteredProjects(state) {
      const query = state.query.trim().toLowerCase();
      const pinned = new Set(state.marks.pinned),
        archived = new Set(state.marks.archivedSessions);
      const marked = (sessions: SessionSummary[]) =>
        sessions.map((session) => ({
          ...session,
          pinned: pinned.has(session.path) || undefined,
          archived: archived.has(session.path) || undefined,
        }));
      // Pinned sessions top their project group; the sort is stable, so
      // recency order survives inside each rank.
      const ranked = (sessions: SessionSummary[]) =>
        [...sessions].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
      return state.projects
        .map((record) => {
          const projectMatch = !query || `${record.project.name} ${record.project.path} ${
            record.project.remote?.kind === "ssh"
              ? record.project.remote.host
              : record.project.remote?.distro ?? ""
          }`.toLowerCase().includes(query);
          const sessions = marked(projectMatch
            ? record.sessions
            : record.sessions.filter((session) =>
                `${session.name ?? ""} ${session.firstMessage} ${session.id}`
                  .toLowerCase()
                  .includes(query),
              ));
          return {
            ...record,
            sessions: ranked(sessions.filter((session) => state.showArchived || !session.archived)),
          };
        })
        .filter((record) =>
          (state.showArchived || !record.archived) &&
          (!query || record.sessions.length || record.project.name.toLowerCase().includes(query)));
    },
    selectedNode(state) {
      return nodeForId(state.current, state.highlightedNode ?? focusId(state));
    },
  },
  actions: {
    runFor(id: string | null) {
      return runForId(this.current, id);
    },
    activityFor(id: string | null): AgentActivity | undefined {
      return activityForId(this, id);
    },
    nodeFor(id: string | null) {
      return nodeForId(this.current, id);
    },
    adoptMarks(projects: ProjectGroup[]) {
      const pinned: string[] = [], archivedSessions: string[] = [];
      for (const record of projects)
        for (const session of record.sessions) {
          if (session.pinned) pinned.push(session.path);
          if (session.archived) archivedSessions.push(session.path);
        }
      this.marks = { pinned, archivedSessions };
    },
    hydrate(
      project: ProjectInfo | null,
      sessions: SessionSummary[],
      projects: ProjectGroup[],
      current?: SessionSnapshot,
      request?: number,
    ) {
      request ??= ++this.viewRequest;
      if (request !== this.viewRequest) return;
      this.adoptMarks(projects);
      this.projects = projects;
      this.activeProjectId = project ? projectId(project) : "";
      this.sessions = sessions;
      this.focusedNode = current?.projection.activeNodeId ?? null;
      this.highlightedNode = null;
      this.activity = undefined;
      this.branchActivities = {};
      this.pendingPrompt = undefined;
      this.current = undefined;
      this.commands = [];
      this.commandRequest++;
      this.syncProject();
      if (current) this.applySnapshot(current);
    },
    syncProject() {
      const record = this.projects.find((item) => item.id === this.activeProjectId);
      if (record) {
        record.sessions = this.sessions;
        if (!record.project.remote) record.connected = true;
      }
    },
    disconnected(id: string) {
      const record = this.projects.find((item) => item.id === id);
      if (record) {
        record.connected = false;
        record.sessions = record.sessions.map(row => ({ ...row, running: undefined }));
      }
      if (this.activeProjectId !== id) return;
      if (record) this.sessions = record.sessions;
      this.activity = undefined;
      this.branchActivities = {};
      if (this.current) this.current.runtime = {
        ...this.current.runtime, available: false, isStreaming: false,
        isCompacting: false, isRetrying: false,
      };
    },
    applySnapshot(snapshot: SessionSnapshot) {
      const previousProjection = this.current?.projection;
      const previousGraph = this.current?.graph;
      if (previousGraph && snapshot.graph && previousGraph.id === snapshot.graph.id && previousGraph.epoch === snapshot.graph.epoch && previousGraph.revision > snapshot.graph.revision) return;
      const graphChanged = this.current?.session.path !== snapshot.session.path;
      if (!graphChanged && this.focusedNode && previousProjection?.nodes.some(node => node.id === this.focusedNode)
        && !snapshot.projection.nodes.some(node => node.id === this.focusedNode)) {
        const previous = new Map(previousProjection.nodes.map(node => [node.id, node]));
        const retained = new Set(snapshot.projection.nodes.map(node => node.id));
        let next: string | null = this.focusedNode;
        while (next && !retained.has(next)) next = previous.get(next)?.parentId ?? null;
        this.focusedNode = next ?? snapshot.projection.nodes[0]?.id ?? null;
      }
      if (graphChanged || previousGraph?.epoch !== snapshot.graph?.epoch) {
        this.branchActivities = {};
        messageCaches.delete(this);
      } else if (previousProjection) reuseGraphProjection(previousProjection, snapshot.projection);
      const pending = this.pendingPrompt;
      if (this.current?.session.path !== snapshot.session.path) this.userThinking = undefined;
      // Session records/projections are immutable snapshots, replaced together.
      // Deep proxies on every historical entry make large-tree navigation costly.
      snapshot.entries = markRaw(snapshot.entries);
      snapshot.projection = markRaw(snapshot.projection);
      this.current = snapshot;
      if (snapshot.session.path)
        this.sessions = [
          { ...snapshot.session, running: isSessionRunning(snapshot) || undefined },
          ...this.sessions.filter((item) => item.path !== snapshot.session.path),
        ];
      this.syncProject();
      if (pending && snapshot.projection.messages.some((message) =>
        message.role === "user" &&
        message.text === pending.message.text &&
        !pending.knownEntryIds.includes(message.entryId)
      )) this.pendingPrompt = undefined;
      if (snapshot.graph) {
        const run = snapshot.graph.runs.find(r => this.focusedNode === `pending:${r.runId}`);
        if (run?.nodeId) this.focusedNode = run.nodeId;
        else if (run && run.status !== "running")
          this.focusedNode = previousGraph?.runs.find(r => r.runId === run.runId)?.pending?.parentNodeId
            ?? snapshot.projection.activeNodeId;
      } else if (this.activity) this.focusedNode = snapshot.projection.activeNodeId;
      if (!snapshot.runtime.isStreaming && this.activity && !this.activity.active)
        this.activity = undefined;
    },
    onAgentEvent(event: unknown) {
      const scoped = event as { graphId?: string; branchId?: string; runId?: string };
      if (scoped.graphId && scoped.branchId && scoped.runId) {
        if (scoped.graphId !== this.current?.graph?.id) return;
        const known = this.current.graph.runs.find(r => r.branchId === scoped.branchId);
        if (known && known.runId !== scoped.runId) return;
        const old = this.branchActivities[scoped.branchId];
        this.branchActivities[scoped.branchId] = { runId: scoped.runId,
          activity: reduceAgentActivity(old?.runId === scoped.runId ? old.activity : undefined, event) };
        return;
      }
      this.activity = reduceAgentActivity(this.activity, event);
      if ((event as { type?: unknown } | null)?.type === "agent_start")
        this.focusedNode = null;
    },
    async refresh() {
      const project = this.activeProjectId, request = this.viewRequest;
      const sessions = await desktop.invoke<SessionSummary[]>("session.list");
      if (project !== this.activeProjectId || request !== this.viewRequest) return;
      this.sessions = sessions;
      this.syncProject();
    },
    // Decorated project groups arrive when a background session settles in any
    // project: rows, marks, and running markers all stay current out of view.
    applyProjects(projects: ProjectGroup[]) {
      this.adoptMarks(projects);
      this.projects = projects;
      this.sessions = projects.find(record => record.id === this.activeProjectId)?.sessions ?? this.sessions;
    },
    // Commands are session-scoped: no usable session means none to offer.
    async loadCommands() {
      const request = ++this.commandRequest;
      const path = this.current?.session.path;
      this.commands = [];
      if (!this.current?.runtime.available) {
        return;
      }
      const commands = await this.fetchCommands();
      if (request === this.commandRequest && path === this.current?.session.path && this.current?.runtime.available)
        this.commands = commands;
    },
    async fetchCommands(): Promise<RuntimeCommand[]> {
      return desktop.invoke<RuntimeCommand[]>("agent.control", { action: "commands" }).catch(() => []);
    },
    // Single source of truth for the model catalog: every path that can change
    // it (bootstrap, settings open, login/logout, catalog refresh, session
    // open) reloads through here so pickers never serve a stale list. The
    // catalog is global — project-less fetch is fine, the runtime serves model
    // actions without an open session.
    async loadModels(): Promise<RuntimeModel[]> {
      const models = await desktop.invoke<RuntimeModel[]>("agent.control", { action: "getModels" });
      this.models = models;
      return models;
    },
    // A deliberate pick in a model menu is what "last set" means: it becomes the
    // profile default every new session starts from, while the open session keeps
    // its own transcript model — the same split as the TUI's set-as-default.
    // Nodes that merely inherit a model never come through here.
    async setDefaultModel(model: RuntimeModel) {
      try {
        const settings = await desktop.invoke<SettingsBundle>("settings.update", {
          scope: "global",
          patch: { defaultProvider: model.provider, defaultModel: model.id },
        });
        useLayoutStore().applySettings(settings);
      } catch (error) {
        useLayoutStore().showNotice(error instanceof Error ? error.message : String(error), "error");
      }
    },
    async open(path: string, request?: number) {
      request ??= ++this.viewRequest;
      if (request !== this.viewRequest) return;
      this.loading = true;
      try {
        const snapshot = await desktop.invoke<SessionSnapshot>("session.open", { path });
        if (request !== this.viewRequest) return;
        this.applySnapshot(snapshot);
        this.focusedNode = snapshot.projection.activeNodeId;
        if (snapshot.runtime.isStreaming || snapshot.graph?.runs.some(run => run.status === "running")) {
          // Switching back mid-run: the snapshot resync replays the session's
          // live progress so partial text shows before the next token.
          void desktop.invoke("session.snapshot").catch(() => {});
        }
        await Promise.all([
          this.refresh(),
          this.loadCommands(),
          this.loadModels().catch(() => {}),
        ]);
      } catch (error) {
        if (request === this.viewRequest) throw error;
      } finally { if (request === this.viewRequest) this.loading = false; }
    },
    async stop(path: string, projectId?: string) {
      try {
        await desktop.invoke("session.stop", { path, ...(projectId ? { projectId } : {}) });
      } catch (error) {
        useLayoutStore().showNotice(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      await this.refresh();
    },
    async control<T = SessionSnapshot>(input: Record<string, unknown>) {
      const project = this.activeProjectId, path = this.current?.session.path, request = this.viewRequest;
      // Abort/lock entries are captured before the IPC settles: the abort run
      // disappears from the snapshot, so its name must be read from the pre-stop graph.
      const abortLabel = this.abortLabel(input);
      const sendLabel = this.sendPromptLabel(input);
      const result = await desktop.invoke<T>("agent.control", input);
      if (request === this.viewRequest && project === this.activeProjectId && path === this.current?.session.path
        && result && typeof result === "object" && "projection" in result)
        this.applySnapshot(result as unknown as SessionSnapshot);
      if (abortLabel) trackEvent({ kind: "abortRun", label: abortLabel });
      if (sendLabel) trackEvent({ kind: "sendPrompt", label: sendLabel });
      return result;
    },
    // A lock entry names the run/branch it stops when one is identifiable, else
    // it falls back to a generic label. Only abort actions resolve to one.
    abortLabel(input: Record<string, unknown>): string | null {
      const action = String(input.action);
      if (action !== "abort" && action !== "branchAbort") return null;
      const runId = typeof input.runId === "string" ? input.runId : undefined;
      const run = this.current?.graph?.runs.find((candidate) =>
        runId ? candidate.runId === runId : candidate.status === "running");
      const node = run && this.current?.projection.nodes.find((item) => item.id === run.nodeId);
      return node?.title
        ? i18n.global.t("history.abortRun", { name: truncate(node.title) })
        : i18n.global.t("history.abort");
    },
    // A submitted turn is irreversible: it seals the journal as a lock. Applies
    // to both the plain prompt action and a pinned-column promptAt.
    sendPromptLabel(input: Record<string, unknown>): string | null {
      const action = String(input.action);
      if (action !== "prompt" && action !== "promptAt") return null;
      const text = typeof input.text === "string" && input.text.trim() ? input.text : "";
      return i18n.global.t("history.sendPrompt", { text: truncate(text) || "…" });
    },
    messageWindow(limit: number) {
      return this.messageWindowFor(focusId(this), limit);
    },
    messageWindowFor(id: string | null, limit: number) {
      const current = this.current;
      if (!current) return { messages: [] as BranchMessage[], hasEarlier: false };
      let cached = messageCaches.get(this);
      if (!cached) { cached = createBranchMessageCache(); messageCaches.set(this, cached); }
      const node = current.projection.nodes.find(item => item.id === id);
      const run = current.graph?.runs.find(run => `pending:${run.runId}` === id && run.pending);
      const pending = run?.pending;
      const optimistic = this.pendingPrompt?.targetNodeId === id ? this.pendingPrompt.message : undefined;
      const parent = pending ? current.projection.nodes.find(item => item.id === pending.parentNodeId) : node;
      const history = cached(current.entries, parent?.leafEntryId ?? (pending ? null : current.projection.leafId),
        Math.max(0, limit - (pending || optimistic ? 1 : 0)));
      if (pending) return { ...history, messages: [...history.messages, {
        entryId: `pending:${run!.runId}`, turnId: `pending:${run!.runId}`, role: "user" as const,
        text: pending.text, images: pending.images, timestamp: "",
      }] };
      return optimistic ? { ...history, messages: [...history.messages, optimistic] } : history;
    },
    async selectNode(id: string | null) {
      this.focusedNode = id;
    },
    async deleteNode(id: string) {
      if (!this.current || this.deleteBlockedReason) return;
      const graphId = this.current.graph!.id;
      const request = this.viewRequest;
      const node = this.current.projection.nodes.find((item) => item.id === id);
      this.deletingNode = true;
      try {
        const snapshot = await desktop.invoke<SessionSnapshot>("agent.control", { action: "deleteNode", nodeId: id, graphId });
        if (request === this.viewRequest && this.current?.graph?.id === graphId) {
          this.applySnapshot(snapshot);
          trackEvent({
            kind: "deleteTurn",
            label: i18n.global.t("history.deleteTurn", { name: node?.title || id }),
          });
        }
      } finally { this.deletingNode = false; }
    },
    // Copies the root-to-node path into a new standalone session; the source
    // graph is untouched, so the list only gains one entry.
    async exportBranchSession(id: string) {
      const graphId = this.current?.graph?.id;
      if (!graphId) return;
      const result = await this.control<{ path: string }>({ action: "exportBranchSession", nodeId: id, graphId });
      await this.refresh();
      return result;
    },
    // Only explicit thinking-menu picks may update the sticky level; model-driven
    // clamps stay local to the composer so they never pollute it.
    setUserThinking(level: string) {
      this.userThinking = level;
    },
    async prompt(text: string, targetNodeId?: string | null, model?: RuntimeModel | null, thinkingLevel?: string, images?: PromptImage[]) {
      const project = this.activeProjectId, path = this.current?.session.path, request = this.viewRequest;
      const value = text.trim();
      if (!value && !images?.length) return;
      const target = targetNodeId === undefined
        ? this.current?.projection.activeNodeId ?? null
        : targetNodeId;
      const id = `pending:${Date.now()}`;
      const pending: PendingPrompt = {
        message: {
          entryId: id,
          turnId: id,
          role: "user",
          text: value,
          ...(images?.length ? { images } : {}),
          timestamp: new Date().toISOString(),
        },
        knownEntryIds: this.current?.entries.map((entry) => entry.id) ?? [],
        targetNodeId: target,
        model,
        thinkingLevel,
      };
      this.pendingPrompt = pending;
      this.focusedNode = null;
      try {
        await this.control({ action: "prompt", text: value, ...(images?.length ? { images } : {}) });
        if (request === this.viewRequest && project === this.activeProjectId && path === this.current?.session.path)
          this.focusedNode = this.current?.projection.activeNodeId ?? this.focusedNode;
      } finally {
        if (this.pendingPrompt?.message.entryId === id) this.pendingPrompt = undefined;
      }
    },
    // follow: false serves pinned chat columns: the submission starts on its
    // branch, but the primary column must keep showing the current selection.
    async promptAt(nodeId: string | null, text: string, model?: RuntimeModel | null, thinkingLevel?: string, images?: PromptImage[], options?: { follow?: boolean }) {
      const current = this.current;
      const project = this.activeProjectId, request = this.viewRequest;
      if (!current || (!text.trim() && !images?.length)) return;
      if (current.graph) {
        const requestId = crypto.randomUUID();
        const result = await this.control<SessionSnapshot>({ action: "promptAt", requestId, nodeId, text,
          provider: model?.provider, modelId: model?.id, thinkingLevel, images });
        if (request !== this.viewRequest || project !== this.activeProjectId || current.session.path !== this.current?.session.path) return;
        const run = result.graph?.runs.find(r => r.requestId === requestId);
        const focus = run?.nodeId ?? (run?.status === "running" ? `pending:${run.runId}` : nodeId);
        if (run && options?.follow !== false) this.focusedNode = focus;
        return focus ?? undefined;
      }
      const node = nodeId ? current.projection.nodes.find((item) => item.id === nodeId) : undefined;
      if (nodeId && !node) return;
      if (node && current.projection.activeNodeId !== nodeId) {
        const anchor = entryAnchorForNode(current.projection, node.id);
        if (!anchor || !current.runtime.available) return;
        await this.control({ action: "navigateTree", entryId: anchor });
      }
      if (model && (this.current?.runtime.model?.provider !== model.provider || this.current.runtime.model.id !== model.id))
        // Session-scoped, like the TUI's model switch: the profile default stays
        // put, so a new session still starts from whatever Pi resolved for it.
        await this.control({ action: "setModel", provider: model.provider, modelId: model.id });
      if (thinkingLevel && this.current?.runtime.thinkingLevel !== thinkingLevel)
        await this.control({ action: "setThinking", level: thinkingLevel });
      await this.prompt(text, nodeId, model, thinkingLevel, images);
      return this.current?.projection.activeNodeId ?? undefined;
    },
    async create() {
      const snapshot = await this.applyCreate();
      if (!snapshot) return;
      const createdPath = snapshot.session.path;
      // Redo recreates a fresh session (a new path each time); the label from
      // the original creation is reused so the entry stays readable.
      track({
        kind: "createSession",
        label: i18n.global.t("history.createSession", { name: displayName(snapshot.session as SessionSummary) }),
        undo: async () => {
          const result = await desktop.invoke<{ sessions: SessionSummary[]; cancelled?: boolean }>(
            "session.delete", { path: createdPath, confirmed: true });
          if (!result.cancelled) this.applyDeletion(createdPath, result.sessions);
          return !result.cancelled;
        },
        redo: async () => {
          await this.applyCreate();
          return true;
        },
      });
    },
    async applyCreate(): Promise<SessionSnapshot | null> {
      if (!useWorkspaceStore().project) {
        useLayoutStore().showNotice(
          i18n.global.t("notice.openProjectFirst"),
          "warning",
        );
        return null;
      }
      const request = ++this.viewRequest;
      const project = this.activeProjectId;
      const snapshot = await this.control<SessionSnapshot>({ action: "newSession" });
      if (request !== this.viewRequest || project !== this.activeProjectId) return null;
      // The reply is authoritative for the new file, and the broadcast event may
      // still be in flight: without adopting it here the list and slash commands
      // would keep serving the session that was just replaced.
      if (snapshot.session.path !== this.current?.session.path) this.applySnapshot(snapshot);
      this.focusedNode = this.current?.projection.activeNodeId ?? null;
      await Promise.all([this.refresh(), this.loadCommands()]);
      return snapshot;
    },
    async importSession() {
      const result = await desktop.invoke<{ imported?: string; sessions: SessionSummary[] } | null>(
        "session.import",
        {},
      );
      if (!result) return;
      this.sessions = result.sessions;
      this.syncProject();
      if (result.imported) await this.open(result.imported);
    },
    async rename(path: string, name: string) {
      const previous = this.sessions.find((session) => session.path === path);
      const prevName = previous?.name ?? "";
      const labelName = previous ? displayName(previous) : path;
      await this.applyRename(path, name);
      track({
        kind: "renameSession",
        label: i18n.global.t("history.renameSession", { name: labelName, newname: name }),
        undo: async () => {
          await this.applyRename(path, prevName);
          return true;
        },
        redo: async () => {
          await this.applyRename(path, name);
          return true;
        },
      });
    },
    async applyRename(path: string, name: string) {
      const result = await desktop.invoke<{ sessions: SessionSummary[]; current?: SessionSnapshot }>(
        "session.rename",
        { path, name },
      );
      this.sessions = result.sessions;
      if (result.current) this.applySnapshot(result.current);
      this.syncProject();
    },
    applyDeletion(path: string, sessions: SessionSummary[]) {
      this.sessions = sessions;
      if (this.current?.session.path === path) {
        this.current = undefined;
        this.focusedNode = null;
        this.highlightedNode = null;
        this.activity = undefined;
        this.pendingPrompt = undefined;
        this.userThinking = undefined;
        this.commands = [];
      }
      this.syncProject();
    },
    async remove(path: string, confirmed = false) {
      const target = this.sessions.find((session) => session.path === path);
      const labelName = target ? displayName(target) : path;
      const result = await desktop.invoke<{ sessions: SessionSummary[]; cancelled?: boolean }>("session.delete", confirmed ? { path, confirmed } : { path });
      if (!result.cancelled) {
        this.applyDeletion(path, result.sessions);
        trackEvent({ kind: "deleteSession", label: i18n.global.t("history.deleteSession", { name: labelName }) });
      }
    },
    async forgetProject(id: string) {
      const record = this.projects.find((item) => item.id === id);
      const labelName = record?.project.name ?? id;
      this.projects = await desktop.invoke<ProjectGroup[]>("app.forgetProject", { id });
      trackEvent({ kind: "removeDirectory", label: i18n.global.t("history.removeDirectory", { name: labelName }) });
    },
    async applyPin(path: string, pinned: boolean) {
      const result = await desktop.invoke<{ sessions?: SessionSummary[]; projects: ProjectGroup[] }>("library.pin", { path, pinned });
      this.applyLibrary(result);
    },
    async pin(path: string, pinned: boolean) {
      const target = this.sessions.find((session) => session.path === path);
      const labelName = target ? displayName(target) : path;
      await this.applyPin(path, pinned);
      track({
        kind: "pin",
        label: i18n.global.t(pinned ? "history.pin" : "history.unpin", { name: labelName }),
        undo: async () => {
          await this.applyPin(path, !pinned);
          return true;
        },
        redo: async () => {
          await this.applyPin(path, pinned);
          return true;
        },
      });
    },
    async applyArchiveSession(path: string, archived: boolean) {
      const result = await desktop.invoke<{ sessions?: SessionSummary[]; projects: ProjectGroup[] }>("library.archiveSession", { path, archived });
      this.applyLibrary(result);
    },
    async archiveSession(path: string, archived: boolean) {
      const target = this.sessions.find((session) => session.path === path);
      const labelName = target ? displayName(target) : path;
      await this.applyArchiveSession(path, archived);
      track({
        kind: archived ? "archiveSession" : "restoreSession",
        label: i18n.global.t(archived ? "history.archiveSession" : "history.restoreSession", { name: labelName }),
        undo: async () => {
          await this.applyArchiveSession(path, !archived);
          return true;
        },
        redo: async () => {
          await this.applyArchiveSession(path, archived);
          return true;
        },
      });
    },
    async applyArchiveProject(id: string, archived: boolean) {
      const result = await desktop.invoke<{ projects: ProjectGroup[] }>("library.archiveProject", { id, archived });
      this.applyLibrary(result);
    },
    async archiveProject(id: string, archived: boolean) {
      const record = this.projects.find((item) => item.id === id);
      const labelName = record?.project.name ?? id;
      await this.applyArchiveProject(id, archived);
      track({
        kind: archived ? "archiveDirectory" : "restoreDirectory",
        label: i18n.global.t(archived ? "history.archiveDirectory" : "history.restoreDirectory", { name: labelName }),
        undo: async () => {
          await this.applyArchiveProject(id, !archived);
          return true;
        },
        redo: async () => {
          await this.applyArchiveProject(id, archived);
          return true;
        },
      });
    },
    // Library marks ride back on the invoke reply: the sessions list only
    // exists while a locally open project answers, and projects always come
    // back. Marks are adopted from the decorated project groups.
    applyLibrary(result: { sessions?: SessionSummary[]; projects: ProjectGroup[] }) {
      this.adoptMarks(result.projects);
      this.projects = result.projects;
      if (result.sessions) {
        this.sessions = result.sessions;
        this.syncProject();
      }
    },
  },
});
