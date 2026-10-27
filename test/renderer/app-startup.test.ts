import { flushPromises, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/renderer/App.vue";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";
import type { SettingsBundle } from "../../src/shared/types";

describe("app startup welcome", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the project picker usable while bootstrap is pending and after it fails", async () => {
    let rejectBootstrap!: (error: Error) => void;
    const boot = new Promise((_, reject) => { rejectBootstrap = reject; });
    const settings: SettingsBundle = {
      app: { language: "en", theme: "system", density: "comfortable", confirmDestructiveActions: true,
        browserHome: "https://pi.dev", openLastSessionOnStartup: false, enterToSend: true,
        openLinksInApp: true, closeToTray: false, canvasDotGrid: true, canvasDotGridSpacing: 24, canvasDotGridDotSize: 4 },
      piGlobal: {}, piProject: {}, effective: {}, paths: { app: "", global: "", project: "" },
    };
    const project = { name: "picked", path: "/picked" };
    const invoke = vi.spyOn(window.pix!, "invoke").mockImplementation(async (route) => {
      if (route === "app.bootstrap") return boot;
      if (route === "app.pickProject") return { project, sessions: [], projects: [], settings };
      if (route === "git.status") return { available: false, changes: [], clean: true, ahead: 0, behind: 0 };
      return [];
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    const wrapper = shallowMount(App, {
      global: { plugins: [pinia, i18n], stubs: { WelcomeScreen: false, Button: false } },
    });
    try {
      expect(layout.hydrated).toBe(false);
      expect(wrapper.find("[data-welcome]").exists()).toBe(true);
      rejectBootstrap(new Error("bootstrap failed"));
      await flushPromises();
      expect(layout.notice?.message).toBe("bootstrap failed");
      expect(wrapper.find("[data-welcome]").exists()).toBe(true);
      await wrapper.get('[data-action="welcome-open-project"]').trigger("click");
      await flushPromises();
      expect(invoke).toHaveBeenCalledWith("app.pickProject");
      expect(useWorkspaceStore().project?.path).toBe("/picked");
      expect(layout.hydrated).toBe(true);
      expect(wrapper.find("[data-welcome]").exists()).toBe(false);
    } finally {
      wrapper.unmount();
      layout.dismissNotice();
    }
  });
});
