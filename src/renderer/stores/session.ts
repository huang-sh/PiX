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
} from "../../shared/types";
import { projectId } from "../../shared/types";
import { reduceAgentActivity } from "../../shared/agent-stream";
import { entryAnchorForNode, projectSession, projectSessionBranch } from "../../shared/session";
import { desktop } from "../api";
import { i18n } from "../i18n";
import { useLayoutStore } from "./layout";
import { useWorkspaceStore } from "./workspace";

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
    sessions: [] as SessionSummary[],
    projects: [] as ProjectGroup[],
    activeProjectId: "",
    current: undefined as SessionSnapshot | undefined,
    focusedNode: null as string | null,
    // Last thinking level the user picked explicitly in a composer; it stays in
    // effect for later drafts until they pick again or the session changes.
    userThinking: undefined as string | undefined,
    query: "",
    commands: [] as RuntimeCommand[],
    models: [] as RuntimeModel[],
    activity: undefined as AgentActivity | undefined,
    branchActivities: {} as Record<string, { runId: string; activity?: AgentActivity }>,
    pendingPrompt: undefined as PendingPrompt | undefined,
  }),
  getters: {
    selectedRun(state) {
      const id = state.focusedNode ?? state.current?.projection.activeNodeId;
      return state.current?.graph?.runs.find(run => run.nodeId === id || `pending:${run.runId}` === id);
    },
    selectedActivity(): AgentActivity | undefined {
      if (!this.current?.graph) return this.activity;
      const run = this.selectedRun;
      const value = run && this.branchActivities[run.branchId];
      return value && value.runId === run?.runId && run.status === "running" ? value.activity : undefined;
    },
    filtered(state) {
      const query = state.query.toLowerCase();
      return state.sessions.filter(
        (session) =>
          !query ||
          `${session.name ?? ""} ${session.firstMessage} ${session.id}`
            .toLowerCase()
            .includes(query),
      );
    },
    filteredProjects(state) {
      const query = state.query.trim().toLowerCase();
      return state.projects
        .map((record) => {
          const projectMatch = !query || `${record.project.name} ${record.project.path} ${
            record.project.remote?.kind === "ssh"
              ? record.project.remote.host
              : record.project.remote?.distro ?? ""
          }`.toLowerCase().includes(query);
          return {
            ...record,
            sessions: projectMatch
              ? record.sessions
              : record.sessions.filter((session) =>
                  `${session.name ?? ""} ${session.firstMessage} ${session.id}`
                    .toLowerCase()
                    .includes(query),
                ),
          };
        })
        .filter((record) => !query || record.sessions.length || record.project.name.toLowerCase().includes(query));
    },
    selectedNode(state) {
      const id = state.focusedNode ?? state.current?.projection.activeNodeId;
      return state.current?.projection.nodes.find((node) => node.id === id);
    },
    selectedMessages(state): BranchMessage[] {
      const current = state.current;
      if (!current) return [];
      const id = state.focusedNode ?? current.projection.activeNodeId;
      const node = current.projection.nodes.find((item) => item.id === id);
      const run = current.graph?.runs.find(r => `pending:${r.runId}` === id && r.pending);
      if (run?.pending) {
        const parent = current.projection.nodes.find(n => n.id === run.pending!.parentNodeId);
        return [...(parent ? projectSessionBranch(current.entries, parent.leafEntryId).messages : []), {
          entryId: `pending:${run.runId}`, turnId: `pending:${run.runId}`, role: "user", text: run.pending.text,
          images: run.pending.images, timestamp: new Date().toISOString(),
        }];
      }
      const messages = node ? projectSessionBranch(current.entries, node.leafEntryId).messages : current.projection.messages;
      return state.pendingPrompt?.targetNodeId === id
        ? [...messages, state.pendingPrompt.message]
        : messages;
    },
  },
  actions: {
    hydrate(
      project: ProjectInfo | null,
      sessions: SessionSummary[],
      projects: ProjectGroup[],
      current?: SessionSnapshot,
    ) {
      this.projects = projects;
      this.activeProjectId = project ? projectId(project) : "";
      this.sessions = sessions;
      this.focusedNode = current?.projection.activeNodeId ?? null;
      this.activity = undefined;
      this.branchActivities = {};
      this.pendingPrompt = undefined;
      this.current = undefined;
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
      if (record) record.connected = false;
      if (this.activeProjectId !== id) return;
      this.activity = undefined;
      this.branchActivities = {};
      if (this.current) this.current.runtime = {
        ...this.current.runtime, available: false, isStreaming: false,
        isCompacting: false, isRetrying: false,
      };
    },
    applySnapshot(snapshot: SessionSnapshot) {
      const previousGraph = this.current?.graph;
      if (previousGraph && snapshot.graph && previousGraph.id === snapshot.graph.id && previousGraph.epoch === snapshot.graph.epoch && previousGraph.revision > snapshot.graph.revision) return;
      const graphChanged = this.current?.session.path !== snapshot.session.path;
      if (graphChanged || previousGraph?.epoch !== snapshot.graph?.epoch) this.branchActivities = {};
      const pending = this.pendingPrompt;
      if (this.current?.session.path !== snapshot.session.path) this.userThinking = undefined;
      // Session records/projections are immutable snapshots, replaced together.
      // Deep proxies on every historical entry make large-tree navigation costly.
      snapshot.entries = markRaw(snapshot.entries);
      snapshot.projection = markRaw(snapshot.projection);
      this.current = snapshot;
      if (snapshot.session.path)
        this.sessions = [
          snapshot.session,
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
      this.sessions = await desktop.invoke<SessionSummary[]>("session.list");
      this.syncProject();
    },
    // Commands are session-scoped: no usable session means none to offer.
    async loadCommands() {
      if (!this.current?.runtime.available) {
        this.commands = [];
        return;
      }
      this.commands = await desktop.invoke<RuntimeCommand[]>("agent.control", { action: "commands" }).catch(() => []);
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
    async open(path: string) {
      this.loading = true;
      const snapshot = await desktop.invoke<SessionSnapshot>("session.open", { path });
      this.applySnapshot(snapshot);
      this.focusedNode = snapshot.projection.activeNodeId;
      await Promise.all([
        this.refresh(),
        this.loadCommands(),
        this.loadModels().catch(() => {}),
      ]);
      this.loading = false;
    },
    async control<T = SessionSnapshot>(input: Record<string, unknown>) {
      const result = await desktop.invoke<T>("agent.control", input);
      if (result && typeof result === "object" && "projection" in result)
        this.applySnapshot(result as unknown as SessionSnapshot);
      return result;
    },
    async selectNode(id: string) {
      this.focusedNode = id;
    },
    // Only explicit thinking-menu picks may update the sticky level; model-driven
    // clamps stay local to the composer so they never pollute it.
    setUserThinking(level: string) {
      this.userThinking = level;
    },
    async prompt(text: string, targetNodeId?: string | null, model?: RuntimeModel | null, thinkingLevel?: string, images?: PromptImage[]) {
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
        this.focusedNode = this.current?.projection.activeNodeId ?? this.focusedNode;
      } finally {
        if (this.pendingPrompt?.message.entryId === id) this.pendingPrompt = undefined;
      }
    },
    async promptAt(nodeId: string | null, text: string, model?: RuntimeModel | null, thinkingLevel?: string, images?: PromptImage[]) {
      const current = this.current;
      if (!current || (!text.trim() && !images?.length)) return;
      if (current.graph) {
        const requestId = crypto.randomUUID();
        const result = await this.control<SessionSnapshot>({ action: "promptAt", requestId, nodeId, text,
          provider: model?.provider, modelId: model?.id, thinkingLevel, images });
        const run = result.graph?.runs.find(r => r.requestId === requestId);
        if (run) this.focusedNode = run.nodeId ?? `pending:${run.runId}`;
        return run ? run.nodeId ?? `pending:${run.runId}` : undefined;
      }
      const node = nodeId ? current.projection.nodes.find((item) => item.id === nodeId) : undefined;
      if (nodeId && !node) return;
      if (node && current.projection.activeNodeId !== nodeId) {
        const anchor = entryAnchorForNode(current.projection, node.id);
        if (!anchor || !current.runtime.available) return;
        await this.control({ action: "navigateTree", entryId: anchor });
      }
      if (model && (this.current?.runtime.model?.provider !== model.provider || this.current.runtime.model.id !== model.id))
        await this.control({ action: "setModel", provider: model.provider, modelId: model.id });
      if (thinkingLevel && this.current?.runtime.thinkingLevel !== thinkingLevel)
        await this.control({ action: "setThinking", level: thinkingLevel });
      await this.prompt(text, nodeId, model, thinkingLevel, images);
      return this.current?.projection.activeNodeId ?? undefined;
    },
    async create() {
      if (!useWorkspaceStore().project) {
        useLayoutStore().showNotice(
          i18n.global.t("notice.openProjectFirst"),
          "warning",
        );
        return;
      }
      this.applySnapshot(await this.control<SessionSnapshot>({ action: "newSession" }));
      this.focusedNode = this.current?.projection.activeNodeId ?? null;
      await this.refresh();
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
        this.activity = undefined;
        this.pendingPrompt = undefined;
        this.userThinking = undefined;
        this.commands = [];
      }
      this.syncProject();
    },
    async remove(path: string, confirmed = false) {
      const result = await desktop.invoke<{ sessions: SessionSummary[]; cancelled?: boolean }>("session.delete", confirmed ? { path, confirmed } : { path });
      if (!result.cancelled) this.applyDeletion(path, result.sessions);
    },
  },
});
