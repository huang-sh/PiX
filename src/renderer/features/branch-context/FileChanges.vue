<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronRight, FileText } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { FileChange } from "../../../shared/file-changes";
import { useWorkspaceStore } from "../../stores/workspace";
import { useLayoutStore } from "../../stores/layout";

const props = defineProps<{ changes: FileChange[]; sessionPath: string }>();
const { t } = useI18n();
const workspace = useWorkspaceStore();
const layout = useLayoutStore();
const busy = ref<string | null>(null);
const totals = computed(() => props.changes.reduce((sum, file) => ({
  added: sum.added + (file.added ?? 0), removed: sum.removed + (file.removed ?? 0),
  partial: sum.partial || file.added === null || file.removed === null,
}), { added: 0, removed: 0, partial: false }));
const filename = (path: string) => path.split("/").at(-1);
const directory = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
async function open(change: FileChange, review: boolean) {
  busy.value = change.ref;
  const project = workspace.project;
  try {
    if (review) await workspace.openTurnChange(props.sessionPath, change);
    else await workspace.openFile(change.path);
    if (workspace.project === project) await layout.openTool(review ? "changes" : "files");
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  } finally { busy.value = null; }
}
</script>

<template>
  <details v-if="changes.length" class="file-changes" open>
    <summary>
      <ChevronRight :size="13" class="disclosure" />
      <span class="change-count">{{ t('fileChanges.count', { n: changes.length }, changes.length) }}</span>
      <span class="change-added">+{{ totals.added }}</span>
      <span class="change-removed">−{{ totals.removed }}</span>
      <small v-if="totals.partial" :title="t('fileChanges.partial')">{{ t('fileChanges.partialLabel') }}</small>
    </summary>
    <ul>
      <li v-for="change in changes" :key="change.path">
        <FileText :size="14" class="change-icon" />
        <div class="change-filename" :title="change.path">
          <strong>{{ filename(change.path) }}</strong><small>{{ directory(change.path) }}</small>
        </div>
        <span class="change-status" :title="t(`fileChanges.${change.status}`)">{{ { added: 'A', modified: 'M', deleted: 'D', unchanged: '' }[change.status] }}</span>
        <span v-if="change.added !== null" class="change-added">+{{ change.added }}</span>
        <span v-if="change.removed !== null" class="change-removed">−{{ change.removed }}</span>
        <small v-if="change.reason" class="change-reason">{{ t(`fileChanges.${change.reason}`) }}</small>
        <div class="change-actions">
          <button type="button" :disabled="busy === change.ref || !!change.reason" @click="open(change, true)">{{ t('fileChanges.review') }}</button>
          <button type="button" :disabled="busy === change.ref || change.status === 'deleted'" @click="open(change, false)">{{ t('common.open') }}</button>
        </div>
      </li>
    </ul>
  </details>
</template>

<style scoped>
.file-changes { margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; font-size: var(--font-size-ui); container-type: inline-size; }
summary { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; padding: 10px 12px; cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary .disclosure { transition: transform .15s; }
.change-count { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details[open] summary .disclosure { transform: rotate(90deg); }
ul { list-style: none; margin: 0; padding: 3px 0; border-top: 1px solid var(--border); }
li { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 8px 12px; }
.change-icon { flex-shrink: 0; color: var(--muted); }
.change-filename { flex: 1; min-width: 80px; overflow: hidden; }
.change-filename strong, .change-filename small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
strong { font-weight: 500; }
small, .change-status { color: var(--muted); font-size: 11px; }
.change-added { color: var(--success); font-variant-numeric: tabular-nums; }
.change-removed { color: var(--danger); font-variant-numeric: tabular-nums; }
.change-reason { max-width: 100%; }
.change-actions { display: flex; gap: 5px; margin-left: auto; }
button { padding: 3px 7px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); cursor: pointer; font: inherit; font-size: 11px; }
button:hover:not(:disabled) { background: var(--surface-subtle); }
button:disabled { opacity: .45; cursor: default; }

/* The docked panel can be dragged narrow. The wide row needs roughly 290px of
   content before its name, directory, totals and actions stop fitting, so below
   300px the filename and its directory share one ellipsized line and the actions
   take their own line, instead of wrapping into four rows per file. The cut sits
   under the default panel width, which keeps the wide layout for default docks. */
@container (max-width: 300px) {
  li { padding: 7px 10px; }
  .change-filename { min-width: 0; white-space: nowrap; text-overflow: ellipsis; }
  .change-filename strong, .change-filename small { display: inline; }
  .change-filename small { margin-left: 5px; }
  .change-actions { flex-basis: 100%; justify-content: flex-end; }
}
</style>
