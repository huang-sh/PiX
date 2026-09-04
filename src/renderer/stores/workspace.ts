import { defineStore } from "pinia";
import type {
  DesktopEvent,
  FileDocument,
  FileNode,
  GitStatus,
  ProjectInfo,
  ShellResult,
} from "../../shared/types";
import { desktop } from "../api";

export interface WorkspaceTab {
  id: string;
  kind: "file" | "browser" | "changes";
  title: string;
  path?: string;
  url?: string;
  document?: FileDocument;
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
    hydrate(project: ProjectInfo, browserHome?: string) {
      const previous = this.project;
      const changed =
        previous &&
        (previous.path !== project.path ||
          previous.remote?.kind !== project.remote?.kind ||
          JSON.stringify(previous.remote) !== JSON.stringify(project.remote));
      this.project = project;
      this.browserUrl = browserHome || "https://pi.dev";
      if (changed) {
        this.files = [];
        this.git = unavailableGit();
        this.diff = "";
        this.tabs = [];
        this.activeTab = "";
        this.utilityOutput = "";
      }
    },
    async load() {
      await Promise.all([this.loadFiles(), this.loadGit()]);
    },
    async loadFiles() {
      try {
        this.files = await desktop.invoke<FileNode[]>("workspace.tree", { path: "" });
      } catch {
        this.files = [];
      }
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
      const document = await desktop.invoke<FileDocument>("workspace.read", { path });
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
      this.events.unshift(
        `${new Date().toLocaleTimeString()} ${event.type} ${JSON.stringify(event.payload)?.slice(0, 700)}`,
      );
      if (event.type === "shell") {
        const payload = event.payload as { chunk?: string };
        if (payload.chunk) this.utilityOutput += payload.chunk;
      }
    },
  },
});
