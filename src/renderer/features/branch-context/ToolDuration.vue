<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{ running?: boolean; startedAt?: string; durationMs?: number }>();
const { t } = useI18n();
const now = ref(Date.now());
const start = computed(() => Date.parse(props.startedAt ?? ""));
watchEffect(onCleanup => {
  if (!props.running || !Number.isFinite(start.value)) return;
  now.value = Date.now();
  const timer = setInterval(() => { now.value = Date.now(); }, 1000);
  onCleanup(() => clearInterval(timer));
});
const duration = computed(() => {
  const ms = props.running && Number.isFinite(start.value) ? Math.max(0, now.value - start.value) : props.durationMs;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return t("time.milliseconds", { n: Math.round(ms) });
  if (ms < 60000) return t("time.seconds", { n: (ms / 1000).toFixed(1) });
  return `${t("time.minutes", { n: Math.floor(ms / 60000) })} ${t("time.seconds", { n: Math.floor(ms / 1000) % 60 })}`;
});
const label = computed(() => t(props.running ? "branch.toolElapsed" : "branch.toolTook", { duration: duration.value }));
</script>

<template>
  <span v-if="duration" class="tool-duration" :title="label" :aria-label="label">{{ duration }}</span>
</template>

<style scoped>
.tool-duration { color: var(--faint); font-size: var(--font-size-caption); font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
