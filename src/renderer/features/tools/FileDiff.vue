<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
const props = defineProps<{ patch: string }>();
const { t } = useI18n();
const limit = ref(2000);
const lines = computed(() => {
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  return props.patch.split("\n").map(text => {
    const row: { text: string; kind: string; old?: number; new?: number } = { text, kind: "header" };
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
      row.kind = "hunk";
    } else if (text.startsWith("-") && oldRemaining > 0) {
      row.kind = "removed"; row.old = oldLine++; oldRemaining--;
    } else if (text.startsWith("+") && newRemaining > 0) {
      row.kind = "added"; row.new = newLine++; newRemaining--;
    } else if (text.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
      row.kind = "context"; row.old = oldLine++; row.new = newLine++;
      oldRemaining--; newRemaining--;
    }
    return row;
  });
});
const gutterWidth = computed(() => `${lines.value.reduce((width, line) =>
  Math.max(width, String(line.new ?? line.old ?? "").length), 2) + 2}ch`);
const lineTitle = (line: { old?: number; new?: number }) => [
  line.old === undefined ? "" : t('fileChanges.oldLine', { n: line.old }),
  line.new === undefined ? "" : t('fileChanges.newLine', { n: line.new }),
].filter(Boolean).join("\n") || undefined;
watch(() => props.patch, () => { limit.value = 2000; });
</script>

<template>
  <div class="file-diff" :aria-label="t('fileChanges.review')" :style="{ '--line-number-width': gutterWidth }">
    <pre><span v-for="(line, index) in lines.slice(0, limit)" :key="index" class="diff-row" :class="line.kind"><span class="line-number" aria-hidden="true" :title="lineTitle(line)">{{ line.new ?? line.old }}</span><span class="line-content">{{ line.text }}</span></span></pre>
    <button v-if="lines.length > limit" type="button" @click="limit += 2000">{{ t('fileChanges.more') }}</button>
  </div>
</template>

<style scoped>
.file-diff { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
pre { margin: 0; width: max-content; min-width: 100%; font: var(--font-size-code)/var(--line-height-code) var(--font-mono); }
.diff-row { display: grid; grid-template-columns: var(--line-number-width) auto; white-space: pre; min-height: 1lh; }
.line-number { color: var(--muted); text-align: right; padding: 0 1ch; user-select: none; font-variant-numeric: tabular-nums; border-right: 1px solid var(--border); }
.line-content { padding-left: 1ch; }
.added { color: var(--success); background: color-mix(in srgb, var(--success) 10%, transparent); }
.removed { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.hunk { color: var(--accent); background: var(--surface-subtle); }
.header { color: var(--muted); }
button { margin-top: 12px; color: var(--accent); }
</style>
