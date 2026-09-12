<script setup lang="ts">
import { AlertCircle, ArrowDown, ArrowUp, Brain, Check, Image, LoaderCircle, Plus, RotateCcw, Sparkles, Trash2, UserRound, Wrench } from "@lucide/vue";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuPortal, ContextMenuContent, ContextMenuItem } from "reka-ui";
import { Handle, Position } from "@vue-flow/core";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { CSSProperties } from "vue";
import type { GraphNode, PromptImage, RuntimeModel } from "../../../shared/types";
import MarkdownRenderer from "../../components/MarkdownRenderer.vue";
import MessageImages from "../../components/MessageImages.vue";
import type { BranchDirection } from "../../graph-layout";

interface NodeContent {
  user: string;
  images?: PromptImage[];
  assistant: string;
}

export interface PromptNodeData {
  node: GraphNode;
  active: boolean;
  current: boolean;
  runnable: boolean;
  blockedReason: string;
  /** True while the submitted prompt is still being processed by the agent. */
  running?: boolean;
  /** True while the node matches the active graph search query. */
  searchHit?: boolean;
  content: () => NodeContent;
  onCompose: (direction?: BranchDirection) => void;
  /** Present only on failed turns: reopens the prompt as an editable draft. */
  onRetry?: () => void;
  onDelete?: () => void;
  deleteBlockedReason?: string;
}

const props = defineProps<{ id: string; data: PromptNodeData; selected?: boolean }>();
const { t } = useI18n();
const root = ref<HTMLElement>();
const preview = ref<HTMLElement>();
const previewing = ref(false);
const branchDirection = ref<BranchDirection>();
const previewContent = ref<NodeContent>({ user: "", assistant: "" });
const previewStyle = ref<CSSProperties>({ visibility: "hidden", left: "0px", top: "0px" });
let openTimer: number | undefined;
let closeTimer: number | undefined;
const CLOSE_DELAY_MS = 500;
let previewObserver: ResizeObserver | undefined;
const displayModel = computed(() => props.data.node.footer?.model);
const usage = computed(() => props.data.node.footer?.contextUsage);

function clearTimers() {
  window.clearTimeout(openTimer);
  window.clearTimeout(closeTimer);
}

function closePreview() {
  previewObserver?.disconnect();
  previewing.value = false;
}

function placePreview() {
  const anchor = root.value?.getBoundingClientRect();
  const card = preview.value?.getBoundingClientRect();
  if (!anchor || !card) return;
  const gap = 12;
  const pad = 12;
  const left = innerWidth - anchor.right >= card.width + gap
    ? anchor.right + gap
    : anchor.left - card.width - gap;
  previewStyle.value = {
    visibility: "visible",
    left: `${Math.max(pad, Math.min(left, innerWidth - card.width - pad))}px`,
    top: `${Math.max(pad, Math.min(anchor.top + anchor.height / 2 - card.height / 2, innerHeight - card.height - pad))}px`,
  };
}

function showPreview(event: MouseEvent) {
  if (event.buttons) return; // a held button means a drag is in progress: no hover card
  window.clearTimeout(closeTimer);
  openTimer = window.setTimeout(async () => {
    previewContent.value = props.data.content();
    previewing.value = true;
    await nextTick();
    if (typeof ResizeObserver !== "undefined" && preview.value) {
      previewObserver?.disconnect();
      previewObserver = new ResizeObserver(placePreview);
      previewObserver.observe(preview.value);
    }
    requestAnimationFrame(placePreview);
  }, 280);
}

function keepPreview() {
  window.clearTimeout(closeTimer);
}

// The branch pill is a control, not node content. Reaching it from the node
// freezes the card state; arriving from elsewhere (card, canvas) counts as
// off the node, so an open card still runs its close delay.
function holdPreview(event: MouseEvent) {
  clearTimers();
  if (previewing.value && !root.value?.contains(event.relatedTarget as Node | null)) {
    closeTimer = window.setTimeout(closePreview, CLOSE_DELAY_MS);
  }
}

function hidePreview() {
  window.clearTimeout(openTimer);
  closeTimer = window.setTimeout(closePreview, CLOSE_DELAY_MS);
}

