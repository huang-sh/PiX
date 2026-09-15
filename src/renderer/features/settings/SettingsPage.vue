<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowLeft, Bot, Box, Check, ChevronDown, ChevronRight, CircleAlert, Download, Eye, Folder, History, Info, Keyboard, KeyRound, Lock, Palette, Pencil, Plus, Puzzle, RefreshCw, Save, Search, SlidersHorizontal, Sparkles, Terminal, Trash2, Wrench, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { RECOMMENDED_EXTENSIONS } from "../../../shared/extensions";
import Button from "../../components/ui/Button.vue";
import CustomModelForm from "./CustomModelForm.vue";
import KeyboardShortcuts from "./KeyboardShortcuts.vue";
import SkillEditorForm from "./SkillEditorForm.vue";
import AboutPage from "./AboutPage.vue";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";
import { createInspectorFocus } from "./inspector-focus";
import { useSettingsDraft } from "./use-settings-draft";
import { useModels } from "./use-models";
import { useSkills } from "./use-skills";
import { useExtensions } from "./use-extensions";

const layout = useLayoutStore();
const workspace = useWorkspaceStore();
const session = useSessionStore();
const { locale, t } = useI18n();

const { draft, saving, rows, optionLabel, rowHint, value, setValue, save } = useSettingsDraft();
const detailsCloseButton = ref<HTMLButtonElement>();
const inspectorFocus = createInspectorFocus(detailsCloseButton);
const {
  models, modelQuery, addingCustomModel, customModels, editingCustomModel, providers, providerFilter,
  selectedModel, expandedProvider, editingProvider, selectedProvider, keyDrafts, runtimeBusy, providerBusy,
  runtimeError, providerFilters, filteredProviders, providerSections, defaultModel, currentModel,
  selectedRuntimeModel, selectedThinkingLevels, modelKey, providerModels, toggleProvider, toggleProviderSetup,
  loadRuntime, customModelSaved, modelSettingsKey, cyclingEnabled, toggleCycling, setAllCycling,
  modelThinkingOverride, setModelThinkingOverride, applyModel, saveApiKey, loginOAuth, logout,
} = useModels(draft, inspectorFocus, () => closeDetailsPanel());
const {
  skills, skillQuery, skillScope, skillBusy, skillError, skillActionPath, skillImport, confirmingSkillPath,
  skillEditor, queriedSkills, skillSections, skillFilters, loadSkills, openCreateSkill, openEditSkill,
  skillSaved, toggleManualOnly, removeSkill, importSkillFile,
} = useSkills();
const {
  extensions, extensionQuery, extensionScope, extensionBusy, extensionError, selectedExtensionPath,
  selectedExtension, packageBusySource, packageError, filteredExtensions, extensionFilters, extensionName,
  extensionSummary, openExtensionDetails, loadExtensions, extensionInstalled, runPackageAction,
} = useExtensions(inspectorFocus);

const shortcutsPage = ref<InstanceType<typeof KeyboardShortcuts>>();
function close() { shortcutsPage.value?.requestClose(); }
defineExpose({ close });

// Only one inspector can be open at a time; closing it clears the selection
// that rendered it and hands focus back to the element that opened it.
function closeDetailsPanel() {
  expandedProvider.value = "";
  editingProvider.value = "";
  selectedExtensionPath.value = "";
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
  ["agent", t("settings.categories.agent"), Bot],
  ["tools", t("settings.categories.tools"), Wrench],
  ["skills", t("settings.categories.skills"), Sparkles],
  ["extensions", t("settings.categories.extensions"), Puzzle],
  ["shell", t("settings.categories.shell"), Terminal],
  ["about", t("settings.categories.about"), Info],
] as const);

