<script setup lang="ts">
import { Pencil, Plus, RotateCcw, Save, Search, Trash2 } from "@lucide/vue";
import { computed, nextTick, ref, toRaw, watch } from "vue";
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { useI18n } from "vue-i18n";
import { SHORTCUTS, formatShortcut, shortcutBindings, shortcutConflict, type ShortcutId, type ShortcutOverrides } from "../../../shared/shortcuts";
import type { SettingsBundle } from "../../../shared/types";
import { desktop } from "../../api";
import Button from "../../components/ui/Button.vue";
import { captureShortcut, isMac } from "../../keyboard-shortcuts";
import { useLayoutStore } from "../../stores/layout";

const layout = useLayoutStore();
const { t } = useI18n();
const clone = (value: ShortcutOverrides = {}) => structuredClone(toRaw(value));
const saved = ref(clone(layout.settings?.app.keyboardShortcuts));
const draft = ref(clone(saved.value));
const query = ref("");
const busy = ref(false);
const error = ref("");
const leaveOpen = ref(false);
const editing = ref<{ id: ShortcutId; index: number }>();
const candidate = ref("");
const captureError = ref("");
const recorder = ref<HTMLElement>();
const display = (binding: string) => formatShortcut(binding, isMac());
const fingerprint = (value: ShortcutOverrides) => JSON.stringify(SHORTCUTS.map(({ id }) => value[id] ?? null));
const dirty = computed(() => fingerprint(draft.value) !== fingerprint(saved.value));
const filtered = computed(() => {
  const text = query.value.trim().toLowerCase();
  return SHORTCUTS.filter(({ id }) => [t(`shortcuts.actions.${id}`), t(`shortcuts.descriptions.${id}`), ...shortcutBindings(id, draft.value).map(display)].join(" ").toLowerCase().includes(text));
});

watch(() => layout.settings?.app.keyboardShortcuts, (value) => {
  if (!dirty.value) draft.value = clone(value);
  saved.value = clone(value);
});

function conflictMessage(value: ShortcutOverrides) {
  const conflict = shortcutConflict(value);
  return conflict ? t("shortcuts.conflict", { key: display(conflict.binding), first: t(`shortcuts.actions.${conflict.first}`), second: t(`shortcuts.actions.${conflict.second}`) }) : "";
}

function proposedBinding() {
  const next = clone(draft.value);
  if (!editing.value || !candidate.value) return next;
  const { id, index } = editing.value;
  const bindings = [...shortcutBindings(id, next)];
  if (index < 0) bindings.push(candidate.value);
  else bindings[index] = candidate.value;
  next[id] = bindings;
  return next;
}

const recordingError = computed(() => captureError.value || (candidate.value ? conflictMessage(proposedBinding()) : ""));

function edit(id: ShortcutId, index = -1) {
  candidate.value = "";
  captureError.value = "";
  editing.value = { id, index };
}

