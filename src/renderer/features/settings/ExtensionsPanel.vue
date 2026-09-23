<script setup lang="ts">
import { ChevronRight, CircleAlert, Download, Folder, Puzzle, RefreshCw, Search, Terminal, Wrench, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { RECOMMENDED_EXTENSIONS } from "../../../shared/extensions";
import Button from "../../components/ui/Button.vue";
import { useExtensionsContext } from "./settings-context";

const { t } = useI18n();
const {
  extensions, extensionQuery, extensionScope, extensionBusy, extensionError, selectedExtension,
  filteredExtensions, extensionFilters, extensionName, extensionSummary, openExtensionDetails,
  loadExtensions, extensionInstalled, packageBusySource, packageError, runPackageAction,
} = useExtensionsContext();
</script>

<template>
  <section class="extension-card" :aria-busy="extensionBusy">
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
</template>
