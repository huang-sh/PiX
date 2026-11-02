import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import SettingsPage from "../../src/renderer/features/settings/SettingsPage.vue";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { applyDiff } from "../../src/renderer/lib/settings-diff";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { SETTINGS_RELOAD_QUIET_MS, useSessionStore } from "../../src/renderer/stores/session";
import type { SessionSnapshot, SettingsBundle } from "../../src/shared/types";

enableAutoUnmount(afterEach);
afterEach(() => vi.restoreAllMocks());

it("saves queue and connection settings while preserving an unsaved prompt across tabs", async () => {
  const pinia = createPinia(); setActivePinia(pinia);
  i18n.global.locale.value = "en";
  const stored = {
    app: { language: "en", theme: "light", density: "comfortable", promptCustomization: { rules: "Existing rules" } },
    piGlobal: { steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", transport: "auto", retry: { enabled: true } },
    piProject: {}, effective: {}, paths: {},
  } as SettingsBundle;
  const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async (route, raw) => {
    const input = raw as { action?: string; scope?: "app" | "global"; patch?: Record<string, unknown> };
    if (route === "settings.update") {
      applyDiff((input.scope === "app" ? stored.app : stored.piGlobal) as Record<string, unknown>, input.patch!);
      stored.effective = structuredClone(stored.piGlobal);
      return structuredClone(stored);
    }
    if (route === "settings.get") return structuredClone(stored);
    if (route === "agent.control" && input.action === "systemPromptPreview")
      return { text: "Stock", preamble: "Stock", sections: [{ name: "rules", content: "Existing rules" }] };
    return [];
  });
  const layout = useLayoutStore();
  layout.applySettings(structuredClone(stored));
  layout.settingsCategory = "agent";
  const wrapper = mount(SettingsPage, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
  await flushPromises();
  await wrapper.get('[data-prompt-block="rules"] button').trigger("click");
  await wrapper.get('[data-prompt-editor-text]').setValue("Unsaved rules");

  const switchTab = async (name: string) => {
    await wrapper.get(`[data-agent-tab="${name}"]`).trigger("mousedown", { button: 0, ctrlKey: false });
    await flushPromises();
    expect(wrapper.get(`[data-agent-tab="${name}"]`).attributes("aria-selected")).toBe("true");
    for (const panel of wrapper.findAll('[data-agent-panel]'))
      expect(panel.isVisible()).toBe(panel.attributes("data-agent-panel") === name);
  };
  await switchTab("queue");
  await wrapper.get('[data-setting-path="steeringMode"] select').setValue("all"); await flushPromises();
  await wrapper.get('[data-setting-path="followUpMode"] select').setValue("all"); await flushPromises();
  expect(stored.piGlobal.steeringMode).toBe("all");
  expect(stored.piGlobal.followUpMode).toBe("all");

  await switchTab("connection");
  await wrapper.get('[data-setting-path="transport"] select').setValue("websocket"); await flushPromises();
  await wrapper.get('[data-setting-path="retry.enabled"] input').setValue(false); await flushPromises();
  expect(stored.piGlobal.transport).toBe("websocket");
  expect(stored.piGlobal.retry?.enabled).toBe(false);

  await switchTab("prompts");
  expect(wrapper.get<HTMLTextAreaElement>('[data-prompt-editor-text]').element.value).toBe("Unsaved rules");
  expect(stored.app.promptCustomization).toEqual({ rules: "Existing rules" });
  const updates = invoke.mock.calls.filter(([route]) => route === "settings.update").map(([, input]) => input);
  expect(updates).toEqual([
    { scope: "global", patch: { steeringMode: "all" } },
    { scope: "global", patch: { followUpMode: "all" } },
    { scope: "global", patch: { transport: "websocket" } },
    { scope: "global", patch: { retry: { enabled: false } } },
  ]);
  expect(invoke.mock.calls.filter(([route, input]) => route === "agent.control"
    && (input as { action?: string }).action === "systemPromptPreview")).toHaveLength(1);
});

it.each(["no session", "idle", "streaming"])("refreshes the content-style addendum automatically with %s", async mode => {
  vi.useFakeTimers();
  let wrapper: ReturnType<typeof mount> | undefined;
  try {
    const pinia = createPinia(); setActivePinia(pinia);
    i18n.global.locale.value = "en";
    const stored = { app: { language: "en", theme: "light", density: "comfortable" }, piGlobal: {}, piProject: {}, effective: {}, paths: {} } as SettingsBundle;
    const session = useSessionStore();
    if (mode !== "no session") session.current = { session: { path: "style.jsonl" },
      projection: { nodes: [] }, runtime: { isStreaming: mode === "streaming" } } as unknown as SessionSnapshot;
    let runtimeStyle: unknown;
    const invoke = vi.spyOn(desktop, "invoke").mockClear().mockImplementation(async (route, raw) => {
      const input = raw as { action?: string; patch?: Record<string, unknown> };
      if (route === "settings.update") {
        applyDiff(stored.piGlobal, input.patch!);
        stored.effective = { ...stored.piGlobal };
        return structuredClone(stored);
      }
      if (route === "settings.get") return structuredClone(stored);
      if (route === "agent.control") {
        if (input.action === "getSkills") return [{ name: "sample-style", outputStyle: true, disableModelInvocation: false }];
        if (input.action === "reload") { runtimeStyle = stored.piGlobal.outputStyle; return {}; }
        if (input.action === "systemPromptPreview") {
          const style = mode === "no session" ? stored.piGlobal.outputStyle : runtimeStyle;
          return { text: "Stock", preamble: "Stock", sections: [{ name: "addendum", content: style ? `Use ${style}` : "Default format rules" }] };
        }
      }
      return [];
    });
    const layout = useLayoutStore(); layout.applySettings(structuredClone(stored)); layout.settingsCategory = "agent";
    wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } }); await flushPromises();
    const addendum = () => wrapper!.get('[data-prompt-block="addendum"] pre').text();
    expect(addendum()).toBe("Default format rules");
    const select = wrapper.get('[data-setting-path="outputStyle"] select');
    await select.setValue("sample-style"); await flushPromises();
    if (mode === "streaming") {
      await vi.advanceTimersByTimeAsync(SETTINGS_RELOAD_QUIET_MS);
      expect(addendum()).toBe("Default format rules");
      expect(wrapper.find('[data-prompt-waiting]').exists()).toBe(true);
      expect(invoke.mock.calls.some(([, raw]) => (raw as { action?: string })?.action === "reload")).toBe(false);
      session.current!.runtime.isStreaming = false;
    }
    await vi.advanceTimersByTimeAsync(SETTINGS_RELOAD_QUIET_MS); await flushPromises();
    expect(addendum()).toBe("Use sample-style");
    await select.setValue(""); await flushPromises();
    await vi.advanceTimersByTimeAsync(SETTINGS_RELOAD_QUIET_MS); await flushPromises();
    expect(addendum()).toBe("Default format rules");
  } finally { wrapper?.unmount(); vi.useRealTimers(); }
});
