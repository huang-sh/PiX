<script setup lang="ts">
import { AlertCircle, ArrowDown, ArrowUp, Brain, Check, Clock, Coins, FolderOutput, GitBranch, Hash, Image, LoaderCircle, MessageSquare, PieChart, Plus, RotateCcw, Sparkles, Tag, Trash2, UserRound, Wrench } from "@lucide/vue";
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuPortal, ContextMenuContent, ContextMenuItem } from "reka-ui";
import { Handle, Position } from "@vue-flow/core";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { CSSProperties } from "vue";
import type { AgentActivity, GraphNode, PromptImage, RuntimeModel } from "../../../shared/types";
import { clipText } from "../../../shared/session";
import MarkdownRenderer from "../../components/MarkdownRenderer.vue";
import MessageImages from "../../components/MessageImages.vue";
import type { BranchDirection } from "../../graph-layout";
import { relativeTimeUnit } from "../../lib/relative-time";
import { FIXED_NODE_CARD_FIELDS, NODE_CARD_FIELDS, normalizeNodeCardFields } from "../../../shared/node-card";
import { usageTokens } from "../../../shared/usage";
import { useLayoutStore } from "../../stores/layout";
import { runDurations } from "../../../shared/run-timing";

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
  compacting?: () => boolean;
  activity?: () => AgentActivity | undefined;
  /** True while the node matches the active graph search query. */
  searchHit?: boolean;
  filterContext?: boolean;
  onEditLabel?: () => void;
  content: () => NodeContent;
  onCompose: (direction?: BranchDirection) => void;
  /** Opens this node in a pinned chat column; graph sessions only. */
  onOpenPanel?: () => void;
  /** Present only on failed turns: reopens the prompt as an editable draft. */
  onRetry?: () => void;
  /** Copies the root-to-node path into a new standalone session; graph sessions only. */
  onExportSession?: () => void;
  /** Live id of the node the chat panel shows; focus moves do not re-render cards. */
  viewedNodeId?: () => string | null;
  exportBlockedReason?: string;
  onDelete?: () => void;
  deleteBlockedReason?: string;
}

const props = defineProps<{ id: string; data: PromptNodeData; selected?: boolean }>();
const { t } = useI18n();
const layout = useLayoutStore();
const root = ref<HTMLElement>();
const footer = ref<HTMLElement>();
const measure = ref<HTMLElement>();
const visibleCount = ref<number>(NODE_CARD_FIELDS.length);
const optionalWidths = ref<number[]>([]);
const preview = ref<HTMLElement>();
const previewing = ref(false);
const previewKind = ref<"content" | "info">("content");
const branchDirection = ref<BranchDirection>();
const previewContent = ref<NodeContent>({ user: "", assistant: "" });
const previewStyle = ref<CSSProperties>({ visibility: "hidden", left: "0px", top: "0px" });
let openTimer: number | undefined;
let closeTimer: number | undefined;
const CLOSE_DELAY_MS = 500;
let previewObserver: ResizeObserver | undefined;
let footerObserver: ResizeObserver | undefined;
let elapsedTimer: number | undefined;
const now = ref(Date.now());
const displayModel = computed(() => props.data.node.footer?.model);
const usage = computed(() => props.data.node.footer?.contextUsage);
const runningText = computed(() => t(props.data.compacting?.() ? "graph.compacting" : "graph.agentRunning"));
const startedAt = computed(() => props.data.node.metrics?.startedAt ?? props.data.node.timestamp);
const durations = computed(() => props.data.running ? runDurations({ startedAt: startedAt.value,
  agentStartedAt: props.data.node.metrics?.agentStartedAt, compactions: props.data.node.metrics?.compactions ?? [] }, now.value) : props.data.node.metrics);
const elapsed = computed(() => props.data.running
  ? durations.value?.durationMs
  : props.data.node.metrics?.durationMs);
