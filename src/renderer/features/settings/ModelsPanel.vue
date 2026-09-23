<script setup lang="ts">
import { Bot, Box, Check, ChevronDown, ChevronRight, CircleAlert, KeyRound, RefreshCw, Search, SlidersHorizontal, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { useSessionStore } from "../../stores/session";
import Button from "../../components/ui/Button.vue";
import CustomModelForm from "./CustomModelForm.vue";
import SettingRow from "./SettingRow.vue";
import { useModelsContext, useSettingsDraftContext } from "./settings-context";

const { t } = useI18n();
const session = useSessionStore();
const { draft, rows, optionLabel } = useSettingsDraftContext();
const {
  models, modelQuery, addingCustomModel, editingCustomModel, providers, providerFilter, runtimeBusy,
  providerBusy, runtimeError, providerFilters, filteredProviders, providerSections, providerModels,
  selectedProvider, expandedProvider, editingProvider, toggleProvider, toggleProviderSetup, loadRuntime,
  customModelSaved, selectedRuntimeModel, selectedThinkingLevels, modelThinkingOverride,
  setModelThinkingOverride, setAllCycling,
} = useModelsContext();
</script>

<template>
  <div class="model-workspace">
    <section class="model-overview" :aria-label="t('settings.modelOverview')">
      <div class="model-default-summary">
        <span class="model-overview-icon"><Box :size="25" aria-hidden="true" /></span>
        <div>
          <span class="model-eyebrow">{{ t("settings.defaultModelLabel") }}</span>
          <h2 data-default-model>{{ draft?.effective.defaultModel || t("settings.noDefaultModel") }}</h2>
          <span v-if="draft?.effective.defaultProvider" class="model-summary-provider">{{ draft?.effective.defaultProvider }}</span>
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
      <SettingRow v-for="row in rows" :key="`${row.scope}:${row.path}`" :row="row" />
      <footer class="model-cycle-actions"><span>{{ t("settings.cyclePreferencesHint") }}</span><Button variant="ghost" size="sm" @click="setAllCycling(true)">{{ t("settings.cycleAll") }}</Button><Button variant="ghost" size="sm" @click="setAllCycling(false)">{{ t("settings.clearCycle") }}</Button></footer>
    </section>
  </div>
</template>
