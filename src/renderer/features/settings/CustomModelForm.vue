<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { DialogRoot, DialogOverlay, DialogContent, DialogTitle } from "reka-ui";
import { useI18n } from "vue-i18n";
import { CUSTOM_MODEL_APIS, type CustomModelInput, type DiscoveredModel } from "../../../shared/types";
import { useSessionStore } from "../../stores/session";
import Button from "../../components/ui/Button.vue";

const props = defineProps<{ model?: CustomModelInput }>();
const emit = defineEmits<{ saved: [provider: string, modelId: string]; cancel: [] }>();
const { t } = useI18n();
const session = useSessionStore();
const busy = ref(false);
const error = ref("");
const keyless = ref(false);
const fetching = ref(false);
const working = computed(() => busy.value || fetching.value);
const discovered = ref<DiscoveredModel[] | null>(null);
const selectedIds = ref<string[]>([]);
const query = ref("");
const draft = reactive<CustomModelInput>({
  provider: "", modelId: "", name: "", baseUrl: "", api: "openai-completions",
  apiKey: "", contextWindow: 128000, maxTokens: 16384, reasoning: false, imageInput: false,
  ...props.model,
});
const fields = [
  { key: "provider", label: "customProviderId", placeholder: "my-provider", type: "text", required: true },
  { key: "baseUrl", label: "customBaseUrl", placeholder: "http://localhost:11434/v1", type: "url", required: true },
  { key: "modelId", label: "customModelId", placeholder: "qwen2.5-coder:7b", type: "text", required: true },
  { key: "name", label: "customModelName", placeholder: "", type: "text", required: false },
] as const;

const filteredModels = computed(() => discovered.value?.filter(model =>
  `${model.id} ${model.name ?? ""}`.toLowerCase().includes(query.value.trim().toLowerCase())) ?? []);
const modelsToAdd = computed(() => {
  const models = new Map<string, { modelId: string; name?: string }>();
  for (const model of discovered.value ?? [])
    if (selectedIds.value.includes(model.id) && !model.exists) models.set(model.id, { modelId: model.id, name: model.name });
  for (const id of draft.modelId.split(/[\n,]+/).map(id => id.trim()).filter(Boolean))
    if (!models.has(id)) models.set(id, { modelId: id });
  const result = [...models.values()];
  if (result.length === 1 && draft.name?.trim()) result[0]!.name = draft.name.trim();
  return result;
});

watch(() => [draft.provider, draft.baseUrl, draft.api, draft.apiKey, keyless.value], () => {
  discovered.value = null;
  selectedIds.value = [];
  query.value = "";
  error.value = "";
});

