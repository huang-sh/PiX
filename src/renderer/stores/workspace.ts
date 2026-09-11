import { defineStore } from "pinia";
import type {
  DesktopEvent,
  FileDocument,
  FileNode,
  GitStatus,
  ProjectInfo,
  ShellResult,
  SessionSnapshot,
} from "../../shared/types";
import { desktop } from "../api";
import type { FileChange } from "../../shared/file-changes";

export interface WorkspaceTab {
  id: string;
  kind: "file" | "browser" | "changes" | "turn-change";
  title: string;
  path?: string;
  url?: string;
  document?: FileDocument;
  patch?: string;
}

const unavailableGit = (): GitStatus => ({
  available: false,
  ahead: 0,
  behind: 0,
  changes: [],
  clean: true,
});

export const useWorkspaceStore = defineStore("workspace", {
  state: () => ({
    project: undefined as ProjectInfo | undefined,
    files: [] as FileNode[],
    filesRequest: 0,
    git: unavailableGit(),
    diff: "",
    tabs: [] as WorkspaceTab[],
    activeTab: "",
    utilityOutput: "",
    events: [] as string[],
    browserUrl: "https://pi.dev",
  }),
  getters: {
    active(state) {
      return state.tabs.find((tab) => tab.id === state.activeTab) ?? state.tabs[0];
    },
  },
  actions: {
    hydrate(project: ProjectInfo | null | undefined, browserHome?: string) {
      const previous = this.project;
      const next = project ?? undefined;
      // Entering the project-less state (welcome screen) must drop the
      // previous project's files, git state and tabs.
      const changed =
        !next ||
        (previous &&
          (previous.path !== next.path ||
            previous.remote?.kind !== next.remote?.kind ||
            JSON.stringify(previous.remote) !== JSON.stringify(next.remote)));
      this.project = next;
      this.browserUrl = browserHome || "https://pi.dev";
      if (changed) {
        this.filesRequest++;
        this.files = [];
        this.git = unavailableGit();
        this.diff = "";
        this.tabs = [];
        this.activeTab = "";
        this.utilityOutput = "";
      }
    },
    async load() {
      if (!this.project) {
        this.files = [];
        this.git = unavailableGit();
        return;
      }
      await Promise.all([this.loadFiles(), this.loadGit()]);
    },
    async loadFiles() {
      if (!this.project) return;
      const project = this.project;
      const request = ++this.filesRequest;
      const current = () => this.project === project && this.filesRequest === request;
      const refresh = async (path: string, previous: FileNode[]): Promise<FileNode[]> => {
        try {
          const entries = await desktop.invoke<FileNode[]>("workspace.tree", { path });
          if (!current()) return previous;
          const old = new Map(previous.map((node) => [node.path, node]));
          return await Promise.all(entries.map(async (entry) => {
            const existing = old.get(entry.path);
            const node = existing?.kind === entry.kind ? Object.assign(existing, entry) : entry;
            if (node.kind === "directory" && node.children !== undefined) {
              const children = await refresh(node.path, node.children);
              if (current()) node.children = children;
            }
            return node;
          }));
        } catch {
          // Keep the last listing during transient local or remote failures.
          return previous;
        }
      };
      const files = await refresh("", this.files);
      if (current()) this.files = files;
    },
    async loadChildren(node: FileNode) {
      if (node.kind !== "directory" || node.children) return;
      node.children = [];
      try {
        node.children = await desktop.invoke<FileNode[]>("workspace.tree", { path: node.path });
      } catch {
        node.children = undefined;
      }
    },
    async loadGit() {
      try {
        this.git = await desktop.invoke<GitStatus>("git.status");
      } catch {
        this.git = unavailableGit();
      }
    },
    async openFile(path: string) {
      const old = this.tabs.find((tab) => tab.kind === "file" && tab.path === path);
      if (old) return void (this.activeTab = old.id);
      const project = this.project;
      const document = await desktop.invoke<FileDocument>("workspace.read", { path });
      if (this.project !== project) return;
      const tab: WorkspaceTab = {
        id: `file:${path}`,
        kind: "file",
        title: document.name,
        path,
        document,
      };
      this.tabs.push(tab);
      this.activeTab = tab.id;
    },
    async saveFile(tab: WorkspaceTab, content: string) {
      if (!tab.path) return;
      tab.document = await desktop.invoke<FileDocument>("workspace.write", {
        path: tab.path,
        content,
      });
    },
    async openChange(path?: string) {
      this.diff = await desktop.invoke<string>("git.diff", { path });
      let tab = this.tabs.find((item) => item.kind === "changes");
      if (!tab) {
        tab = { id: "changes", kind: "changes", title: "Changes" };
        this.tabs.push(tab);
      }
      tab.path = path;
      this.activeTab = tab.id;
    },
    async openTurnChange(session: string, change: FileChange) {
      const id = `change:${session}:${change.ref}`;
      const old = this.tabs.find(tab => tab.id === id);
      if (old) return void (this.activeTab = id);
      const project = this.project;
      const patch = await desktop.invoke<string>("changes.read", { session, ref: change.ref });
      if (this.project !== project) return;
      this.tabs.push({ id, kind: "turn-change", title: change.path.split("/").at(-1) ?? change.path, path: change.path, patch });
      this.activeTab = id;
    },
    openBrowser(raw?: string) {
      let url = (raw ?? this.browserUrl).trim() || "https://pi.dev";
      if (!/^[a-z]+:/i.test(url)) url = `https://${url}`;
      const parsed = new URL(url);
      let tab = this.tabs.find((item) => item.kind === "browser");
      if (!tab) {
        tab = { id: "browser", kind: "browser", title: parsed.hostname || "Browser" };
        this.tabs.push(tab);
      }
      tab.url = parsed.href;
      tab.title = parsed.hostname || "Browser";
      this.browserUrl = parsed.href;
      this.activeTab = tab.id;
    },
    closeTab(id: string) {
      this.tabs = this.tabs.filter((tab) => tab.id !== id);
      this.activeTab = this.tabs.at(-1)?.id ?? "";
    },
    async runShell(command: string) {
      this.utilityOutput += `\n$ ${command}\n`;
      const result = await desktop.invoke<ShellResult>("shell.run", { command });
      this.utilityOutput += result.output;
    },
    record(event: DesktopEvent) {
      if (event.type === "terminal") return;
      const payload = event.payload as { type?: string; branchId?: string; runId?: string; toolName?: string;
        current?: SessionSnapshot; deletedPath?: string } | undefined;
      // Progress is already displayed in activity. Diagnostics must not retain
      // or stringify every cumulative token payload or the full session tree.
      if (event.type === "agent" && ["message_update", "tool_execution_update"].includes(payload?.type ?? "")) return;
      const detail = event.type === "agent"
        ? { type: payload?.type, branchId: payload?.branchId, runId: payload?.runId, toolName: payload?.toolName }
        : event.type === "sessions"
          ? { path: payload?.current?.session.path, revision: payload?.current?.graph?.revision,
              nodes: payload?.current?.projection.nodes.length, deletedPath: payload?.deletedPath }
          : event.payload;
      this.events.unshift(
        `${new Date().toLocaleTimeString()} ${event.type} ${JSON.stringify(detail)?.slice(0, 700)}`,
      );
      if (this.events.length > 200) this.events.length = 200;
      if (event.type === "shell") {
        const payload = event.payload as { chunk?: string };
        if (payload.chunk) this.utilityOutput += payload.chunk;
      }
      if (event.type === "notice") {
        const payload = event.payload as { source?: string; message?: string };
        if (payload.source === "extension" && payload.message)
          this.utilityOutput += `${payload.message}\n`;
      }
    },
  },
});
