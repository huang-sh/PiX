<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { SessionImage } from "../../shared/types";
import { sessionImageUrl } from "../lib/session-images";
import { useLayoutStore } from "../stores/layout";

const props = defineProps<{ image: SessionImage; index: number }>();
const { t } = useI18n();
const button = ref<HTMLElement>();
const src = ref("");
const failed = ref(false);
let observer: IntersectionObserver | undefined;
let ticket = 0;
async function load() {
  const request = ++ticket;
  failed.value = false;
  try {
    const url = await sessionImageUrl(props.image, true);
    if (request === ticket) src.value = url;
  } catch { if (request === ticket) failed.value = true; }
}
function observe() {
  observer?.disconnect();
  src.value = "";
  failed.value = false;
  ++ticket;
  if (typeof IntersectionObserver === "undefined") { void load(); return; }
  observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer?.disconnect();
    void load();
  });
  if (button.value) observer.observe(button.value);
}
onMounted(observe);
onActivated(observe);
onDeactivated(() => { ++ticket; observer?.disconnect(); });
watch(() => props.image, observe, { flush: "post" });
onBeforeUnmount(() => { ++ticket; observer?.disconnect(); });
</script>

<template>
  <button ref="button" type="button" :title="t('draft.previewImage', { n: index + 1 })"
    :aria-label="t('draft.previewImage', { n: index + 1 })" :aria-busy="!src && !failed"
    @click.stop="useLayoutStore().previewImage(image, t('draft.imageLabel', { n: index + 1 }))">
    <img v-if="src" :src="src" :alt="t('draft.imageLabel', { n: index + 1 })" />
    <span v-else>{{ failed ? t('draft.imageLoadError') : t('draft.imagesReading') }}</span>
  </button>
</template>

<style scoped>
button { cursor: zoom-in; padding: 0; width: 96px; height: 76px; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button img { display: block; width: 100%; height: 100%; object-fit: cover; }
button span { display: block; font-size: 11px; color: var(--muted); }
</style>
