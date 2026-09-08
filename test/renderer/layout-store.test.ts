import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { toRaw } from "vue";
import type { LayoutState, SettingsBundle } from "../../src/shared/types";
import { useLayoutStore } from "../../src/renderer/stores/layout";

const settings = {
  app: {
    language: "system",
    theme: "system",
    density: "comfortable",
    confirmDestructiveActions: true,
    browserHome: "https://pi.dev",
  },
  piGlobal: {},
  piProject: {},
  effective: {},
  paths: { app: "", global: "", project: "" },
} satisfies SettingsBundle;

describe("layout store", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("keeps graph outside the collapsible panel state", async () => {
    const layout = useLayoutStore();
    await layout.setCollapsed("chat", false);
    await layout.openTool("files");

    expect(layout.layout.collapsed).toEqual({
      navigator: true,
      chat: false,
      content: false,
    });
    expect(layout.contentSection).toBe("files");
    expect(layout.contentTabs).toEqual(["files"]);
    expect("graph" in layout.layout.collapsed).toBe(false);
  });

  it("defaults the session navigator to auto-hide and persists its pinned mode", async () => {
    const layout = useLayoutStore();
    expect(layout.layout.navigatorPinned).toBe(false);

    await layout.toggleNavigatorPinned();
    expect(layout.layout.navigatorPinned).toBe(true);
    expect(layout.layout.collapsed.navigator).toBe(false);
    await layout.toggle("navigator");
    expect(layout.layout.navigatorPinned).toBe(true);
    expect(layout.layout.collapsed.navigator).toBe(true);
    await layout.toggleNavigatorPinned();
    expect(layout.layout.navigatorPinned).toBe(false);
    expect(layout.layout.collapsed.navigator).toBe(false);
  });

  it("restores fixed open/closed states and widths, but starts auto-hide closed", () => {
    const layout = useLayoutStore();
    for (const pinned of [true, false]) {
      for (const collapsed of [true, false]) {
        const saved = structuredClone({ ...toRaw(layout.layout), navigatorPinned: pinned,
          widths: { navigator: 312, chat: 356, content: 320 },
          collapsed: { navigator: collapsed, chat: true, content: true } });
        layout.hydrate(settings, saved);
        expect(layout.layout.navigatorPinned).toBe(pinned);
        expect(layout.layout.collapsed.navigator).toBe(pinned ? collapsed : true);
        expect(layout.layout.widths.navigator).toBe(312);
      }
    }
  });

  it("starts with the tool panel closed when no tabs exist", () => {
    const layout = useLayoutStore();
    const savedLayout: LayoutState = {
      widths: { navigator: 248, chat: 356, content: 620 },
      collapsed: { navigator: false, chat: false, content: false },
      minimap: false,
      utility: { open: false, collapsed: false, height: 250, activeTab: "terminal" },
    };

    layout.hydrate(settings, savedLayout);

    expect(layout.contentTabs).toEqual([]);
    expect(layout.layout.collapsed.content).toBe(true);
    expect(savedLayout.collapsed.content).toBe(false);
  });

  it("keeps the chat composer collapsed by default and persists its toggle", async () => {
    const layout = useLayoutStore();
    const savedLayout: LayoutState = {
      widths: { navigator: 248, chat: 356, content: 620 },
      collapsed: { navigator: false, chat: false, content: false },
      minimap: false,
      utility: { open: false, collapsed: false, height: 250, activeTab: "terminal" },
    };
    delete savedLayout.composer;

    layout.hydrate(settings, savedLayout);
    expect(layout.layout.composer.open).toBe(false);

    await layout.setComposerOpen(true);
    expect(layout.layout.composer.open).toBe(true);
  });

  it("migrates inflated legacy side-panel widths once", () => {
    const layout = useLayoutStore();
    layout.hydrate(settings, {
      widths: { navigator: 390, chat: 547, content: 320 },
      collapsed: { navigator: false, chat: false, content: true },
      minimap: false,
      utility: { open: false, collapsed: false, height: 250, activeTab: "terminal" },
    } as LayoutState);

    expect(layout.layout.version).toBe(4);
    expect(layout.layout.widths).toEqual({ navigator: 248, chat: 356, content: 320 });
    expect(layout.layout.collapsed.chat).toBe(true);
  });

  it("collapses the chat panel on hydrate even when it was saved expanded", () => {
    const layout = useLayoutStore();
    layout.hydrate(settings, {
      version: 3,
      widths: { navigator: 248, chat: 356, content: 320 },
      collapsed: { navigator: false, chat: false, content: true },
      minimap: false,
      utility: { open: false, collapsed: false, height: 250, activeTab: "terminal" },
    } as LayoutState);

    expect(layout.layout.collapsed.chat).toBe(true);
  });

  it("keeps the minimap off by default and persists its toggle", async () => {
    const layout = useLayoutStore();
    expect(layout.layout.minimap).toBe(false);
    await layout.toggleMinimap();
    expect(layout.layout.minimap).toBe(true);
  });

  it("keeps multiple tool tabs and selects an adjacent tab when closing", async () => {
    const layout = useLayoutStore();
    await layout.openTool("files");
    await layout.openTool("terminal");
    await layout.openTool("browser");
    await layout.openTool("terminal");

    expect(layout.contentTabs).toEqual(["files", "terminal", "browser"]);
    expect(layout.contentSection).toBe("terminal");

    await layout.closeTool("terminal");
    expect(layout.contentTabs).toEqual(["files", "browser"]);
    expect(layout.contentSection).toBe("browser");

    await layout.closeTool("files");
    await layout.closeTool("browser");
    expect(layout.contentSection).toBe("home");
    expect(layout.layout.collapsed.content).toBe(true);
  });
});
