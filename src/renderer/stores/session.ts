import { defineStore } from "pinia";
import type {
  AgentActivity,
  BranchMessage,
  ProjectGroup,
  ProjectInfo,
  RuntimeCommand,
  RuntimeModel,
  SessionSnapshot,
  SessionSummary,
} from "../../shared/types";
import { projectId } from "../../shared/types";
import { reduceAgentActivity } from "../../shared/agent-stream";
import { entryAnchorForNode, projectSession } from "../../shared/session";
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
    pendingPrompt: undefined as PendingPrompt | undefined,
  }),
  getters: {
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
      const messages = node ? projectSession(current.entries, node.leafEntryId).messages : current.projection.messages;
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
      this.pendingPrompt = undefined;
      this.current = undefined;
      this.syncProject();
      if (current) this.applySnapshot(current);
    },
    syncProject() {
      const record = this.projects.find((item) => item.id === this.activeProjectId);
      if (record) {
        record.sessions = this.sessions;
        record.connected = true;
      }
    },
    applySnapshot(snapshot: SessionSnapshot) {
      const pending = this.pendingPrompt;
      if (this.current?.session.path !== snapshot.session.path) this.userThinking = undefined;
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
      if (this.activity) this.focusedNode = snapshot.projection.activeNodeId;
      if (!snapshot.runtime.isStreaming && this.activity && !this.activity.active)
        this.activity = undefined;
    },
    onAgentEvent(event: unknown) {
      this.activity = reduceAgentActivity(this.activity, event);
      if ((event as { type?: unknown } | null)?.type === "agent_start")
        this.focusedNode = null;
    },
    async refresh() {
      this.sessions = await desktop.invoke<SessionSummary[]>("session.list");
      this.syncProject();
    },
    async loadCommands() {
      if (!this.current?.runtime.available) {
        this.commands = [];
        this.models = [];
        return;
      }
      [this.commands, this.models] = await Promise.all([
        desktop.invoke<RuntimeCommand[]>("agent.control", { action: "commands" }).catch(() => []),
        desktop.invoke<RuntimeModel[]>("agent.control", { action: "getModels" }).catch(() => []),
      ]);
    },
    async open(path: string) {
      this.loading = true;
      const snapshot = await desktop.invoke<SessionSnapshot>("session.open", { path });
      this.applySnapshot(snapshot);
      this.focusedNode = snapshot.projection.activeNodeId;
      await Promise.all([this.refresh(), this.loadCommands()]);
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
    async prompt(text: string, targetNodeId?: string | null, model?: RuntimeModel | null, thinkingLevel?: string) {
      const value = text.trim();
      if (!value) return;
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
        await this.control({ action: "prompt", text: value });
        this.focusedNode = this.current?.projection.activeNodeId ?? this.focusedNode;
      } finally {
        if (this.pendingPrompt?.message.entryId === id) this.pendingPrompt = undefined;
      }
    },
    async promptAt(nodeId: string | null, text: string, model?: RuntimeModel | null, thinkingLevel?: string) {
      const current = this.current;
      if (!current || !text.trim()) return;
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
      await this.prompt(text, nodeId, model, thinkingLevel);
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
      this.current = result.current ?? this.current;
      this.syncProject();
    },
    async remove(path: string, confirmed = false) {
      const result = await desktop.invoke<{ sessions: SessionSummary[] }>("session.delete", confirmed ? { path, confirmed } : { path });
      this.sessions = result.sessions;
      this.syncProject();
    },
  },
});
