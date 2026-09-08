<script setup lang="ts">
import { Check, Copy, CircleAlert } from "@lucide/vue";
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{ text: string }>();
const { t } = useI18n();
const status = ref<"copy" | "copied" | "copyFailed">("copy");
const busy = ref(false);
const label = computed(() => t(`common.${status.value}`));
let reset: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  if (!props.text || busy.value) return;
  clearTimeout(reset);
  busy.value = true;
  try {
    if (window.pix?.copy) await window.pix.copy(props.text);
    else await navigator.clipboard.writeText(props.text);
    status.value = "copied";
  } catch {
    status.value = "copyFailed";
  } finally {
    busy.value = false;
    reset = setTimeout(() => { status.value = "copy"; }, 2000);
  }
}

onBeforeUnmount(() => clearTimeout(reset));
</script>

<template>
  <button class="copy-button" type="button" :disabled="!text || busy" :title="label" :aria-label="label" @click.stop="copy">
    <Check v-if="status === 'copied'" :size="14" />
    <CircleAlert v-else-if="status === 'copyFailed'" :size="14" />
    <Copy v-else :size="14" />
    <span class="sr-only" role="status">{{ status === 'copy' ? '' : label }}</span>
  </button>
</template>

<style scoped>
/* Keep the absolutely positioned live status inside this button, including in collapsed panels. */
.copy-button { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px; border-radius: 6px; color: var(--muted); vertical-align: middle; }
.copy-button:hover:not(:disabled) { background: var(--muted-surface); color: var(--text); }
.copy-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.copy-button:disabled { opacity: .4; cursor: not-allowed; }
</style>