const cost = computed(() => {
  const costs = props.data.node.metrics?.costs;
  if (!costs || !Object.keys(costs).length) return undefined;
  const unbilled = new Set(layout.settings?.app.usage?.unbilledProviders?.map(provider => provider.toLowerCase()));
  let total = 0;
  let billed = false;
  for (const [provider, amount] of Object.entries(costs)) {
    if (unbilled.has(provider.toLowerCase())) continue;
    if (amount === null) return undefined;
    billed = true;
    total += amount;
  }
  return { total, estimated: billed };
});
const allInfo = computed(() => {
  const amount = props.data.node.metrics?.usage;
  const tokens = amount ? usageTokens(amount) : undefined;
  const model = `${providerName(displayModel.value?.provider)} / ${modelName(displayModel.value)}`;
  const context = usage.value;
  const values = {
    model: { icon: Sparkles, text: model, detail: model },
    duration: { icon: Clock, text: formatDuration(elapsed.value), detail: formatDuration(elapsed.value) },
    cost: { icon: Coins, text: cost.value ? `${cost.value.estimated ? "≈" : ""}$${cost.value.total.toFixed(4)}` : "—",
      detail: cost.value ? `${cost.value.estimated ? "≈" : ""}$${cost.value.total.toFixed(6)} USD` : "—" },
    tokens: { icon: Hash, text: compactTokens(tokens), detail: tokens == null ? "—" : tokens.toLocaleString() },
    context: { icon: PieChart, text: context?.percent == null ? "—" : `${Math.round(context.percent)}% ${compactTokens(context.contextWindow)}`,
      detail: context ? `${context.tokens?.toLocaleString() ?? "—"} / ${context.contextWindow.toLocaleString()}${context.percent == null ? "" : ` (${Math.round(context.percent)}%)`}` : "—" },
    thinking: { icon: Brain, text: props.data.node.footer?.thinkingLevel ?? "—", detail: props.data.node.footer?.thinkingLevel ?? "—" },
    branch: { icon: GitBranch, text: props.data.node.gitBranch ?? "—", detail: props.data.node.gitBranch ?? "—" },
  };
  return NODE_CARD_FIELDS.map(id => ({ id, ...values[id] }));
});
const selectedInfo = computed(() => [...FIXED_NODE_CARD_FIELDS, ...normalizeNodeCardFields(layout.settings?.app.nodeCardFields)]
  .map(id => allInfo.value.find(field => field.id === id)!)
  .filter(field => field.id !== "branch" || props.data.node.gitBranch));
const footerInfo = computed(() => [...selectedInfo.value.slice(FIXED_NODE_CARD_FIELDS.length), ...selectedInfo.value.slice(0, FIXED_NODE_CARD_FIELDS.length)]);
const visibleOptionalCount = computed(() => Math.max(0, Math.min(visibleCount.value, selectedInfo.value.length) - FIXED_NODE_CARD_FIELDS.length));
const footerColumns = computed(() => [
  ...Array.from({ length: Math.max(1, visibleOptionalCount.value) }, (_, index) => {
    const width = optionalWidths.value[index];
    return index === Math.max(1, visibleOptionalCount.value) - 1
      ? `minmax(${visibleOptionalCount.value && width ? `${width}px` : "0"},1fr)`
      : width ? `${width}px` : "auto";
  }),
  "minmax(0,auto)", "auto",
].join(" "));

function fitFooter() {
  if (!footer.value || !measure.value || !footer.value.clientWidth) return;
  const available = footer.value.clientWidth - 4;
  const widths = Array.from(measure.value.children, item => (item as HTMLElement).offsetWidth);
  // Reserve the same optional widths in the grid that determine which fields fit.
  optionalWidths.value = widths.slice(FIXED_NODE_CARD_FIELDS.length);
  let width = 0;
  let count = 0;
  for (const itemWidth of widths) {
    width += itemWidth + (count ? 2 : 0);
    if (width > available) break;
    count++;
  }
  visibleCount.value = Math.max(FIXED_NODE_CARD_FIELDS.length, count);
}

watch(selectedInfo, async () => { await nextTick(); fitFooter(); });
watch(() => props.data.running, running => {
  window.clearInterval(elapsedTimer);
  now.value = Date.now();
  if (running) elapsedTimer = window.setInterval(() => { now.value = Date.now(); }, 1000);
}, { immediate: true });
const liveResponse = computed(() => {
  const items = props.data.activity?.()?.items ?? [];
  for (let index = items.length - 1; index >= 0; index--)
    if (items[index]!.kind === "assistant" && items[index]!.text) return items[index]!.text;
  return undefined;
});
const responsePreview = computed(() => liveResponse.value ? clipText(liveResponse.value, 240) : props.data.node.preview);
// Focus moves never rebuild the cards, so the viewed-node check stays live here.
const exportBlocked = computed(() => {
  if (props.data.viewedNodeId && props.data.viewedNodeId() !== props.data.node.id)
    return t("graph.exportBranchBlockedNotCurrent");
  return props.data.exportBlockedReason ? t(props.data.exportBlockedReason) : undefined;
});

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

function showPreview(event: MouseEvent, kind: "content" | "info" = "content") {
  if (event.buttons) return; // a held button means a drag is in progress: no hover card
  window.clearTimeout(openTimer);
  window.clearTimeout(closeTimer);
  openTimer = window.setTimeout(async () => {
    await openPreview(kind);
  }, 280);
}

async function openPreview(kind: "content" | "info") {
  previewKind.value = kind;
  if (kind === "content") previewContent.value = props.data.content();
  previewing.value = true;
  await nextTick();
  if (typeof ResizeObserver !== "undefined" && preview.value) {
    previewObserver?.disconnect();
    previewObserver = new ResizeObserver(placePreview);
    previewObserver.observe(preview.value);
  }
  requestAnimationFrame(placePreview);
}

