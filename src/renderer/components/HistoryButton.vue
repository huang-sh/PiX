<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { History } from "@lucide/vue";
import { history, togglePanel, undoDepth } from "../stores/history";

const { t } = useI18n();

const depth = computed(() => undoDepth());
const badge = computed(() => (depth.value > 99 ? "99+" : depth.value > 0 ? String(depth.value) : ""));
</script>

<template>
  <button
    type="button"
    class="history-floating-btn"
    :class="{ 'history-floating-btn-open': history.panelOpen }"
    :aria-label="t('history.button.title')"
    :title="t('history.button.title')"
    @click="togglePanel()"
  >
    <History :size="16" />
    <span v-if="badge" class="history-floating-badge">{{ badge }}</span>
  </button>
</template>