async function fetchModels() {
  if (working.value) return;
  fetching.value = true;
  error.value = "";
  try {
    discovered.value = await session.control<DiscoveredModel[]>({
      action: "discoverModels", provider: draft.provider, baseUrl: draft.baseUrl,
      api: draft.api, apiKey: keyless.value ? "pix-local" : draft.apiKey,
    });
    selectedIds.value = [];
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally { fetching.value = false; }
}

function selectAll() {
  selectedIds.value = [...new Set([...selectedIds.value, ...filteredModels.value.filter(model => !model.exists).map(model => model.id)])];
}

async function save() {
  if (working.value) return;
  if (!props.model && !modelsToAdd.value.length) {
    error.value = t("settings.customChooseModels");
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const common = { ...draft, apiKey: keyless.value ? "pix-local" : draft.apiKey };
    if (props.model) await session.control({ ...common, action: "updateCustomModel" });
    else if (modelsToAdd.value.length === 1)
      await session.control({ ...common, ...modelsToAdd.value[0]!, action: "addCustomModel" });
    else {
      const { modelId, name, ...provider } = common;
      await session.control({ ...provider, action: "addCustomModels", models: modelsToAdd.value.map(model => ({ ...model })) });
    }
    const firstId = props.model ? draft.modelId.trim() : modelsToAdd.value[0]!.modelId;
    draft.apiKey = "";
    emit("saved", draft.provider.trim(), firstId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <DialogRoot :open="true" @update:open="!$event && !working && emit('cancel')">
    <DialogOverlay class="dialog-overlay" />
    <DialogContent class="custom-model-dialog" :aria-describedby="undefined" @interact-outside.prevent @escape-key-down="working && $event.preventDefault()">
  <form class="settings-card model-options" data-custom-model-form :aria-busy="working" @submit.prevent="save">
    <header class="model-options-header"><DialogTitle>{{ t(props.model ? "settings.editCustomModel" : "settings.addCustomModel") }}</DialogTitle></header>
    <fieldset :disabled="working" class="custom-model-fields">
      <template v-for="field in fields" :key="field.key">
        <label v-if="field.key !== 'name' || props.model || modelsToAdd.length <= 1" class="setting-row"><span><strong>{{ t(`settings.${field.key === 'modelId' && !props.model ? 'customModelIds' : field.label}`) }}</strong><small v-if="field.key === 'provider'">{{ t("settings.customProviderHint") }}</small><small v-if="field.key === 'modelId'">{{ t(props.model ? "settings.customIdentityHint" : "settings.customModelIdsHint") }}</small></span><textarea v-if="field.key === 'modelId' && !props.model" v-model="draft.modelId" name="modelId" rows="3" :placeholder="field.placeholder" /><input v-else v-model="draft[field.key]" :readonly="!!props.model && (field.key === 'provider' || field.key === 'modelId')" :name="field.key" :type="field.type" :required="field.required" :placeholder="field.placeholder" /></label>
      </template>
      <label class="setting-row"><span><strong>{{ t("settings.customApi") }}</strong></span><select v-model="draft.api" name="api"><option v-for="api in CUSTOM_MODEL_APIS" :key="api" :value="api">{{ api }}</option></select></label>
      <label class="setting-row"><span><strong>{{ t("settings.customKeyless") }}</strong><small>{{ t("settings.customKeylessHint") }}</small></span><input v-model="keyless" class="switch" name="keyless" type="checkbox" /></label>
      <label v-if="!keyless" class="setting-row"><span><strong>API Key</strong><small>{{ t("settings.customApiKeyHint") }}</small></span><input v-model="draft.apiKey" name="apiKey" type="password" autocomplete="new-password" /></label>
      <section v-if="!props.model" class="model-discovery">
        <div class="discovery-actions"><Button type="button" variant="outline" data-discover-models :disabled="working || !draft.provider.trim() || !draft.baseUrl.trim()" @click="fetchModels">{{ t(fetching ? "settings.customFetchingModels" : "settings.customFetchModels") }}</Button><span v-if="modelsToAdd.length" role="status">{{ t("settings.customModelsSelected", { n: modelsToAdd.length }) }}</span></div>
        <p class="discovery-hint">{{ t("settings.customDiscoveryHint") }}</p>
        <template v-if="discovered !== null">
          <input v-if="discovered.length" v-model="query" type="search" data-discovered-model-search :placeholder="t('settings.customSearchModels')" :aria-label="t('settings.customSearchModels')" @keydown.enter.prevent />
          <div v-if="discovered.length" class="discovery-actions"><Button type="button" variant="ghost" size="sm" data-select-all-models @click="selectAll">{{ t("settings.customSelectAll") }}</Button><Button type="button" variant="ghost" size="sm" data-clear-models @click="selectedIds = []">{{ t("settings.customClearSelection") }}</Button></div>
          <div class="discovered-models" role="group" :aria-label="t('settings.customAvailableModels')">
            <label v-for="model in filteredModels" :key="model.id" class="discovered-model"><input v-model="selectedIds" type="checkbox" :value="model.id" :disabled="model.exists" :data-discovered-model="model.id" /><span><strong>{{ model.name || model.id }}</strong><small v-if="model.name && model.name !== model.id">{{ model.id }}</small></span><small v-if="model.exists">{{ t("settings.customModelExists") }}</small></label>
            <p v-if="!filteredModels.length" role="status">{{ t(discovered.length ? "settings.noMatchingModels" : "settings.customNoModels") }}</p>
          </div>
        </template>
        <p v-if="modelsToAdd.length > 1" class="discovery-hint">{{ t("settings.customSharedOptionsHint") }}</p>
      </section>
      <label class="setting-row"><span><strong>{{ t("settings.customContextWindow") }}</strong></span><input v-model.number="draft.contextWindow" name="contextWindow" type="number" required min="1" step="1" /></label>
      <label class="setting-row"><span><strong>{{ t("settings.customMaxTokens") }}</strong></span><input v-model.number="draft.maxTokens" name="maxTokens" type="number" required min="1" step="1" /></label>
      <label class="setting-row"><span><strong>{{ t("settings.customReasoning") }}</strong></span><input v-model="draft.reasoning" name="reasoning" class="switch" type="checkbox" /></label>
      <label class="setting-row"><span><strong>{{ t("settings.customImageInput") }}</strong></span><input v-model="draft.imageInput" name="imageInput" class="switch" type="checkbox" /></label>
    </fieldset>
    <p class="custom-model-note">{{ t("settings.customStorageHint") }}</p>
    <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
    <footer class="model-options-header">
      <Button type="button" variant="outline" :disabled="working" @click="emit('cancel')">{{ t("settings.customCancel") }}</Button>
      <Button type="submit" :disabled="working">{{ busy ? t("settings.saving") : props.model ? t("common.save") : modelsToAdd.length > 1 ? t("settings.customAddModels", { n: modelsToAdd.length }) : t("settings.addCustomModel") }}</Button>
    </footer>
  </form>
    </DialogContent>
  </DialogRoot>
</template>

<style scoped>
.custom-model-dialog { position: fixed; z-index: 151; top: 5vh; left: 50%; transform: translateX(-50%); width: min(680px, calc(100vw - 40px)); max-height: 90vh; overflow: auto; border-radius: 14px; background: var(--surface); box-shadow: 0 30px 90px rgba(14,38,31,.26); }
.custom-model-dialog h2 { margin: 0; font-size: var(--font-size-ui); }
.custom-model-fields { border: 0; padding: 0; margin: 0; min-width: 0; }
.custom-model-note { padding: 14px 21px; color: var(--muted); font-size: var(--font-size-ui); line-height: 1.6; }
.model-discovery { padding: 14px 21px; border-bottom: 1px solid var(--border); }
.discovery-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.discovery-actions > span, .discovery-hint, .discovered-model small, .discovered-models > p { color: var(--muted); font-size: var(--font-size-ui); }
.discovery-hint { margin: 10px 0; line-height: 1.5; }
.discovered-models { max-height: 240px; overflow-y: auto; }
.discovered-model { display: flex; align-items: center; gap: 10px; padding: 8px 0; cursor: pointer; }
.discovered-model > span { display: grid; flex: 1; min-width: 0; gap: 3px; overflow-wrap: anywhere; }
.discovered-model:has(input:disabled) { opacity: .6; cursor: default; }
.model-discovery > input { width: 100%; height: 39px; padding: 0 11px; margin: 4px 0; }
.setting-row textarea { width: 100%; min-width: 0; padding: 9px 11px; resize: vertical; font-size: var(--font-size-ui); }
</style>
