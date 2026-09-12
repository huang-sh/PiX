<script setup lang="ts">
import { reactive, ref } from "vue";
import { DialogRoot, DialogOverlay, DialogContent, DialogTitle } from "reka-ui";
import { useI18n } from "vue-i18n";
import { CUSTOM_MODEL_APIS, type CustomModelInput } from "../../../shared/types";
import { useSessionStore } from "../../stores/session";
import Button from "../../components/ui/Button.vue";

const props = defineProps<{ model?: CustomModelInput }>();
const emit = defineEmits<{ saved: [provider: string]; cancel: [] }>();
const { t } = useI18n();
const session = useSessionStore();
const busy = ref(false);
const error = ref("");
const keyless = ref(false);
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

async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await session.control({ ...draft, action: props.model ? "updateCustomModel" : "addCustomModel", apiKey: keyless.value ? "pix-local" : draft.apiKey });
    draft.apiKey = "";
    emit("saved", draft.provider.trim());
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <DialogRoot :open="true" @update:open="!$event && !busy && emit('cancel')">
    <DialogOverlay class="dialog-overlay" />
    <DialogContent class="custom-model-dialog" :aria-describedby="undefined" @interact-outside.prevent @escape-key-down="busy && $event.preventDefault()">
  <form class="settings-card model-options" data-custom-model-form :aria-busy="busy" @submit.prevent="save">
    <header class="model-options-header"><DialogTitle>{{ t(props.model ? "settings.editCustomModel" : "settings.addCustomModel") }}</DialogTitle></header>
    <fieldset :disabled="busy" class="custom-model-fields">
      <label v-for="field in fields" :key="field.key" class="setting-row"><span><strong>{{ t(`settings.${field.label}`) }}</strong><small v-if="field.key === 'provider'">{{ t("settings.customProviderHint") }}</small><small v-if="props.model && field.key === 'modelId'">{{ t("settings.customIdentityHint") }}</small></span><input v-model="draft[field.key]" :readonly="!!props.model && (field.key === 'provider' || field.key === 'modelId')" :name="field.key" :type="field.type" :required="field.required" :placeholder="field.placeholder" /></label>
      <label class="setting-row"><span><strong>{{ t("settings.customApi") }}</strong></span><select v-model="draft.api" name="api"><option v-for="api in CUSTOM_MODEL_APIS" :key="api" :value="api">{{ api }}</option></select></label>
      <label class="setting-row"><span><strong>{{ t("settings.customKeyless") }}</strong><small>{{ t("settings.customKeylessHint") }}</small></span><input v-model="keyless" class="switch" name="keyless" type="checkbox" /></label>
      <label v-if="!keyless" class="setting-row"><span><strong>API Key</strong><small>{{ t("settings.customApiKeyHint") }}</small></span><input v-model="draft.apiKey" name="apiKey" type="password" autocomplete="new-password" /></label>
      <label class="setting-row"><span><strong>{{ t("settings.customContextWindow") }}</strong></span><input v-model.number="draft.contextWindow" name="contextWindow" type="number" required min="1" step="1" /></label>
      <label class="setting-row"><span><strong>{{ t("settings.customMaxTokens") }}</strong></span><input v-model.number="draft.maxTokens" name="maxTokens" type="number" required min="1" step="1" /></label>
      <label class="setting-row"><span><strong>{{ t("settings.customReasoning") }}</strong></span><input v-model="draft.reasoning" name="reasoning" class="switch" type="checkbox" /></label>
      <label class="setting-row"><span><strong>{{ t("settings.customImageInput") }}</strong></span><input v-model="draft.imageInput" name="imageInput" class="switch" type="checkbox" /></label>
    </fieldset>
    <p class="custom-model-note">{{ t("settings.customStorageHint") }}</p>
    <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
    <footer class="model-options-header">
      <Button type="button" variant="outline" :disabled="busy" @click="emit('cancel')">{{ t("settings.customCancel") }}</Button>
      <Button type="submit" :disabled="busy">{{ t(busy ? "settings.saving" : props.model ? "common.save" : "settings.addCustomModel") }}</Button>
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
</style>
