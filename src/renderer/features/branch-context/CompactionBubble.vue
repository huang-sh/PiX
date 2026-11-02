<script setup lang="ts">
import { Check, ChevronRight, LoaderCircle, Minimize2 } from "@lucide/vue";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { CompactionRecord } from "../../../shared/run-timing";
import MarkdownRenderer from "../../components/MarkdownRenderer.vue";
import CopyButton from "../../components/CopyButton.vue";
import ToolDuration from "./ToolDuration.vue";

defineProps<{ compaction: CompactionRecord }>();
const { t } = useI18n();
const expanded = ref(false);
</script>

<template>
  <details class="compaction-bubble" :data-status="compaction.status" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
    <summary>
      <LoaderCircle v-if="compaction.status === 'running'" :size="14" class="spin" />
      <Check v-else-if="compaction.status === 'complete'" :size="14" />
      <Minimize2 v-else :size="14" />
      <span>{{ t(`graph.compaction.${compaction.status}`) }}</span>
      <ToolDuration :running="compaction.status === 'running'" :started-at="compaction.startedAt" :duration-ms="compaction.durationMs" />
      <ChevronRight class="disclosure" :size="13" />
    </summary>
    <div v-if="expanded" class="compaction-details">
      <dl v-if="compaction.tokensBefore != null || compaction.tokensAfter != null">
        <dt>{{ t('graph.compaction.before') }}</dt><dd>{{ compaction.tokensBefore?.toLocaleString() ?? '—' }}</dd>
        <dt>{{ t('graph.compaction.after') }}</dt><dd>{{ compaction.tokensAfter == null ? '—' : `≈${compaction.tokensAfter.toLocaleString()}` }}</dd>
      </dl>
      <p v-if="compaction.error" class="error-message">{{ compaction.error }}</p>
      <template v-if="compaction.summary">
        <h4>{{ t('graph.compaction.summary') }}</h4>
        <MarkdownRenderer :content="compaction.summary" :custom-id="`compaction:${compaction.entryTimestamp}`" />
        <CopyButton :text="compaction.summary" />
      </template>
      <p v-else-if="compaction.status === 'running'">{{ t('graph.compaction.preparing') }}</p>
    </div>
  </details>
</template>

<style scoped>
.compaction-bubble { margin: 12px 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-subtle); color: var(--muted); }
.compaction-bubble > summary { display: flex; align-items: center; gap: 7px; cursor: pointer; list-style: none; font-size: var(--font-size-caption); }
.compaction-bubble > summary::-webkit-details-marker { display: none; }
.compaction-bubble > summary > svg { flex: none; }
.compaction-bubble .disclosure { margin-left: auto; }
.compaction-bubble[open] .disclosure { transform: rotate(90deg); }
.compaction-details { padding-top: 12px; overflow-wrap: anywhere; }
.compaction-details dl { display: grid; grid-template-columns: 1fr auto; gap: 6px 20px; margin: 0 0 12px; font-size: var(--font-size-caption); }
.compaction-details dd { margin: 0; font-variant-numeric: tabular-nums; }
.compaction-details h4 { margin: 12px 0; font-size: var(--font-size-caption); }
</style>
