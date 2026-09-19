<script setup lang="ts">
import { FolderOpen, RotateCcw, Trash2 } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { PIXIE_IDENTITY } from "../../../shared/pixie-prompt";
import type { SessionSnapshot } from "../../../shared/types";
import { desktop } from "../../api";
import Button from "../../components/ui/Button.vue";
import { useAssistantStore } from "../../stores/assistant";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import { useSettingsDraftContext } from "./settings-context";
import type { Row } from "./use-settings-draft";
import SettingRow from "./SettingRow.vue";

const { t } = useI18n();
const { value, setValue, rowHint, optionLabel } = useSettingsDraftContext();
const assistant = useAssistantStore();
const session = useSessionStore();
const layout = useLayoutStore();
const clearing = ref(false);
// The editor edits the identity line only — the rest of the prompt is Pi's
// own dynamically generated default and is never user-configurable. Matching
// the built-in identity exactly keeps default mode.
const promptDraft = ref(layout.settings?.app.pixie?.systemPrompt ?? PIXIE_IDENTITY);
const promptSaving = ref(false);
const customized = computed(() => Boolean(layout.settings?.app.pixie?.systemPrompt?.trim()));
// Adopt externally-normalized writes; local edits win until they save.
watch(() => layout.settings?.app.pixie?.systemPrompt, saved => {
  promptDraft.value = saved ?? PIXIE_IDENTITY;
});

// The model picker spells entries "provider/modelId" — the same string the
// runtime splits back into its set_model command.
const rows = computed<Row[]>(() => [
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
  void desktop.invoke("assistant.reveal").catch(() => {});
}

// An empty draft or one matching the built-in identity removes the override
// (null is the patch language's remove); a saved identity restarts the idle
// assistant so it takes effect immediately.
async function savePrompt() {
  if (promptSaving.value) return;
  promptSaving.value = true;
  try {
    const text = promptDraft.value.trim();
    await layout.updateAppSettings({ pixie: { systemPrompt: text && text !== PIXIE_IDENTITY.trim() ? text : null } });
    await desktop.invoke("assistant.reload");
    layout.showNotice(t("settings.pixiePromptApplied"));
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  } finally {
    promptSaving.value = false;
  }
}

function resetPrompt() {
  promptDraft.value = PIXIE_IDENTITY;
  void savePrompt();
}

async function clearHistory() {
  if (clearing.value) return;
  clearing.value = true;
  try {
    const result = await desktop.invoke<SessionSnapshot | { cancelled: true }>("assistant.clearHistory");
    if (result && "projection" in result) assistant.applySnapshot(result);
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
        <textarea
          v-model="promptDraft"
          rows="3"
          :aria-label="t('settings.rows.pixieSystemPrompt')"
          data-pixie-prompt
          @change="savePrompt"
        ></textarea>
        <Button variant="ghost" size="sm" data-action="pixie-prompt-reset" @click="resetPrompt">
          <RotateCcw :size="14" /> {{ t("settings.pixiePromptReset") }}
        </Button>
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
.pixie-prompt-editor textarea {
  width: 100%;
  min-height: 120px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: 12px/1.6 var(--font-mono, monospace);
  resize: vertical;
}
.pixie-prompt-editor textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
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