function suppressPreview() {
  clearTimers();
  closePreview();
}

// Any pointer press outside an open hover card (or its pending open timer)
// closes it immediately, so press-and-hold interactions (canvas pan, node
// drag) never open or keep the card around.
function onPointerDown(event: PointerEvent) {
  if (!preview.value?.contains(event.target as Node)) suppressPreview();
}

function compose(direction: BranchDirection = "down") {
  suppressPreview();
  if (!props.data.runnable) return;
  props.data.onCompose(direction);
}

function pointBranch(event: MouseEvent) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  branchDirection.value = event.clientY < box.top + box.height / 2 ? "up" : "down";
}

function focusBranch(direction: BranchDirection, event: KeyboardEvent) {
  branchDirection.value = direction;
  (event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLButtonElement>(`[data-direction="${direction}"]`)?.focus();
}

function providerName(value?: string) {
  if (!value) return "—";
  return value.toLowerCase() === "openai" ? "OpenAI" : value.charAt(0).toUpperCase() + value.slice(1);
}

function modelName(value?: RuntimeModel | null) {
  return value?.name || value?.id || "—";
}

function compactTokens(value?: number | null) {
  if (!value) return "—";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
}

onMounted(() => window.addEventListener("pointerdown", onPointerDown, true));

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onPointerDown, true);
  clearTimers();
  previewObserver?.disconnect();
});

function relative(value: string) {
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return t("time.now");
  if (minutes < 60) return t("time.minutes", { n: minutes });
  return t("time.hours", { n: Math.floor(minutes / 60) });
}
</script>

