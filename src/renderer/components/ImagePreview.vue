<script setup lang="ts">
import { X, ZoomIn, ZoomOut } from "@lucide/vue";
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useLayoutStore } from "../stores/layout";

const layout = useLayoutStore();
const { t } = useI18n();
const zoomed = ref(false);
let returnFocus: HTMLElement | undefined;
watch(() => layout.imagePreview, (image) => {
  if (!image) return;
  zoomed.value = false;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
});
function restoreFocus(event: Event) {
  if (!returnFocus?.isConnected) return;
  event.preventDefault();
  returnFocus.focus({ preventScroll: true });
}
</script>

<template>
  <DialogRoot :open="!!layout.imagePreview" @update:open="!$event && (layout.imagePreview = undefined)">
    <DialogPortal>
      <DialogOverlay class="image-viewer-overlay" data-image-preview-overlay @click="layout.imagePreview = undefined" />
      <DialogContent class="image-viewer" data-image-preview :aria-describedby="undefined" @close-auto-focus="restoreFocus">
        <header>
          <DialogTitle>{{ t("draft.imagePreview") }} · {{ layout.imagePreview?.alt }}</DialogTitle>
          <button type="button" data-image-preview-zoom :aria-pressed="zoomed" :aria-label="t(zoomed ? 'draft.imageFit' : 'draft.imageActualSize')" :title="t(zoomed ? 'draft.imageFit' : 'draft.imageActualSize')" @click="zoomed = !zoomed"><ZoomOut v-if="zoomed" :size="19" /><ZoomIn v-else :size="19" /></button>
          <DialogClose as-child><button type="button" data-image-preview-close :aria-label="t('draft.closeImagePreview')" :title="t('draft.closeImagePreview')"><X :size="21" /></button></DialogClose>
        </header>
        <div class="image-viewer-stage" :class="{ 'is-zoomed': zoomed }" @click.self="layout.imagePreview = undefined">
          <img v-if="layout.imagePreview" :src="layout.imagePreview.src" :alt="layout.imagePreview.alt" draggable="false" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.image-viewer-overlay { position: fixed; inset: 0; z-index: 500; background: rgb(0 0 0 / 78%); }
.image-viewer { position: fixed; z-index: 501; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 94vw; height: 90vh; display: flex; flex-direction: column; min-width: 0; padding: 12px; border: 1px solid #ffffff30; border-radius: 12px; background: #181b1e; color: #fff; box-shadow: 0 20px 80px #0008; }
header { display: flex; align-items: center; gap: 8px; padding-bottom: 12px; }
header h2 { flex: 1; margin: 0; font-size: 14px; font-weight: 500; }
header button { display: grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: 8px; }
header button:hover { background: #ffffff20; }
header button:focus-visible { outline: 2px solid var(--accent); }
.image-viewer-stage { flex: 1; min-height: 0; overflow: auto; display: flex; align-items: center; justify-content: center; }
.image-viewer-stage img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
.image-viewer-stage.is-zoomed { display: block; }
.image-viewer-stage.is-zoomed img { max-width: none; max-height: none; margin: auto; }
</style>
