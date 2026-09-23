<script setup lang="ts">
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Minus, Plus } from "@lucide/vue";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import Button from "../../components/ui/Button.vue";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const props = defineProps<{ dataUrl: string }>();

const pages = shallowRef<HTMLCanvasElement[]>([]);
const pageCount = ref(0);
const zoom = ref(1);
const loading = ref(true);
const failed = ref(false);
const pagesEl = ref<HTMLElement>();
const { t } = useI18n();

// Each render pass bumps `run`; async work from older passes (getPage,
// renderTask) is discarded so zoom changes and unmounts cancel cleanly.
let pdf: PDFDocumentProxy | undefined;
let loadingTask: PDFDocumentLoadingTask | undefined;
let renderTask: RenderTask | undefined;
let run = 0;

function clampZoom(next: number) {
  zoom.value = Math.min(3, Math.max(0.25, Math.round(next * 100) / 100));
}

// Decoding inline sidesteps fetch(): the app CSP's connect-src does not
// allow data: URLs, while atob needs no network permission at all.
function decodeDataUrl(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    data[index] = binary.charCodeAt(index);
  return data;
}

async function load() {
  const id = ++run;
  renderTask?.cancel();
  renderTask = undefined;
  loading.value = true;
  failed.value = false;
  pages.value = [];
  try {
    const next = pdfjs.getDocument({ data: decodeDataUrl(props.dataUrl) });
    const book = await next.promise;
    await loadingTask?.destroy();
    loadingTask = next;
    pdf = book;
    pageCount.value = book.numPages;
    await render();
  } catch {
    // A newer load may already be underway (tab switch); its state wins.
    if (id === run) {
      failed.value = true;
      loading.value = false;
    }
  }
}

async function render() {
  if (!pdf) return;
  const id = ++run;
  renderTask?.cancel();
  renderTask = undefined;
  failed.value = false;
  loading.value = true;
  pages.value = [];
  // jsdom and hidden panels measure 0; a 1:1 viewport keeps tests and the
  // first paint deterministic until the container has a real width.
  const available = (pagesEl.value?.clientWidth ?? 0) - 32;
  const canvases: HTMLCanvasElement[] = [];
  try {
    const first = await pdf.getPage(1);
    const fit = available > 0 ? available / first.getViewport({ scale: 1 }).width : 1;
    const scale = fit * zoom.value;
    const dpr = window.devicePixelRatio || 1;
    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined;
    for (let number = 1; number <= pdf.numPages; number++) {
      if (id !== run) return;
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const task = page.render({ canvas, viewport, transform });
      renderTask = task;
      await task.promise;
      if (id !== run) return;
      canvases.push(canvas);
      pages.value = [...canvases];
    }
    loading.value = false;
  } catch (error) {
    // A cancelled pass belongs to a newer zoom/load, not to this view.
    if (id === run && !(error instanceof Error && error.name === "RenderingCancelledException")) {
      failed.value = true;
      loading.value = false;
    }
  }
}

watch(pages, (list) => pagesEl.value?.replaceChildren(...list));
watch(zoom, () => void render());
watch(() => props.dataUrl, () => {
  loading.value = true;
  pages.value = [];
  void load();
});
onMounted(() => void load());
onBeforeUnmount(() => {
  run++;
  renderTask?.cancel();
  void loadingTask?.destroy();
  loadingTask = undefined;
  pdf = undefined;
});
</script>

<template>
  <div class="pdf-view" data-pdf-view>
    <div class="pdf-toolbar">
      <Button
        variant="ghost"
        size="icon"
        :title="t('tools.pdfZoomOut')"
        :disabled="zoom <= 0.25"
        data-action="pdf-zoom-out"
        @click="clampZoom(zoom - 0.25)"
      >
        <Minus :size="14" />
      </Button>
      <span class="pdf-zoom-level">{{ Math.round(zoom * 100) }}%</span>
      <Button
        variant="ghost"
        size="icon"
        :title="t('tools.pdfZoomIn')"
        :disabled="zoom >= 3"
        data-action="pdf-zoom-in"
        @click="clampZoom(zoom + 0.25)"
      >
        <Plus :size="14" />
      </Button>
      <span v-if="pageCount" class="pdf-page-count">{{ t("tools.pdfPages", { count: pageCount }) }}</span>
    </div>
    <div class="pdf-pages">
      <p v-if="failed" class="empty-copy">{{ t("tools.pdfFailed") }}</p>
      <p v-else-if="loading && !pages.length" class="empty-copy">{{ t("tools.pdfLoading") }}</p>
      <!-- Canvas host is written imperatively by the pages watcher; Vue only
           owns the empty element, so patches never collide with canvases. -->
      <div ref="pagesEl" class="pdf-canvas-stack"></div>
    </div>
  </div>
</template>
