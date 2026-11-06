<script setup lang="ts">
import { ChevronRight, FolderOpen, Pencil, RefreshCw, RotateCcw, Trash2 } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { PIXIE_DOCS, PIXIE_IDENTITY, PIXIE_RULES } from "../../../shared/pixie-prompt";
import type { PixiePromptCustomization, SessionSnapshot } from "../../../shared/types";
import { desktop } from "../../api";
import Button from "../../components/ui/Button.vue";
import { usePixieStore } from "../../stores/pixie";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import type { Row } from "./use-settings-draft";
import SettingRow from "./SettingRow.vue";

const { t } = useI18n();
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
type PromptSection = keyof PixiePromptCustomization;
const defaults = { identity: PIXIE_IDENTITY, rules: PIXIE_RULES, docs: PIXIE_DOCS, full: "" };
const labels = { identity: "pixiePromptIdentity", rules: "pixiePromptRules", docs: "pixiePromptDocs", full: "pixiePromptFull" };
const editing = ref<PromptSection | null>(null);
const root = ref<HTMLElement>();
let editBackup: PixiePromptCustomization = {};
const sections = computed<PromptSection[]>(() => fullMode.value ? ["full"] : ["identity", "rules", "docs"]);
const contentOf = (name: PromptSection) => draft.value[name]?.trim() || defaults[name];
async function startEdit(name: PromptSection, backup = { ...draft.value }) {
  editBackup = backup;
  editing.value = name;
  draft.value[name] = contentOf(name);
  await nextTick();
  root.value?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
}
function cancelEdit() {
  draft.value = { ...editBackup };
  editing.value = null;
}
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
  editing.value = null;
}, { immediate: true });
// Switching modes starts an edit; cancelling restores the previous mode and
// sections. Saving a full replacement removes the section overrides.
const fullMode = computed({
  get: () => draft.value.full !== undefined,
  set: (on: boolean) => {
    const backup = { ...draft.value };
    if (on) draft.value.full = "";
    else delete draft.value.full;
    void startEdit(on ? "full" : "identity", backup);
  },
});
const personas = computed(() => layout.settings?.app.personas ?? []);

function seedIdentity(event: Event) {
  const select = event.target as HTMLSelectElement;
  const persona = personas.value.find(item => item.name === select.value);
  if (persona) {
    if (editing.value !== "identity") void startEdit("identity");
    draft.value.identity = persona.text;
  }
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
          rules: draft.value.rules?.trim() && draft.value.rules.trim() !== PIXIE_RULES.trim() ? draft.value.rules.trim() : null,
          docs: draft.value.docs?.trim() && draft.value.docs.trim() !== PIXIE_DOCS.trim() ? draft.value.docs.trim() : null,
          full: null,
        };
    await layout.updateAppSettings({ pixie: { prompt } });
    await desktop.invoke("pixie.reload");
    draft.value = { ...layout.settings?.app.pixie?.prompt };
    editing.value = null;
    layout.showNotice(t("settings.pixiePromptApplied"));
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  } finally {
    promptSaving.value = false;
  }
}

