<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { DialogRoot, DialogOverlay, DialogContent, DialogTitle } from "reka-ui";
import { useI18n } from "vue-i18n";
import { X } from "@lucide/vue";
import { MAX_SKILL_BYTES, skillBodyError, skillDescriptionError, skillDisplayNameError, skillTemplate, slugifySkillName } from "../../../shared/skills";
import type { RuntimeSkillDocument } from "../../../shared/types";
import { useSessionStore } from "../../stores/session";
import Button from "../../components/ui/Button.vue";

const props = defineProps<{ skill?: RuntimeSkillDocument; scope: "user" | "project" }>();
const emit = defineEmits<{ saved: [path: string]; cancel: [] }>();
const { t } = useI18n();
const session = useSessionStore();
const busy = ref(false);
const error = ref("");

const draft = reactive({
  name: props.skill?.name ?? "",
  description: props.skill?.description ?? "",
  body: props.skill?.body.trim() ?? "",
  disableModelInvocation: props.skill?.disableModelInvocation ?? false,
});

// A pristine draft has no name or description yet; the starter body is a
// placeholder, so only what the user must write decides whether it is empty.
const pristine = computed(() => !props.skill && !draft.name.trim() && !draft.description.trim());
const slug = computed(() => slugifySkillName(draft.name));
// The folder an existing skill lives in, taken from its own path: a skill can
// sit in `.agents/skills` or a package, so naming a root here would lie.
const skillFolder = computed(() => props.skill ? props.skill.path.replace(/[\\/][^\\/]*$/, "") : "");
const bytes = computed(() => new TextEncoder().encode(draft.body).length);
// The counter exists to warn about the cap, so it never reports a non-empty
// body as "0 KB": under a kilobyte it says so, and small sizes keep a decimal.
const kilobytes = computed(() => {
  if (bytes.value < 1024) return "<1";
  return bytes.value < 10_240 ? Number((bytes.value / 1024).toFixed(1)) : Math.round(bytes.value / 1024);
});

const errorKey = computed(() => {
  const name = skillDisplayNameError(draft.name);
  if (name) return `settings.skillError.${name}`;
  const description = skillDescriptionError(draft.description);
  if (description) return `settings.skillError.${description}`;
  const body = skillBodyError(draft.body);
  if (body) return `settings.skillError.${body}`;
  return "";
});

// A host error describes the attempt that just failed, so editing the draft
// clears it instead of leaving a stale message under a fixed form.
watch(draft, () => { error.value = ""; });

function setName(value: string) {
  draft.name = value;
  // Seed the body once so a new skill is never a blank page, but never
  // overwrite instructions the user has already started writing.
  if (!props.skill && !draft.body.trim()) draft.body = skillTemplate(value);
}

