import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeExtension, RuntimeModel, RuntimeProvider, RuntimeSkill, SettingsBundle } from "../../src/shared/types";
import { desktop } from "../../src/renderer/api";
import SettingsPage from "../../src/renderer/features/settings/SettingsPage.vue";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";

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
      if (route === "agent.control") return (payload as { action: string }).action === "getModels" ? models : providers;
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
      { name: "docx", description: "Create Word documents", path: "/home/me/.pi/agent/skills/docx/SKILL.md", source: "local", scope: "user", disableModelInvocation: false },
      { name: "project-review", description: "Review this project", path: "/project/.pi/skills/review/SKILL.md", source: "local", scope: "project", disableModelInvocation: true },
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
    expect(wrapper.get('[data-skill="project-review"]').text()).toContain("manual only");
    await wrapper.get("[data-skill-search]").setValue("Word");
    expect(wrapper.find('[data-skill="project-review"]').exists()).toBe(false);

    await wrapper.get('.skill-card button[title="Refresh skills"]').trigger("click");
    await flushPromises();
    expect(vi.mocked(desktop.invoke)).toHaveBeenCalledWith("agent.control", { action: "getSkills", reload: true });
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