watch(
  [() => layout.settingsCategory, () => session.current?.session.id],
  () => {
    selectedExtensionPath.value = "";
    expandedProvider.value = "";
    editingProvider.value = "";
    skillEditor.value = undefined;
    confirmingSkillPath.value = "";
    void loadRuntime();
    void loadSkills();
    void loadExtensions();
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
        </div>
        <nav v-if="!['models', 'skills', 'extensions', 'shortcuts', 'about'].includes(layout.settingsCategory)">
          <Button :disabled="saving || layout.themeSaving" @click="save"><Save :size="15" />{{ saving ? t("settings.saving") : t("common.save") }}</Button>
        </nav>
      </header>

      <KeyboardShortcuts ref="shortcutsPage" v-show="layout.settingsCategory === 'shortcuts'" />
      <div v-if="layout.settingsCategory === 'models'" class="model-workspace">
        <section class="model-overview" :aria-label="t('settings.modelOverview')">
          <div class="model-default-summary">
            <span class="model-overview-icon"><Box :size="25" aria-hidden="true" /></span>
            <div>
              <span class="model-eyebrow">{{ t("settings.defaultModelLabel") }}</span>
              <h2 data-default-model>{{ draft.effective.defaultModel || t("settings.noDefaultModel") }}</h2>
              <span v-if="draft.effective.defaultProvider" class="model-summary-provider">{{ draft.effective.defaultProvider }}</span>
              <p>{{ t("settings.defaultModelHint") }}</p>
            </div>
          </div>
          <div class="model-session-summary">
            <span class="model-eyebrow"><Bot :size="14" />{{ t("settings.sessionModelLabel") }}</span>
            <strong>{{ session.current?.runtime.model?.id || t("settings.noSessionModel") }}</strong>
            <span v-if="session.current?.runtime.model" class="model-summary-provider">{{ session.current.runtime.model.provider }}</span>
            <p>{{ t("settings.sessionModelHint") }}</p>
          </div>
          <div class="model-overview-footer">
            <span><Check :size="14" />{{ t("settings.connectedProviderCount", { n: providerFilters[1].count }) }}</span>
            <span><Box :size="14" />{{ t("settings.availableModelCount", { n: models.length }) }}</span>
            <a href="#model-preferences"><SlidersHorizontal :size="13" />{{ t("settings.modelPreferences") }}<ChevronDown :size="13" /></a>
          </div>
        </section>
        <Button v-if="!addingCustomModel" variant="outline" data-add-custom-model :disabled="runtimeBusy || !!providerBusy" @click="editingCustomModel = undefined; addingCustomModel = true">{{ t("settings.addCustomModel") }}</Button>
        <CustomModelForm v-if="addingCustomModel" :model="editingCustomModel" @saved="customModelSaved" @cancel="addingCustomModel = false; editingCustomModel = undefined" />
        <section class="provider-card model-card" :aria-busy="runtimeBusy">
          <div class="settings-toolbar model-toolbar">
            <label class="settings-search">
              <Search :size="16" aria-hidden="true" />
              <input v-model="modelQuery" data-model-search :aria-label="t('settings.searchModels')" :placeholder="t('settings.searchModels')" />
              <button v-if="modelQuery" type="button" class="model-search-clear" :aria-label="t('settings.modelClearSearch')" @click="modelQuery = ''"><X :size="14" /></button>
            </label>
            <Button variant="outline" :disabled="runtimeBusy || !!providerBusy" data-model-refresh :title="t('settings.refreshModelsHint')" @click="loadRuntime(true)"><RefreshCw :size="15" :class="{ spin: runtimeBusy }" />{{ t(runtimeBusy ? "settings.refreshingModels" : "settings.refreshModels") }}</Button>
          </div>
          <div class="model-filter-bar">
            <div class="model-filters" role="group" :aria-label="t('settings.providerFilterLabel')">
              <button v-for="filter in providerFilters" :key="filter.id" type="button" :data-provider-filter="filter.id" :aria-pressed="providerFilter === filter.id" @click="providerFilter = filter.id">{{ t(`settings.providerFilters.${filter.id}`) }}<span>{{ filter.count }}</span></button>
            </div>
            <span class="model-result-count" role="status">{{ t("settings.providerResults", { n: filteredProviders.length }) }}</span>
          </div>
          <div v-if="runtimeError" class="model-feedback" role="alert"><CircleAlert :size="18" /><div><strong>{{ t("settings.modelLoadError") }}</strong><p>{{ runtimeError }}</p></div></div>
          <div v-if="runtimeBusy && !providers.length" class="model-empty" role="status"><RefreshCw :size="26" class="spin" /><strong>{{ t("settings.loadingProviders") }}</strong></div>
          <div v-else-if="!filteredProviders.length && !runtimeError" class="model-empty">
            <Search :size="28" /><strong>{{ t("settings.noMatchingModels") }}</strong><p>{{ t("settings.modelSearchHint") }}</p>
            <Button v-if="modelQuery || providerFilter !== 'all'" variant="outline" @click="modelQuery = ''; providerFilter = 'all'">{{ t("settings.modelResetFilters") }}</Button>
          </div>
          <template v-else-if="filteredProviders.length">
          <template v-for="section in providerSections" :key="section.id">
          <header class="provider-section-title" :data-provider-section="section.id">
            <div><h2>{{ section.label }}<span>{{ section.providers.length }}</span></h2><p>{{ t(`settings.providerSectionHints.${section.id}`) }}</p></div>
          </header>
          <div class="provider-section-grid" :data-provider-section-grid="section.id">
          <section v-for="provider in section.providers" :key="provider.id" class="provider-group" :class="{ configured: !!provider.status, 'is-selected': selectedProvider === provider }" :data-provider="provider.id">
            <div class="provider-row">
              <div class="provider-identity">
                <span class="provider-icon" aria-hidden="true">{{ provider.name.slice(0, 1).toUpperCase() }}</span>
                <span class="provider-name">
                  <strong>{{ provider.name }}</strong>
                  <small>{{ provider.id }}</small>
                </span>
              </div>
              <div v-if="provider.status" class="provider-status configured" :title="provider.status.source">
                <Check :size="13" />{{ t("settings.connected") }}
              </div>
              <div v-else class="provider-status">{{ t("settings.notConfigured") }}</div>
            </div>
            <div class="provider-card-footer">
              <span class="provider-auth-type"><KeyRound :size="13" />{{ provider.authTypes.map(type => t(`settings.providerAuthTypes.${type}`)).join(' / ') || t('settings.providerAuthTypes.custom') }}</span>
              <div class="provider-actions">
                <button v-if="providerModels(provider).length" type="button" class="provider-model-toggle" :aria-expanded="expandedProvider === provider.id" :aria-controls="expandedProvider === provider.id ? 'model-details-panel' : undefined" @click="toggleProvider(provider, $event)">
                  {{ t(providerModels(provider).length === 1 ? "settings.oneModel" : "settings.models", { n: providerModels(provider).length }) }}
                  <ChevronRight :size="14" />
                </button>
                <Button variant="outline" size="sm" :data-provider-configure="provider.id" :aria-expanded="editingProvider === provider.id" :aria-controls="editingProvider === provider.id ? 'model-details-panel' : undefined" @click="toggleProviderSetup(provider, $event)">
                  {{ t(editingProvider === provider.id ? "settings.closeProviderSetup" : provider.status ? "settings.manageProvider" : "settings.configureProvider") }}
                </Button>
              </div>
            </div>

          </section>
          </div>
          </template>
          </template>
          <details class="credential-note">
            <summary><KeyRound :size="14" />{{ t("settings.credentialStorage") }}<ChevronDown :size="13" /></summary>
            <span>{{ t("settings.apiKeysNotePrefix") }}<code>~/.pix/agent/auth.json</code>{{ t("settings.apiKeysNoteSuffix") }}</span>
          </details>
        </section>
        <section id="model-preferences" class="settings-card model-options">
          <header class="model-options-header">
            <span class="model-preferences-title"><SlidersHorizontal :size="19" /><span><strong>{{ t("settings.modelPreferences") }}</strong><small>{{ t("settings.modelPreferencesHint") }}</small></span></span>
            <Button class="model-primary-button" :disabled="saving" @click="save"><Save :size="15" />{{ saving ? t("settings.saving") : t("common.save") }}</Button>
          </header>
          <label v-if="selectedRuntimeModel" class="setting-row" data-setting-path="modelThinkingLevels">
            <span>
              <strong>{{ t("settings.thinkingFor", { id: selectedRuntimeModel.id }) }}</strong>
              <small>{{ t("settings.thinkingOverrideHint") }}</small>
            </span>
            <select :value="modelThinkingOverride()" @change="setModelThinkingOverride">
              <option value="">{{ t("settings.inheritDefault") }}</option>
              <option v-for="level in selectedThinkingLevels" :key="level" :value="level">{{ optionLabel(level) }}</option>
            </select>
          </label>
          <label v-for="row in rows" :key="`${row.scope}:${row.path}`" class="setting-row" :data-setting-path="row.path">
            <span><strong>{{ t(row.label) }}</strong><small>{{ rowHint(row) }}</small></span>
            <input v-if="row.type === 'check'" class="switch" type="checkbox" :checked="Boolean(value(row))" @change="setValue(row, $event)" />
            <select v-if="row.type === 'select'" :value="String(value(row))" @change="setValue(row, $event)">
              <option v-for="option in row.options" :key="option" :value="option">{{ optionLabel(option) }}</option>
            </select>
            <input v-else-if="row.type !== 'check'" :type="row.type ?? 'text'" :value="String(value(row))" :placeholder="row.placeholder" :min="row.min" :max="row.max" @input="setValue(row, $event)" />
          </label>
          <footer class="model-cycle-actions"><span>{{ t("settings.cyclePreferencesHint") }}</span><Button variant="ghost" size="sm" @click="setAllCycling(true)">{{ t("settings.cycleAll") }}</Button><Button variant="ghost" size="sm" @click="setAllCycling(false)">{{ t("settings.clearCycle") }}</Button></footer>
        </section>
      </div>
      <section v-else-if="layout.settingsCategory === 'skills'" class="settings-card skill-card" :aria-busy="skillBusy">
        <div class="skill-toolbar">
          <div class="skill-segments" role="radiogroup" :aria-label="t('settings.skillFilterLabel')">
            <button v-for="filter in skillFilters" :key="filter.scope" type="button" role="radio" :aria-checked="skillScope === filter.scope" :class="{ active: skillScope === filter.scope }" :data-skill-filter="filter.scope" @click="skillScope = filter.scope">
              {{ t(`settings.skillFilters.${filter.scope}`) }}<span class="skill-segment-count">{{ filter.count }}</span>
            </button>
          </div>
          <label class="skill-search">
            <Search :size="13" aria-hidden="true" />
            <input type="search" v-model="skillQuery" data-skill-search :aria-label="t('settings.searchSkills')" :placeholder="t('settings.searchSkills')" />
            <button v-if="skillQuery" type="button" class="skill-search-clear" :aria-label="t('common.close')" @click="skillQuery = ''"><X :size="11" /></button>
          </label>
          <div class="skill-toolbar-actions">
            <input ref="skillImport" type="file" accept=".md,text/markdown" hidden @change="importSkillFile" />
            <Button variant="outline" size="sm" data-skill-import :title="t('settings.skillImportHint')" :disabled="!!skillActionPath" @click="skillImport?.click()"><Download :size="14" />{{ t("settings.importSkill") }}</Button>
            <Button size="sm" data-skill-new :disabled="!!skillActionPath" @click="openCreateSkill"><Plus :size="14" />{{ t("settings.newSkill") }}</Button>
            <Button variant="outline" size="icon" :title="t('settings.refreshSkills')" :disabled="skillBusy" @click="loadSkills(true)">
              <RefreshCw :size="15" :class="{ spin: skillBusy }" />
            </Button>
          </div>
        </div>
        <div class="skill-panel" :class="{ 'is-refreshing': skillBusy && skills.length }">
          <p v-if="skillError" class="skill-error" role="alert">{{ skillError }}</p>
          <div v-if="skillBusy && !skills.length" class="skill-skeleton" role="status" :aria-label="t('settings.loadingSkills')">
            <div v-for="row in 3" :key="row" class="skill-skeleton-row">
              <span class="skill-skeleton-glyph" />
              <span class="skill-skeleton-lines"><span class="skill-skeleton-line" /><span class="skill-skeleton-line is-desc" /></span>
            </div>
          </div>
          <div v-else-if="skillQuery && !queriedSkills.length" class="skill-empty">
            <span class="skill-empty-icon"><Search :size="18" /></span>
            <strong>{{ t("settings.noMatchingSkills") }}</strong>
            <span>{{ t("settings.skillNoMatchHint") }}</span>
            <Button variant="outline" size="sm" @click="skillQuery = ''">{{ t("settings.modelResetFilters") }}</Button>
          </div>
          <template v-else>
            <section v-for="section in skillSections" :key="section.scope" class="skill-group">
              <header class="skill-group-header">
                <span class="skill-group-label">{{ section.label }}</span>
                <span class="skill-group-count">{{ section.skills.length }}</span>
              </header>
              <div v-if="section.skills.length" class="skill-list" role="list">
                <article v-for="skill in section.skills" :key="skill.path" class="skill-row" :class="{ 'is-off': skill.disableModelInvocation, 'is-busy': skillActionPath === skill.path }" role="listitem" :data-skill="skill.name" :title="skill.path">
                  <span class="skill-glyph" aria-hidden="true"><Sparkles :size="15" /></span>
                  <div class="skill-copy">
                    <div class="skill-row-title">
                      <span class="skill-name">{{ skill.name }}</span>
                      <span class="skill-badge is-level">{{ t(`settings.skillFilters.${skill.scope}`) }}</span>
                      <span v-if="skill.disableModelInvocation && !skill.editable" class="skill-badge is-manual">{{ t("settings.manualSkill") }}</span>
                      <span v-if="!skill.editable" class="skill-badge"><Lock :size="10" />{{ t("settings.skillReadOnly") }}</span>
                      <span v-if="skill.shadowsBuiltin" class="skill-badge" :title="skill.shadowsBuiltin">{{ t("settings.skillShadowsBuiltin") }}</span>
                    </div>
                    <p class="skill-description" :title="skill.description">{{ skill.description }}</p>
                  </div>
                  <div class="skill-actions">
                    <button v-if="skill.editable || skill.scope === 'builtin'" type="button" class="skill-switch" role="switch" data-skill-manual :aria-checked="!skill.disableModelInvocation" :aria-label="t('settings.skillAuto')" :title="t(skill.disableModelInvocation ? 'settings.skillManualOnlyHint' : 'settings.skillAutoHint')" :disabled="!!skillActionPath" @click="toggleManualOnly(skill)">
                      <span class="skill-switch-thumb" />
                    </button>
                    <Button v-if="!skill.editable" class="skill-action" variant="ghost" size="icon" data-skill-view :title="t('settings.viewSkill')" :disabled="!!skillActionPath" @click="openEditSkill(skill)"><Eye :size="15" /></Button>
                    <Button v-if="skill.editable" class="skill-action" variant="ghost" size="icon" :title="t('settings.editSkill')" :disabled="!!skillActionPath" @click="openEditSkill(skill)"><Pencil :size="15" /></Button>
                    <Button v-if="skill.editable" class="skill-action skill-action-delete" :class="confirmingSkillPath === skill.path ? 'is-arming' : undefined" variant="ghost" size="icon" :title="t(confirmingSkillPath === skill.path ? 'settings.skillDeleteConfirm' : 'settings.deleteSkill')" :disabled="!!skillActionPath" @click="removeSkill(skill)"><Trash2 :size="15" /></Button>
                  </div>
                </article>
              </div>
              <p v-else class="skill-group-empty">{{ t("settings.skillGroupEmpty") }}</p>
            </section>
          </template>
        </div>
      </section>
      <section v-else-if="layout.settingsCategory === 'extensions'" class="extension-card" :aria-busy="extensionBusy">
        <div class="extension-overview">
          <div class="extension-intro">
            <span class="extension-intro-icon"><Puzzle :size="25" aria-hidden="true" /></span>
            <div><h2>{{ t("settings.extensionLibrary") }}</h2><p>{{ t("settings.extensionLibraryHint") }}</p></div>
          </div>
        </div>
        <div class="extension-controls">
          <div class="settings-toolbar">
            <label class="settings-search">
              <Search :size="16" aria-hidden="true" />
              <input v-model="extensionQuery" data-extension-search :aria-label="t('settings.searchExtensions')" :placeholder="t('settings.searchExtensions')" />
              <button v-if="extensionQuery" type="button" :aria-label="t('settings.extensionClearSearch')" @click="extensionQuery = ''"><X :size="14" /></button>
            </label>
            <Button variant="outline" :title="t('settings.refreshExtensions')" :disabled="extensionBusy" @click="loadExtensions(true)">
              <RefreshCw :size="15" :class="{ spin: extensionBusy }" aria-hidden="true" />{{ t(extensionBusy ? "settings.extensionRefreshing" : "settings.refreshExtensions") }}
            </Button>
          </div>
          <div class="extension-filter-bar">
            <div class="extension-filters" role="group" :aria-label="t('settings.extensionFilterLabel')">
              <button v-for="filter in extensionFilters" :key="filter.scope" type="button" :data-extension-scope="filter.scope" :aria-pressed="extensionScope === filter.scope" @click="extensionScope = filter.scope">
                {{ t(`settings.extensionFilters.${filter.scope}`) }}<span>{{ filter.count }}</span>
              </button>
            </div>
            <span class="extension-result-count" role="status">{{ t("settings.extensionResults", { n: filteredExtensions.length }) }}</span>
          </div>
        </div>
        <div v-if="extensionError" class="extension-feedback extension-error" role="alert"><CircleAlert :size="19" /><div><strong>{{ t("settings.extensionLoadError") }}</strong><p>{{ extensionError }}</p></div></div>
        <div v-if="extensionBusy && !extensions.length" class="extension-empty" role="status"><RefreshCw :size="26" class="spin" /><h3>{{ t("settings.loadingExtensions") }}</h3></div>
        <div v-else-if="!extensions.length && !extensionError" class="extension-empty">
          <span class="extension-empty-icon"><Puzzle :size="28" /></span><h3>{{ t("settings.noExtensions") }}</h3><p>{{ t("settings.extensionEmptyHint") }}</p>
        </div>
        <div v-else-if="extensions.length && !filteredExtensions.length" class="extension-empty">
          <span class="extension-empty-icon"><Search :size="26" /></span><h3>{{ t("settings.noMatchingExtensions") }}</h3><p>{{ t("settings.extensionSearchHint") }}</p>
          <Button variant="outline" @click="extensionQuery = ''; extensionScope = 'all'">{{ t("settings.extensionResetFilters") }}</Button>
        </div>
        <div v-else-if="filteredExtensions.length" class="extension-grid">
          <article v-for="extension in filteredExtensions" :key="extension.resolvedPath" class="extension-item" :class="{ 'is-selected': selectedExtension === extension }" :data-extension="extensionName(extension.path)" :data-scope="extension.scope">
            <header class="extension-item-header">
              <span class="extension-item-icon"><Puzzle :size="22" aria-hidden="true" /></span>
              <div class="extension-identity"><h3 :title="extensionName(extension.path)">{{ extensionName(extension.path) }}</h3><span>{{ extension.source }}</span></div>
              <span class="extension-scope-badge">{{ t(`settings.extensionFilters.${extension.scope}`) }}</span>
            </header>
            <div class="extension-item-body">
              <p v-if="extension.bundled" class="extension-no-capabilities">{{ t("settings.extensionBundledNote") }}</p>
              <p class="extension-summary">{{ extensionSummary(extension) }}</p>
              <div class="extension-metrics"><span><Wrench :size="13" />{{ t("settings.extensionTools", { n: extension.tools.length }) }}</span><span><Terminal :size="13" />{{ t("settings.extensionCommands", { n: extension.commands.length }) }}</span></div>
            </div>
            <button type="button" class="extension-details" :aria-expanded="selectedExtension === extension" :aria-controls="selectedExtension === extension ? 'extension-details-panel' : undefined" @click="openExtensionDetails(extension, $event)">{{ t("settings.extensionDetails") }}<ChevronRight :size="15" /></button>
          </article>
        </div>
        <section class="extension-recommended" :aria-label="t('settings.recommendedTitle')">
          <div class="extension-recommended-heading">
            <h3>{{ t("settings.recommendedTitle") }}</h3>
            <p>{{ t("settings.recommendedHint") }}</p>
          </div>
          <div class="extension-grid">
            <article v-for="item in RECOMMENDED_EXTENSIONS" :key="item.source" class="extension-item" :data-recommended="item.name">
              <header class="extension-item-header">
                <span class="extension-item-icon"><Download :size="21" aria-hidden="true" /></span>
                <div class="extension-identity">
                  <h3>{{ item.name }}</h3>
                  <span>{{ item.source }}</span>
                </div>
                <Button v-if="extensionInstalled(item.name)" variant="outline" size="sm" class="extension-install-button" :disabled="!!packageBusySource" @click="runPackageAction(item.source, 'removeExtension')">
                  <RefreshCw v-if="packageBusySource === item.source" :size="14" class="spin" aria-hidden="true" />
                  <Trash2 v-else :size="14" aria-hidden="true" />
                  {{ t(packageBusySource === item.source ? "settings.recommendedRemoving" : "settings.recommendedRemove") }}
                </Button>
                <Button v-else size="sm" class="extension-install-button" :disabled="!!packageBusySource" @click="runPackageAction(item.source, 'installExtension')">
                  <RefreshCw v-if="packageBusySource === item.source" :size="14" class="spin" aria-hidden="true" />
                  <Download v-else :size="14" aria-hidden="true" />
                  {{ t(packageBusySource === item.source ? "settings.recommendedInstalling" : "settings.recommendedInstall") }}
                </Button>
              </header>
              <div class="extension-item-body">
                <p class="extension-summary">{{ t(`settings.recommended.${item.key}.description`) }}</p>
                <p v-if="packageError?.source === item.source" class="extension-install-error" role="alert">{{ packageError.message }}</p>
              </div>
            </article>
          </div>
        </section>
        <p class="extension-footnote"><Folder :size="14" aria-hidden="true" />{{ t("settings.extensionDiscoveryNote") }}</p>
      </section>
      <AboutPage v-else-if="layout.settingsCategory === 'about'" />
      <section v-else-if="layout.settingsCategory !== 'shortcuts'" class="settings-card">
        <label v-for="row in rows" :key="`${row.scope}:${row.path}`" class="setting-row" :data-setting-path="row.path">
          <span><strong>{{ t(row.label) }}</strong><small>{{ rowHint(row) }}</small></span>
          <input
            v-if="row.type === 'check'"
            class="switch"
            type="checkbox"
            :checked="Boolean(value(row))"
            @change="setValue(row, $event)"
          />
          <select v-else-if="row.type === 'select'" :value="String(value(row))" :disabled="row.path === 'theme' && (layout.themeSaving || saving)" @change="setValue(row, $event)">
            <option v-for="option in row.options" :key="option" :value="option">{{ optionLabel(option) }}</option>
          </select>
          <input v-else :type="row.type ?? 'text'" :value="String(value(row))" :placeholder="row.placeholder" :min="row.min" :max="row.max" @input="setValue(row, $event)" />
        </label>
      </section>
      <SkillEditorForm v-if="skillEditor" :key="skillEditor.document?.path ?? `new:${skillEditor.scope}`" :skill="skillEditor.document" :scope="skillEditor.scope" :readonly="skillEditor.readonly" @saved="skillSaved" @cancel="skillEditor = undefined" />
    </main>
    <aside v-if="layout.settingsCategory === 'models' && selectedProvider" id="model-details-panel" class="settings-inspector model-inspector" aria-labelledby="model-details-title" @keydown.esc.stop="closeDetailsPanel">
      <header class="settings-inspector-header">
        <div><small>{{ t(editingProvider ? "settings.manageProvider" : "settings.chooseModel") }}</small><h2 id="model-details-title">{{ selectedProvider.name }}</h2><span>{{ selectedProvider.id }}</span></div>
        <button ref="detailsCloseButton" type="button" class="settings-inspector-close" :aria-label="t('common.close')" @click="closeDetailsPanel"><X :size="18" /></button>
      </header>
      <div :key="selectedProvider.id + (editingProvider ? ':setup' : ':models')" class="settings-inspector-body model-inspector-body" tabindex="0" :aria-label="t(editingProvider ? 'settings.manageProvider' : 'settings.chooseModel')">
        <div v-if="editingProvider === selectedProvider.id" class="provider-setup" :data-provider-setup="selectedProvider.id">
          <div class="provider-setup-heading"><strong>{{ t("settings.providerSetupTitle", { name: selectedProvider.name }) }}</strong><small>{{ t(selectedProvider.authTypes.includes('api_key') ? 'settings.providerKeyHint' : 'settings.providerLoginHint') }}</small></div>
          <form v-if="selectedProvider.authTypes.includes('api_key')" class="provider-auth" @submit.prevent="saveApiKey(selectedProvider)">
            <label>
              <KeyRound :size="14" />
              <input v-model="keyDrafts[selectedProvider.id]" type="password" autocomplete="off" :aria-label="t('settings.providerApiKeyLabel', { name: selectedProvider.name })" :data-provider-api-key="selectedProvider.id" :placeholder="selectedProvider.status?.type === 'api_key' ? t('settings.replaceApiKey') : t('settings.enterApiKey')" />
            </label>
            <Button size="sm" class="model-primary-button" :disabled="providerBusy === selectedProvider.id || !keyDrafts[selectedProvider.id]?.trim()">{{ t("settings.saveKey") }}</Button>
          </form>
          <div v-else-if="selectedProvider.authTypes.includes('oauth')" class="provider-auth">
            <Button variant="outline" size="sm" :data-provider-oauth="selectedProvider.id" data-oauth-method="browser" :disabled="providerBusy === selectedProvider.id" @click="loginOAuth(selectedProvider, 'browser')">
              {{ providerBusy === selectedProvider.id ? t("settings.waitingSignIn") : t("settings.browser") }}
            </Button>
            <Button variant="outline" size="sm" :data-provider-oauth="selectedProvider.id" data-oauth-method="device-code" :disabled="providerBusy === selectedProvider.id" @click="loginOAuth(selectedProvider, 'device-code')">
              {{ t("settings.deviceCode") }}
            </Button>
          </div>
          <small v-else class="provider-auth-note">{{ t("settings.providerSetupNote") }}</small>
          <Button v-if="selectedProvider.status" variant="ghost" size="sm" class="provider-remove" :disabled="providerBusy === selectedProvider.id" @click="logout(selectedProvider)">{{ t("settings.removeProviderCredentials") }}</Button>
          <section v-if="customModels.some(model => model.provider === selectedProvider!.id)" data-custom-model-list>
            <div class="provider-model-heading"><strong>{{ t("settings.customModels") }}</strong></div>
            <div v-for="model in customModels.filter(model => model.provider === selectedProvider!.id)" :key="model.modelId" class="model-row">
              <span><strong>{{ model.name || model.modelId }}</strong><small>{{ model.modelId }}</small></span>
              <Button variant="outline" size="sm" :data-edit-custom-model="`${model.provider}/${model.modelId}`" :disabled="runtimeBusy || !!providerBusy" @click="editingCustomModel = model; addingCustomModel = true">{{ t("settings.editCustomModel") }}</Button>
            </div>
          </section>
        </div>

        <div v-if="expandedProvider === selectedProvider.id" class="provider-model-list" :data-provider-models="selectedProvider.id">
          <div class="provider-model-heading"><strong>{{ t("settings.chooseModel") }}</strong><span>{{ t("settings.chooseModelHint") }}</span></div>
          <p v-if="!providerModels(selectedProvider).length" class="settings-empty">{{ t("settings.noModels") }}</p>
          <article v-for="model in providerModels(selectedProvider)" :key="modelKey(model)" class="model-row" :class="{ selected: selectedModel === modelKey(model) }" :data-model="`${model.provider}/${model.id}`">
            <button type="button" class="model-select" :aria-pressed="selectedModel === modelKey(model)" @click="selectedModel = modelKey(model)">
              <span class="model-selection-mark" aria-hidden="true"><Check v-if="selectedModel === modelKey(model)" :size="12" /></span>
              <span><strong>{{ model.id }}</strong><small>{{ model.name || model.provider }}</small><span v-if="model.contextWindow || model.reasoning" class="model-specs"><span v-if="model.contextWindow">{{ t("settings.modelContext", { n: model.contextWindow.toLocaleString(locale) }) }}</span><span v-if="model.reasoning"><Sparkles :size="11" />{{ t("settings.modelReasoning") }}</span></span></span>
            </button>
            <span class="model-meta">
              <Button v-if="customModels.some(item => item.provider === model.provider && item.modelId === model.id)" variant="outline" size="sm" :data-edit-custom-model="`${model.provider}/${model.id}`" :disabled="runtimeBusy || !!providerBusy" @click="editingCustomModel = customModels.find(item => item.provider === model.provider && item.modelId === model.id); addingCustomModel = true">{{ t("settings.editCustomModel") }}</Button>
              <em v-if="currentModel === modelKey(model)" class="active">{{ t("settings.badgeCurrent") }}</em>
              <em v-if="defaultModel === modelKey(model)" class="default">{{ t("settings.badgeDefault") }}</em>
              <em v-if="draft.piGlobal.modelThinkingLevels?.[modelSettingsKey(model)]" class="default">{{ t("settings.badgeThinking") }}</em>
              <label class="model-cycle" :title="t('settings.cycleTitle')"><input type="checkbox" :checked="cyclingEnabled(model)" @change="toggleCycling(model)" />{{ t("settings.cycle") }}</label>
            </span>
          </article>

        </div>
      </div>
      <footer v-if="expandedProvider" class="model-actions">
        <span><small>{{ t("settings.selectedModelLabel") }}</small><strong>{{ selectedRuntimeModel?.id || '—' }}</strong></span>
        <Button class="model-primary-button" data-model-action="default" :disabled="!selectedModel || selectedModel === defaultModel" @click="applyModel">{{ t(selectedModel === defaultModel ? "settings.alreadyDefault" : "settings.setDefault") }}</Button>
      </footer>
    </aside>
    <aside v-if="layout.settingsCategory === 'extensions' && selectedExtension" id="extension-details-panel" class="settings-inspector extension-inspector" aria-labelledby="extension-details-title" @keydown.esc.stop="closeDetailsPanel">
      <header class="settings-inspector-header">
        <div><small>{{ t("settings.extensionDetails") }}</small><h2 id="extension-details-title">{{ extensionName(selectedExtension.path) }}</h2><span>{{ selectedExtension.source }}</span></div>
        <button ref="detailsCloseButton" type="button" class="settings-inspector-close" :aria-label="t('common.close')" @click="closeDetailsPanel"><X :size="18" /></button>
      </header>
      <div :key="selectedExtension.resolvedPath" class="settings-inspector-body extension-detail-body" tabindex="0" :aria-label="t('settings.extensionDetails')">
        <span class="extension-scope-badge">{{ t(`settings.extensionFilters.${selectedExtension.scope}`) }}</span>
        <p v-if="selectedExtension.bundled" class="extension-no-capabilities">{{ t("settings.extensionBundledNote") }}</p>
        <div class="extension-path"><strong><Folder :size="13" />{{ t("settings.extensionLocation") }}</strong><code>{{ selectedExtension.resolvedPath }}</code></div>
        <div v-if="selectedExtension.tools.length || selectedExtension.commands.length" class="extension-capabilities">
          <section v-if="selectedExtension.tools.length"><h3>{{ t("settings.extensionTools", { n: selectedExtension.tools.length }) }}</h3><div v-for="tool in selectedExtension.tools" :key="tool.name" class="extension-capability"><code>{{ tool.name }}</code><p v-if="tool.description">{{ tool.description }}</p></div></section>
          <section v-if="selectedExtension.commands.length"><h3>{{ t("settings.extensionCommands", { n: selectedExtension.commands.length }) }}</h3><div v-for="command in selectedExtension.commands" :key="command.name" class="extension-capability"><code>/{{ command.name }}</code><p v-if="command.description">{{ command.description }}</p></div></section>
        </div>
        <p v-else class="extension-no-capabilities">{{ t("settings.extensionNoCapabilities") }}</p>
      </div>
    </aside>
  </div>
</template>
