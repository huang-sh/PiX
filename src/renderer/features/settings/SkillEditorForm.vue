<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { DialogRoot, DialogOverlay, DialogContent, DialogTitle } from "reka-ui";
import { useI18n } from "vue-i18n";
import { MAX_SKILL_BYTES, skillBodyError, skillDescriptionError, skillNameError, skillTemplate, slugifySkillName } from "../../../shared/skills";
import type { RuntimeSkillDocument } from "../../../shared/types";
import { useSessionStore } from "../../stores/session";
import Button from "../../components/ui/Button.vue";

const props = defineProps<{ skill?: RuntimeSkillDocument; scope: "user" | "project"; canUseProject: boolean }>();
const emit = defineEmits<{ saved: [path: string]; cancel: [] }>();
const { t } = useI18n();
const session = useSessionStore();
const busy = ref(false);
const error = ref("");

const draft = reactive({
  // A new draft starts empty so the starter template stays a placeholder until
  // the name is known, then seeds the body once.
  name: props.skill?.name ?? "",
  description: props.skill?.description ?? "",
  body: props.skill?.body.trim() ?? "",
  disableModelInvocation: props.skill?.disableModelInvocation ?? false,
  scope: props.scope,
});

// A pristine draft has no name or description yet; the starter body is a
// placeholder, so only what the user must write decides whether it is empty.
const pristine = computed(() => !props.skill && !draft.name.trim() && !draft.description.trim());
const slug = computed(() => slugifySkillName(draft.name));
const bytes = computed(() => new TextEncoder().encode(draft.body).length);
// A one-decimal reading keeps a small body from showing up as a flat "0 KB".
const kilobytes = computed(() => bytes.value < 10_240 ? Number((bytes.value / 1024).toFixed(1)) : Math.round(bytes.value / 1024));

const errorKey = computed(() => {
  const name = skillNameError(draft.name);
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
  try {
    const result = props.skill
      ? await session.control<{ path: string }>({
          action: "updateSkill",
          path: props.skill.path,
          name: draft.name.trim(),
          description: draft.description.trim(),
          body: draft.body,
          disableModelInvocation: draft.disableModelInvocation,
        })
      : await session.control<{ path: string }>({
          action: "createSkill",
          scope: draft.scope,
          name: draft.name.trim(),
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
    <DialogContent class="skill-dialog" :aria-describedby="undefined" @interact-outside.prevent @escape-key-down="busy && $event.preventDefault()">
      <form class="settings-card model-options" data-skill-form :aria-busy="busy" @submit.prevent="save">
        <header class="model-options-header">
          <DialogTitle>{{ t(skill ? "settings.editSkill" : "settings.newSkill") }}</DialogTitle>
        </header>
        <fieldset :disabled="busy" class="custom-model-fields">
          <label class="setting-row">
            <span>
              <strong>{{ t("settings.skillName") }}</strong>
              <small>{{ skill ? t("settings.skillNameEditHint") : slug ? t("settings.skillNameHint", { slug }) : t("settings.skillNamePlaceholder") }}</small>
            </span>
            <input
              :value="draft.name"
              data-skill-name
              autofocus
              :placeholder="t('settings.skillNamePlaceholder')"
              @input="setName(($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="setting-row">
            <span>
              <strong>{{ t("settings.skillDescription") }}</strong>
              <small>{{ t("settings.skillDescriptionHint") }}</small>
            </span>
            <input v-model="draft.description" data-skill-description :placeholder="t('settings.skillDescriptionPlaceholder')" />
          </label>
          <label class="setting-row">
            <span>
              <strong>{{ t("settings.skillManualOnly") }}</strong>
              <small>{{ t("settings.skillManualOnlyHint") }}</small>
            </span>
            <input v-model="draft.disableModelInvocation" class="switch" data-skill-manual type="checkbox" />
          </label>
          <label v-if="!skill" class="setting-row">
            <span>
              <strong>{{ t("settings.skillScope") }}</strong>
              <small>{{ t("settings.skillScopeHint") }}</small>
            </span>
            <select v-model="draft.scope" data-skill-scope>
              <option value="user">{{ t("settings.skillScopeUser") }}</option>
              <option v-if="canUseProject" value="project">{{ t("settings.skillScopeProject") }}</option>
            </select>
          </label>
          <div class="skill-body-field">
            <div class="setting-row">
              <span>
                <strong>{{ t("settings.skillBody") }}</strong>
                <small>{{ t("settings.skillBodyHint") }}</small>
              </span>
              <em :class="{ 'is-over': bytes > MAX_SKILL_BYTES }">{{ t("settings.skillBytes", { used: kilobytes, max: MAX_SKILL_BYTES / 1024 }) }}</em>
            </div>
            <textarea v-model="draft.body" data-skill-body rows="14" spellcheck="false" :aria-label="t('settings.skillBody')" :placeholder="skillTemplate('')" />
          </div>
        </fieldset>
        <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
        <p v-else-if="errorKey && !pristine" class="settings-error" role="alert">{{ t(errorKey) }}</p>
        <footer class="model-options-header">
          <Button type="button" variant="outline" :disabled="busy" @click="emit('cancel')">{{ t("settings.customCancel") }}</Button>
          <Button type="submit" data-skill-save :disabled="busy || !!errorKey || (pristine && !skill)">{{ t(busy ? "settings.saving" : "settings.saveChanges") }}</Button>
        </footer>
      </form>
    </DialogContent>
  </DialogRoot>
</template>

<style scoped>
.skill-dialog { position: fixed; z-index: 151; top: 5vh; left: 50%; display: flex; flex-direction: column; transform: translateX(-50%); width: min(760px, calc(100vw - 40px)); max-height: 90vh; overflow: hidden; border-radius: 14px; background: var(--surface); box-shadow: 0 30px 90px rgba(14,38,31,.26); }
.skill-dialog > form { display: flex; min-height: 0; flex-direction: column; }
.skill-dialog h2 { margin: 0; font-size: var(--font-size-ui); }
.custom-model-fields { min-width: 0; margin: 0; padding: 0; border: 0; }
/* Only the fields scroll, so Save and Cancel stay reachable however long the
   instructions grow. */
.skill-dialog .custom-model-fields { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.skill-dialog .model-options-header { flex: 0 0 auto; }
.skill-body-field { display: block; padding: 14px 21px; border-top: 1px solid var(--border); }
.skill-body-field > .setting-row { padding: 0 0 8px; border: 0; }
.skill-body-field em { color: var(--muted); font-size: var(--font-size-caption); font-style: normal; }
.skill-body-field em.is-over { color: var(--danger); }
.skill-body-field textarea { width: 100%; font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--font-size-caption); line-height: 1.6; resize: vertical; }
</style>
