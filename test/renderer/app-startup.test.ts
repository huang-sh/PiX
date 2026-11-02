import { flushPromises, shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/renderer/App.vue";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";
import type { SettingsBundle } from "../../src/shared/types";
import type { HostConnectionState } from "../../src/shared/host-protocol";

const settings: SettingsBundle = {
  app: { language: "en", theme: "system", density: "comfortable", confirmDestructiveActions: true,
    browserHome: "https://pi.dev", openLastSessionOnStartup: false, enterToSend: true,
    openLinksInApp: true, closeToTray: false, canvasDotGrid: true, canvasDotGridSpacing: 24, canvasDotGridDotSize: 4 },
  piGlobal: {}, piProject: {}, effective: {}, paths: { app: "", global: "", project: "" },
};

describe("app startup welcome", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

  it("shows failed transport recovery without immediately retrying the same connection", async () => {
    let emit!: (event: import("../../src/shared/types").DesktopEvent) => void;
    let boots = 0;
    vi.spyOn(window.pix!, "onEvent").mockImplementation(listener => { emit = listener; return () => {}; });
    vi.spyOn(window.pix!, "invoke").mockImplementation(async route => {
      if (route === "app.bootstrap") {
        if (++boots > 1) throw new Error("cleanup timed out");
        return { project: null, sessions: [], projects: [], settings };
      }
      if (route === "app.hostStatus") return { connected: false, version: "0.0.32", error: "cleanup timed out",
        host: { id: "stopping-host", version: "0.0.32", verified: true, stopping: true } };
      return [];
    });
    const pinia = createPinia(); setActivePinia(pinia);
    const wrapper = shallowMount(App, { global: { plugins: [pinia, i18n], stubs: { HostRecovery: false, Button: false, Primitive: false } } });
    try {
      await flushPromises();
      emit({ type: "host.connection", payload: { connected: false } });
      await flushPromises();
      expect(boots).toBe(1);
      expect(wrapper.find("[data-host-recovery]").exists()).toBe(true);
      expect(wrapper.get('[data-action="host-force"]').attributes("disabled")).toBeUndefined();
    } finally { wrapper.unmount(); }
  });

  it("polls cleanup without a blocking reconnect and continues when the old host disappears", async () => {
    vi.useFakeTimers();
    let cleaning = true, boots = 0;
    const invoke = vi.spyOn(window.pix!, "invoke").mockImplementation(async route => {
      if (route === "app.bootstrap") {
        boots++;
        if (cleaning) throw new Error("cleanup timed out");
        return { project: null, sessions: [], projects: [], settings };
      }
      if (route === "app.hostStatus") return { connected: false, version: "0.0.32", ...(cleaning
        ? { host: { id: "stopping-host", version: "0.0.32", verified: true, stopping: true } } : {}) };
      return [];
    });
    const pinia = createPinia(); setActivePinia(pinia);
    const wrapper = shallowMount(App, { global: { plugins: [pinia, i18n], stubs: { HostRecovery: false, Button: false, Primitive: false } } });
    try {
      await flushPromises();
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();
      expect(boots).toBe(1);
      expect(invoke.mock.calls.filter(([route]) => route === "app.hostStatus")).toHaveLength(2);
      expect(wrapper.get('[data-action="host-force"]').attributes("disabled")).toBeUndefined();
      cleaning = false;
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();
      expect(boots).toBe(2);
      expect(wrapper.find("[data-host-recovery]").exists()).toBe(false);
    } finally { wrapper.unmount(); }
  });

  it("ignores a late disconnected status after the transport has recovered", async () => {
    let emit!: (event: import("../../src/shared/types").DesktopEvent) => void;
    let resolveStatus!: (state: HostConnectionState) => void;
    const status = new Promise<HostConnectionState>(resolve => { resolveStatus = resolve; });
    let boots = 0;
    vi.spyOn(window.pix!, "onEvent").mockImplementation(listener => { emit = listener; return () => {}; });
    vi.spyOn(window.pix!, "invoke").mockImplementation(async route => {
      if (route === "app.bootstrap") {
        if (++boots > 1) throw new Error("disconnected");
        return { project: null, sessions: [], projects: [], settings };
      }
      if (route === "app.hostStatus") return status;
      return [];
    });
    const pinia = createPinia(); setActivePinia(pinia);
    const wrapper = shallowMount(App, { global: { plugins: [pinia, i18n], stubs: { HostRecovery: false, Button: false } } });
    try {
      await flushPromises();
      emit({ type: "host.connection", payload: { connected: false } });
      await flushPromises();
      emit({ type: "host.connection", payload: { connected: true } });
      resolveStatus({ connected: false, version: "0.0.32", host: { id: "old-host", version: "0.0.32", verified: true } });
      await flushPromises();
      expect(wrapper.find("[data-host-recovery]").exists()).toBe(false);
      expect(boots).toBe(1);
    } finally { wrapper.unmount(); useLayoutStore().dismissNotice(); }
  });

  it("leaves recovery if a failed manual restart nevertheless restores the transport", async () => {
    let connected = false;
    vi.spyOn(window.pix!, "invoke").mockImplementation(async route => {
      if (route === "app.bootstrap") throw new Error("host unavailable");
      if (route === "app.hostStatus") return { connected, version: "0.0.32",
        host: { id: "host", version: "0.0.32", verified: true } };
      if (route === "app.hostRestart") { connected = true; throw new Error("restart response lost"); }
      return [];
    });
    const pinia = createPinia(); setActivePinia(pinia);
    const wrapper = shallowMount(App, { global: { plugins: [pinia, i18n], stubs: { HostRecovery: false, Button: false } } });
    try {
      await flushPromises();
      await wrapper.get('[data-action="host-force"]').trigger("click");
      await wrapper.get('[data-action="host-force-confirm"]').trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-host-recovery]").exists()).toBe(false);
      expect(useLayoutStore().notice?.message).toBe("restart response lost");
    } finally { wrapper.unmount(); useLayoutStore().dismissNotice(); }
  });

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
