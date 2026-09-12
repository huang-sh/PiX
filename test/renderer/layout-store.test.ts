import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toRaw } from "vue";
import type { LayoutState, SettingsBundle } from "../../src/shared/types";
import { desktop } from "../../src/renderer/api";
import { NOTICE_AUTO_DISMISS_MS, useLayoutStore } from "../../src/renderer/stores/layout";

const settings = {
  app: {
    language: "system",
    theme: "system",
    density: "comfortable",
    confirmDestructiveActions: true,
    browserHome: "https://pi.dev",
    openLastSessionOnStartup: false,
    enterToSend: true,
    openLinksInApp: true,
    closeToTray: true,
    canvasDotGrid: true,
    canvasDotGridSpacing: 24,
    canvasDotGridDotSize: 4,
  },
  piGlobal: {},
  piProject: {},
  effective: {},
  paths: { app: "", global: "", project: "" },
} satisfies SettingsBundle;

describe("layout store", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.useRealTimers());

  it("folds an app-settings write back so the form's full save keeps the key", async () => {
    const layout = useLayoutStore();
    layout.hydrate(settings);
    vi.spyOn(desktop, "invoke").mockResolvedValue({
      ...settings,
      app: { ...settings.app, updateSkippedVersion: "9.9.9" },
    });

    await layout.updateAppSettings({ updateSkippedVersion: "9.9.9" });

    expect(desktop.invoke).toHaveBeenCalledWith("settings.update", {
      scope: "app",
      patch: { updateSkippedVersion: "9.9.9" },
    });
    expect(layout.settings?.app.updateSkippedVersion).toBe("9.9.9");
  });

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

  it("auto-dismisses info and warning notices but keeps errors until clicked", () => {
    vi.useFakeTimers();
    const layout = useLayoutStore();

    layout.showNotice("Copied last Pi response");
    expect(layout.notice?.level).toBe("info");
    vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS - 1);
    expect(layout.notice?.message).toBe("Copied last Pi response");
    vi.advanceTimersByTime(1);
    expect(layout.notice).toBeUndefined();

    layout.showNotice("No assistant response to copy", "warning");
    vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS);
    expect(layout.notice).toBeUndefined();

    layout.showNotice("boom", "error");
    vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS * 10);
    expect(layout.notice?.message).toBe("boom");

    layout.dismissNotice();
    expect(layout.notice).toBeUndefined();
  });

  it("replaces the pending auto-dismiss timer when a new notice arrives", () => {
    vi.useFakeTimers();
    const layout = useLayoutStore();

    layout.showNotice("first");
    vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS / 2);
    layout.showNotice("boom", "error");
    vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS * 10);
    expect(layout.notice?.message).toBe("boom");
  });
});
