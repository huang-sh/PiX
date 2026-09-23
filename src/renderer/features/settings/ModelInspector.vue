<script setup lang="ts">
import { Check, KeyRound, Sparkles, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import Button from "../../components/ui/Button.vue";
import { useModelsContext, useSettingsDraftContext, useSettingsInspector } from "./settings-context";

const { locale, t } = useI18n();
const { close, registerCloseButton } = useSettingsInspector();
const { draft } = useSettingsDraftContext();
const {
  editingProvider, selectedProvider, keyDrafts, providerBusy, saveApiKey, loginOAuth, logout, customModels,
  runtimeBusy, editingCustomModel, addingCustomModel, expandedProvider, providerModels, modelKey,
  selectedModel, currentModel, defaultModel, modelSettingsKey, cyclingEnabled, toggleCycling,
  selectedRuntimeModel, applyModel,
} = useModelsContext();
</script>

<template>
  <aside v-if="selectedProvider" id="model-details-panel" class="settings-inspector model-inspector" aria-labelledby="model-details-title" @keydown.esc.stop="close">
    <header class="settings-inspector-header">
      <div><small>{{ t(editingProvider ? "settings.manageProvider" : "settings.chooseModel") }}</small><h2 id="model-details-title">{{ selectedProvider.name }}</h2><span>{{ selectedProvider.id }}</span></div>
      <button :ref="registerCloseButton" type="button" class="settings-inspector-close" :aria-label="t('common.close')" @click="close"><X :size="18" /></button>
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
            <em v-if="draft?.piGlobal.modelThinkingLevels?.[modelSettingsKey(model)]" class="default">{{ t("settings.badgeThinking") }}</em>
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
</template>
