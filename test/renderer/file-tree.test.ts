import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileNode } from "../../src/shared/types";
import ToolPanel from "../../src/renderer/features/tools/ToolPanel.vue";
import { filterFileTree } from "../../src/renderer/features/tools/file-tree";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";

describe("file tree filtering", () => {
  afterEach(() => {
    vi.mocked(window.pix!.invoke).mockReset();
    vi.useRealTimers();
  });
  it("keeps matching branches and their file", () => {
    const nodes: FileNode[] = [
      {
        name: "src",
        path: "src",
        kind: "directory",
        children: [
          { name: "app.ts", path: "src/app.ts", kind: "file" },
          { name: "theme.css", path: "src/theme.css", kind: "file" },
        ],
      },
      { name: "README.md", path: "README.md", kind: "file" },
    ];

    expect(filterFileTree(nodes, "THEME")).toEqual([
      { ...nodes[0], children: [nodes[0]!.children![1]] },
    ]);
    expect(filterFileTree(nodes, "  ")).toBe(nodes);
  });

  it("lets the file tree be resized and collapsed", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    const workspace = useWorkspaceStore();
    layout.contentTabs = ["files"];
    layout.contentSection = "files";
    workspace.project = { name: "project", path: "/project" };

    const wrapper = mount(ToolPanel, { global: { plugins: [pinia, i18n] } });
    expect(wrapper.get('[role="separator"]').attributes("aria-label")).toBe(
      i18n.global.t("tools.resizeTree"),
    );

    await wrapper.get('[data-action="toggle-file-tree"]').trigger("click");
    expect(wrapper.find(".file-explorer").exists()).toBe(false);
    await wrapper.get('[data-action="toggle-file-tree"]').trigger("click");
    expect(wrapper.find(".file-explorer").exists()).toBe(true);
    wrapper.unmount();
  });

  it("refreshes files and loaded branches while visible, preserving expansion", async () => {
    vi.useFakeTimers();
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    const workspace = useWorkspaceStore();
    layout.contentTabs = ["files"];
    layout.contentSection = "files";
    layout.layout.collapsed.content = false;
    workspace.project = { name: "project", path: "/project" };
    workspace.files = [{ name: "src", path: "src", kind: "directory", children: [
      { name: "old.ts", path: "src/old.ts", kind: "file" },
    ] }];
    const invoke = vi.mocked(window.pix!.invoke);
    let children: FileNode[] = workspace.files[0]!.children!;
    invoke.mockImplementation(async (_method, params) =>
      (params as { path: string }).path === "src" ? children : [
        { name: "src", path: "src", kind: "directory" },
        { name: "unopened", path: "unopened", kind: "directory" },
      ]);
    const wrapper = mount(ToolPanel, { global: { plugins: [pinia, i18n] } });
    try {
      await flushPromises();
      const directory = wrapper.get('[data-directory-path="src"]');
      (directory.element as HTMLDetailsElement).open = true;
      await directory.trigger("toggle");
      children = [{ name: "new.ts", path: "src/new.ts", kind: "file" }];
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      expect(wrapper.find('[data-file-path="src/new.ts"]').exists()).toBe(true);
      expect(wrapper.find('[data-file-path="src/old.ts"]').exists()).toBe(false);
      expect((directory.element as HTMLDetailsElement).open).toBe(true);
      expect(invoke).not.toHaveBeenCalledWith("workspace.tree", { path: "unopened" });

      invoke.mockClear();
      window.dispatchEvent(new Event("focus"));
      await flushPromises();
      expect(invoke).toHaveBeenCalled();
      await wrapper.get('[data-action="toggle-file-tree"]').trigger("click");
      invoke.mockClear();
      await vi.advanceTimersByTimeAsync(4000);
      window.dispatchEvent(new Event("focus"));
      expect(invoke).not.toHaveBeenCalled();
      await wrapper.get('[data-action="toggle-file-tree"]').trigger("click");
      await flushPromises();
      expect(invoke).toHaveBeenCalled();
    } finally {
      wrapper.unmount();
    }
    invoke.mockClear();
    await vi.advanceTimersByTimeAsync(4000);
    window.dispatchEvent(new Event("focus"));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps listings on refresh failure and ignores a previous project's response", async () => {
    setActivePinia(createPinia());
    const workspace = useWorkspaceStore();
    workspace.hydrate({ name: "first", path: "/first" });
    workspace.files = [{ name: "old.ts", path: "old.ts", kind: "file" }];
    const invoke = vi.mocked(window.pix!.invoke);
    invoke.mockRejectedValueOnce(new Error("Disconnected"));
    await workspace.loadFiles();
    expect(workspace.files[0]?.name).toBe("old.ts");
    let resolve!: (nodes: FileNode[]) => void;
    invoke.mockReturnValueOnce(new Promise<FileNode[]>((done) => { resolve = done; }));
    const pending = workspace.loadFiles();
    workspace.hydrate({ name: "second", path: "/second" });
    resolve([{ name: "stale.ts", path: "stale.ts", kind: "file" }]);
    await pending;
    expect(workspace.files).toEqual([]);
  });
});
