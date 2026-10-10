import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileNode } from "../../src/shared/types";
import ToolPanel from "../../src/renderer/features/tools/ToolPanel.vue";
import FileTree from "../../src/renderer/features/tools/FileTree.vue";
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
    // The tree panel and its handle mount one flush after the group binds
    // (filesMeasured gates them).
    await flushPromises();
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

describe("file tree context menu", () => {
  const nodes: FileNode[] = [
    {
      name: "src",
      path: "src",
      kind: "directory",
      children: [{ name: "app.ts", path: "src/app.ts", kind: "file" }],
    },
    { name: "README.md", path: "README.md", kind: "file" },
  ];

  const mountTree = (props: { local?: boolean }) =>
    mount(FileTree, { props: { nodes, ...props }, global: { plugins: [i18n] } });

  it("offers copy-path and open-external on file rows", async () => {
    const wrapper = mountTree({});
    await wrapper.get('[data-file-path="README.md"]').trigger("contextmenu", { button: 2 });
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-action="tree-copy-path"]')).toHaveLength(1));
    document.querySelector<HTMLElement>('[data-action="tree-copy-path"]')!.click();
    await flushPromises();
    expect(wrapper.emitted("copyPath")?.[0]?.[0]).toMatchObject({ path: "README.md" });

    await wrapper.get('[data-file-path="README.md"]').trigger("contextmenu", { button: 2 });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-action="tree-open-external"]')).toBeTruthy());
    document.querySelector<HTMLElement>('[data-action="tree-open-external"]')!.click();
    await flushPromises();
    expect(wrapper.emitted("openExternal")?.[0]?.[0]).toMatchObject({ path: "README.md" });
    wrapper.unmount();
  });

  it("opens only the nested row's menu, not the ancestor directory's", async () => {
    const wrapper = mountTree({});
    await wrapper.get('[data-file-path="src/app.ts"]').trigger("contextmenu", { button: 2 });
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-action="tree-copy-path"]')).toHaveLength(1));
    wrapper.unmount();
  });

  it("disables opening remote files with local applications", async () => {
    const wrapper = mountTree({ local: false });
    await wrapper.get('[data-file-path="README.md"]').trigger("contextmenu", { button: 2 });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-action="tree-open-external"]')).toBeTruthy());
    expect(document.querySelector('[data-action="tree-open-external"]')!.hasAttribute("data-disabled"))
      .toBe(true);
    wrapper.unmount();
  });

  it("emits openWith from the plain chooser entry on non-Linux platforms", async () => {
    const wrapper = mountTree({});
    await wrapper.get('[data-file-path="README.md"]').trigger("contextmenu", { button: 2 });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-action="tree-open-with"]')).toBeTruthy());
    expect(document.querySelector('[data-action="tree-open-with"]')!.getAttribute("aria-haspopup"))
      .toBeNull();
    document.querySelector<HTMLElement>('[data-action="tree-open-with"]')!.click();
    await flushPromises();
    expect(wrapper.emitted("openWith")?.[0]?.[0]).toMatchObject({ path: "README.md" });
    wrapper.unmount();
  });

  it("lists registered applications in a submenu on Linux", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const apps = [{ id: "code.desktop", name: "Visual Studio Code" }, { id: "writer.desktop", name: "LibreOffice Writer" }];
    const wrapper = mount(FileTree, {
      props: { nodes, local: true, openWithApps: () => apps },
      global: { plugins: [i18n] },
    });
    await wrapper.get('[data-file-path="README.md"]').trigger("contextmenu", { button: 2 });
    await vi.waitFor(() => {
      expect(wrapper.emitted("menuOpen")?.at(-1)?.[0]).toMatchObject({ path: "README.md" });
      expect(document.querySelector('[data-action="tree-open-with"]')).toBeTruthy();
    });
    // reka opens submenus 100ms after a mouse pointermove over the trigger.
    const trigger = document.querySelector<HTMLElement>('[data-action="tree-open-with"]')!;
    const move = new (window.PointerEvent ?? Event)("pointermove", { bubbles: true }) as PointerEvent;
    Object.defineProperty(move, "pointerType", { value: "mouse" });
    trigger.dispatchEvent(move);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-app="code.desktop"]')).toBeTruthy(), 1500);
    expect(document.querySelector('[data-app="none"]')).toBeNull();
    document.querySelector<HTMLElement>('[data-app="code.desktop"]')!.click();
    await flushPromises();
    expect(wrapper.emitted("openWithApp")).toEqual([[{ path: "README.md", name: "README.md", kind: "file" }, "code.desktop"]]);
    platform.mockRestore();
    wrapper.unmount();
  });

  it("shows a placeholder when Linux registers no application for a type", async () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const wrapper = mount(FileTree, {
      props: { nodes, local: true, openWithApps: () => [] },
      global: { plugins: [i18n] },
    });
    await wrapper.get('[data-file-path="README.md"]').trigger("contextmenu", { button: 2 });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-action="tree-open-with"]')).toBeTruthy());
    const trigger = document.querySelector<HTMLElement>('[data-action="tree-open-with"]')!;
    const move = new (window.PointerEvent ?? Event)("pointermove", { bubbles: true }) as PointerEvent;
    Object.defineProperty(move, "pointerType", { value: "mouse" });
    trigger.dispatchEvent(move);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-app="none"]')).toBeTruthy(), 1500);
    platform.mockRestore();
    wrapper.unmount();
  });
});
