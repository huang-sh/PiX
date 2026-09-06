<script setup lang="ts">
import { useVueFlow, type Node } from "@vue-flow/core";
import { onBeforeUnmount, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{ nodes: Node[] }>();
const { t } = useI18n();
const { viewport, dimensions, setCenter, zoomIn, zoomOut } = useVueFlow();
const canvas = ref<HTMLCanvasElement>();
let frame = 0;
let transform = { x: 0, y: 0, scale: 1 };
watchEffect(() => {
  const nodes = props.nodes;
  const view = { ...viewport.value }, size = { ...dimensions.value };
  const element = canvas.value;
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const ctx = element?.getContext("2d");
    if (!ctx || !element || !nodes.length) return;
    const left = -view.x / view.zoom, top = -view.y / view.zoom;
    let minX = left, minY = top, maxX = left + size.width / view.zoom, maxY = top + size.height / view.zoom;
    for (const node of nodes) {
      minX = Math.min(minX, node.position.x); minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + 360); maxY = Math.max(maxY, node.position.y + 280);
    }
    const scale = Math.min(184 / Math.max(1, maxX - minX), 124 / Math.max(1, maxY - minY));
    transform = { x: minX - 8 / scale, y: minY - 8 / scale, scale };
    ctx.clearRect(0, 0, 200, 140);
    ctx.fillStyle = getComputedStyle(element).color;
    for (const node of nodes) ctx.fillRect((node.position.x - transform.x) * scale,
      (node.position.y - transform.y) * scale, Math.max(1, 280 * scale), Math.max(1, 146 * scale));
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 2;
    ctx.strokeRect((left - transform.x) * scale, (top - transform.y) * scale,
      Math.max(3, size.width / view.zoom * scale), Math.max(3, size.height / view.zoom * scale));
  });
});
onBeforeUnmount(() => cancelAnimationFrame(frame));
function navigate(event: PointerEvent) {
  if (event.type === "pointermove" && !event.buttons) return;
  const element = canvas.value!;
  element.setPointerCapture(event.pointerId);
  const rect = element.getBoundingClientRect();
  void setCenter(transform.x + (event.clientX - rect.left) * 200 / rect.width / transform.scale,
    transform.y + (event.clientY - rect.top) * 140 / rect.height / transform.scale,
    { zoom: viewport.value.zoom });
}
</script>

<template>
  <canvas ref="canvas" class="graph-overview nodrag nopan" width="200" height="140" role="img"
    :aria-label="t('graph.minimapLabel')" @pointerdown.stop="navigate" @pointermove.stop="navigate"
    @wheel.prevent.stop="($event.deltaY < 0 ? zoomIn() : zoomOut())" />
</template>

<style scoped>
.graph-overview { position: absolute; right: 15px; bottom: 15px; z-index: 5; width: 200px; height: 140px;
  color: var(--accent); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; touch-action: none; }
</style>
