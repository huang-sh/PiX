<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { PromptImage } from "../../shared/types";
import { imageDataUrl } from "../../shared/images";
import { useLayoutStore } from "../stores/layout";
defineProps<{ images?: PromptImage[] }>();
const { t } = useI18n();
function preview(image: PromptImage, index: number) {
  useLayoutStore().previewImage(image, t("draft.imageLabel", { n: index + 1 }));
}
</script>

<template>
  <div v-if="images?.length" class="message-images">
    <button v-for="(image, index) in images" :key="index" type="button" :title="t('draft.previewImage', { n: index + 1 })" :aria-label="t('draft.previewImage', { n: index + 1 })" @click.stop="preview(image, index)">
      <img :src="imageDataUrl(image)" :alt="t('draft.imageLabel', { n: index + 1 })" loading="lazy" />
    </button>
  </div>
</template>

<style scoped>
.message-images { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; min-width: 0; }
button { cursor: zoom-in; padding: 0; border-radius: 8px; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button img { display: block; width: 96px; height: 76px; object-fit: cover; border: 1px solid var(--border); border-radius: 8px; }
</style>
