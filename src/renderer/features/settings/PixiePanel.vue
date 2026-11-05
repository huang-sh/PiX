<script setup lang="ts">
import { FolderOpen, RotateCcw, Save, Trash2 } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { PIXIE_IDENTITY } from "../../../shared/pixie-prompt";
import type { PixiePromptCustomization, SessionSnapshot } from "../../../shared/types";
import { desktop } from "../../api";
import Button from "../../components/ui/Button.vue";
import { usePixieStore } from "../../stores/pixie";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import { useSettingsDraftContext } from "./settings-context";
import type { Row } from "./use-settings-draft";
import SettingRow from "./SettingRow.vue";

const { t } = useI18n();
const { value, setValue, rowHint, optionLabel } = useSettingsDraftContext();
const pixie = usePixieStore();
const session = useSessionStore();
const layout = useLayoutStore();
const clearing = ref(false);
// The prompt is fully customizable: the identity line, optional <rules>/<docs>
// sections, or the entire text verbatim in full-replacement mode. Empty fields
// fall back to the built-in prompt; matching the built-in identity keeps
// default mode.
const draft = ref<PixiePromptCustomization>({});
const promptSaving = ref(false);
const customized = computed(() => Boolean(layout.settings?.app.pixie?.prompt));
// The saved prompt as last adopted. Settings refreshes replace the whole
// bundle on every unrelated write (toggling a row, another window), so the
// draft resets only when the saved prompt itself changed — unsaved edits
// survive anything else. A local save adopts the normalized result.
let adopted: PixiePromptCustomization | undefined;
watch(() => layout.settings?.app.pixie?.prompt, saved => {
  if (saved?.identity === adopted?.identity && saved?.rules === adopted?.rules
    && saved?.docs === adopted?.docs && saved?.full === adopted?.full) return;
  adopted = saved;
  draft.value = { ...saved };
}, { immediate: true });
// Full replacement ignores the sections. Their drafts stay while toggling
// back without saving; a save in full mode clears them from the settings.
const fullMode = computed({
  get: () => draft.value.full !== undefined,
  set: (on: boolean) => {
    if (on) { if (draft.value.full === undefined) draft.value.full = ""; }
    else delete draft.value.full;
  },
});
const personas = computed(() => layout.settings?.app.personas ?? []);

function seedIdentity(event: Event) {
  const select = event.target as HTMLSelectElement;
  const persona = personas.value.find(item => item.name === select.value);
  if (persona) draft.value.identity = persona.text;
  select.value = "";
}

// The model picker spells entries "provider/modelId" — the same string the
// runtime splits back into its set_model command.
const rows = computed<Row[]>(() => [
  {
    path: "pixie.sprite",
    label: "settings.rows.pixieSprite",
    scope: "app",
    type: "check",
    fallback: true,
    description: "settings.rows.pixieSpriteDesc",
  },
  {
    path: "pixie.restoreLastConversation",
    label: "settings.rows.pixieRestore",
    scope: "app",
    type: "check",
    fallback: true,
    description: "settings.rows.pixieRestoreDesc",
  },
  {
    path: "pixie.defaultModel",
    label: "settings.rows.pixieDefaultModel",
    scope: "app",
    type: "select",
    options: ["default", ...session.models.map(model => `${model.provider}/${model.id}`)],
    fallback: "default",
    description: "settings.rows.pixieDefaultModelDesc",
  },
]);
const modelRow = computed(() => rows.value.find(row => row.path === "pixie.defaultModel"));
// The raw "default" entry reads as a model id until the catalog loads; keep
// the picker disabled for that window instead of showing a broken list.
const modelOptionsReady = computed(() => (modelRow.value?.options?.length ?? 0) > 1);

function revealWorkspace() {
  void desktop.invoke("pixie.reveal").catch(() => {});
}

