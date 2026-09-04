import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeExtension, RuntimeModel, RuntimeProvider, RuntimeSkill, SettingsBundle } from "../../src/shared/types";
import { desktop } from "../../src/renderer/api";
import SettingsPage from "../../src/renderer/features/settings/SettingsPage.vue";
import { i18n } from "../../src/renderer/i18n";
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
    ];
    vi.mocked(desktop.invoke).mockImplementation(async (route) =>
      route === "agent.control" ? extensions : settings,
    );

    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    layout.settingsCategory = "extensions";
    const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();

    expect(wrapper.get('[data-extension="reviewer"]').text()).toContain("2 tools");
    expect(wrapper.get('[data-extension="reviewer"]').text()).toContain("Review changed files");
    expect(wrapper.get('[data-extension="reviewer"]').text()).toContain("/review");
    expect(wrapper.get('[data-extension="status"]').text()).toContain("1 commands");
    await wrapper.get("[data-extension-search]").setValue("status");
    expect(wrapper.find('[data-extension="reviewer"]').exists()).toBe(false);

    await wrapper.get('.extension-card button[title="Refresh extensions"]').trigger("click");
    await flushPromises();
    expect(vi.mocked(desktop.invoke)).toHaveBeenCalledWith("agent.control", { action: "getExtensions", reload: true });
  });
});
