<script setup lang="ts">
import { Brain, LoaderCircle, MessageSquarePlus, Minimize, Sparkles, Terminal } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { withoutToolLabels } from "../../../shared/session";
import type { BranchMessage, PromptImage, RuntimeModel } from "../../../shared/types";
import CopyButton from "../../components/CopyButton.vue";
import MarkdownRenderer from "../../components/MarkdownRenderer.vue";
import MessageImages from "../../components/MessageImages.vue";
import PromptComposer from "../../components/PromptComposer.vue";
import { useRunCommand } from "../commands/runCommand";
import BranchHistory, { type HistoryTurn as Turn } from "../branch-context/BranchHistory.vue";
import { registerPixieOverlay } from "../../stores/pixie";
import { usePixieStore } from "../../stores/pixie";
import { useLayoutStore } from "../../stores/layout";

const pixie = usePixieStore();
const layout = useLayoutStore();
const runCommand = useRunCommand();
const { t } = useI18n();
const card = ref<HTMLElement>();
const scroll = ref<HTMLElement>();
const composer = ref<InstanceType<typeof PromptComposer>>();
// null rides the CSS default (centered); the first drag pins concrete pixels.
const position = ref<{ left: number; top: number } | null>(null);
// Keep the preferred size separate from viewport constraints.
const size = ref<{ width: number; height: number } | null>(null);
const viewport = ref({ width: window.innerWidth, height: window.innerHeight });
const fittedSize = computed(() => size.value ? {
  width: Math.min(size.value.width, Math.max(1, viewport.value.width - 16)),
  height: Math.min(size.value.height, Math.max(1, viewport.value.height - 52)),
} : null);
const cardStyle = computed(() => ({
  ...(position.value ? { left: `${position.value.left}px`, top: `${position.value.top}px` } : {}),
  ...(fittedSize.value
    ? {
        width: `${fittedSize.value.width}px`,
        height: `${fittedSize.value.height}px`,
        maxHeight: "calc(100vh - 52px)",
        ...(!position.value ? { top: `${Math.max(44, Math.min(viewport.value.height * 0.28, viewport.value.height - fittedSize.value.height - 8))}px` } : {}),
      }
    : {}),
}));
const following = ref(true);
const expandedProcesses = ref(new Set<string>());
const visibleTurnCount = ref(40);
const expandedLiveTools = ref(new Set<string>());
let drag: { id: number; grabX: number; grabY: number; width: number; height: number } | undefined;
let previousFocus: HTMLElement | null = null;
let scrollFrame: number | undefined;
let lastScrollTop = 0;

// The compact bar stays until a first message exists; the expanded card keeps
// the composer in place and grows the transcript above it.
const messages = computed(() => pixie.snapshot?.projection.messages ?? []);
const expanded = computed(() =>
  Boolean(messages.value.length || pixie.pending || pixie.activity));
const activity = computed(() => pixie.activity);
const composerRunnable = computed(() => Boolean(pixie.snapshot));
const composerModel = computed<RuntimeModel | null>(() =>
  pixie.model ?? pixie.snapshot?.runtime.model ?? null);
const composerThinking = computed(() =>
  pixie.thinking ?? pixie.snapshot?.runtime.thinkingLevel ?? "off");
const composerPlaceholder = computed(() => pixie.snapshot
  ? t("pixie.placeholder")
  : pixie.error ? t("pixie.retryHint") : t("pixie.preparing"));

const turns = computed<Turn[]>(() => {
  const grouped: Array<{ id: string; user?: BranchMessage; body: BranchMessage[] }> = [];
  for (const message of messages.value.slice(-visibleTurnCount.value * 2)) {
    if (message.role === "user") grouped.push({ id: message.turnId, user: message, body: [] });
    else {
      let turn = grouped.at(-1);
      if (!turn || turn.id !== message.turnId) {
        turn = { id: message.turnId, body: [] };
        grouped.push(turn);
      }
      turn.body.push(message);
    }
  }
  return grouped.map(({ id, user, body }) => {
    const terminal = [...body].reverse().find(message => message.role === "assistant");
    return { id, user, terminal, process: body.filter(message => message !== terminal) };
  });
});
const processMessages = computed(() => {
  const result = new Map<string, BranchMessage[]>();
  for (const turn of turns.value) {
    if (!expandedProcesses.value.has(turn.id)) continue;
    result.set(turn.id, turn.process.map(message => ({ ...message, text: withoutToolLabels(message.text) })));
  }
  return result;
});

