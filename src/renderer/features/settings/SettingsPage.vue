<script setup lang="ts">
import { computed, provide, ref, watch } from "vue";
import { ArrowLeft, Bot, Box, ChartColumn, FlaskConical, History, Info, Keyboard, Palette, Puzzle, SlidersHorizontal, Sparkles, Terminal, Wrench } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import Button from "../../components/ui/Button.vue";
import AboutPage from "./AboutPage.vue";
import KeyboardShortcuts from "./KeyboardShortcuts.vue";
import ExtensionsPanel from "./ExtensionsPanel.vue";
import ExtensionInspector from "./ExtensionInspector.vue";
import ModelInspector from "./ModelInspector.vue";
import ModelsPanel from "./ModelsPanel.vue";
import SettingsRowsPanel from "./SettingsRowsPanel.vue";
import SkillsPanel from "./SkillsPanel.vue";
import UsagePanel from "./UsagePanel.vue";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";
import { createInspectorFocus } from "./inspector-focus";
import { settingsDraftKey, settingsExtensionsKey, settingsInspectorKey, settingsModelsKey, settingsSkillsKey } from "./settings-context";
import { useSettingsDraft } from "./use-settings-draft";
import { useModels } from "./use-models";
import { useSkills } from "./use-skills";
import { useExtensions } from "./use-extensions";

const layout = useLayoutStore();
const workspace = useWorkspaceStore();
const session = useSessionStore();
const { t } = useI18n();

const inspectorFocus = createInspectorFocus();
// Created before the draft: the agent category's output-style select lists
// the loaded skills that opt in with an output-style marker.
const skillCtx = useSkills();
const outputStyleSkills = computed(() => skillCtx.skills.value.filter((skill) => skill.outputStyle).map((skill) => skill.name));
const draftCtx = useSettingsDraft(outputStyleSkills);
const modelCtx = useModels(draftCtx.draft, inspectorFocus, () => closeDetailsPanel(), draftCtx.save);
const extensionCtx = useExtensions(inspectorFocus);

// The panels and inspectors read the state they render through these contexts.
provide(settingsDraftKey, draftCtx);
provide(settingsModelsKey, modelCtx);
provide(settingsSkillsKey, skillCtx);
provide(settingsExtensionsKey, extensionCtx);
provide(settingsInspectorKey, { close: closeDetailsPanel, registerCloseButton: inspectorFocus.register });

// What the shell renders itself: the root class and the header counts.
const { draft } = draftCtx;
const { selectedProvider } = modelCtx;
const { skills } = skillCtx;
const { extensions, selectedExtension } = extensionCtx;

const shortcutsPage = ref<InstanceType<typeof KeyboardShortcuts>>();
function close() { shortcutsPage.value?.requestClose(); }
defineExpose({ close });

// Only one inspector can be open at a time; closing it clears the selection
// that rendered it and hands focus back to the element that opened it.
function closeDetailsPanel() {
  modelCtx.expandedProvider.value = "";
  modelCtx.editingProvider.value = "";
  extensionCtx.selectedExtensionPath.value = "";
  inspectorFocus.restore();
}

// The category sidebar resizes like the workbench navigator: drag the edge or
// arrow keys, clamped, persisted with the rest of the GUI layout.
const SETTINGS_SIDEBAR_MIN = 210, SETTINGS_SIDEBAR_MAX = 420;
let sidebarDrag: { id: number; x: number; width: number } | undefined;
function clampSidebarWidth(width: number) {
  return Math.min(SETTINGS_SIDEBAR_MAX, Math.max(SETTINGS_SIDEBAR_MIN, width));
}
function startSidebarResize(event: PointerEvent) {
  if (event.button !== 0) return;
  sidebarDrag = { id: event.pointerId, x: event.clientX, width: layout.layout.widths.settings };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function moveSidebarResize(event: PointerEvent) {
  if (!sidebarDrag || event.pointerId !== sidebarDrag.id) return;
  layout.layout.widths.settings = clampSidebarWidth(sidebarDrag.width + event.clientX - sidebarDrag.x);
}
function finishSidebarResize() {
  if (!sidebarDrag) return;
  sidebarDrag = undefined;
  void layout.save();
}
function resizeSidebarWithKeyboard(event: KeyboardEvent) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  layout.layout.widths.settings = Math.round(clampSidebarWidth(layout.layout.widths.settings + (event.key === "ArrowLeft" ? -10 : 10)));
  void layout.save();
}

