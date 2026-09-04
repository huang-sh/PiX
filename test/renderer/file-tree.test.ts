import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it } from "vitest";
import type { FileNode } from "../../src/shared/types";
import ToolPanel from "../../src/renderer/features/tools/ToolPanel.vue";
import { filterFileTree } from "../../src/renderer/features/tools/file-tree";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";

describe("file tree filtering", () => {
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
  });
});