// The prompt patch is a complete snapshot with explicit null removals —
// the settings merge would keep stale sections otherwise. Saving persists
// the visible configuration: full replacement drops the hidden sections,
// the sections drop an unset full. A saved prompt restarts the idle Pixie
// so it takes effect immediately.
async function savePrompt() {
  if (promptSaving.value) return;
  promptSaving.value = true;
  try {
    const identity = draft.value.identity?.trim();
    const full = draft.value.full?.trim();
    const prompt: Record<string, string | null> = full
      ? { full, identity: null, rules: null, docs: null }
      : {
          identity: identity && identity !== PIXIE_IDENTITY.trim() ? identity : null,
          rules: draft.value.rules?.trim() || null,
          docs: draft.value.docs?.trim() || null,
          full: null,
        };
    await layout.updateAppSettings({ pixie: { prompt } });
    await desktop.invoke("pixie.reload");
    layout.showNotice(t("settings.pixiePromptApplied"));
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  } finally {
    promptSaving.value = false;
  }
}

function resetPrompt() {
  draft.value = {};
  void savePrompt();
}

// The preview shows exactly what the next idle restart passes to the agent,
// composed main-side from the current draft. Debounced so typing does not
// spam the route; the request counter drops stale replies.
const preview = ref("");
const previewBusy = ref(false);
const previewError = ref("");
let previewRequest = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

async function loadPreview() {
  const request = ++previewRequest;
  previewBusy.value = true;
  previewError.value = "";
  try {
    const result = await desktop.invoke<{ text?: string }>("pixie.previewPrompt", {
      identity: draft.value.identity?.trim() || undefined,
      rules: draft.value.rules?.trim() || undefined,
      docs: draft.value.docs?.trim() || undefined,
      full: draft.value.full?.trim() || undefined,
    });
    if (request !== previewRequest) return;
    preview.value = result?.text ?? "";
    if (!preview.value) previewError.value = t("settings.promptEmpty");
  } catch (error) {
    if (request !== previewRequest) return;
    previewError.value = t("settings.promptLoadFailed", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (request === previewRequest) previewBusy.value = false;
  }
}
watch(draft, () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(loadPreview, 300);
}, { deep: true, immediate: true });
onBeforeUnmount(() => clearTimeout(previewTimer));

async function clearHistory() {
  if (clearing.value) return;
  clearing.value = true;
  try {
    const result = await desktop.invoke<SessionSnapshot | { cancelled: true }>("pixie.clearHistory");
    if (result && "projection" in result) pixie.applySnapshot(result);
    else if (result?.cancelled) return;
    layout.showNotice(t("settings.pixieCleared"));
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  } finally {
    clearing.value = false;
  }
}
</script>

