import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomModelInput, RuntimeExtension, RuntimeModel, RuntimeProvider, RuntimeSkill, SettingsBundle } from "../../src/shared/types";
import { desktop } from "../../src/renderer/api";
import SettingsPage from "../../src/renderer/features/settings/SettingsPage.vue";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";
import { version } from "../../package.json";

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

type UpdatePayload = { scope?: string; patch?: Record<string, unknown>; replace?: boolean };

function updateCalls(): UpdatePayload[] {
  return vi
    .mocked(desktop.invoke)
    .mock.calls.filter(([route]) => route === "settings.update")
    .map(([, payload]) => payload as UpdatePayload);
}

describe("SettingsPage save", () => {
  beforeEach(() => {
    vi.mocked(desktop.invoke).mockReset();
    vi.mocked(desktop.invoke).mockImplementation(async () => settings);
  });

  it("opens About from settings and links to releases and source, with localized errors", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    const previousLocale = i18n.global.locale.value;
    try {
      i18n.global.locale.value = "en";
      await wrapper.get('[data-settings-category="about"]').trigger("click");
      expect(wrapper.get("#about-name").text()).toBe("PiX");
      expect(wrapper.get(".about-version").text()).toBe(`Version ${version}`);
      expect(wrapper.get(".about-logo").attributes("src")).toBe("icon.png");
      expect(wrapper.find("main > header nav").exists()).toBe(false);
      expect(wrapper.findAll(".settings-card").filter(card => card.isVisible())).toHaveLength(0);
      await wrapper.get("[data-about-updates]").trigger("click");
      await flushPromises();
      expect(desktop.invoke).toHaveBeenCalledWith("app.openExternal", { url: "https://github.com/huang-sh/PiX/releases" });
      await wrapper.get("[data-about-source]").trigger("click");
      await flushPromises();
      expect(desktop.invoke).toHaveBeenCalledWith("app.openExternal", { url: "https://github.com/huang-sh/PiX" });
      i18n.global.locale.value = "zh-CN";
      vi.mocked(desktop.invoke).mockRejectedValueOnce(new Error("Browser unavailable"));
      await wrapper.get("[data-about-source]").trigger("click");
      await flushPromises();
      expect(wrapper.get("main > header h1").text()).toBe("关于");
      expect(wrapper.get(".about-version").text()).toBe(`版本 ${version}`);
      expect(wrapper.get('[role="alert"]').text()).toBe("无法打开链接，请重试。");
      await wrapper.get("[data-about-source]").trigger("click");
      await flushPromises();
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      await wrapper.get('[data-settings-category="general"]').trigger("click");
      expect(wrapper.find(".about-page").exists()).toBe(false);
      expect(wrapper.find("main > header nav").exists()).toBe(true);
    } finally {
      i18n.global.locale.value = previousLocale;
      wrapper.unmount();
    }
  });

  it("sends IPC payloads that survive structured clone when switching language", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });

    await wrapper.get('[data-setting-path="language"] select').setValue("zh-CN");
    await wrapper.get("main > header nav button").trigger("click");
    await flushPromises();

    const updates = updateCalls();
    expect(updates.find((payload) => payload.scope === "app")?.patch).toMatchObject({
      language: "zh-CN",
    });
    // Electron IPC serializes arguments with the structured clone algorithm,
    // which rejects Vue reactive proxies with "An object could not be cloned."
    for (const payload of updates) expect(() => structuredClone(payload)).not.toThrow();
    expect(layout.notice?.level).toBe("info");
  });

  it("adds a custom model and refreshes the shared picker catalog", async () => {
    const available: RuntimeModel[] = [];
    const providers: RuntimeProvider[] = [];
    vi.mocked(desktop.invoke).mockImplementation(async (route, payload) => {
      if (route !== "agent.control") return settings;
      const v = payload as Record<string, unknown>;
      if (v.action === "getModels") return [...available];
      if (v.action === "getProviders") return [...providers];
      if (v.action === "addCustomModel") {
        expect(() => structuredClone(payload)).not.toThrow();
        expect(v).toMatchObject({ provider: "local-llm", modelId: "custom-model", api: "openai-completions", apiKey: "pix-local", contextWindow: 64000, maxTokens: 16384 });
        available.push({ provider: "local-llm", id: "custom-model", contextWindow: 64000 });
        providers.push({ id: "local-llm", name: "local-llm", authTypes: ["api_key"], status: { type: "api_key" } });
        return { ok: true };
      }
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "models";
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();
    await wrapper.get("[data-add-custom-model]").trigger("click");
    await wrapper.get('[name="provider"]').setValue("local-llm");
    await wrapper.get('[name="modelId"]').setValue("custom-model");
    await wrapper.get('[name="baseUrl"]').setValue("http://localhost:11434/v1");
    await wrapper.get('[name="contextWindow"]').setValue("64000");
    await wrapper.get('[name="keyless"]').setValue(true);
    expect(wrapper.find('[name="apiKey"]').exists()).toBe(false);
    await wrapper.get("[data-custom-model-form]").trigger("submit");
    await flushPromises();
    expect(wrapper.find("[data-custom-model-form]").exists()).toBe(false);
    expect(useSessionStore().models).toEqual(available);
    expect(wrapper.find('[data-provider="local-llm"]').exists()).toBe(true);
    expect(wrapper.get("#model-details-panel").text()).toContain("custom-model");
    wrapper.unmount();
  });

  it("edits an unavailable custom model, preserves blank credentials and reloads saved settings", async () => {
    let model: CustomModelInput = { provider: "custom", modelId: "vision", name: "Vision", baseUrl: "https://example.com/v1", api: "openai-completions", contextWindow: 64000, maxTokens: 4096, reasoning: false, imageInput: false };
    let fail = true;
    vi.mocked(desktop.invoke).mockImplementation(async (_route, payload) => {
      const v = payload as Record<string, unknown>;
      if (v?.action === "getCustomModels") return [{ ...model }];
      if (v?.action === "updateCustomModel") {
        expect(() => structuredClone(payload)).not.toThrow();
        expect(v).toMatchObject({ provider: "custom", modelId: "vision", apiKey: "", imageInput: true, reasoning: true, baseUrl: "https://new.example.com/v1", maxTokens: 8192 });
        if (fail) throw new Error("Save failed");
        const { action, apiKey, ...saved } = v;
        model = saved as unknown as CustomModelInput;
        return { ok: true };
      }
      return [];
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "models";
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();
    await wrapper.get('[data-provider-configure="custom"]').trigger("click");
    await wrapper.get('[data-edit-custom-model="custom/vision"]').trigger("click");
    expect((wrapper.get('[name="baseUrl"]').element as HTMLInputElement).value).toBe(model.baseUrl);
    expect(wrapper.get('[name="modelId"]').attributes("readonly")).toBeDefined();
    expect((wrapper.get('[name="apiKey"]').element as HTMLInputElement).value).toBe("");
    await wrapper.get('[name="baseUrl"]').setValue("https://new.example.com/v1");
    await wrapper.get('[name="imageInput"]').setValue(true);
    await wrapper.get('[name="reasoning"]').setValue(true);
    await wrapper.get('[name="maxTokens"]').setValue(8192);
    await wrapper.get("form[data-custom-model-form]").trigger("submit");
    await flushPromises();
    expect(wrapper.get('[data-custom-model-form] [role="alert"]').text()).toBe("Save failed");
    fail = false;
    await wrapper.get("form[data-custom-model-form]").trigger("submit");
    await flushPromises();
    expect(wrapper.find("[data-custom-model-form]").exists()).toBe(false);
    await wrapper.get('[data-edit-custom-model="custom/vision"]').trigger("click");
    expect((wrapper.get('[name="imageInput"]').element as HTMLInputElement).checked).toBe(true);
    expect((wrapper.get('[name="maxTokens"]').element as HTMLInputElement).value).toBe("8192");
    wrapper.unmount();
  });

  it("keeps provider management, default and cycling controls alongside custom model editing", async () => {
    const custom: CustomModelInput = { provider: "custom", modelId: "vision", baseUrl: "https://example.com/v1", api: "openai-completions", contextWindow: 64000, maxTokens: 4096, reasoning: true, imageInput: true };
    vi.mocked(desktop.invoke).mockImplementation(async (route, payload) => {
      if (route !== "agent.control") return settings;
      const v = payload as Record<string, unknown>;
      if (v.action === "getCustomModels") return [{ ...custom }];
      if (v.action === "getModels") return [{ provider: "custom", id: "vision" }];
      if (v.action === "getProviders") return [
        { id: "custom", name: "Custom", authTypes: ["api_key"], status: { type: "api_key" } },
        { id: "other", name: "Other", authTypes: ["oauth"] },
      ];
      if (v.action === "updateCustomModel") return { ok: true };
      return [];
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "models";
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();
    expect(wrapper.find('[data-custom-model-list]').exists()).toBe(false);
    await wrapper.get('[data-provider-configure="custom"]').trigger("click");
    expect(wrapper.find('[data-provider-api-key="custom"]').exists()).toBe(true);
    expect(wrapper.find('.provider-remove').exists()).toBe(true);
    expect(wrapper.find('[data-edit-custom-model="custom/vision"]').exists()).toBe(true);
    await wrapper.get('[data-provider="custom"] .provider-model-toggle').trigger("click");
    expect(wrapper.find('[data-model-action="default"]').exists()).toBe(true);
    expect(wrapper.find('[data-model="custom/vision"] .model-cycle').exists()).toBe(true);
    await wrapper.get('[data-edit-custom-model="custom/vision"]').trigger("click");
    expect(wrapper.find('[role="dialog"] [data-custom-model-form]').exists()).toBe(true);
    await wrapper.get('[data-custom-model-form]').trigger("submit");
    await flushPromises();
    expect(wrapper.find('[data-custom-model-form]').exists()).toBe(false);
    expect(wrapper.find('[data-model-action="default"]').exists()).toBe(true);
    expect(wrapper.find('[data-model="custom/vision"] .model-cycle').exists()).toBe(true);
    expect(wrapper.find('[data-provider-configure="custom"]').exists()).toBe(true);
    expect(wrapper.find('[data-provider="other"]').exists()).toBe(true);
    expect((wrapper.get('[data-model-search]').element as HTMLInputElement).value).toBe("");
    wrapper.unmount();
  });

  it("keeps provider management available when custom model loading fails", async () => {
    vi.mocked(desktop.invoke).mockImplementation(async (_route, payload) => {
      const v = payload as Record<string, unknown>;
      if (v?.action === "getCustomModels") throw new Error("Invalid models.json");
      if (v?.action === "getProviders") return [{ id: "custom", name: "Custom", authTypes: ["api_key"] }];
      return [];
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "models";
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();
    expect(wrapper.text()).toContain("Invalid models.json");
    await wrapper.get('[data-provider-configure="custom"]').trigger("click");
    expect(wrapper.find('[data-provider-api-key="custom"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("retains custom model input and shows save errors", async () => {
    vi.mocked(desktop.invoke).mockImplementation(async (_route, payload) => {
      if ((payload as { action?: string })?.action === "addCustomModel") throw new Error("Invalid model endpoint");
      return [];
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "models";
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();
    await wrapper.get("[data-add-custom-model]").trigger("click");
    await wrapper.get('[name="provider"]').setValue("my-provider");
    await wrapper.get("[data-custom-model-form]").trigger("submit");
    await flushPromises();
    expect(wrapper.get('[data-custom-model-form] [role="alert"]').text()).toContain("Invalid model endpoint");
    expect((wrapper.get('[name="provider"]').element as HTMLInputElement).value).toBe("my-provider");
    expect(wrapper.get('[type="submit"]').attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("keeps provider credentials hidden until configuration is requested", async () => {
    const models: RuntimeModel[] = [{ provider: "openai", id: "gpt-test" }];
    const providers: RuntimeProvider[] = [
      { id: "openai", name: "OpenAI", authTypes: ["api_key"] },
      { id: "deepseek", name: "DeepSeek", authTypes: ["api_key"], status: { type: "api_key", source: "stored credential" } },
    ];
    vi.mocked(desktop.invoke).mockImplementation(async (route, payload) => {
      if (route === "agent.control") {
        const action = (payload as { action?: string })?.action;
        if (action === "getModels") return models;
        if (action === "getProviders") return providers;
      }
      return settings;
    });

    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "models";
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();

    expect(wrapper.find("[data-provider-api-key=openai]").exists()).toBe(false);
    expect(wrapper.get("[data-provider=deepseek] .provider-status").text()).toContain("Connected");

    await wrapper.get("[data-provider-configure=openai]").trigger("click");
    expect(wrapper.get("[data-provider-api-key=openai]").isVisible()).toBe(true);
  });

  it("filters providers, selects a default model, and retains providers after refresh fails", async () => {
    const models: RuntimeModel[] = [
      { provider: "openai", id: "gpt-base", name: "Base", contextWindow: 128000, reasoning: true },
      { provider: "openai", id: "gpt-fast", name: "Fast" },
    ];
    const providers: RuntimeProvider[] = [
      { id: "openai", name: "OpenAI", authTypes: ["api_key"], status: { type: "api_key" } },
      { id: "other", name: "Other", authTypes: ["oauth"] },
    ];
    const initial = { ...settings, effective: { defaultProvider: "openai", defaultModel: "gpt-base" } };
    vi.mocked(desktop.invoke).mockImplementation(async (route, payload) => {
      if (route === "agent.control") {
        const action = (payload as { action: string }).action;
        return action === "getCustomModels" ? [] : action === "getModels" ? models : providers;
      }
      if (route === "settings.update") return { ...initial, effective: { ...initial.effective, ...(payload as UpdatePayload).patch } };
      return initial;
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(initial);
    layout.settingsCategory = "models";
    const wrapper = mount(SettingsPage, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
    await flushPromises();

    expect(wrapper.get('[data-default-model]').text()).toBe("gpt-base");
    await wrapper.get('[data-provider-filter="configured"]').trigger("click");
    expect(wrapper.find('[data-provider="other"]').exists()).toBe(false);
    expect(wrapper.get('[data-provider-filter="configured"]').attributes('aria-pressed')).toBe("true");
    await wrapper.get('[data-provider-filter="all"]').trigger("click");
    await wrapper.get('[data-model-search]').setValue("Fast");
    expect(wrapper.findAll('[data-provider]')).toHaveLength(1);
    await wrapper.get('[data-model-search]').setValue("missing-model");
    expect(wrapper.get('.model-empty').text()).toContain("No matching providers or models");
    await wrapper.get('.model-empty button').trigger("click");
    expect(wrapper.findAll('[data-provider]')).toHaveLength(2);

    const modelToggle = wrapper.get('[data-provider="openai"] .provider-model-toggle');
    await modelToggle.trigger("click");
    await flushPromises();
    expect(wrapper.get('#model-details-title').text()).toBe("OpenAI");
    expect(wrapper.find('[data-provider="openai"] [data-provider-models]').exists()).toBe(false);
    expect(wrapper.get('.model-inspector > .model-actions').exists()).toBe(true);
    expect(document.activeElement).toBe(wrapper.get('.settings-inspector-close').element);
    await wrapper.get('.model-inspector').trigger("keydown", { key: "Escape" });
    expect(wrapper.find('.model-inspector').exists()).toBe(false);
    expect(document.activeElement).toBe(modelToggle.element);
    await modelToggle.trigger("click");
    expect(wrapper.get('[data-model="openai/gpt-base"]').text()).toContain("128,000 token context");
    expect(wrapper.get('[data-model-action="default"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-model="openai/gpt-fast"] .model-select').trigger("click");
    expect(wrapper.get('[data-model="openai/gpt-fast"] .model-select').attributes('aria-pressed')).toBe("true");
    expect(wrapper.get('.model-actions').text()).toContain("gpt-fast");
    await wrapper.get('[data-model-action="default"]').trigger("click");
    await flushPromises();
    expect(updateCalls().at(-1)?.patch).toEqual({ defaultProvider: "openai", defaultModel: "gpt-fast" });
    expect(wrapper.get('[data-default-model]').text()).toBe("gpt-fast");

    vi.mocked(desktop.invoke).mockRejectedValueOnce(new Error("Connection lost"));
    await wrapper.get('[data-model-refresh]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Connection lost");
    expect(wrapper.findAll('[data-provider]')).toHaveLength(2);
    await wrapper.get('[data-model-refresh]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);

    await wrapper.get('[data-provider-configure="other"]').trigger("click");
    expect(wrapper.find('[data-provider-models]').exists()).toBe(false);
    expect(wrapper.get('#model-details-title').text()).toBe("Other");
    expect(wrapper.find('[data-provider="other"] .provider-setup').exists()).toBe(false);
    expect(wrapper.get('.model-inspector [data-provider-setup="other"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-provider-oauth="other"]')).toHaveLength(2);
    await wrapper.get('.settings-inspector-close').trigger("click");
    expect(wrapper.find('.model-inspector').exists()).toBe(false);
    expect(wrapper.classes()).not.toContain("has-details-panel");
    wrapper.unmount();
  });

  it("forces a catalog refresh only on click and updates the composer after it completes", async () => {
    let finishRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => { finishRefresh = resolve; });
    const available: RuntimeModel[] = [{ provider: "openai", id: "existing-model" }];
    vi.mocked(desktop.invoke).mockImplementation(async (route, payload) => {
      if (route !== "agent.control") return settings;
      const action = (payload as { action: string }).action;
      if (action === "getModels") return [...available];
      if (action === "getCustomModels") return [];
      if (action === "refreshModels") {
        await refresh;
        available.push({ provider: "openai", id: "new-model" });
        return { ok: true };
      }
      return [{ id: "openai", name: "OpenAI", authTypes: ["api_key"], status: { type: "api_key" } }];
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "models";
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();
    expect(vi.mocked(desktop.invoke)).not.toHaveBeenCalledWith("agent.control", { action: "refreshModels" });
    vi.mocked(desktop.invoke).mockClear();
    await wrapper.get('[data-model-refresh]').trigger("click");
    expect(wrapper.get('[data-model-refresh]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-model-refresh]').text()).toContain("Refreshing");
    await wrapper.get('[data-model-refresh]').trigger("click");
    expect(vi.mocked(desktop.invoke).mock.calls).toEqual([["agent.control", { action: "refreshModels" }]]);
    expect(wrapper.find('[data-provider="openai"]').exists()).toBe(true);
    finishRefresh();
    await flushPromises();
    expect(vi.mocked(desktop.invoke).mock.calls.slice(1)).toEqual([
      ["agent.control", { action: "getCustomModels" }],
      ["agent.control", { action: "getModels" }], ["agent.control", { action: "getProviders" }],
    ]);
    expect(useSessionStore().models.map(model => model.id)).toContain("new-model");
    expect(layout.notice?.message).toContain("Model catalogs refreshed");
    expect(wrapper.get('[data-model-refresh]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-provider="openai"] .provider-model-toggle').trigger("click");
    expect(wrapper.find('[data-model="openai/new-model"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("updates the shared model list used by the graph after saving an API key", async () => {
    const available: RuntimeModel[] = [{ provider: "openai", id: "existing-model" }];
    const providers: RuntimeProvider[] = [{ id: "openai", name: "OpenAI", authTypes: ["api_key"] }];
    vi.mocked(desktop.invoke).mockImplementation(async (route, payload) => {
      if (route !== "agent.control") return settings;
      const action = (payload as { action?: string }).action;
      if (action === "getModels") return [...available];
      if (action === "getProviders") return providers;
      if (action === "loginApiKey") {
        available.push({ provider: "openai", id: "new-model" });
        return { ok: true };
      }
      return {};
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "models";
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();

    const store = useSessionStore();
    expect(store.models.map((model) => model.id)).toEqual(["existing-model"]);

    await wrapper.get('[data-provider-configure="openai"]').trigger("click");
    await wrapper.get('[data-provider-api-key="openai"]').setValue("sk-test");
    await wrapper.get("form.provider-auth").trigger("submit");
    await flushPromises();

    // The store list — what the graph and branch-context pickers read — must
    // pick up the model the new credential unlocked without a restart, session
    // reopen, or manual catalog refresh.
    expect(store.models.map((model) => model.id)).toEqual(["existing-model", "new-model"]);
    wrapper.unmount();
  });

  it("re-points the settings selection when logout removes the selected model", async () => {
    let available: RuntimeModel[] = [
      { provider: "openai", id: "gpt-base" },
      { provider: "openai", id: "gpt-fast" },
    ];
    const providers: RuntimeProvider[] = [
      { id: "openai", name: "OpenAI", authTypes: ["api_key"], status: { type: "api_key" } },
    ];
    vi.mocked(desktop.invoke).mockImplementation(async (route, payload) => {
      if (route !== "agent.control") return settings;
      const action = (payload as { action?: string }).action;
      if (action === "getModels") return [...available];
      if (action === "getProviders") return providers;
      if (action === "logout") {
        available = [available[0]];
        return { ok: true };
      }
      return {};
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "models";
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();

    await wrapper.get('[data-provider="openai"] .provider-model-toggle').trigger("click");
    await wrapper.get('[data-model="openai/gpt-fast"] .model-select').trigger("click");
    expect(wrapper.get(".model-actions").text()).toContain("gpt-fast");

    await wrapper.get('[data-provider-configure="openai"]').trigger("click");
    await wrapper.get('[data-provider-setup="openai"] .provider-remove').trigger("click");
    await flushPromises();

    // The selected model disappeared with the credential; the selection must
    // fall back to a real model instead of dangling on a missing one.
    await wrapper.get('[data-provider="openai"] .provider-model-toggle').trigger("click");
    expect(wrapper.get(".model-actions").text()).toContain("gpt-base");
    wrapper.unmount();
  });

  it("shows, filters, and refreshes skills detected by Pi", async () => {
    const skills: RuntimeSkill[] = [
      { name: "docx", description: "Create Word documents", path: "/home/me/.pi/agent/skills/docx/SKILL.md", source: "local", scope: "user", disableModelInvocation: false, editable: true },
      { name: "project-review", description: "Review this project", path: "/project/.pi/skills/review/SKILL.md", source: "local", scope: "project", disableModelInvocation: true, editable: true },
    ];
    vi.mocked(desktop.invoke).mockImplementation(async (route) =>
      route === "agent.control" ? skills : settings,
    );

    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "skills";
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();

    expect(wrapper.get('[data-skill="docx"]').text()).toContain("Create Word documents");
    expect(wrapper.get('[data-skill="docx"] [data-skill-manual]').attributes("aria-checked")).toBe("false");
    // The switch is the only place an editable skill states this, so no chip
    // repeats it next to it.
    expect(wrapper.get('[data-skill="project-review"] [data-skill-manual]').attributes("aria-checked")).toBe("true");
    expect(wrapper.get('[data-skill="project-review"]').text()).not.toContain("manual only");
    await wrapper.get("[data-skill-search]").setValue("Word");
    expect(wrapper.find('[data-skill="project-review"]').exists()).toBe(false);

    await wrapper.get('.skill-card button[title="Refresh skills"]').trigger("click");
    await flushPromises();
    expect(vi.mocked(desktop.invoke)).toHaveBeenCalledWith("agent.control", { action: "getSkills", reload: true });
  });

  it("creates, edits, toggles, and deletes editable skills", async () => {
    const skills: RuntimeSkill[] = [
      { name: "docx", description: "Create Word documents", path: "/home/me/.pi/agent/skills/docx/SKILL.md", source: "local", scope: "user", disableModelInvocation: false, editable: true, shadowsBuiltin: "/app/resources/skills/docx/SKILL.md" },
      { name: "bundled", description: "Ships with a package", path: "/app/pkg/skills/bundled/SKILL.md", source: "cli", scope: "temporary", disableModelInvocation: false, editable: false },
      { name: "zotero-cli", description: "Read and write a Zotero library", path: "/app/resources/skills/zotero-cli/SKILL.md", source: "local", scope: "builtin", disableModelInvocation: false, editable: false },
    ];
    const calls: Record<string, unknown>[] = [];
    vi.mocked(desktop.invoke).mockImplementation(async (route, payload) => {
      if (route !== "agent.control") return settings;
      const input = payload as Record<string, unknown>;
      calls.push(input);
      if (input.action === "getSkills") return skills;
      if (input.action === "getSkill")
        return { path: input.path, name: "docx", description: "Create Word documents", body: "# docx", disableModelInvocation: false };
      if (input.action === "createSkill") return { path: "/home/me/.pi/agent/skills/new-skill/SKILL.md" };
      if (input.action === "updateSkill") return { path: input.path };
      return { ok: true };
    });

    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "skills";
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();

    // A skill outside the editable folders offers a read-only viewer, never
    // an edit or delete; a packaged (temporary) one has no manual switch.
    const bundled = wrapper.get('[data-skill="bundled"]');
    expect(bundled.find(".skill-action-delete").exists()).toBe(false);
    expect(bundled.find("[data-skill-manual]").exists()).toBe(false);
    expect(bundled.text()).toContain("Read-only");
    // A row shadowing a same-named bundled skill says so, path on hover.
    expect(wrapper.get('[data-skill="docx"]').text()).toContain("Shadows built-in");
    // A builtin skill is read-only but its manual-only switch works.
    const builtin = wrapper.get('[data-skill="zotero-cli"]');
    expect(builtin.find("[data-skill-manual]").exists()).toBe(true);
    await builtin.get("[data-skill-manual]").trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.action === "setSkillManualOnly")).toMatchObject({
      path: "/app/resources/skills/zotero-cli/SKILL.md",
      manualOnly: true,
    });
    // The viewer opens the shared sheet without a save control.
    await bundled.get("[data-skill-view]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-skill-form]").exists()).toBe(true);
    expect(wrapper.find("[data-skill-save]").exists()).toBe(false);
    await wrapper.find("[data-skill-form] button[type=button]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-skill-form]").exists()).toBe(false);

    await wrapper.get('[data-skill="docx"] [data-skill-manual]').trigger("click");
    await flushPromises();
    expect(calls.filter((call) => call.action === "setSkillManualOnly").at(-1)).toMatchObject({
      path: "/home/me/.pi/agent/skills/docx/SKILL.md",
      manualOnly: true,
    });

    // The delete button arms on the first press and only then removes.
    const remove = wrapper.get('[data-skill="docx"] .skill-actions button:last-child');
    await remove.trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.action === "deleteSkill")).toBe(false);
    await remove.trigger("click");
    await flushPromises();
    expect(calls.find((call) => call.action === "deleteSkill")).toMatchObject({
      path: "/home/me/.pi/agent/skills/docx/SKILL.md",
    });

    await wrapper.get("[data-skill-new]").trigger("click");
    // Typing a name must not nag about the description the user has not
    // reached yet; the form only speaks once a field is left behind empty.
    await wrapper.get("[data-skill-name]").setValue("PDF Tools");
    expect(wrapper.find(".skill-sheet-error").exists()).toBe(false);
    expect((wrapper.get("[data-skill-save]").element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.get("[data-skill-description]").trigger("blur");
    expect(wrapper.get(".skill-sheet-error").text()).toContain("Description is required");
    // A readable name is accepted and stored as its slug.
    await wrapper.get("[data-skill-description]").setValue("A new skill");
    await wrapper.get("form[data-skill-form]").trigger("submit");
    await flushPromises();
    expect(calls.find((call) => call.action === "createSkill")).toMatchObject({
      scope: "user",
      name: "pdf-tools",
      description: "A new skill",
      disableModelInvocation: false,
    });
    expect(wrapper.find("form[data-skill-form]").exists()).toBe(false);

    await wrapper.get('[data-skill="docx"] .skill-actions .skill-action').trigger("click");
    await flushPromises();
    expect(calls.some((call) => call.action === "getSkill")).toBe(true);
    expect((wrapper.get("[data-skill-name]").element as HTMLInputElement).value).toBe("docx");
  });

  it("shows, filters, and refreshes extensions detected by Pi", async () => {
    const extensions: RuntimeExtension[] = [
      { path: "/project/.pi/extensions/reviewer/index.ts", resolvedPath: "/project/.pi/extensions/reviewer/index.ts", source: "local", scope: "project", tools: [{ name: "review", description: "Review changed files" }, { name: "summarize" }], commands: [{ name: "review", description: "Start a review" }] },
      { path: "/home/me/.pi/agent/extensions/status.ts", resolvedPath: "/home/me/.pi/agent/extensions/status.ts", source: "local", scope: "user", tools: [], commands: [{ name: "status" }] },
      { path: "/app/pi-builtin/node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts", resolvedPath: "/app/pi-builtin/node_modules/@injaneity/pi-computer-use/extensions/computer-use.ts", source: "cli", scope: "temporary", bundled: true, tools: [{ name: "observe_ui" }], commands: [{ name: "computer-use" }] },
    ];
    vi.mocked(desktop.invoke).mockImplementation(async (route) =>
      route === "agent.control" ? extensions : settings,
    );

    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "extensions";
    const wrapper = mount(SettingsPage, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
    await flushPromises();

    expect(wrapper.get('[data-extension="reviewer"]').text()).toContain("2 tools");
    expect(wrapper.get('[data-extension="reviewer"]').text()).toContain("Review changed files");
    expect(wrapper.find('.extension-inspector').exists()).toBe(false);
    expect(wrapper.find('.extension-grid details').exists()).toBe(false);
    expect(wrapper.get('[data-extension="status"]').text()).toContain("1 commands");
    expect(wrapper.find('.extension-stats').exists()).toBe(false);
    expect(wrapper.get('[data-extension-scope="temporary"]').text()).toContain("Built-in");
    expect(wrapper.get('[data-extension="@injaneity/pi-computer-use"] .extension-scope-badge').text()).toBe("Built-in");
    expect(wrapper.get('[data-extension="@injaneity/pi-computer-use"]').text()).toContain("Built into PiX. Loaded as a pi extension.");
    expect(wrapper.get('[data-extension="reviewer"]').text()).not.toContain("Built into PiX");
    expect(wrapper.find('[data-extension-scope="bundled"]').exists()).toBe(false);
    await wrapper.get('[data-extension-scope="temporary"]').trigger("click");
    expect(wrapper.findAll('[data-extension]')).toHaveLength(1);
    expect(wrapper.get('[data-extension="@injaneity/pi-computer-use"] .extension-identity').text()).toContain("cli");
    await wrapper.get('[data-extension-scope="all"]').trigger("click");
    const reviewerDetails = wrapper.get('[data-extension="reviewer"] .extension-details');
    await reviewerDetails.trigger("click");
    await flushPromises();
    expect(wrapper.classes()).toContain("has-details-panel");
    expect(wrapper.get('.extension-inspector').text()).toContain("/review");
    expect(wrapper.get('.extension-inspector').text()).toContain(extensions[0]!.resolvedPath);
    expect(wrapper.find('.extension-grid .extension-detail-body').exists()).toBe(false);
    expect(reviewerDetails.attributes('aria-expanded')).toBe("true");
    expect(document.activeElement).toBe(wrapper.get('.settings-inspector-close').element);
    await wrapper.get('.extension-inspector').trigger("keydown", { key: "Escape" });
    expect(wrapper.find('.extension-inspector').exists()).toBe(false);
    expect(document.activeElement).toBe(reviewerDetails.element);
    await reviewerDetails.trigger("click");
    await wrapper.get('[data-extension="@injaneity/pi-computer-use"] .extension-details').trigger("click");
    expect(wrapper.get('#extension-details-title').text()).toBe("@injaneity/pi-computer-use");
    expect(wrapper.get('.extension-inspector').text()).toContain("observe_ui");
    expect(wrapper.get('.extension-inspector').text()).not.toContain("/review");
    await wrapper.get('.settings-inspector-close').trigger("click");
    expect(wrapper.find('.extension-inspector').exists()).toBe(false);
    expect(wrapper.classes()).not.toContain("has-details-panel");
    await wrapper.get('[data-extension-scope="user"]').trigger("click");
    expect(wrapper.find('[data-extension="reviewer"]').exists()).toBe(false);
    expect(wrapper.get('[data-extension-scope="user"]').attributes('aria-pressed')).toBe("true");
    await wrapper.get('[data-extension-scope="all"]').trigger("click");
    await wrapper.get("[data-extension-search]").setValue("changed files");
    expect(wrapper.find('[data-extension="reviewer"]').exists()).toBe(true);
    expect(wrapper.find('[data-extension="status"]').exists()).toBe(false);
    await wrapper.get("[data-extension-search]").setValue("does-not-exist");
    expect(wrapper.get('.extension-empty').text()).toContain("No matching extensions");
    await wrapper.get('.extension-empty button').trigger("click");
    expect(wrapper.findAll('[data-extension]')).toHaveLength(3);
    await wrapper.get("[data-extension-search]").setValue("status");
    expect(wrapper.find('[data-extension="reviewer"]').exists()).toBe(false);

    await wrapper.get('[data-extension="status"] .extension-details').trigger("click");
    await wrapper.get('.extension-card button[title="Refresh extensions"]').trigger("click");
    await flushPromises();
    expect(vi.mocked(desktop.invoke)).toHaveBeenCalledWith("agent.control", { action: "getExtensions", reload: true });

    vi.mocked(desktop.invoke).mockRejectedValueOnce(new Error("Connection lost"));
    await wrapper.get('.extension-card button[title="Refresh extensions"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Connection lost");
    expect(wrapper.find('[data-extension="status"]').exists()).toBe(true);

    vi.mocked(desktop.invoke).mockResolvedValueOnce([]);
    await wrapper.get('.extension-card button[title="Refresh extensions"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('.extension-empty').text()).toContain("No extensions detected");
    expect(wrapper.find('.extension-inspector').exists()).toBe(false);
    wrapper.unmount();
  });
});