function resetPrompt(name?: PromptSection) {
  if (promptSaving.value) return;
  if (name) delete draft.value[name];
  else draft.value = {};
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
  <section class="pixie-settings" data-pixie-settings>
    <div class="settings-card pixie-basics">
      <SettingRow
        v-for="row in rows"
        :key="row.path"
        :row="row"
        :disabled="row === modelRow && !modelOptionsReady"
      />
    </div>
    <section class="settings-card">
      <div ref="root" class="prompt-section" data-pixie-prompt-section>
        <header class="persona-card-head">
          <div>
            <h2>{{ t("settings.rows.pixieSystemPrompt") }}</h2>
            <p>{{ t("settings.rows.pixieSystemPromptDesc") }}</p>
          </div>
          <Button variant="outline" size="icon" :title="t('settings.promptRefresh')" :disabled="previewBusy || promptSaving" @click="loadPreview">
            <RefreshCw :size="15" :class="{ spin: previewBusy }" />
          </Button>
        </header>
        <label class="pixie-prompt-mode">
          <span>{{ t("settings.pixiePromptFullMode") }}</span>
          <input class="switch" type="checkbox" data-pixie-prompt-full-mode v-model="fullMode" :disabled="promptSaving || !!editing" />
        </label>
        <p v-if="fullMode" class="prompt-note">{{ t("settings.pixiePromptFullWarning") }}</p>
        <article v-for="name in sections" :key="name" class="prompt-block" :data-pixie-prompt-block="name">
          <header>
            <strong>{{ t(`settings.${labels[name]}`) }}</strong>
            <span class="prompt-badge" :class="{ 'is-dynamic': !layout.settings?.app.pixie?.prompt?.[name] }">
              {{ t(layout.settings?.app.pixie?.prompt?.[name] ? "settings.promptCustomized" : "settings.pixiePromptBuiltin") }}
            </span>
            <span class="prompt-block-actions">
              <Button v-if="!editing" variant="ghost" size="icon" :title="t('settings.promptCustomize')" :disabled="promptSaving" :data-pixie-edit="name" @click="startEdit(name)"><Pencil :size="13" /></Button>
              <Button v-if="layout.settings?.app.pixie?.prompt?.[name]" variant="ghost" size="icon" :title="t('settings.promptReset')" :disabled="promptSaving || !!editing" :data-pixie-reset="name" @click="resetPrompt(name)"><RotateCcw :size="13" /></Button>
            </span>
          </header>
          <label v-if="name === 'identity' && personas.length" class="prompt-persona-picker">
            <span>{{ t("settings.promptChoosePersona") }}</span>
            <select data-pixie-prompt-persona :disabled="promptSaving || !!(editing && editing !== 'identity')" @change="seedIdentity">
              <option value="">{{ t("settings.pixiePromptSeedPersona") }}</option>
              <option v-for="persona in personas" :key="persona.name" :value="persona.name">{{ persona.name }}</option>
            </select>
          </label>
          <form v-if="editing === name" class="persona-form" :aria-busy="promptSaving" @submit.prevent="savePrompt">
            <label>
              <span>{{ t("settings.promptEditing", { section: t(`settings.${labels[name]}`) }) }}</span>
              <textarea v-model="draft[name]" rows="10" :disabled="promptSaving"
                :data-pixie-prompt-identity="name === 'identity' ? '' : undefined"
                :data-pixie-prompt-rules="name === 'rules' ? '' : undefined"
                :data-pixie-prompt-docs="name === 'docs' ? '' : undefined"
                :data-pixie-prompt-full="name === 'full' ? '' : undefined"
              />
            </label>
            <footer>
              <Button variant="outline" size="sm" type="button" :disabled="promptSaving" data-action="pixie-prompt-cancel" @click="cancelEdit">{{ t("common.cancel") }}</Button>
              <Button size="sm" type="submit" :disabled="promptSaving" data-action="pixie-prompt-save">{{ t(promptSaving ? "settings.saving" : "common.save") }}</Button>
            </footer>
          </form>
          <pre v-else :class="{ 'is-empty': !contentOf(name) }">{{ contentOf(name) || t("settings.promptNotSet") }}</pre>
        </article>
        <details class="pixie-preview-section">
          <summary><ChevronRight :size="15" />{{ t("settings.pixiePromptPreview") }}</summary>
          <article class="prompt-block is-readonly" data-pixie-prompt-preview>
            <small>{{ t("settings.pixiePromptPreviewHint") }}</small>
            <p v-if="previewError" class="persona-error" role="alert">{{ previewError }}</p>
            <pre v-else>{{ previewBusy && !preview ? t("settings.promptLoading") : preview }}</pre>
          </article>
        </details>
        <div class="pixie-prompt-actions">
          <Button variant="ghost" size="sm" :disabled="promptSaving || !!editing" data-action="pixie-prompt-reset" @click="resetPrompt()">
            <RotateCcw :size="14" /> {{ t("settings.pixiePromptReset") }}
          </Button>
        </div>
      </div>
    </section>
    <div class="settings-card pixie-storage">
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
    </div>
  </section>
</template>

<style scoped>
.pixie-settings { display: grid; gap: 16px; }
.pixie-settings :deep(.setting-row:last-child) { border-bottom: 0; }
.pixie-storage button { justify-self: end; }
.pixie-prompt-mode { display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: 12px; cursor: pointer; }
.pixie-prompt-mode .switch { flex: none; }
.pixie-preview-section summary { display: flex; align-items: center; gap: 7px; width: fit-content; cursor: pointer; font-size: 12px; color: var(--muted); list-style: none; }
.pixie-preview-section summary::-webkit-details-marker { display: none; }
.pixie-preview-section summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 3px; }
.pixie-preview-section[open] summary { margin-bottom: 10px; }
.pixie-preview-section[open] summary svg { transform: rotate(90deg); }
.pixie-prompt-actions { display: flex; justify-content: flex-end; }
@media (max-width: 900px) {
  .pixie-settings :deep(.setting-row) { grid-template-columns: minmax(0, 1fr) auto; gap: 16px; }
  .pixie-settings :deep(.setting-row select) { grid-column: 1 / -1; }
}
</style>
