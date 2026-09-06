import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeTheme, applyTheme, colorScheme, startTheme } from "../../src/renderer/theme";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { desktop } from "../../src/renderer/api";
import { normalizeTheme, themeColors } from "../../src/shared/theme";
import { validateRouteInput } from "../../src/shared/contracts";
import type { SettingsBundle } from "../../src/shared/types";
import { mount, flushPromises } from "@vue/test-utils";
import SettingsPage from "../../src/renderer/features/settings/SettingsPage.vue";
import { i18n } from "../../src/renderer/i18n";

const bundle = (): SettingsBundle => ({
  app: { theme: "light", language: "en", density: "comfortable", browserHome: "https://pi.dev",
    confirmDestructiveActions: true, enterToSend: true, openLinksInApp: true,
    closeToTray: true, openLastSessionOnStartup: false },
  piGlobal: {}, piProject: {}, effective: {}, paths: { app: "", global: "", project: null },
});

describe("theme lifecycle", () => {
  let media: EventTarget & { matches: boolean };
  let stop: () => void;
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(desktop.invoke).mockReset();
    media = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal("matchMedia", () => media);
    stop = startTheme("light");
  });
  afterEach(() => { stop(); applyTheme("light"); vi.unstubAllGlobals(); });

  it("follows OS changes only in system mode and removes its listener", () => {
    expect(colorScheme.value).toBe("light");
    applyTheme("system");
    expect(colorScheme.value).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--surface")).toBe(themeColors.dark.surface);
    media.matches = false;
    media.dispatchEvent(new Event("change"));
    expect(colorScheme.value).toBe("light");
    applyTheme("dark");
    media.dispatchEvent(new Event("change"));
    expect(colorScheme.value).toBe("dark");
    applyTheme("system");
    stop();
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(colorScheme.value).toBe("light");
  });

  it("keeps classic teal light even on a dark system and restores its palette", () => {
    applyTheme("teal");
    expect(activeTheme.value).toBe("teal");
    expect(colorScheme.value).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#eef2f1");
    expect(normalizeTheme("teal")).toBe("teal");
    expect(validateRouteInput("settings.update", { scope: "app", patch: { theme: "teal" } }).patch).toEqual({ theme: "teal" });
    media.dispatchEvent(new Event("change"));
    expect(activeTheme.value).toBe("teal");
    applyTheme("light");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(themeColors.light.accent);
  });

  it("persists only the theme without changing panels, tabs or settings identity", async () => {
    const layout = useLayoutStore();
    layout.hydrate(bundle());
    layout.layout.collapsed.chat = false;
    layout.contentTabs = ["terminal"];
    layout.layout.collapsed.content = false;
    const panels = layout.layout, settings = layout.settings;
    let finish!: (value: SettingsBundle) => void;
    vi.mocked(desktop.invoke).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = layout.setTheme("dark");
    expect(colorScheme.value).toBe("dark");
    expect(layout.themeSaving).toBe(true);
    await layout.setTheme("light");
    expect(desktop.invoke).toHaveBeenCalledTimes(1);
    expect(desktop.invoke).toHaveBeenCalledWith("settings.update", { scope: "app", patch: { theme: "dark" } });
    const saved = bundle(); saved.app.theme = "dark";
    finish(saved); await saving;
    expect(layout.settings).toBe(settings);
    expect(layout.layout).toBe(panels);
    expect(layout.layout.collapsed.chat).toBe(false);
    expect(layout.contentTabs).toEqual(["terminal"]);
    expect(layout.themeSaving).toBe(false);
    layout.applySettings(saved);
    expect(layout.layout).toBe(panels);
    expect(layout.layout.collapsed.chat).toBe(false);
  });

  it("rolls back a failed save to the current system appearance", async () => {
    const layout = useLayoutStore(), initial = bundle();
    initial.app.theme = "system";
    layout.hydrate(initial);
    vi.mocked(desktop.invoke).mockRejectedValueOnce(new Error("Disk full"));
    const saving = layout.setTheme("light");
    expect(colorScheme.value).toBe("light");
    await expect(saving).rejects.toThrow("Disk full");
    expect(layout.settings?.app.theme).toBe("system");
    expect(colorScheme.value).toBe("dark");
    expect(layout.themeSaving).toBe(false);
  });

  it.each(["dark", "teal"] as const)("auto-saves %s without discarding other draft edits or later overwriting the theme", async (theme) => {
    const layout = useLayoutStore(), saved = bundle();
    layout.hydrate(structuredClone(saved));
    layout.settingsCategory = "appearance";
    layout.layout.collapsed.chat = false;
    vi.mocked(desktop.invoke).mockImplementation(async (route, input) => {
      if (route === "settings.update") Object.assign(saved.app, (input as { patch: object }).patch);
      return structuredClone(saved);
    });
    const wrapper = mount(SettingsPage, { global: { plugins: [i18n] } });
    await wrapper.get('[data-setting-path="density"] select').setValue("compact");
    await wrapper.get('[data-setting-path="theme"] select').setValue(theme);
    await flushPromises();
    expect(saved.app.theme).toBe(theme);
    expect(saved.app.density).toBe("comfortable");
    expect((wrapper.get('[data-setting-path="density"] select').element as HTMLSelectElement).value).toBe("compact");
    await wrapper.get("main > header nav button").trigger("click");
    await flushPromises();
    expect(saved.app.theme).toBe(theme);
    expect(saved.app.density).toBe("compact");
    expect(layout.layout.collapsed.chat).toBe(false);
    wrapper.unmount();
    const reopened = mount(SettingsPage, { global: { plugins: [i18n] } });
    expect((reopened.get('[data-setting-path="theme"] select').element as HTMLSelectElement).value).toBe(theme);
    reopened.unmount();
  });

  it("rejects invalid saved selections and tolerates old malformed configuration", () => {
    for (const theme of [null, [], ["dark"], "sepia", 1]) {
      expect(() => validateRouteInput("settings.update", { scope: "app", patch: { theme } })).toThrow();
      expect(normalizeTheme(theme)).toBe("light");
    }
    expect(validateRouteInput("settings.update", { scope: "global", patch: { theme: "custom-tui" } }).patch).toEqual({ theme: "custom-tui" });
  });

  it("keeps button labels readable in every palette, including hover", () => {
    const luminance = (hex: string) => hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
    for (const colors of Object.values(themeColors)) {
      for (const background of [colors.accent, colors["accent-strong"]]) {
        const levels = [luminance(background), luminance(colors["accent-foreground"])].sort((a, b) => b - a);
        expect((levels[0]! + .05) / (levels[1]! + .05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
