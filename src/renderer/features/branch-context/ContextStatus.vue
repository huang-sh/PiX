<script setup lang="ts">
import { CircleMinus, PencilLine } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { BranchMessage } from "../../../shared/types";

const props = defineProps<{ status?: BranchMessage["contextStatus"] }>();
const { t } = useI18n();
const label = computed(() => t(props.status === "excluded" ? "branch.contextExcluded" : "branch.contextModified"));
</script>

<template>
  <span v-if="status" class="context-status" :data-context-status="status" role="img" tabindex="0"
    :title="label" :aria-label="label">
    <CircleMinus v-if="status === 'excluded'" :size="13" aria-hidden="true" />
    <PencilLine v-else :size="13" aria-hidden="true" />
  </span>
</template>

<style scoped>
.context-status { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px; border-radius: 5px; color: var(--muted); vertical-align: middle; cursor: help; }
.context-status:hover { color: var(--text); background: var(--muted-surface); }
.context-status:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
