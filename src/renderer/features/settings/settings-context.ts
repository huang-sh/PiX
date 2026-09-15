import { inject } from "vue";
import type { ComponentPublicInstance, InjectionKey } from "vue";
import type { useSettingsDraft } from "./use-settings-draft";
import type { useModels } from "./use-models";
import type { useSkills } from "./use-skills";
import type { useExtensions } from "./use-extensions";

/** The one inspector that can be open: close it, and register its close button. */
export interface SettingsInspectorContext {
  close(): void;
  registerCloseButton(el: Element | ComponentPublicInstance | null): void;
}

// The page owns every domain's state and hands it to the panels through these
// contexts, so a panel never reaches past the page for it. Symbol.for keeps
// providers and remounted panels connected across Vite module reloads.
export const settingsDraftKey: InjectionKey<ReturnType<typeof useSettingsDraft>> = Symbol.for("pix.settings.draft");
export const settingsModelsKey: InjectionKey<ReturnType<typeof useModels>> = Symbol.for("pix.settings.models");
export const settingsSkillsKey: InjectionKey<ReturnType<typeof useSkills>> = Symbol.for("pix.settings.skills");
export const settingsExtensionsKey: InjectionKey<ReturnType<typeof useExtensions>> = Symbol.for("pix.settings.extensions");
export const settingsInspectorKey: InjectionKey<SettingsInspectorContext> = Symbol.for("pix.settings.inspector");

// Panels only ever render inside SettingsPage, so a missing provider is a
// wiring bug rather than a supported standalone mount.
function provided<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`settings panel rendered without the ${name} context`);
  return value;
}

export function useSettingsDraftContext() {
  return provided(inject(settingsDraftKey, undefined), "draft");
}

export function useModelsContext() {
  return provided(inject(settingsModelsKey, undefined), "models");
}

export function useSkillsContext() {
  return provided(inject(settingsSkillsKey, undefined), "skills");
}

export function useExtensionsContext() {
  return provided(inject(settingsExtensionsKey, undefined), "extensions");
}

export function useSettingsInspector() {
  return provided(inject(settingsInspectorKey, undefined), "inspector");
}