<template>
  <ContextMenuRoot :modal="false" @update:open="suppressPreview">
  <ContextMenuTrigger as-child>
  <article
    ref="root"
    class="prompt-node"
    :class="{ active: data.active, current: data.current, running: data.running, selected, 'search-hit': data.searchHit }"
    @mouseenter="showPreview"
    @mouseleave="hidePreview"
    @contextmenu.stop
  >
    <Handle v-if="data.node.parentId" type="target" :position="Position.Left" />
    <Handle type="source" :position="Position.Right" />
    <section class="turn-copy">
      <span class="turn-role" :title="t('graph.you')" :aria-label="t('graph.you')"><UserRound :size="13" /></span>
      <strong>{{ data.node.title }}</strong>
      <aside class="node-meta">
        <span v-if="data.running" class="node-run-state" role="status" :title="t('graph.agentRunning')" :aria-label="t('graph.agentRunning')"><LoaderCircle :size="12" class="spin" /></span>
        <span v-if="data.node.imageCount" :title="t('draft.attachedImages', { n: data.node.imageCount })"><Image :size="11" />{{ data.node.imageCount }}</span>
        <span v-if="data.current" :title="t('graph.currentTurn')" :aria-label="t('graph.currentTurn')"><Check :size="11" /></span>
        <span v-if="data.node.hasError" class="node-error" :title="t('graph.responseError')" :aria-label="t('graph.responseError')"><AlertCircle :size="12" /></span>
        <span v-else-if="data.node.toolCallCount" :title="t('graph.toolCalls', { n: data.node.toolCallCount })"><Wrench :size="11" />{{ data.node.toolCallCount }}</span>
        <button v-if="data.onRetry" type="button" class="node-retry nodrag nowheel"
          :title="t('graph.retryTurnHint')" :aria-label="t('graph.retryTurn')"
          @focus="suppressPreview"
          @click.stop="data.onRetry()"
        ><RotateCcw :size="12" /></button>
        <time>{{ relative(data.node.timestamp) }}</time>
      </aside>
      <span class="turn-role pi" title="Pi" aria-label="Pi"><Sparkles :size="13" /></span>
      <p :class="{ 'node-running': data.running }">
        <template v-if="data.running && !data.node.preview">{{ t("graph.agentRunning") }}</template>
        <template v-else>{{ data.node.preview || t("graph.waitingAssistant") }}</template>
      </p>
    </section>
    <footer
      class="node-footer nodrag nowheel"
      @click.stop
    >
      <span
        class="node-context-usage"
        :title="usage ? `${compactTokens(usage.tokens)} / ${compactTokens(usage.contextWindow)} tokens` : 'Usage will be saved after this node finishes'"
      >
        <i :style="{ '--usage': `${Math.min(100, usage?.percent ?? 0) * 3.6}deg` }" />
        <b>{{ usage?.percent == null ? "—" : `${Math.round(usage.percent)}%` }}</b>
        <em>{{ compactTokens(usage?.contextWindow) }}</em>
      </span>
      <span class="node-footer-value node-model-value" :title="`${providerName(displayModel?.provider)} / ${modelName(displayModel)}`">
        <span>{{ providerName(displayModel?.provider) }} / {{ modelName(displayModel) }}</span>
      </span>
      <span class="node-footer-value node-thinking-value" title="Node thinking level">
        <Brain :size="12" />
        <span>{{ data.node.footer?.thinkingLevel || "off" }}</span>
      </span>
    </footer>
    <div class="node-branch-controls nodrag nowheel"
      :class="branchDirection ? `direction-${branchDirection}` : ''"
      @mouseenter="holdPreview" @mousemove="pointBranch"
      @mouseleave="branchDirection = undefined; showPreview($event)">
    <button
      type="button"
      class="node-add nodrag nowheel"
      :aria-disabled="!data.runnable"
      :title="data.runnable ? undefined : t(data.blockedReason)"
      :aria-label="data.runnable ? t('graph.continueFromTurn') : t(data.blockedReason)"
      @focus="suppressPreview"
      @keydown.up.prevent.stop="focusBranch('up', $event)"
      @keydown.down.prevent.stop="focusBranch('down', $event)"
      @click.stop="compose()"
    ><Plus :size="15" /></button>
    <button v-for="direction in (['up', 'down'] as const)" :key="direction"
      type="button" class="node-branch-arrow" :data-direction="direction"
      :class="{ 'is-visible': branchDirection === direction }"
      :aria-disabled="!data.runnable"
      :title="data.runnable ? undefined : t(data.blockedReason)"
      :aria-label="t(direction === 'up' ? 'graph.branchUp' : 'graph.branchDown')"
      @focus="branchDirection = direction; suppressPreview()" @blur="branchDirection = undefined"
      @click.stop="compose(direction)"
    ><ArrowUp v-if="direction === 'up'" :size="18" :stroke-width="3" /><ArrowDown v-else :size="18" :stroke-width="3" /></button>
    </div>
  </article>
  </ContextMenuTrigger>
  <ContextMenuPortal>
    <ContextMenuContent class="menu-content nodrag nowheel" :side-offset="4" @close-auto-focus.prevent>
      <ContextMenuItem
        v-if="data.node.hasError"
        class="menu-item"
        data-action="node-retry"
        :disabled="!data.onRetry"
        :title="t('graph.retryTurnHint')"
        @select="data.onRetry?.()"
      ><RotateCcw :size="14" />{{ t('graph.retryTurn') }}</ContextMenuItem>
      <ContextMenuItem
        class="menu-item danger"
        data-action="node-delete"
        :disabled="!data.onDelete || Boolean(data.deleteBlockedReason)"
        :title="t(data.deleteBlockedReason || 'graph.deleteNodeHint')"
        @select="data.onDelete?.()"
      ><Trash2 :size="14" />{{ t('graph.deleteNode') }}</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenuPortal>
  </ContextMenuRoot>

  <Teleport to="body">
    <aside
      v-if="previewing"
      ref="preview"
      class="node-hover-card"
      :style="previewStyle"
      @mouseenter="keepPreview"
      @mouseleave="hidePreview"
    >
      <section>
        <UserRound :size="15" :aria-label="t('graph.you')" />
        <MarkdownRenderer
          v-if="previewContent.user || !previewContent.images?.length"
          :content="previewContent.user || t('common.empty')"
          :custom-id="`${id}:hover:user`"
        />
        <MessageImages :images="previewContent.images" />
      </section>
      <section>
        <Sparkles :size="15" aria-label="Pi" />
        <MarkdownRenderer
          :content="previewContent.assistant || t('graph.noAssistantResponse')"
          :custom-id="`${id}:hover:assistant`"
        />
      </section>
    </aside>
  </Teleport>
</template>