function duration(turn: Turn) {
  const start = new Date(turn.user?.timestamp ?? "").getTime();
  const end = new Date(turn.terminal?.timestamp ?? turn.process.at(-1)?.timestamp ?? "").getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return t("time.aMoment");
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds >= 60
    ? `${t("time.minutes", { n: Math.floor(seconds / 60) })} ${t("time.seconds", { n: seconds % 60 })}`
    : t("time.seconds", { n: seconds });
}

// Model failures arrive as e.g. `401: {"message":"…","type":"authentication_error"}`;
// unwrap the trailing JSON payload so the card shows a readable one-liner.
function errorText(message: { errorMessage?: string }) {
  const raw = message.errorMessage?.trim();
  if (!raw) return t("branch.requestFailed");
  const at = raw.lastIndexOf("{");
  if (at > 0) {
    try {
      const detail = JSON.parse(raw.slice(at)) as { message?: unknown };
      if (typeof detail.message === "string" && detail.message.trim())
        return `${raw.slice(0, at).replace(/[\s:]+$/, "")}: ${detail.message.trim()}`;
    } catch { /* not JSON — fall through to the raw text */ }
  }
  return raw;
}

async function showEarlierTurns() {
  const root = scroll.value;
  const height = root?.scrollHeight ?? 0, top = root?.scrollTop ?? 0;
  visibleTurnCount.value += 40;
  await nextTick();
  if (root) root.scrollTop = top + root.scrollHeight - height;
}

function toggleProcess(id: string, event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open) expandedProcesses.value.add(id);
  else expandedProcesses.value.delete(id);
  scrollLatest();
}

const liveText = (text: string) => text.length > 32768 ? text.slice(-32768) : text;
function toggleLiveTool(id: string, event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open) expandedLiveTools.value.add(id);
  else expandedLiveTools.value.delete(id);
  scrollLatest();
}

// --- Scrolling ---------------------------------------------------------------
function updateFollow() {
  const root = scroll.value;
  if (!root || scrollFrame !== undefined || root.scrollTop === lastScrollTop) return;
  lastScrollTop = root.scrollTop;
  following.value = root.scrollHeight - root.scrollTop - root.clientHeight < 48;
}
function scrollLatest() {
  if (scrollFrame !== undefined) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = undefined;
    const root = scroll.value;
    if (!root || !following.value) return;
    root.scrollTop = root.scrollHeight;
    // A delayed programmatic scroll event must not unpin newly grown output.
    lastScrollTop = root.scrollTop;
  });
}
watch(() => [
  messages.value.length,
  pixie.pending?.timestamp,
  activity.value?.items.map(item => `${item.text.length}:${item.thinking?.length ?? 0}:${item.status}`).join(":"),
], scrollLatest);
watch(() => pixie.pending, pending => {
  if (pending) following.value = true;
  scrollLatest();
});

// --- Composer ----------------------------------------------------------------
function selectModel(model: RuntimeModel) {
  pixie.model = model;
  if (model.reasoning === false) pixie.thinking = "off";
}
function setThinking(level: string, explicit: boolean) {
  if (explicit) pixie.thinking = level;
}
// The prompt itself runs in the background: the composer stays editable for
// the next draft while the live activity carries the stream. A failed send
// puts the text back — unless the user already typed something new.
async function submitComposer(text: string, images?: PromptImage[]) {
  if (pixie.running) return false;
  void pixie.send(text, images).then(delivered => {
    if (delivered || pixie.draft.text.trim() || pixie.draft.images.length) return;
    pixie.draft.text = text;
    pixie.draft.images = images ?? [];
  });
  return true;
}

