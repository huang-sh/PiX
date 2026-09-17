<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { History } from "@lucide/vue";
import { history, togglePanel, undoDepth } from "./store";

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

<style scoped>
/* ── floating history button ───────────────────────────────────────── */

.history-floating-btn {
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 155;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  box-shadow: var(--shadow);
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
  cursor: pointer;
}

.history-floating-btn:hover {
  background: var(--muted-surface);
  color: var(--text);
  border-color: var(--border-strong);
}

.history-floating-btn-open {
  background: var(--accent-soft);
  color: var(--accent-strong);
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
}

.history-floating-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  display: grid;
  place-items: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-foreground);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}
</style>