const categories = computed(() => [
  ["general", t("settings.categories.general"), SlidersHorizontal],
  ["appearance", t("settings.categories.appearance"), Palette],
  ["shortcuts", t("settings.categories.shortcuts"), Keyboard],
  ["models", t("settings.categories.models"), Box],
  ["sessions", t("settings.categories.sessions"), History],
  ["usage", t("settings.categories.usage"), ChartColumn],
  ["agent", t("settings.categories.agent"), Bot],
  ["tools", t("settings.categories.tools"), Wrench],
  ["skills", t("settings.categories.skills"), Sparkles],
  ["extensions", t("settings.categories.extensions"), Puzzle],
  ["shell", t("settings.categories.shell"), Terminal],
  ["experimental", t("settings.categories.experimental"), FlaskConical],
  ["about", t("settings.categories.about"), Info],
] as const);

watch(
  [() => layout.settingsCategory, () => session.current?.session.id],
  () => {
    extensionCtx.selectedExtensionPath.value = "";
    modelCtx.expandedProvider.value = "";
    modelCtx.editingProvider.value = "";
    skillCtx.skillEditor.value = undefined;
    skillCtx.confirmingSkillPath.value = "";
    void modelCtx.loadRuntime();
    void skillCtx.loadSkills();
    void extensionCtx.loadExtensions();
  },
  { immediate: true },
);
</script>

<template>
  <div class="settings-page" :class="{ 'has-details-panel': (layout.settingsCategory === 'extensions' && selectedExtension) || (layout.settingsCategory === 'models' && selectedProvider) }" :style="{ '--settings-sidebar-width': `${layout.layout.widths.settings}px` }" v-if="draft">
    <aside>
      <Button variant="ghost" class="justify-start" @click="close">
        <ArrowLeft :size="16" />{{ t("settings.back") }}
      </Button>
      <nav>
        <button
          v-for="category in categories"
          :key="category[0]"
          type="button"
          :data-settings-category="category[0]"
          :class="{ active: layout.settingsCategory === category[0] }"
          @click="layout.settingsCategory = category[0]"
        >
          <component :is="category[2]" :size="17" aria-hidden="true" />
          {{ category[1] }}
        </button>
      </nav>
      <footer><strong>{{ workspace.project?.name }}</strong><small>{{ workspace.project?.path }}</small></footer>
      <div
        class="settings-resize resize-handle"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="t('settings.resizeNav')"
        :aria-valuenow="layout.layout.widths.settings"
        :aria-valuemin="SETTINGS_SIDEBAR_MIN"
        :aria-valuemax="SETTINGS_SIDEBAR_MAX"
        @pointerdown.prevent="startSidebarResize"
        @pointermove="moveSidebarResize"
        @pointerup="finishSidebarResize"
        @lostpointercapture="finishSidebarResize"
        @keydown="resizeSidebarWithKeyboard"
      />
    </aside>

    <main>
      <header>
        <div>
          <small>{{ t("settings.preferences") }}</small>
          <h1>{{ categories.find((item) => item[0] === layout.settingsCategory)?.[1] }}</h1>
          <p v-if="layout.settingsCategory === 'models'">{{ t("settings.modelsDescription") }}</p>
          <p v-else-if="layout.settingsCategory === 'skills'">{{ t("settings.skillsDescription", { n: skills.length }) }}</p>
          <p v-else-if="layout.settingsCategory === 'extensions'">{{ t("settings.extensionsDescription", { n: extensions.length }) }}</p>
          <p v-else-if="layout.settingsCategory === 'shortcuts'">{{ t("shortcuts.description") }}</p>
          <p v-else-if="layout.settingsCategory === 'usage'">{{ t("settings.usageDescription") }}</p>
        </div>
      </header>

      <KeyboardShortcuts ref="shortcutsPage" v-show="layout.settingsCategory === 'shortcuts'" />
      <ModelsPanel v-if="layout.settingsCategory === 'models'" />
      <SkillsPanel v-else-if="layout.settingsCategory === 'skills'" />
      <UsagePanel v-else-if="layout.settingsCategory === 'usage'" />
      <ExtensionsPanel v-else-if="layout.settingsCategory === 'extensions'" />
      <AboutPage v-else-if="layout.settingsCategory === 'about'" />
      <SettingsRowsPanel v-else-if="layout.settingsCategory !== 'shortcuts'" />
    </main>
    <ModelInspector v-if="layout.settingsCategory === 'models'" />
    <ExtensionInspector v-if="layout.settingsCategory === 'extensions'" />
  </div>
</template>