// --- Dragging ----------------------------------------------------------------
function clamp(left: number, top: number, width: number, height: number) {
  return {
    left: Math.max(8, Math.min(window.innerWidth - width - 8, left)),
    top: Math.max(44, Math.min(window.innerHeight - height - 8, top)),
  };
}
function startDrag(event: PointerEvent) {
  if (event.button !== 0 || (event.target as Element).closest("button, input, textarea")) return;
  const rect = card.value?.getBoundingClientRect();
  if (!rect) return;
  drag = {
    id: event.pointerId,
    grabX: event.clientX - rect.left,
    grabY: event.clientY - rect.top,
    width: rect.width,
    height: rect.height,
  };
  position.value = { left: rect.left, top: rect.top };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function dragMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return;
  position.value = clamp(event.clientX - drag.grabX, event.clientY - drag.grabY, drag.width, drag.height);
}
function endDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return;
  drag = undefined;
}

// --- Resizing -----------------------------------------------------------------
const MIN_WIDTH = 380, MIN_HEIGHT = 240;
const resizeDirections = ["se", "s", "sw", "w", "nw", "n", "ne", "e"] as const;
type ResizeDirection = typeof resizeDirections[number];
type ResizeBounds = { width: number; height: number; left: number; top: number };
let resize: (ResizeBounds & { id: number; startX: number; startY: number; direction: ResizeDirection }) | undefined;
function startResize(event: PointerEvent, direction: ResizeDirection) {
  if (event.button !== 0) return;
  const rect = card.value?.getBoundingClientRect();
  if (!rect) return;
  position.value = clamp(rect.left, rect.top, rect.width, rect.height);
  resize = {
    id: event.pointerId,
    direction,
    startX: event.clientX,
    startY: event.clientY,
    width: rect.width,
    height: rect.height,
    ...position.value,
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function resizeBy(bounds: ResizeBounds, direction: ResizeDirection, dx: number, dy: number) {
  let { left, top } = bounds;
  let right = left + bounds.width, bottom = top + bounds.height;
  if (direction.includes("w")) left = Math.max(8, Math.min(right - MIN_WIDTH, left + dx));
  if (direction.includes("e")) right = Math.min(window.innerWidth - 8, Math.max(left + MIN_WIDTH, right + dx));
  if (direction.includes("n")) top = Math.max(44, Math.min(bottom - MIN_HEIGHT, top + dy));
  if (direction.includes("s")) bottom = Math.min(window.innerHeight - 8, Math.max(top + MIN_HEIGHT, bottom + dy));
  position.value = { left, top };
  size.value = { width: Math.max(1, Math.round(right - left)), height: Math.max(1, Math.round(bottom - top)) };
  scrollLatest();
}
function resizeMove(event: PointerEvent) {
  if (!resize || event.pointerId !== resize.id) return;
  resizeBy(resize, resize.direction, event.clientX - resize.startX, event.clientY - resize.startY);
}
function endResize(event: PointerEvent) {
  if (!resize || event.pointerId !== resize.id) return;
  resize = undefined;
  if (size.value) void layout.setPixieSize(size.value);
}
function constrainOnResize() {
  viewport.value = { width: window.innerWidth, height: window.innerHeight };
  if (!position.value || !card.value) return;
  // The clamped size lands in the DOM after this pass; clamp the position with
  // the intended size, not the still-stale rendered one.
  const width = fittedSize.value?.width ?? card.value.offsetWidth;
  const height = fittedSize.value?.height ?? card.value.offsetHeight;
  const { left, top } = position.value;
  const next = clamp(left, top, width, height);
  if (next.left !== left || next.top !== top) position.value = next;
}
function resetSize() {
  size.value = null;
  position.value = null;
  void layout.setPixieSize();
}
function resizeWithKeys(event: KeyboardEvent, direction: ResizeDirection) {
  const steps: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
  const step = steps[event.key], rect = card.value?.getBoundingClientRect();
  if (!step || !rect || (step[0] && !/[ew]/.test(direction)) || (step[1] && !/[ns]/.test(direction))) return;
  event.preventDefault();
  resizeBy(rect, direction, step[0], step[1]);
  if (size.value) void layout.setPixieSize(size.value);
}
watch(() => layout.layout.pixieSize, saved => {
  if (!size.value && saved) size.value = { ...saved };
}, { immediate: true });
watch([expanded, () => pixie.visible], () => { void nextTick(constrainOnResize); });

// --- Focus and keyboard ------------------------------------------------------
async function focusComposer() {
  await nextTick();
  composer.value?.focus();
}
function collapse() {
  pixie.hide();
}
// Escape collapses the card, but only from inside it, and only after inner
// menus had their chance — the model dropdowns portal to body, so the check
// cannot stay inside the card — and IME composition never collapses anything.
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
  if (document.querySelector('[data-state="open"]')) return;
  event.preventDefault();
  collapse();
}

onMounted(() => {
  registerPixieOverlay({
    containsFocus: () => Boolean(card.value?.contains(document.activeElement)),
    focus: () => {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      void focusComposer();
    },
  });
  window.addEventListener("resize", constrainOnResize);
  document.addEventListener("pointermove", dragMove);
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  document.addEventListener("pointermove", resizeMove);
  document.addEventListener("pointerup", endResize);
  document.addEventListener("pointercancel", endResize);
});
onBeforeUnmount(() => {
  registerPixieOverlay(undefined);
  window.removeEventListener("resize", constrainOnResize);
  document.removeEventListener("pointermove", dragMove);
  document.removeEventListener("pointerup", endDrag);
  document.removeEventListener("pointercancel", endDrag);
  document.removeEventListener("pointermove", resizeMove);
  document.removeEventListener("pointerup", endResize);
  document.removeEventListener("pointercancel", endResize);
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
});
// Hiding returns focus to whatever the workbench held when the card opened.
watch(() => pixie.visible, visible => {
  if (!visible && previousFocus?.isConnected) previousFocus.focus();
  previousFocus = null;
});
// A card opened while the session was still preparing shows a disabled input,
// so the show-time focus landed nowhere; put the cursor in it once usable.
watch(() => pixie.snapshot?.session.path, () => {
  if (pixie.visible && !card.value?.contains(document.activeElement)) void focusComposer();
}, { flush: "post" });
</script>

<template>
  <Teleport to="body">
    <Transition name="pixie-card">
      <section
        v-show="pixie.visible"
        ref="card"
        class="pixie-card"
        :class="{ expanded, sized: size }"
        :style="cardStyle"
        role="complementary"
        :aria-label="t('pixie.title')"
        data-pixie-card
        @keydown="onKeydown"
      >
        <header class="pixie-header" :title="t('pixie.dragHint')" @pointerdown="startDrag" @lostpointercapture="endDrag">
          <span class="pixie-title"><Sparkles :size="14" /> {{ t("pixie.title") }}</span>
          <span class="pixie-scope">{{ t("pixie.scope") }}</span>
          <button
            type="button"
            class="pixie-action"
            data-action="pixie-new-session"
            :disabled="pixie.running"
            :title="t('pixie.newSession')"
            :aria-label="t('pixie.newSession')"
            @click="pixie.newSession()"
          ><MessageSquarePlus :size="15" /></button>
          <button
            type="button"
            class="pixie-action"
            data-action="pixie-collapse"
            :title="t('pixie.collapse')"
            :aria-label="t('pixie.collapse')"
            @click="collapse"
          ><Minimize :size="15" /></button>
        </header>

        <div v-if="expanded" ref="scroll" class="pixie-messages" @scroll="updateFollow">
          <button v-if="messages.length >= visibleTurnCount * 2" type="button" class="load-earlier-turns" @click="showEarlierTurns">
            {{ t("branch.loadEarlier") }}
          </button>
          <BranchHistory
            view-key="pixie"
            :turns="turns"
            :process-messages="processMessages"
            :expanded-processes="expandedProcesses"
            :duration="duration"
            :error-text="errorText"
            @toggle="toggleProcess"
          />
          <article v-if="pixie.pending" class="branch-message user">
            <p>{{ pixie.pending.text }}</p>
            <MessageImages :images="pixie.pending.images" />
            <CopyButton :text="pixie.pending.text" />
          </article>
          <div v-if="pixie.running && !activity" class="process-item waiting" role="status">
            <LoaderCircle :size="14" class="spin" /> {{ t("branch.working") }}
          </div>
          <details v-if="activity" class="agent-process live" :open="activity.active" @toggle="scrollLatest()">
            <summary>
              <LoaderCircle :size="14" class="spin" />
              {{ activity.pass > 1 ? t("branch.workingPass", { n: activity.pass }) : t("branch.working") }}
            </summary>
            <div class="process-items">
              <template v-for="item in activity.items" :key="item.id">
                <details v-if="item.thinking" class="process-item process-thinking" :open="item.status === 'running'" @toggle="scrollLatest()">
                  <summary><Brain :size="13" /><strong>{{ t("branch.thinking") }}</strong></summary>
                  <p>{{ item.status === "running" ? liveText(item.thinking) : item.thinking }}</p>
                </details>
                <details
                  v-if="item.kind === 'tool'"
                  class="process-item process-tool"
                  :class="item.status"
                  :open="item.status === 'running'"
                  @toggle="toggleLiveTool(item.id, $event)"
                >
                  <summary>
                    <LoaderCircle v-if="item.status === 'running'" :size="13" class="spin" />
                    <Terminal v-else :size="13" />
                    <strong>{{ item.title }}</strong>
                    <code v-if="item.input" :title="item.input">{{ item.input }}</code>
                  </summary>
                  <pre v-if="item.status === 'running' || expandedLiveTools.has(item.id)">{{ (item.status === "running" ? liveText(item.text) : item.text) || (item.status === "running" ? t("branch.working") : t("common.noOutput")) }}</pre>
                </details>
                <div v-else-if="item.text" class="process-item assistant">
                  <MarkdownRenderer
                    :content="item.status === 'running' ? liveText(item.text) : item.text"
                    custom-id="pixie-live"
                    :streaming="item.status === 'running'"
                  />
                  <CopyButton :text="item.text" />
                </div>
                <div v-if="item.kind === 'assistant' && item.status === 'error'" class="process-item error">
                  {{ errorText(item) }}
                </div>
              </template>
              <div v-if="!activity.items.length" class="process-item waiting">
                {{ t("branch.waiting") }}
              </div>
            </div>
          </details>
        </div>
        <p v-else class="pixie-hint">{{ t("pixie.hint") }}</p>

        <p v-if="pixie.error" class="pixie-error" role="alert">
          <span>{{ pixie.error }}</span>
          <button type="button" data-action="pixie-retry" @click="pixie.ensure()">{{ t("pixie.retry") }}</button>
          <button v-if="!pixie.models.length" type="button" data-action="pixie-configure" @click="runCommand?.('settings')">
            {{ t("pixie.configureModels") }}
          </button>
        </p>

        <PromptComposer
          ref="composer"
          class="pixie-composer"
          :draft-state="pixie.draft"
          :runnable="composerRunnable"
          :model="composerModel"
          :thinking-level="composerThinking"
          :models="pixie.models"
          :placeholder="composerPlaceholder"
          :commands="[]"
          :running="pixie.running"
          :on-model="selectModel"
          :on-thinking="setThinking"
          :on-submit="submitComposer"
          :on-stop="() => pixie.stop()"
        />
        <button
          v-for="direction in resizeDirections"
          :key="direction"
          type="button"
          class="pixie-resize"
          :data-resize="direction"
          :aria-label="t(`pixie.resize_${direction}`)"
          :title="t('pixie.resize')"
          @pointerdown.stop.prevent="startResize($event, direction)"
          @lostpointercapture="endResize"
          @keydown="resizeWithKeys($event, direction)"
          @dblclick="resetSize"
        />
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.pixie-card {
  position: fixed;
  left: 50%;
  top: 28vh;
  z-index: 140;
  display: flex;
  flex-direction: column;
  width: min(640px, calc(100vw - 48px));
  max-width: calc(100vw - 16px);
  max-height: min(66vh, 720px);
  transform: translateX(-50%);
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.pixie-card[style*="left:"] { transform: none; }
.pixie-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 4px 6px 4px 12px;
  border-bottom: 1px solid var(--border);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.pixie-header:active { cursor: grabbing; }
.pixie-title { display: flex; align-items: center; gap: 7px; font-size: var(--font-size-ui); font-weight: 600; }
.pixie-scope { flex: 1; color: var(--muted); font-size: var(--font-size-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pixie-action {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.pixie-action:hover:not(:disabled) { background: var(--surface-subtle); color: var(--text); }
.pixie-action:disabled { opacity: 0.45; cursor: default; }
.pixie-hint { margin: 0; padding: 10px 12px 0; color: var(--muted); font-size: var(--font-size-caption); }
.pixie-messages {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin: 0 6px;
  padding: 0 6px;
}
.pixie-messages :deep(.branch-history) { display: block; }
.pixie-error {
  display: flex;
  align-items: flex-start;
  min-height: 0;
  max-height: 120px;
  overflow-y: auto;
  gap: 8px;
  margin: 0 6px;
  padding: 6px;
  color: var(--danger);
  font-size: var(--font-size-ui);
}
.pixie-error span { flex: 1; overflow-wrap: anywhere; }
.pixie-error button {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: var(--font-size-caption);
  cursor: pointer;
  white-space: nowrap;
}
/* Keep scrollbars and controls inside the six-pixel resize targets. */
.pixie-composer { flex-shrink: 0; border-top: 1px solid var(--border); margin: 0 6px; padding: 0 6px 10px; }
.pixie-card.sized .pixie-composer { max-height: calc(100% - 44px); overflow-y: auto; }
.pixie-card.sized .pixie-hint { flex: 1; }
.pixie-resize {
  position: absolute;
  padding: 0;
  border: 0;
  background: transparent;
  z-index: 1;
  touch-action: none;
}
.pixie-resize[data-resize="n"], .pixie-resize[data-resize="s"] { left: 16px; right: 16px; height: 6px; cursor: ns-resize; }
.pixie-resize[data-resize="n"] { top: 0; }
.pixie-resize[data-resize="s"] { bottom: 0; }
.pixie-resize[data-resize="e"], .pixie-resize[data-resize="w"] { top: 16px; bottom: 16px; width: 6px; cursor: ew-resize; }
.pixie-resize[data-resize="e"] { right: 0; }
.pixie-resize[data-resize="w"] { left: 0; }
.pixie-resize[data-resize="nw"], .pixie-resize[data-resize="ne"],
.pixie-resize[data-resize="sw"], .pixie-resize[data-resize="se"] { width: 16px; height: 16px; }
.pixie-resize[data-resize="nw"] { top: 0; left: 0; cursor: nwse-resize; }
.pixie-resize[data-resize="ne"] { top: 0; right: 0; cursor: nesw-resize; }
.pixie-resize[data-resize="sw"] { bottom: 0; left: 0; cursor: nesw-resize; }
.pixie-resize[data-resize="se"] { bottom: 0; right: 0; cursor: nwse-resize; }
.pixie-resize:hover, .pixie-resize:focus-visible { background: color-mix(in srgb, var(--accent) 20%, transparent); }
.pixie-card:not(.expanded) { max-height: none; }
.pixie-card:not(.expanded) .pixie-composer :deep(textarea) { min-height: 72px; }

.pixie-card-enter-active, .pixie-card-leave-active { transition: opacity 0.14s ease; }
.pixie-card-enter-from, .pixie-card-leave-to { opacity: 0; }
</style>
