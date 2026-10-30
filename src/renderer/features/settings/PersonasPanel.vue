<script setup lang="ts">
import { computed, ref, toRaw } from "vue";
import { Pencil, Plus, Trash2, VenetianMask } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { PersonaDefinition } from "../../../shared/types";
import Button from "../../components/ui/Button.vue";
import { useLayoutStore } from "../../stores/layout";

const { t } = useI18n();
const layout = useLayoutStore();
const personas = computed(() => layout.settings?.app.personas ?? []);
// The form doubles as create (original null) and edit (original name).
const form = ref<{ original: string | null; name: string; text: string } | null>(null);
const confirming = ref<string | null>(null);
const error = ref("");
const saving = ref(false);

function openCreate() {
  if (saving.value) return;
  error.value = "";
  form.value = { original: null, name: "", text: "" };
}
function openEdit(persona: PersonaDefinition) {
  if (saving.value) return;
  error.value = "";
  form.value = { original: persona.name, name: persona.name, text: persona.text };
}
function closeForm() {
  form.value = null;
  error.value = "";
}
async function save() {
  const draft = form.value;
  if (!draft || saving.value) return;
  const name = draft.name.trim();
  if (!name) { error.value = t("settings.personaNameRequired"); return; }
  if (!draft.text.trim()) { error.value = t("settings.personaTextRequired"); return; }
  const others = personas.value.map(toRaw).filter(persona => persona.name !== draft.original);
  if (others.some(persona => persona.name === name)) { error.value = t("settings.personaNameTaken"); return; }
  saving.value = true;
  error.value = "";
  try {
    await layout.updateAppSettings({ personas: [...others, { name, text: draft.text }].sort((a, b) => a.name.localeCompare(b.name)) });
    closeForm();
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : String(saveError);
  } finally {
    saving.value = false;
  }
}
async function remove(persona: PersonaDefinition) {
  if (saving.value) return;
  // Arm on the first click, delete on the second — the same pattern as skills.
  if (confirming.value !== persona.name) {
    confirming.value = persona.name;
    return;
  }
  confirming.value = null;
  saving.value = true;
  error.value = "";
  try {
    await layout.updateAppSettings({ personas: personas.value.map(toRaw).filter(item => item.name !== persona.name) });
    if (form.value?.original === persona.name) closeForm();
  } catch (saveError) {
    error.value = saveError instanceof Error ? saveError.message : String(saveError);
  } finally {
    saving.value = false;
  }
}
const clip = (text: string) => {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 90 ? `${single.slice(0, 89)}…` : single;
};
</script>

<template>
  <div class="persona-section" data-personas-panel>
    <header class="persona-card-head">
      <div>
        <h2>{{ t("settings.personasTitle") }}</h2>
        <p>{{ t("settings.personasHint") }}</p>
      </div>
      <Button size="sm" data-persona-new :disabled="saving" @click="openCreate"><Plus :size="14" />{{ t("settings.personaNew") }}</Button>
    </header>
    <p v-if="error" class="persona-error" role="alert">{{ error }}</p>
    <form v-if="form" class="persona-form" data-persona-form :aria-busy="saving" @submit.prevent="save">
      <label>
        <span>{{ t("settings.personaName") }}</span>
        <input v-model="form.name" data-persona-name :placeholder="t('settings.personaNamePlaceholder')" maxlength="60" :disabled="saving" />
      </label>
      <label>
        <span>{{ t("settings.personaText") }}</span>
        <textarea v-model="form.text" data-persona-text rows="8" :placeholder="t('settings.personaTextPlaceholder')" :disabled="saving" />
      </label>
      <footer>
        <Button variant="outline" size="sm" type="button" :disabled="saving" @click="closeForm">{{ t("common.cancel") }}</Button>
        <Button size="sm" type="submit" data-persona-save :disabled="saving">{{ t(saving ? "settings.saving" : "common.save") }}</Button>
      </footer>
    </form>
    <div v-if="personas.length" class="persona-list" role="list">
      <article v-for="persona in personas" :key="persona.name" class="persona-row" role="listitem" :data-persona="persona.name">
        <span class="persona-glyph" aria-hidden="true"><VenetianMask :size="15" /></span>
        <div class="persona-body">
          <strong>{{ persona.name }}</strong>
          <p>{{ clip(persona.text) }}</p>
        </div>
        <div class="persona-actions">
          <Button variant="ghost" size="icon" :title="t('settings.personaEdit')" :aria-label="t('settings.personaEdit')" :disabled="saving" @click="openEdit(persona)"><Pencil :size="13" /></Button>
          <Button variant="ghost" size="icon" :class="confirming === persona.name ? 'persona-delete is-arming' : 'persona-delete'"
            :title="t(confirming === persona.name ? 'settings.personaConfirmDeleteShort' : 'settings.deletePersona')"
            :aria-label="t('settings.deletePersona')" :data-persona-delete="persona.name"
            :disabled="saving"
            @click="remove(persona)"><Trash2 :size="13" /></Button>
        </div>
      </article>
    </div>
    <div v-else-if="!form" class="persona-empty">
      <span class="persona-empty-icon"><VenetianMask :size="18" /></span>
      <strong>{{ t("settings.personaEmpty") }}</strong>
      <span>{{ t("settings.personaEmptyHint") }}</span>
    </div>
  </div>
</template>