<template>
  <section class="settings-card" data-pixie-settings>
    <SettingRow
      v-for="row in rows"
      :key="row.path"
      :row="row"
      :disabled="row === modelRow && !modelOptionsReady"
    />
    <div class="setting-row pixie-prompt-row">
      <span>
        <strong>
          {{ t("settings.rows.pixieSystemPrompt") }}
          <em v-if="customized" class="pixie-prompt-tag">{{ t("settings.pixiePromptCustomized") }}</em>
        </strong>
        <small>{{ t("settings.rows.pixieSystemPromptDesc") }}</small>
      </span>
      <div class="pixie-prompt-editor">
        <label class="pixie-prompt-mode">
          <input type="checkbox" data-pixie-prompt-full-mode v-model="fullMode" />
          {{ t("settings.pixiePromptFullMode") }}
        </label>
        <template v-if="!fullMode">
          <select v-if="personas.length" data-pixie-prompt-persona @change="seedIdentity">
            <option value="">{{ t("settings.pixiePromptSeedPersona") }}</option>
            <option v-for="persona in personas" :key="persona.name" :value="persona.name">{{ persona.name }}</option>
          </select>
          <textarea
            v-model="draft.identity"
            rows="2"
            :placeholder="PIXIE_IDENTITY"
            :aria-label="t('settings.pixiePromptIdentity')"
            data-pixie-prompt-identity
          ></textarea>
          <textarea
            v-model="draft.rules"
            rows="3"
            :placeholder="t('settings.pixiePromptRulesPlaceholder')"
            :aria-label="t('settings.pixiePromptRules')"
            data-pixie-prompt-rules
          ></textarea>
          <textarea
            v-model="draft.docs"
            rows="3"
            :placeholder="t('settings.pixiePromptDocsPlaceholder')"
            :aria-label="t('settings.pixiePromptDocs')"
            data-pixie-prompt-docs
          ></textarea>
        </template>
        <template v-else>
          <small class="pixie-prompt-warning">{{ t("settings.pixiePromptFullWarning") }}</small>
          <textarea
            v-model="draft.full"
            rows="10"
            :placeholder="t('settings.pixiePromptFullPlaceholder')"
            :aria-label="t('settings.pixiePromptFull')"
            data-pixie-prompt-full
          ></textarea>
        </template>
        <div class="pixie-prompt-actions">
          <Button variant="ghost" size="sm" data-action="pixie-prompt-reset" @click="resetPrompt">
            <RotateCcw :size="14" /> {{ t("settings.pixiePromptReset") }}
          </Button>
          <Button variant="outline" size="sm" :disabled="promptSaving" data-action="pixie-prompt-save" @click="savePrompt">
            <Save :size="14" /> {{ promptSaving ? t("settings.saving") : t("settings.pixiePromptSave") }}
          </Button>
        </div>
      </div>
    </div>
    <div class="setting-row pixie-preview-row">
      <span>
        <strong>{{ t("settings.pixiePromptPreview") }}</strong>
        <small>{{ t("settings.pixiePromptPreviewHint") }}</small>
      </span>
      <div class="pixie-prompt-preview" data-pixie-prompt-preview>
        <p v-if="previewError" class="pixie-preview-error">{{ previewError }}</p>
        <pre v-else>{{ previewBusy && !preview ? t("settings.promptLoading") : preview }}</pre>
      </div>
    </div>
    <label class="setting-row">
      <span>
        <strong>{{ t("settings.rows.pixieWorkspace") }}</strong>
        <small>{{ t("settings.rows.pixieWorkspaceDesc") }}</small>
      </span>
      <Button variant="outline" size="sm" data-action="pixie-reveal" @click="revealWorkspace">
        <FolderOpen :size="14" /> {{ t("settings.pixieOpen") }}
      </Button>
    </label>
    <label class="setting-row">
      <span>
        <strong>{{ t("settings.rows.pixieClear") }}</strong>
        <small>{{ t("settings.rows.pixieClearDesc") }}</small>
      </span>
      <Button variant="danger" size="sm" :disabled="clearing" data-action="pixie-clear" @click="clearHistory">
        <Trash2 :size="14" /> {{ t(clearing ? "settings.pixieClearing" : "settings.pixieClear") }}
      </Button>
    </label>
  </section>
</template>

<style scoped>
.pixie-prompt-row { align-items: start; }
.pixie-prompt-editor { display: grid; gap: 7px; justify-items: end; }
.pixie-prompt-mode {
  justify-self: start;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-caption);
  color: var(--text-muted);
  cursor: pointer;
}
.pixie-prompt-editor select {
  width: 100%;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: var(--font-size-caption);
}
.pixie-prompt-editor textarea {
  width: 100%;
  min-height: 64px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: 12px/1.6 var(--font-mono, monospace);
  resize: vertical;
}
.pixie-prompt-editor textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.pixie-prompt-actions { display: flex; gap: 8px; }
.pixie-prompt-warning {
  justify-self: start;
  max-width: 100%;
  color: var(--warning, #b45309);
  font-size: var(--font-size-caption);
}
.pixie-preview-row { align-items: start; }
.pixie-prompt-preview {
  width: 100%;
  max-height: 240px;
  overflow: auto;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
.pixie-prompt-preview pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: 11px/1.6 var(--font-mono, monospace);
  color: var(--text);
}
.pixie-preview-error { margin: 0; font-size: var(--font-size-caption); color: var(--danger, #b91c1c); }
.pixie-prompt-tag {
  margin-left: 7px;
  padding: 1px 7px;
  border: 1px solid var(--accent);
  border-radius: 10px;
  color: var(--accent-strong);
  font-size: var(--font-size-caption);
  font-style: normal;
}
</style>
