import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GitBranchPicker from "../../src/renderer/components/GitBranchPicker.vue";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import type { FileDocument, GitStatus, SessionSnapshot } from "../../src/shared/types";

const git: GitStatus = { available: true, branch: "main", changes: [], ahead: 0, behind: 0, clean: true };
const documentFile = (content: string): FileDocument => ({ path: "file.txt", name: "file.txt", language: "text", content, readonly: false, truncated: false });
beforeEach(() => {
  vi.restoreAllMocks();
  setActivePinia(createPinia());
  const workspace = useWorkspaceStore();
  workspace.hydrate({ name: "repo", path: "/repo" });
  workspace.git = { ...git };
  vi.spyOn(desktop, "invoke").mockImplementation(async route => {
    if (route === "git.branches") return ["main", "feature/Next"] as never;
    if (route === "git.status") return { ...git } as never;
    if (route === "git.switch") return { ...git, branch: "feature/Next" } as never;
    if (route === "workspace.read") return documentFile("new branch") as never;
    return [] as never;
  });
});
afterEach(() => { document.body.innerHTML = ""; });

it("switches from the menu and shares current state without rewriting historical nodes", async () => {
  const session = useSessionStore();
  session.current = { session: { path: "session" }, projection: { nodes: [{ id: "turn:one", gitBranch: "old-branch" }] }, runtime: { available: true } } as SessionSnapshot;
  const wrapper = mount(GitBranchPicker, { global: { plugins: [i18n] }, attachTo: document.body });
  const second = mount(GitBranchPicker, { global: { plugins: [i18n] } });
  await wrapper.get("button").trigger("click"); await flushPromises();
  expect(document.querySelector('.git-branch-hint')?.textContent).toContain("workspace");
  (document.querySelector('[data-git-branch="feature/Next"]') as HTMLElement).click();
  await flushPromises();
  expect(desktop.invoke).toHaveBeenCalledWith("git.switch", { branch: "feature/Next", cwd: "/repo" });
  expect(wrapper.get("button").text()).toContain("feature/Next");
  expect(second.get("button").text()).toContain("feature/Next");
  expect(session.current.projection.nodes[0]!.gitBranch).toBe("old-branch");
  wrapper.unmount(); second.unmount();
});

it("blocks running tasks and unsaved editors, and reports Git failures without changing the label", async () => {
  const workspace = useWorkspaceStore(), session = useSessionStore();
  const wrapper = mount(GitBranchPicker, { global: { plugins: [i18n] }, attachTo: document.body });
  session.sessions = [{ running: true }] as any;
  await flushPromises();
  expect(wrapper.get("button").attributes("disabled")).toBeDefined();
  session.sessions = [];
  workspace.tabs = [{ id: "file", kind: "file", title: "file", document: documentFile("draft"), savedContent: "saved" }];
  await flushPromises();
  expect(wrapper.get("button").attributes("title")).toContain("Save");
  await expect(workspace.switchGitBranch("feature/Next")).rejects.toThrow("Save");
  workspace.tabs = [];
  vi.mocked(desktop.invoke).mockImplementation(async route => {
    if (route === "git.branches") return ["main", "feature/Next"] as never;
    if (route === "git.status") return { ...git } as never;
    throw new Error("Local changes would be overwritten");
  });
  await flushPromises();
  await wrapper.get("button").trigger("click"); await flushPromises();
  (document.querySelector('[data-git-branch="feature/Next"]') as HTMLElement).click();
  await flushPromises();
  expect(useLayoutStore().notice?.message).toContain("would be overwritten");
  expect(workspace.git.branch).toBe("main");
  expect(workspace.gitSwitching).toBe(false);
  wrapper.unmount();
});

it("refreshes clean editors and files while preserving edits made during checkout", async () => {
  const workspace = useWorkspaceStore();
  workspace.tabs = [
    { id: "clean", kind: "file", title: "clean", path: "clean", document: documentFile("old"), savedContent: "old" },
    { id: "typing", kind: "file", title: "typing", path: "typing", document: documentFile("old"), savedContent: "old" },
    { id: "diff", kind: "changes", title: "Changes" },
  ];
  let done!: (value: GitStatus) => void;
  vi.mocked(desktop.invoke).mockImplementation(async route => {
    if (route === "git.switch") return new Promise<GitStatus>(resolve => { done = resolve; }) as never;
    if (route === "workspace.read") return documentFile("new branch") as never;
    return [] as never;
  });
  const pending = workspace.switchGitBranch("feature/Next");
  workspace.tabs[1]!.document!.content = "typing during checkout";
  done({ ...git, branch: "feature/Next" }); await pending;
  expect(workspace.tabs.map(tab => tab.document?.content)).toEqual(["new branch", "typing during checkout"]);
  expect(workspace.tabs[0]!.savedContent).toBe("new branch");
  expect(desktop.invoke).toHaveBeenCalledWith("workspace.tree", { path: "" });
});

it("discards stale status and switch results after another project is opened", async () => {
  const workspace = useWorkspaceStore();
  let statusDone!: (value: GitStatus) => void, switchDone!: (value: GitStatus) => void;
  vi.mocked(desktop.invoke).mockImplementation(async route => {
    if (route === "git.status") return new Promise<GitStatus>(resolve => { statusDone = resolve; }) as never;
    return new Promise<GitStatus>(resolve => { switchDone = resolve; }) as never;
  });
  const statusRequest = workspace.loadGit();
  const switchRequest = workspace.switchGitBranch("feature/Next");
  workspace.hydrate({ name: "other", path: "/other" });
  workspace.git = { ...git, branch: "other" };
  statusDone(git); switchDone({ ...git, branch: "feature/Next" });
  await Promise.all([statusRequest, switchRequest]);
  expect(workspace.git.branch).toBe("other");
  expect(workspace.gitSwitching).toBe(false);
});
