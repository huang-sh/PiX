import { flushPromises, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/renderer/App.vue";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";
import type { SettingsBundle } from "../../src/shared/types";

const settings: SettingsBundle = {
  app: { language: "en", theme: "system", density: "comfortable", confirmDestructiveActions: true,
    browserHome: "https://pi.dev", openLastSessionOnStartup: false, enterToSend: true,
    openLinksInApp: true, closeToTray: false, canvasDotGrid: true, canvasDotGridSpacing: 24, canvasDotGridDotSize: 4 },
  piGlobal: {}, piProject: {}, effective: {}, paths: { app: "", global: "", project: "" },
};

describe("app startup welcome", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not reset the workspace layout on a transparent transport reconnect", async () => {
    let emit!: (event: import("../../src/shared/types").DesktopEvent) => void;
    vi.spyOn(window.pix!, "onEvent").mockImplementation(listener => { emit = listener; return () => {}; });
    const invoke = vi.spyOn(window.pix!, "invoke").mockImplementation(async route => {
      if (route === "app.bootstrap") return { project: null, sessions: [], projects: [], settings };
      return [];
    });
    const pinia = createPinia(); setActivePinia(pinia);
    const wrapper = shallowMount(App, { global: { plugins: [pinia, i18n] } });
    try {
      await flushPromises();
      const layout = useLayoutStore();
      layout.layout.collapsed.chat = false;
      emit({ type: "host.connection", payload: { connected: false, reconnecting: true } });
      emit({ type: "host.connection", payload: { connected: true } });
      await flushPromises();
      expect(invoke.mock.calls.filter(([route]) => route === "app.bootstrap")).toHaveLength(1);
      expect(layout.layout.collapsed.chat).toBe(false);
    } finally { wrapper.unmount(); }
  });

  it("leaves host recovery when the transport recovers even if opening the project fails", async () => {
    let connected = false;
    vi.spyOn(window.pix!, "invoke").mockImplementation(async route => {
      if (route === "app.bootstrap") throw new Error(connected ? "Project is unavailable" : "Host is unavailable");
      if (route === "app.hostStatus") return { connected, version: "0.0.32", host: { id: "host", version: "0.0.32", verified: true } };
      return [];
    });
    const pinia = createPinia(); setActivePinia(pinia);
    const wrapper = shallowMount(App, { global: { plugins: [pinia, i18n], stubs: { HostRecovery: false, Button: false } } });
    try {
      await flushPromises();
      expect(wrapper.find("[data-host-recovery]").exists()).toBe(true);
      connected = true;
      await wrapper.get('[data-action="host-retry"]').trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-host-recovery]").exists()).toBe(false);
      expect(useLayoutStore().notice?.message).toBe("Project is unavailable");
    } finally { wrapper.unmount(); useLayoutStore().dismissNotice(); }
  });

  it("keeps the project picker usable while bootstrap is pending and after it fails", async () => {
    let rejectBootstrap!: (error: Error) => void;
    const boot = new Promise((_, reject) => { rejectBootstrap = reject; });
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

  it("keeps a blocked host inside the app and resumes only after an explicit restart confirmation", async () => {
    let restarted = false;
    const invoke = vi.spyOn(window.pix!, "invoke").mockImplementation(async route => {
      if (route === "app.bootstrap") {
        if (!restarted) throw new Error("Host has a different version");
        return { project: null, sessions: [], projects: [], settings };
      }
      if (route === "app.hostStatus") return { connected: false, version: "0.0.32", language: "zh-CN",
        host: { id: "reviewed-host", version: "0.0.31", verified: true, running: 2, clients: 0 } };
      if (route === "app.hostRestart") { restarted = true; return { stopped: true }; }
      if (route === "git.status") return { available: false, changes: [], clean: true, ahead: 0, behind: 0 };
      return [];
    });
    const pinia = createPinia(); setActivePinia(pinia);
    const wrapper = shallowMount(App, { global: { plugins: [pinia, i18n], stubs: { HostRecovery: false, Button: false, WelcomeScreen: false } } });
    try {
      await flushPromises();
      expect(wrapper.get("[data-host-recovery]").text()).toContain("之前的后台仍有任务进行中");
      expect(restarted).toBe(false);
      await wrapper.get('[data-action="host-force"]').trigger("click");
      await wrapper.get('[data-action="host-force-cancel"]').trigger("click");
      expect(restarted).toBe(false);
      await wrapper.get('[data-action="host-force"]').trigger("click");
      await wrapper.get('[data-action="host-force-confirm"]').trigger("click");
      await flushPromises();
      expect(invoke).toHaveBeenCalledWith("app.hostRestart", { id: "reviewed-host", force: true });
      expect(wrapper.find("[data-host-recovery]").exists()).toBe(false);
      expect(useLayoutStore().hydrated).toBe(true);
    } finally { wrapper.unmount(); }
  });
});