function showInfo() {
  clearTimers();
  void openPreview("info");
}

function blurInfo() {
  if (!preview.value?.matches(":hover")) hidePreview();
}

function leaveInfo(event: MouseEvent) {
  if (root.value?.contains(event.relatedTarget as Node | null)) showPreview(event);
  else hidePreview();
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
  clearTimers();
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
  if (value == null) return "—";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  return value >= 1000 ? `${Math.round(value / 100) / 10}K` : String(value);
}

function formatDuration(value?: number) {
  if (value == null || !Number.isFinite(value)) return "—";
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return t("graph.nodeInfo.seconds", { n: seconds });
  if (seconds < 3600) return t("graph.nodeInfo.minutesSeconds", { m: Math.floor(seconds / 60), s: seconds % 60 });
  return t("graph.nodeInfo.hoursMinutes", { h: Math.floor(seconds / 3600), m: Math.floor(seconds / 60) % 60 });
}

onMounted(() => {
  window.addEventListener("pointerdown", onPointerDown, true);
  if (typeof ResizeObserver !== "undefined" && footer.value) {
    footerObserver = new ResizeObserver(fitFooter);
    footerObserver.observe(footer.value);
    if (measure.value) footerObserver.observe(measure.value);
  }
  fitFooter();
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onPointerDown, true);
  clearTimers();
  previewObserver?.disconnect();
  footerObserver?.disconnect();
  window.clearInterval(elapsedTimer);
});

function relative(value: string) {
  if (!Number.isFinite(Date.parse(value))) return "—";
  const { unit, n } = relativeTimeUnit(Date.now() - new Date(value).getTime());
  return t(`time.${unit}`, { n });
}
</script>

