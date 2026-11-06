import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, vi } from "vitest";
import SettingsPage from "../../src/renderer/features/settings/SettingsPage.vue";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { applyDiff } from "../../src/renderer/lib/settings-diff";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import type { SettingsBundle } from "../../src/shared/types";

enableAutoUnmount(afterEach);
afterEach(() => vi.restoreAllMocks());

const settle = () => new Promise(resolve => setTimeout(resolve, 360));

async function openPixieSettings(stored: SettingsBundle) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async (route, raw) => {
    const input = raw as Record<string, any>;
    if (route === "settings.update" && input.scope === "app") {
      applyDiff(stored.app as Record<string, unknown>, input.patch);
      // Mirror the main process's pixie normalization: only non-blank string
      // sections survive, and an emptied prompt object is removed.
      const pixie = stored.app.pixie as Record<string, any> | undefined;
      if (pixie?.prompt) {
        for (const key of ["identity", "rules", "docs", "full"])
          if (typeof pixie.prompt[key] !== "string" || !pixie.prompt[key].trim()) delete pixie.prompt[key];
        if (!Object.keys(pixie.prompt).length) delete pixie.prompt;
      }
      return structuredClone(stored);
    }
    if (route === "pixie.reload") return [];
    if (route === "pixie.previewPrompt")
      return { text: `PREVIEW ${JSON.stringify(input)}` };
    return [];
  });
  const layout = useLayoutStore();
  layout.applySettings(structuredClone(stored));
  layout.settingsCategory = "pixie";
  const wrapper = mount(SettingsPage, { global: { plugins: [pinia, i18n] } });
  await flushPromises();
  return { wrapper, invoke, layout };
}

it("saves the customized prompt as a complete snapshot and reloads the idle agent", async () => {
  i18n.global.locale.value = "en";
  const stored = {
    app: { language: "en", theme: "light", density: "comfortable", personas: [{ name: "reviewer", text: "Review carefully." }] },
    piGlobal: {}, piProject: {}, effective: {}, paths: {},
  } as unknown as SettingsBundle;
  const { wrapper, invoke } = await openPixieSettings(stored);

  // The persona picker seeds the identity draft without saving anything.
  await wrapper.get("[data-pixie-prompt-persona]").setValue("reviewer");
  expect(wrapper.get("[data-pixie-prompt-identity]").element.value).toBe("Review carefully.");
  await wrapper.get("[data-pixie-prompt-identity]").setValue("My Pixie.");
  await wrapper.get("form.persona-form").trigger("submit");
  await flushPromises();
  await wrapper.get('[data-pixie-edit="rules"]').trigger("click");
  await wrapper.get("[data-pixie-prompt-rules]").setValue("Always cite files.");
  await wrapper.get("form.persona-form").trigger("submit");
  await flushPromises();

  expect(stored.app.pixie).toEqual({ prompt: { identity: "My Pixie.", rules: "Always cite files." } });
  expect(invoke).toHaveBeenCalledWith("pixie.reload");
  // The preview composes from the live draft and renders main-side.
  await wrapper.get('[data-pixie-edit="docs"]').trigger("click");
  await wrapper.get("[data-pixie-prompt-docs]").setValue("Notes.");
  await settle();
  expect(invoke).toHaveBeenCalledWith("pixie.previewPrompt",
    { identity: "My Pixie.", rules: "Always cite files.", docs: "Notes.", full: undefined });
  expect(wrapper.get("[data-pixie-prompt-preview]").text()).toContain("PREVIEW");
});

it("keeps unsaved prompt edits when an unrelated settings row saves", async () => {
  i18n.global.locale.value = "en";
  const stored = {
    app: { language: "en", theme: "light", density: "comfortable", pixie: { prompt: { identity: "Saved." }, sprite: true } },
    piGlobal: {}, piProject: {}, effective: {}, paths: {},
  } as unknown as SettingsBundle;
  const { wrapper } = await openPixieSettings(stored);
  await wrapper.get('[data-pixie-edit="identity"]').trigger("click");
  const identity = wrapper.get("[data-pixie-prompt-identity]");
  expect(identity.element.value).toBe("Saved.");

  await identity.setValue("Unsaved edit.");
  await wrapper.get('[data-setting-path="pixie.sprite"] input').setValue(false);
  await flushPromises();

  // The sprite row saved; the prompt draft keeps the unsaved edit, and the
  // saved prompt itself was untouched by the row's patch.
  expect(stored.app.pixie).toEqual({ prompt: { identity: "Saved." }, sprite: false });
  expect(wrapper.get("[data-pixie-prompt-identity]").element.value).toBe("Unsaved edit.");
});

