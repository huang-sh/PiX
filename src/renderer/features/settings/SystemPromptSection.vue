<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Pencil, RefreshCw, RotateCcw, ScrollText } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { PromptCustomization, SystemPromptPreview } from "../../../shared/types";
import Button from "../../components/ui/Button.vue";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";

const { t, te } = useI18n();
const layout = useLayoutStore();
const session = useSessionStore();
const customization = computed(() => layout.settings?.app.promptCustomization ?? {});
const personas = computed(() => layout.settings?.app.personas ?? []);
const preview = ref<SystemPromptPreview>();
const loading = ref(false);
const saving = ref(false);
const editing = ref<"preamble" | "rules" | "docs" | null>(null);
const editText = ref("");
const editInitialText = ref("");
const editPreambleSource = ref("");
const savedPersona = computed(() => {
  const { preamble, preamblePersona } = customization.value;
  if (!preamble) return "";
  if (preamblePersona === null) return "custom";
  if (preamblePersona) {
    const persona = personas.value.find(item => item.name === preamblePersona && item.text === preamble);
    return persona ? `persona:${persona.name}` : "custom";
  }
  // Older settings have only text. Infer a name only when it is unambiguous.
  const matches = personas.value.filter(item => item.text === preamble);
  return matches.length === 1 ? `persona:${matches[0]!.name}` : "custom";
});
const selectedPersona = computed(() => {
  if (editing.value !== "preamble") return savedPersona.value;
  if (editText.value !== editInitialText.value) return "custom";
  const source = editPreambleSource.value;
  if (!source || source === "custom") return source;
  return personas.value.some(item => `persona:${item.name}` === source && item.text === editText.value) ? source : "custom";
});
const error = ref("");
const root = ref<HTMLElement>();
let previewRequest = 0;

const EDITABLE = ["preamble", "rules", "docs"] as const;
const DYNAMIC_HINT: Record<string, string> = {
  tools: "promptDynamicTools",
  project_context: "promptDynamicProject",
  skills: "promptDynamicSkills",
  cwd: "promptDynamicCwd",
  addendum: "promptDynamicAddendum",
};

async function loadPreview() {
  const request = ++previewRequest;
  loading.value = true;
  error.value = "";
  try {
    const result = await session.promptPreview();
    if (request !== previewRequest) return;
    preview.value = result;
    if (!preview.value?.text) error.value = t("settings.promptEmpty");
  } catch (loadError) {
    if (request !== previewRequest) return;
    // A stale or mismatched host must report itself instead of rendering blank.
    error.value = t("settings.promptLoadFailed", { message: loadError instanceof Error ? loadError.message : String(loadError) });
  } finally {
    if (request === previewRequest) loading.value = false;
  }
}
// Open sessions expose new settings after their idle reload. With no session,
// the preview can read the saved settings immediately.
watch([
  () => session.activeProjectId,
  () => session.current?.session.path,
  () => session.promptPreviewRevision,
  () => session.current ? undefined : layout.settings?.piGlobal?.outputStyle,
  () => session.current ? undefined : layout.settings?.piProject?.outputStyle,
], loadPreview, { immediate: true });

const parsed = computed(() => preview.value ?? { preamble: "", sections: [] });
// Editable sections first, dynamic ones in render order after.
const sectionLabel = (name: string) => {
  const key = `settings.promptSections.${name}`;
  return te(key) ? t(key) : name;
};

async function startEdit(section: "preamble" | "rules" | "docs") {
  if (saving.value) return;
  error.value = "";
  editing.value = section;
  const current = customization.value[section];
  if (current) editText.value = current;
  else if (section === "preamble") editText.value = parsed.value.preamble;
  else editText.value = parsed.value.sections.find(item => item.name === section)?.content ?? "";
  editInitialText.value = editText.value;
  if (section === "preamble") editPreambleSource.value = savedPersona.value;
  await nextTick();
  const textarea = root.value?.querySelector<HTMLTextAreaElement>("[data-prompt-editor-text]");
  textarea?.focus({ preventScroll: true });
  textarea?.scrollIntoView?.({ block: "nearest" });
}
async function choosePersona(event: Event) {
  const select = event.target as HTMLSelectElement;
  if (saving.value || (editing.value && editing.value !== "preamble")) return;
  if (select.value === "") {
    await resetSection("preamble");
    return;
  }
  const persona = personas.value.find(item => `persona:${item.name}` === select.value);
  if (!persona) return;
  await startEdit("preamble");
  editText.value = persona.text;
  editInitialText.value = persona.text;
  editPreambleSource.value = `persona:${persona.name}`;
}
async function saveEdit() {
  if (!editing.value || saving.value) return;
  const next: PromptCustomization = { ...customization.value };
  if (editText.value.trim() && !(editing.value === "preamble" && selectedPersona.value === "")) next[editing.value] = editText.value;
  else delete next[editing.value];
  if (editing.value === "preamble") {
    const persona = personas.value.find(item => `persona:${item.name}` === selectedPersona.value && item.text === editText.value);
    if (next.preamble) next.preamblePersona = persona?.name ?? null;
    else delete next.preamblePersona;
  }
  saving.value = true;
  error.value = "";
  try {
    await layout.updateAppSettings({ promptCustomization: next });
    editing.value = null;
    await loadPreview();
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : String(saveError);
  } finally {
    saving.value = false;
  }
}
async function resetSection(section: "preamble" | "rules" | "docs") {
  if (saving.value) return;
  const next: PromptCustomization = { ...customization.value };
  delete next[section];
  if (section === "preamble") delete next.preamblePersona;
  saving.value = true;
  error.value = "";
  try {
    await layout.updateAppSettings({ promptCustomization: next });
    if (editing.value === section) editing.value = null;
    await loadPreview();
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : String(saveError);
  } finally {
    saving.value = false;
  }
}
/** Display the effective render, including persona precedence. */
const contentOf = (name: "preamble" | "rules" | "docs") =>
  (preview.value ? (name === "preamble" ? parsed.value.preamble : parsed.value.sections.find(s => s.name === name)?.content)
    : customization.value[name]) ?? "";