<template>
  <ContextMenuRoot :modal="false" @update:open="suppressPreview">
  <ContextMenuTrigger as-child>
  <article
    ref="root"
    class="prompt-node"
    :class="{ active: data.active, current: data.current, running: data.running, selected, 'search-hit': data.searchHit, 'filter-context': data.filterContext }"
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
        <span v-if="data.running" class="node-run-state" role="status" :title="runningText" :aria-label="runningText"><LoaderCircle :size="12" class="spin" /></span>
        <span v-if="data.node.imageCount" :title="t('draft.attachedImages', { n: data.node.imageCount })"><Image :size="11" />{{ data.node.imageCount }}</span>
        <span v-if="data.current" :title="t('graph.currentTurn')" :aria-label="t('graph.currentTurn')"><Check :size="11" /></span>
        <span v-if="data.node.hasError" class="node-error" :title="t('graph.responseError')" :aria-label="t('graph.responseError')"><AlertCircle :size="12" /></span>
        <span v-else-if="data.node.toolCallCount" :title="t('graph.toolCalls', { n: data.node.toolCallCount })"><Wrench :size="11" />{{ data.node.toolCallCount }}</span>
        <button v-if="data.onRetry" type="button" class="node-retry nodrag nowheel"
          :title="t('graph.retryTurnHint')" :aria-label="t('graph.retryTurn')"
          @focus="suppressPreview"
          @click.stop="data.onRetry()"
        ><RotateCcw :size="12" /></button>
        <time>{{ relative(startedAt) }}</time>
      </aside>
      <span class="turn-role pi" title="Pi" aria-label="Pi"><Sparkles :size="13" /></span>
      <p :class="{ 'node-running': data.running }">
        <template v-if="data.running && (!responsePreview || data.compacting?.())">{{ runningText }}</template>
        <template v-else>{{ responsePreview || t("graph.waitingAssistant") }}</template>
      </p>
    </section>
    <span v-if="data.node.label" class="node-label" :title="data.node.label"><Tag :size="12" /><span>{{ data.node.label }}</span></span>
    <footer
      ref="footer"
      class="node-footer nodrag nowheel"
      :style="{ gridTemplateColumns: footerColumns }"
      role="button"
      tabindex="0"
      :aria-label="t('graph.nodeInfo.details')"
      :aria-expanded="previewing && previewKind === 'info'"
      @mouseenter.stop="showPreview($event, 'info')"
      @mouseleave="leaveInfo"
      @focus="showInfo"
      @blur="blurInfo"
      @click.stop="showInfo"
      @keydown.enter.prevent.stop="showInfo"
      @keydown.space.prevent.stop="showInfo"
      @keydown.esc.prevent.stop="suppressPreview"
    >
      <span v-for="(field, index) in footerInfo" v-show="FIXED_NODE_CARD_FIELDS.includes(field.id) || index < visibleOptionalCount" :key="field.id"
        class="node-info-item node-footer-value"
        :class="[`node-${field.id}-value`, { 'node-context-usage': field.id === 'context', 'node-info-last': index === visibleOptionalCount - 1 }]"
        :data-node-info="field.id"
        :title="`${t(`graph.nodeInfo.${field.id}`)}: ${field.detail}`">
        <template v-if="field.id === 'context'">
          <i :style="{ '--usage': `${Math.max(0, Math.min(100, usage?.percent ?? 0)) * 3.6}deg` }" />
          <b>{{ usage?.percent == null ? "—" : `${Math.round(usage.percent)}%` }}</b><em>{{ compactTokens(usage?.contextWindow) }}</em>
        </template>
        <template v-else><component v-if="field.id !== 'model'" :is="field.icon" :size="12" aria-hidden="true" /><span>{{ field.text }}</span></template>
      </span>
      <span ref="measure" class="node-info-measure" aria-hidden="true">
        <span v-for="field in selectedInfo" :key="field.id" class="node-info-item node-footer-value" :class="[`node-${field.id}-value`, { 'node-context-usage': field.id === 'context' }]">
          <template v-if="field.id === 'context'">
            <i /><b>{{ usage?.percent == null ? "—" : `${Math.round(usage.percent)}%` }}</b><em>{{ compactTokens(usage?.contextWindow) }}</em>
          </template>
          <template v-else><component v-if="field.id !== 'model'" :is="field.icon" :size="12" /><span>{{ field.text }}</span></template>
        </span>
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
      <ContextMenuItem class="menu-item" data-action="node-edit-label" :disabled="!data.onEditLabel" @select="data.onEditLabel?.()"><Tag :size="14" />{{ t("graph.editLabel") }}</ContextMenuItem>
      <ContextMenuItem
        v-if="data.onOpenPanel"
        class="menu-item"
        data-action="node-open-chat"
        :title="t('graph.openInPanelHint')"
        @select="data.onOpenPanel()"
      ><MessageSquare :size="14" />{{ t('graph.openInPanel') }}</ContextMenuItem>
      <ContextMenuItem
        v-if="data.node.hasError"
        class="menu-item"
        data-action="node-retry"
        :disabled="!data.onRetry"
        :title="t('graph.retryTurnHint')"
        @select="data.onRetry?.()"
      ><RotateCcw :size="14" />{{ t('graph.retryTurn') }}</ContextMenuItem>
      <ContextMenuItem
        v-if="data.onExportSession"
        class="menu-item"
        data-action="node-export-session"
        :disabled="Boolean(exportBlocked)"
        :title="exportBlocked || t('graph.exportBranchHint')"
        @select="data.onExportSession()"
      ><FolderOutput :size="14" />{{ t('graph.exportBranch') }}</ContextMenuItem>
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
      @keydown.esc.prevent.stop="suppressPreview"
    >
      <template v-if="previewKind === 'info'">
        <h3 class="node-info-heading">{{ t('graph.nodeInfo.details') }}</h3>
        <dl class="node-info-details">
          <template v-for="field in allInfo" :key="field.id">
            <dt>{{ t(`graph.nodeInfo.${field.id}`) }}</dt><dd>{{ field.detail }}</dd>
          </template>
          <template v-if="data.node.metrics?.usage">
            <dt>{{ t('graph.nodeInfo.input') }}</dt><dd>{{ data.node.metrics.usage.input.toLocaleString() }}</dd>
            <dt>{{ t('graph.nodeInfo.output') }}</dt><dd>{{ data.node.metrics.usage.output.toLocaleString() }}</dd>
            <dt>{{ t('graph.nodeInfo.cacheRead') }}</dt><dd>{{ data.node.metrics.usage.cacheRead.toLocaleString() }}</dd>
            <dt>{{ t('graph.nodeInfo.cacheWrite') }}</dt><dd>{{ data.node.metrics.usage.cacheWrite.toLocaleString() }}</dd>
          </template>
          <template v-if="data.node.metrics?.compactions?.length">
            <dt>{{ t('graph.nodeInfo.compactionDuration') }}</dt><dd>{{ formatDuration(durations?.compactionDurationMs) }}</dd>
            <dt>{{ t('graph.nodeInfo.agentDuration') }}</dt><dd>{{ formatDuration(durations?.agentDurationMs) }}</dd>
          </template>
          <dt>{{ t('graph.nodeInfo.started') }}</dt><dd>{{ Number.isFinite(Date.parse(startedAt)) ? new Date(startedAt).toLocaleString() : "—" }}</dd>
        </dl>
        <p class="node-info-note">{{ t('graph.nodeInfo.note') }}</p>
      </template>
      <template v-else>
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
      </template>
    </aside>
  </Teleport>
</template>