it("adopts a prompt changed by another writer", async () => {
  i18n.global.locale.value = "en";
  const stored = {
    app: { language: "en", theme: "light", density: "comfortable" },
    piGlobal: {}, piProject: {}, effective: {}, paths: {},
  } as unknown as SettingsBundle;
  const { wrapper, layout } = await openPixieSettings(stored);
  expect(wrapper.find("textarea").exists()).toBe(false);
  expect(wrapper.get('[data-pixie-prompt-block="identity"] pre').text()).toContain("You are Pixie");

  stored.app.pixie = { prompt: { full: "External full prompt." } };
  layout.applySettings(structuredClone(stored));
  await flushPromises();

  // Full mode takes over: the checkbox reflects it and the sections are gone.
  expect((wrapper.get("[data-pixie-prompt-full-mode]").element as HTMLInputElement).checked).toBe(true);
  expect(wrapper.find("[data-pixie-prompt-identity]").exists()).toBe(false);
  expect(wrapper.get('[data-pixie-prompt-block="full"] pre').text()).toBe("External full prompt.");
});

it("full replacement saves only the verbatim text and resets everything together", async () => {
  i18n.global.locale.value = "en";
  const stored = {
    app: {
      language: "en", theme: "light", density: "comfortable",
      pixie: { prompt: { identity: "Old identity.", rules: "Old rules." } },
    },
    piGlobal: {}, piProject: {}, effective: {}, paths: {},
  } as unknown as SettingsBundle;
  const { wrapper } = await openPixieSettings(stored);
  expect(wrapper.get('[data-pixie-prompt-block="identity"] pre').text()).toBe("Old identity.");

  await wrapper.get("[data-pixie-prompt-full-mode]").setValue(true);
  expect(wrapper.find("[data-pixie-prompt-full]").exists()).toBe(true);
  await wrapper.get("[data-pixie-prompt-full]").setValue("Verbatim prompt.");
  await wrapper.get("form.persona-form").trigger("submit");
  await flushPromises();
  // The section keys were explicitly removed, not left stale by the merge.
  expect(stored.app.pixie).toEqual({ prompt: { full: "Verbatim prompt." } });

  await wrapper.get('[data-action="pixie-prompt-reset"]').trigger("click");
  await flushPromises();
  expect(stored.app.pixie).toEqual({});
  expect((wrapper.get("[data-pixie-prompt-full-mode]").element as HTMLInputElement).checked).toBe(false);
});


it("edits one section at a time and cancels without changing saved settings", async () => {
  const stored = {
    app: { language: "en", pixie: { prompt: { rules: "Saved rules." } } },
    piGlobal: {}, piProject: {}, effective: {}, paths: {},
  } as unknown as SettingsBundle;
  const { wrapper } = await openPixieSettings(stored);
  expect(wrapper.find("textarea").exists()).toBe(false);
  await wrapper.get('[data-pixie-edit="rules"]').trigger("click");
  await wrapper.get("[data-pixie-prompt-rules]").setValue("Unsaved rules.");
  expect(wrapper.findAll("textarea")).toHaveLength(1);
  await wrapper.get('[data-action="pixie-prompt-cancel"]').trigger("click");
  expect(wrapper.get('[data-pixie-prompt-block="rules"] pre').text()).toBe("Saved rules.");
  expect(stored.app.pixie?.prompt?.rules).toBe("Saved rules.");
  await wrapper.get("[data-pixie-prompt-full-mode]").setValue(true);
  await wrapper.get('[data-action="pixie-prompt-cancel"]').trigger("click");
  expect(wrapper.find('[data-pixie-prompt-block="identity"]').exists()).toBe(true);
});