function record(event: KeyboardEvent) {
  if (event.key === "Tab" || event.key === "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat || event.isComposing || event.keyCode === 229 || ["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
  candidate.value = captureShortcut(event) ?? "";
  captureError.value = candidate.value ? "" : t("shortcuts.invalid");
}

function normalize(value: ShortcutOverrides) {
  for (const { id, defaults } of SHORTCUTS)
    if (JSON.stringify(value[id]) === JSON.stringify(defaults)) delete value[id];
  return value;
}

function confirmBinding() {
  if (!candidate.value || recordingError.value) return;
  draft.value = normalize(proposedBinding());
  error.value = "";
  editing.value = undefined;
}

function remove(id: ShortcutId, index: number) {
  const next = clone(draft.value);
  next[id] = shortcutBindings(id, next).filter((_, i) => i !== index);
  draft.value = normalize(next);
  error.value = "";
}

function reset(id?: ShortcutId) {
  const next = id ? clone(draft.value) : {};
  if (id) delete next[id];
  error.value = conflictMessage(next);
  if (!error.value) draft.value = next;
}

async function save() {
  if (busy.value) return false;
  error.value = conflictMessage(draft.value);
  if (error.value) return false;
  busy.value = true;
  try {
    const settings = await desktop.invoke<SettingsBundle>("settings.update", {
      scope: "app", patch: { keyboardShortcuts: clone(draft.value) },
    });
    saved.value = clone(settings.app.keyboardShortcuts);
    draft.value = clone(saved.value);
    layout.settings = settings;
    layout.showNotice(t("settings.saved"));
    return true;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
    return false;
  } finally {
    busy.value = false;
  }
}

function requestClose() {
  if (busy.value) return;
  if (dirty.value) leaveOpen.value = true;
  else layout.screen = "workbench";
}

async function saveAndLeave() {
  if (await save()) layout.screen = "workbench";
}

function discardAndLeave() {
  leaveOpen.value = false;
  layout.screen = "workbench";
}

defineExpose({ requestClose });
</script>

<template>
  <section class="shortcut-settings" data-keyboard-shortcuts>
    <div class="shortcut-toolbar">
      <label class="settings-search"><Search :size="17" aria-hidden="true" /><input v-model="query" :placeholder="t('shortcuts.search')" :aria-label="t('shortcuts.search')" /></label>
      <Button variant="outline" :disabled="busy || !Object.keys(draft).length" data-shortcut-reset-all @click="reset()"><RotateCcw :size="15" />{{ t('shortcuts.resetAll') }}</Button>
      <Button :disabled="busy || !dirty" data-shortcut-save @click="save"><Save :size="15" />{{ t(busy ? 'settings.saving' : 'settings.saveChanges') }}</Button>
    </div>
    <p class="shortcut-scope">{{ t('shortcuts.scope') }}</p>
    <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
    <div class="settings-card shortcut-list" :aria-busy="busy">
      <article v-for="{ id } in filtered" :key="id" class="shortcut-row" :data-shortcut="id">
        <div class="shortcut-description"><strong>{{ t(`shortcuts.actions.${id}`) }}</strong><small>{{ t(`shortcuts.descriptions.${id}`) }}</small><span v-if="Object.hasOwn(draft, id)" class="shortcut-custom">{{ t('shortcuts.customized') }}</span></div>
        <div class="shortcut-bindings">
          <div v-for="(binding, index) in shortcutBindings(id, draft)" :key="binding" class="shortcut-binding">
            <kbd>{{ display(binding) }}</kbd>
            <Button variant="ghost" size="icon" :disabled="busy" data-shortcut-edit :aria-label="t('shortcuts.editBinding', { key: display(binding), action: t(`shortcuts.actions.${id}`) })" :title="t('shortcuts.edit')" @click="edit(id, index)"><Pencil :size="15" /></Button>
            <Button variant="ghost" size="icon" :disabled="busy" data-shortcut-remove :aria-label="t('shortcuts.removeBinding', { key: display(binding), action: t(`shortcuts.actions.${id}`) })" :title="t('common.remove')" @click="remove(id, index)"><Trash2 :size="15" /></Button>
          </div>
          <span v-if="!shortcutBindings(id, draft).length" class="shortcut-unassigned">{{ t('shortcuts.unassigned') }}</span>
          <div class="shortcut-row-actions">
            <Button variant="ghost" size="sm" :disabled="busy" data-shortcut-add :aria-label="t('shortcuts.addFor', { action: t(`shortcuts.actions.${id}`) })" @click="edit(id)"><Plus :size="14" />{{ t('shortcuts.add') }}</Button>
            <Button v-if="Object.hasOwn(draft, id)" variant="ghost" size="sm" :disabled="busy" data-shortcut-reset @click="reset(id)"><RotateCcw :size="14" />{{ t('shortcuts.reset') }}</Button>
          </div>
        </div>
      </article>
      <p v-if="!filtered.length" class="settings-empty">{{ t('shortcuts.noResults') }}</p>
    </div>
    <p class="shortcut-footnote" role="status">{{ t(dirty ? 'shortcuts.unsaved' : 'shortcuts.savedHint') }}</p>

    <DialogRoot :open="!!editing" @update:open="!$event && (editing = undefined)">
      <DialogPortal><DialogOverlay class="dialog-overlay" /><DialogContent class="shortcut-dialog" data-shortcut-recording @open-auto-focus.prevent="nextTick(() => recorder?.focus())">
        <DialogTitle>{{ t('shortcuts.recordTitle') }}</DialogTitle>
        <DialogDescription>{{ editing ? t(`shortcuts.actions.${editing.id}`) : '' }} · {{ t('shortcuts.recordHint') }}</DialogDescription>
        <div ref="recorder" tabindex="0" class="shortcut-recorder" :aria-label="t('shortcuts.recordHint')" @keydown="record"><kbd v-if="candidate">{{ display(candidate) }}</kbd><span v-else>{{ t('shortcuts.pressKeys') }}</span></div>
        <p v-if="recordingError" class="settings-error" role="alert">{{ recordingError }}</p>
        <footer><Button variant="outline" @click="editing = undefined">{{ t('common.cancel') }}</Button><Button :disabled="!candidate || !!recordingError" data-shortcut-confirm @click="confirmBinding">{{ t('shortcuts.confirm') }}</Button></footer>
      </DialogContent></DialogPortal>
    </DialogRoot>
    <DialogRoot :open="leaveOpen" @update:open="!busy && (leaveOpen = $event)">
      <DialogPortal><DialogOverlay class="dialog-overlay" /><DialogContent class="shortcut-dialog" :aria-busy="busy" @escape-key-down="busy && $event.preventDefault()" @interact-outside="busy && $event.preventDefault()">
        <DialogTitle>{{ t('shortcuts.leaveTitle') }}</DialogTitle><DialogDescription>{{ t('shortcuts.leaveHint') }}</DialogDescription>
        <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
        <footer><Button variant="outline" :disabled="busy" @click="leaveOpen = false">{{ t('common.cancel') }}</Button><Button variant="ghost" :disabled="busy" data-shortcut-discard @click="discardAndLeave">{{ t('shortcuts.discard') }}</Button><Button :disabled="busy" data-shortcut-save-leave @click="saveAndLeave">{{ t(busy ? 'settings.saving' : 'shortcuts.saveLeave') }}</Button></footer>
      </DialogContent></DialogPortal>
    </DialogRoot>
  </section>
</template>

<style scoped>
.shortcut-settings { max-width: 1120px; margin: auto; }
.shortcut-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.shortcut-toolbar .settings-search { flex: 1; min-width: 190px; width: auto; height: 42px; border-radius: 24px; }
.shortcut-scope, .shortcut-footnote { margin: 14px 0 20px; color: var(--muted); font-size: 12px; line-height: 1.7; }
.shortcut-row { display: grid; grid-template-columns: minmax(0,1fr) minmax(240px,.8fr); gap: 24px; align-items: center; padding: 22px 24px; border-bottom: 1px solid var(--border); }
.shortcut-row:last-child { border-bottom: 0; }
.shortcut-description { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; }
.shortcut-description strong { font-size: 14px; font-weight: 600; }
.shortcut-description small, .shortcut-unassigned { color: var(--muted); font-size: 12px; line-height: 1.6; }
.shortcut-custom { color: var(--accent-strong); font-size: 10px; }
.shortcut-bindings { display: grid; gap: 4px; justify-items: start; }
.shortcut-binding, .shortcut-row-actions { display: flex; gap: 4px; align-items: center; }
kbd { padding: 4px 11px; border: 1px solid var(--border); border-radius: 20px; background: var(--surface-subtle); color: var(--text); font: 12px/1.5 var(--font-mono, monospace); overflow-wrap: anywhere; }
.shortcut-dialog { position: fixed; z-index: 151; top: 50%; left: 50%; width: min(480px,calc(100vw - 40px)); padding: 24px; transform: translate(-50%,-50%); background: var(--surface); border: 1px solid var(--border); border-radius: 16px; box-shadow: 0 24px 80px #0003; }
.shortcut-dialog h2 { margin: 0 0 10px; font-size: 19px; }
.shortcut-dialog p { color: var(--muted); font-size: 12px; line-height: 1.7; }
.shortcut-dialog .settings-error { color: var(--danger); }
.shortcut-recorder { display: flex; align-items: center; justify-content: center; min-height: 95px; margin: 20px 0; padding: 14px; border: 1px dashed var(--border-strong); border-radius: 10px; color: var(--muted); font-size: 13px; }
.shortcut-recorder:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.shortcut-dialog footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
@media (max-width: 1100px) { .shortcut-row { grid-template-columns: minmax(0,1fr) minmax(200px,.8fr); padding: 18px; gap: 15px; } }
</style>