async function save() {
  if (busy.value || errorKey.value) return;
  busy.value = true;
  error.value = "";
  // The frontmatter name has to satisfy the Agent Skills spec even when the
  // author typed something more readable; the field's hint shows the result.
  const name = slugifySkillName(draft.name);
  try {
    const result = props.skill
      ? await session.control<{ path: string }>({
          action: "updateSkill",
          path: props.skill.path,
          name,
          description: draft.description.trim(),
          body: draft.body,
          disableModelInvocation: draft.disableModelInvocation,
        })
      : await session.control<{ path: string }>({
          action: "createSkill",
          scope: props.scope,
          name,
          description: draft.description.trim(),
          body: draft.body,
          disableModelInvocation: draft.disableModelInvocation,
        });
    emit("saved", result?.path ?? "");
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
    <DialogContent class="skill-sheet" aria-describedby="skill-sheet-subtitle" @interact-outside.prevent @escape-key-down="busy && $event.preventDefault()">
      <form class="skill-sheet-form" data-skill-form :aria-busy="busy" @submit.prevent="save">
        <header class="skill-sheet-head">
          <div>
            <DialogTitle class="skill-sheet-title">{{ t(skill ? "settings.editSkill" : "settings.newSkill") }}</DialogTitle>
            <p id="skill-sheet-subtitle" class="skill-sheet-sub">{{ t("settings.skillSheetSubtitle") }}</p>
          </div>
          <button type="button" class="skill-sheet-close" :aria-label="t('common.close')" :disabled="busy" @click="emit('cancel')"><X :size="15" /></button>
        </header>

        <div class="skill-sheet-body">
          <label class="skill-field">
            <span class="skill-field-label">{{ t("settings.skillName") }}</span>
            <span class="skill-field-hint">{{ skill ? t("settings.skillNameEditHint") : slug ? t("settings.skillNameHint", { slug }) : t("settings.skillNamePlaceholder") }}</span>
            <input
              :value="draft.name"
              data-skill-name
              autofocus
              :placeholder="t('settings.skillNamePlaceholder')"
              @input="setName(($event.target as HTMLInputElement).value)"
            />
          </label>

          <label class="skill-field">
            <span class="skill-field-label">{{ t("settings.skillDescription") }}</span>
            <span class="skill-field-hint">{{ t("settings.skillDescriptionHint") }}</span>
            <textarea v-model="draft.description" data-skill-description rows="2" :placeholder="t('settings.skillDescriptionPlaceholder')" />
          </label>

          <div class="skill-field">
            <div class="skill-field-label skill-field-label-row">
              <span>{{ t("settings.skillBody") }}</span>
              <span class="skill-byte-count" :class="{ 'is-over': bytes > MAX_SKILL_BYTES }">{{ t("settings.skillBytes", { used: kilobytes, max: MAX_SKILL_BYTES / 1024 }) }}</span>
            </div>
            <span class="skill-field-hint">{{ t("settings.skillBodyHint") }}</span>
            <textarea v-model="draft.body" class="skill-body" data-skill-body rows="14" spellcheck="false" :aria-label="t('settings.skillBody')" :placeholder="skillTemplate('')" />
          </div>

          <div class="skill-field">
            <span class="skill-field-label">{{ t("settings.skillScope") }}</span>
            <div class="skill-tile">
              <div class="skill-tile-copy">
                <span v-if="skill" class="skill-tile-label is-path" :title="skill.path">{{ skillFolder }}</span>
                <template v-else>
                  <span class="skill-tile-label">{{ scope === "project" ? t("settings.skillScopeProject") : t("settings.skillScopeUser") }}</span>
                  <span class="skill-tile-hint">{{ t("settings.skillScopeDecided") }}</span>
                </template>
              </div>
            </div>
          </div>

          <div class="skill-field">
            <span class="skill-field-label">{{ t("settings.skillInvocation") }}</span>
            <div class="skill-tile">
              <div class="skill-tile-copy">
                <span class="skill-tile-label">{{ t(draft.disableModelInvocation ? "settings.manualSkill" : "settings.skillAuto") }}</span>
                <span class="skill-tile-hint">{{ t("settings.skillManualOnlyHint") }}</span>
              </div>
              <button type="button" class="skill-switch" role="switch" data-skill-invocation :aria-checked="draft.disableModelInvocation" :aria-label="t('settings.skillManualOnly')" @click="draft.disableModelInvocation = !draft.disableModelInvocation">
                <span class="skill-switch-thumb" />
              </button>
            </div>
          </div>
        </div>

        <p v-if="error" class="skill-sheet-error" role="alert">{{ error }}</p>
        <p v-else-if="errorKey && !pristine" class="skill-sheet-error" role="alert">{{ t(errorKey) }}</p>

        <footer class="skill-sheet-actions">
          <span class="skill-sheet-note">{{ t("settings.skillSheetNote") }}</span>
          <div class="skill-sheet-actions-end">
            <Button type="button" variant="ghost" :disabled="busy" @click="emit('cancel')">{{ t("settings.customCancel") }}</Button>
            <Button type="submit" data-skill-save :disabled="busy || !!errorKey || (pristine && !skill)">{{ t(busy ? "settings.saving" : "settings.saveChanges") }}</Button>
          </div>
        </footer>
      </form>
    </DialogContent>
  </DialogRoot>
</template>

<style scoped>
/* Head, body and actions are separated by spacing, not rules; only the fields
   scroll, so the title and the actions stay put. */
.skill-sheet { position: fixed; z-index: 151; top: 40px; left: 50%; display: flex; width: min(100% - 32px, 560px); max-height: calc(100vh - 80px); overflow: hidden; transform: translateX(-50%); border: 1px solid var(--border); border-radius: 16px; background: var(--surface); box-shadow: 0 30px 90px rgba(14, 38, 31, .26); }
.skill-sheet-form { display: flex; min-height: 0; flex: 1; flex-direction: column; }
.skill-sheet-head { display: flex; align-items: center; gap: 12px; padding: 16px 16px 10px 18px; }
.skill-sheet-head > div { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
.skill-sheet-title { margin: 0; color: var(--text); font-size: var(--font-size-body); font-weight: 650; letter-spacing: -.01em; }
.skill-sheet-sub { margin: 0; color: var(--muted); font-size: var(--font-size-small); line-height: 1.5; }
.skill-sheet-close { display: inline-flex; width: 26px; height: 26px; flex: 0 0 auto; align-items: center; justify-content: center; border-radius: 6px; color: var(--faint); }
.skill-sheet-close:hover:not(:disabled) { background: var(--muted-surface); color: var(--text); }
.skill-sheet-body { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 16px; padding: 12px 18px 16px; overflow-y: auto; }
.skill-field { display: flex; min-width: 0; flex-direction: column; gap: 6px; }
.skill-field-label { color: var(--text); font-size: var(--font-size-small); font-weight: 600; }
.skill-field-label-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.skill-field-hint { margin: -2px 0 2px; color: var(--muted); font-size: var(--font-size-caption); line-height: 1.5; }
.skill-byte-count { color: var(--faint); font-size: var(--font-size-caption); font-variant-numeric: tabular-nums; }
.skill-byte-count.is-over { color: var(--danger); }
.skill-body { font-family: var(--font-mono); font-size: var(--font-size-caption); line-height: 1.6; resize: vertical; }
.skill-tile { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-radius: 10px; background: var(--surface-subtle); }
.skill-tile-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.skill-tile-label { color: var(--text); font-size: var(--font-size-small); font-weight: 500; }
.skill-tile-label.is-path { display: block; overflow: hidden; font-family: var(--font-mono); font-size: 11px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.skill-tile-hint { color: var(--muted); font-size: var(--font-size-caption); line-height: 1.45; }
.skill-sheet-error { margin: 0 18px 8px; padding: 8px 12px; border-radius: 8px; background: color-mix(in srgb, var(--danger) 8%, var(--surface)); color: var(--danger); font-size: var(--font-size-small); line-height: 1.5; }
.skill-sheet-actions { display: flex; align-items: center; gap: 12px; padding: 6px 18px 14px; }
.skill-sheet-note { max-width: 30ch; color: var(--faint); font-size: var(--font-size-caption); line-height: 1.45; }
.skill-sheet-actions-end { display: flex; align-items: center; gap: 8px; margin-left: auto; }
</style>