</script>

<template>
  <div ref="root" class="prompt-section" data-prompt-section>
    <header class="persona-card-head">
      <div>
        <h2>{{ t("settings.promptTitle") }}</h2>
        <p>{{ t("settings.promptHint") }}</p>
      </div>
      <Button variant="outline" size="icon" :title="t('settings.promptRefresh')" :disabled="loading || saving" @click="loadPreview">
        <RefreshCw :size="15" :class="{ spin: loading }" />
      </Button>
    </header>
    <p v-if="error && !editing" class="persona-error" role="alert">{{ error }}</p>
    <p v-if="!error && !session.current" class="prompt-note" data-prompt-no-session>
      {{ t("settings.promptPreviewFresh") }}
    </p>
    <p v-if="session.current?.runtime.isStreaming || session.current?.runtime.isCompacting" class="prompt-note" data-prompt-waiting>
      {{ t("settings.promptPreviewWaiting") }}
    </p>

    <template v-if="preview || Object.keys(customization).length">
      <article v-for="name in EDITABLE" :key="name" class="prompt-block" :data-prompt-block="name">
        <header>
          <strong>{{ sectionLabel(name) }}</strong>
          <span v-if="customization[name]" class="prompt-badge">{{ t("settings.promptCustomized") }}</span>
          <span v-else class="prompt-badge is-dynamic">{{ t("settings.promptDynamic") }}</span>
          <span class="prompt-block-actions">
            <Button v-if="!editing" variant="ghost" size="icon" :title="t('settings.promptCustomize')" :disabled="saving" @click="startEdit(name)"><Pencil :size="13" /></Button>
            <Button v-if="customization[name]" variant="ghost" size="icon" :title="t('settings.promptReset')" :disabled="saving" @click="resetSection(name)"><RotateCcw :size="13" /></Button>
          </span>
        </header>
        <label v-if="name === 'preamble'" class="prompt-persona-picker">
          <span>{{ t("settings.promptChoosePersona") }}</span>
          <select data-prompt-persona :value="selectedPersona" :disabled="saving || !!(editing && editing !== 'preamble')" @change="choosePersona">
            <option value="">{{ t("settings.promptDefaultPersona") }}</option>
            <option v-if="selectedPersona === 'custom'" value="custom" disabled>{{ t("settings.promptCustomPersona") }}</option>
            <option v-for="persona in personas" :key="persona.name" :value="`persona:${persona.name}`">{{ persona.name }}</option>
          </select>
          <small>{{ t("settings.promptChoosePersonaHint") }}</small>
        </label>
        <form v-if="editing === name" class="persona-form" data-prompt-editor :aria-busy="saving" @submit.prevent="saveEdit">
          <label>
            <span>{{ t("settings.promptEditing", { section: sectionLabel(name) }) }}</span>
            <textarea v-model="editText" data-prompt-editor-text rows="10" :disabled="saving" />
          </label>
          <p v-if="error" class="persona-error" role="alert">{{ error }}</p>
          <footer>
            <Button variant="outline" size="sm" type="button" :disabled="saving" @click="editing = null">{{ t("common.cancel") }}</Button>
            <Button size="sm" type="submit" data-prompt-editor-save :disabled="saving">{{ t(saving ? "settings.saving" : "common.save") }}</Button>
          </footer>
        </form>
        <pre v-else-if="contentOf(name)">{{ contentOf(name) }}</pre>
        <pre v-else class="is-empty">{{ t("settings.promptNotSet") }}</pre>
      </article>

      <!-- Read-only dynamic sections -->
      <article v-for="section in parsed.sections.filter(s => !EDITABLE.includes(s.name as (typeof EDITABLE)[number]))" :key="section.name" class="prompt-block is-readonly" :data-prompt-block="section.name">
        <header>
          <strong>{{ sectionLabel(section.name) }}</strong>
          <span class="prompt-badge is-dynamic">{{ t("settings.promptDynamic") }}</span>
        </header>
        <pre>{{ section.content }}</pre>
        <small v-if="DYNAMIC_HINT[section.name]">{{ t(`settings.${DYNAMIC_HINT[section.name]}`) }}</small>
      </article>
    </template>
    <div v-if="!preview && loading" class="persona-empty">
      <span class="persona-empty-icon"><ScrollText :size="18" /></span>
      <strong>{{ t("settings.promptLoading") }}</strong>
    </div>
  </div>
</template>
