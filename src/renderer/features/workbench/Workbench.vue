<script setup lang="ts">
import {
  SplitterGroup,
  SplitterPanel,
  SplitterResizeHandle,
} from "reka-ui";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { PanelId } from "../../../shared/types";
import type { ProjectGroup } from "../../../shared/types";
import BranchContextPanel from "../branch-context/BranchContextPanel.vue";
import GraphPanel from "../graph/GraphPanel.vue";
import SessionNavigator from "../navigator/SessionNavigator.vue";
import ToolPanel from "../tools/ToolPanel.vue";
import WelcomeScreen from "./WelcomeScreen.vue";
import { whenMeasured, whenPanelsSettle, whenVisible, type PanelSettleTarget } from "../../lib/frame";
import { equalSplitWidth } from "../../lib/split";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";

const emit = defineEmits<{
  settings: [];
  pickProject: [];
  newSession: [];
  activateProject: [record: ProjectGroup];
  createProjectSession: [record: ProjectGroup];
  openProjectSession: [record: ProjectGroup, path: string];
  rename: [record: ProjectGroup, path: string, current: string];
  removeProjectSession: [record: ProjectGroup, path: string];
  forgetProject: [record: ProjectGroup];
}>();

type PanelHandle = { collapse: () => void; expand: () => void; resize: (size: number) => void };
const layout = useLayoutStore();
const session = useSessionStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();
const shell = ref<HTMLElement>();
const navigatorElement = ref<HTMLElement>();
const navigatorWidth = computed(() => Math.min(420, Math.max(210, layout.layout.widths.navigator)));
const chatPanel = ref<PanelHandle>();
const contentPanel = ref<PanelHandle>();
const saveTimer = ref<ReturnType<typeof setTimeout>>();
let navigatorHideTimer: ReturnType<typeof setTimeout> | undefined;
let navigatorHovered = false;
let navigatorMenus = 0;
let navigatorDrag: { id: number; x: number; width: number } | undefined;
let navigatorProtectedUntil = 0;
let restoringLayout = true;
// The width the splitter itself is at: its own drags report through resized(),
// so only a store-driven width (restore, pin, close) has to be pushed back —
// otherwise the next drag resumes from a stale baseline and jumps.
let syncedChatWidth = -1;

function sync(panel: PanelId, handle?: PanelHandle) {
  if (!handle) return;
  if (layout.layout.collapsed[panel]) handle.collapse();
  else {
    const width = layout.layout.widths[panel];
    handle.expand();
    // Pixel panels may initially measure before the parent has its final size.
    handle.resize(width);
    if (panel === "chat") syncedChatWidth = width;
  }
}

// Store-driven width changes (pinning widens the slot, closing restores it)
// must reach the splitter too: its drag baseline is its own layout, not the
// rendered flex-basis, so a stale copy makes the first drag jump.
function reconcileChatWidth() {
  if (layout.layout.widths.chat !== syncedChatWidth) sync("chat", chatPanel.value);
}

function resized(panel: PanelId, size: number) {
  if (restoringLayout) return;
  if (size <= 0) return;
  const width = Math.round(size);
  if (width <= 0) return;
  // Programmatic resizes echo back through here; a no-op write would only
  // reschedule the debounced save with an identical payload.
  if (width === layout.layout.widths[panel]) return;
  layout.layout.widths[panel] = width;
  if (panel === "chat") syncedChatWidth = width;
  if (saveTimer.value) clearTimeout(saveTimer.value);
  saveTimer.value = setTimeout(() => void layout.save(), 250);
}

function panelState(panel: PanelId, collapsed: boolean) {
  if (restoringLayout) return;
  if (layout.layout.collapsed[panel] === collapsed) return;
  layout.layout.collapsed[panel] = collapsed;
  void layout.save();
}

function cancelNavigatorHide() {
  if (navigatorHideTimer) clearTimeout(navigatorHideTimer);
  navigatorHideTimer = undefined;
}

function navigatorBusy() {
  const focused = document.activeElement;
  return navigatorHovered || navigatorMenus > 0 || !!navigatorDrag ||
    !!(focused && navigatorElement.value?.contains(focused) &&
      focused.matches('input, textarea, select, [contenteditable="true"], :focus-visible'));
}

function scheduleNavigatorHide() {
  cancelNavigatorHide();
  if (layout.layout.navigatorPinned || layout.layout.collapsed.navigator || navigatorBusy()) return;
  navigatorHideTimer = setTimeout(() => {
    if (!layout.layout.navigatorPinned && !navigatorBusy()) void layout.setCollapsed("navigator", true);
  }, Math.max(1000, navigatorProtectedUntil - Date.now()));
}

function navigatorHover(inside: boolean) {
  navigatorHovered = inside;
  scheduleNavigatorHide();
}

function navigatorMenuChanged(open: boolean) {
  navigatorMenus = Math.max(0, navigatorMenus + (open ? 1 : -1));
  void nextTick(scheduleNavigatorHide);
}

function outsideNavigator(event: PointerEvent) {
  if (layout.layout.navigatorPinned || layout.layout.collapsed.navigator || navigatorDrag) return;
  const target = event.target;
  if (!(target instanceof Element) || navigatorElement.value?.contains(target) ||
    target.closest('[data-action="navigator-panel"], [data-navigator-menu], [role="dialog"]')) return;
  cancelNavigatorHide();
  void layout.setCollapsed("navigator", true);
}

function startNavigatorResize(event: PointerEvent) {
  if (event.button !== 0) return;
  navigatorDrag = { id: event.pointerId, x: event.clientX, width: navigatorWidth.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  cancelNavigatorHide();
}

function resizeNavigator(event: PointerEvent) {
  if (!navigatorDrag || event.pointerId !== navigatorDrag.id) return;
  layout.layout.widths.navigator = Math.min(420, Math.max(210, navigatorDrag.width + event.clientX - navigatorDrag.x));
}

function finishNavigatorResize() {
  if (!navigatorDrag) return;
  navigatorDrag = undefined;
  void layout.save();
  scheduleNavigatorHide();
}

function resizeNavigatorWithKeyboard(event: KeyboardEvent) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  void layout.setWidth("navigator", Math.min(420, Math.max(210, navigatorWidth.value + (event.key === "ArrowLeft" ? -10 : 10))));
}

// Shared by the chat panel's :min-size and the equal-split clamp below.
const CHAT_MIN_WIDTH = 310;

// The handle fires click after every drag release, and the OS folds two quick
// releases into a dblclick even when both were small drags. Track each press's
// own travel and judge only the two presses that make up the double click:
// micro-adjust drags cannot masquerade as a reset, while a completed drag
// right before a genuine double click does not poison it.
const SPLIT_GESTURE_TRAVEL_LIMIT = 4; // px within either press of a double click
let splitSegmentTravel = 0;
let splitPrevSegmentTravel = 0;
let splitGestureX = 0;
let splitGestureY = 0;
let splitGesturePressed = false;

function splitGestureDown(event: PointerEvent) {
  splitPrevSegmentTravel = splitSegmentTravel;
  splitSegmentTravel = 0;
  splitGestureX = event.clientX;
  splitGestureY = event.clientY;
  splitGesturePressed = true;
}

function splitGestureMove(event: PointerEvent) {
  if (!splitGesturePressed) return;
  splitSegmentTravel += Math.hypot(event.clientX - splitGestureX, event.clientY - splitGestureY);
  splitGestureX = event.clientX;
  splitGestureY = event.clientY;
}

function splitGestureUp() {
  splitGesturePressed = false;
}

// Double-click on the canvas/chat handle equalizes the two columns. The chat
// panel is pixel-sized and the graph panel flexes to the remainder, so chat
// takes half of the measured group (minus the handle). The store write reaches
// the splitter through the widths watcher, like pin-driven changes do. Double
// click instead of click: the handle still fires click after a drag release.
function resetChatSplit(event: MouseEvent) {
  if (restoringLayout) return;
  // The double click is made of the last two presses: if either was itself a
  // drag, this is a pair of micro-adjust drags, not a reset gesture.
  const dragLike = Math.max(splitPrevSegmentTravel, splitSegmentTravel) > SPLIT_GESTURE_TRAVEL_LIMIT;
  splitSegmentTravel = 0;
  splitPrevSegmentTravel = 0;
  if (dragLike) return;
  const handle = event.currentTarget;
  if (!(handle instanceof HTMLElement)) return;
  // reka renders the group id as data-panel-group-id, never as an id attribute.
  const group = document.querySelector<HTMLElement>('[data-panel-group-id="pix-primary"]');
  if (!group) return;
  const width = equalSplitWidth(group.clientWidth, handle.offsetWidth, CHAT_MIN_WIDTH);
  if (width === layout.layout.widths.chat) return;
  void layout.setWidth("chat", width);
}

function openProjectSession(record: ProjectGroup, path: string) {
  emit("openProjectSession", record, path);
}

function renameSession(record: ProjectGroup, path: string, current: string) {
  emit("rename", record, path, current);
}

function removeProjectSession(record: ProjectGroup, path: string) {
  emit("removeProjectSession", record, path);
}

watch(() => [layout.layout.collapsed.navigator, layout.layout.navigatorPinned], ([collapsed], previous) => {
  cancelNavigatorHide();
  if (collapsed) navigatorHovered = false;
  else {
    if (previous?.[0]) navigatorProtectedUntil = Date.now() + 2000;
    scheduleNavigatorHide();
  }
}, { immediate: true });

// Pinned chat columns die with their node or their session, and a column that
// submitted follows its branch (pending pin → real node, failed run → parent).
watch(() => session.current?.session.path, () => layout.clearChatColumns());
watch([() => session.current?.projection.nodes, () => session.current?.graph?.runs, () => layout.chatColumns], () => {
  const current = session.current;
  layout.trackChatColumns(
    new Set(current?.projection.nodes.map((node) => node.id)),
    current?.graph?.runs ?? [],
  );
});
watch(() => layout.layout.collapsed.chat, () => sync("chat", chatPanel.value));
watch(() => layout.layout.widths.chat, () => {
  if (!restoringLayout) reconcileChatWidth();
});
watch(() => layout.layout.collapsed.content, () => sync("content", contentPanel.value));
onMounted(() => {
  document.addEventListener("pointerdown", outsideNavigator, true);
  document.addEventListener("pointermove", resizeNavigator);
  document.addEventListener("pointerup", finishNavigatorResize);
  document.addEventListener("pointercancel", finishNavigatorResize);
});
onBeforeUnmount(() => {
  cancelNavigatorHide();
  if (saveTimer.value) clearTimeout(saveTimer.value);
  document.removeEventListener("pointerdown", outsideNavigator, true);
  document.removeEventListener("pointermove", resizeNavigator);
  document.removeEventListener("pointerup", finishNavigatorResize);
  document.removeEventListener("pointercancel", finishNavigatorResize);
});

// Panel restore is driven by render events, not fixed waits: wait for the
// window to be visible, wait until the splitter groups are measured (panel
// calls no-op before that), apply the persisted layout, then wait until the
// DOM actually reached it before letting splitter events write back.
function restoreTargets(): PanelSettleTarget[] {
  const targets: PanelSettleTarget[] = [];
  for (const panel of ["navigator", "chat", "content"] as const) {
    const element = document.getElementById(`${panel}-panel`);
    if (element) {
      targets.push({
        element,
        collapsed: layout.layout.collapsed[panel],
        width: panel === "navigator" ? navigatorWidth.value : layout.layout.widths[panel],
      });
    }
  }
  return targets;
}

watch(() => layout.hydrated, async (hydrated) => {
  if (!hydrated || !restoringLayout) return;
  await whenVisible();
  await nextTick();
  if (shell.value) await whenMeasured(shell.value);
  sync("chat", chatPanel.value);
  sync("content", contentPanel.value);
  await whenPanelsSettle(restoreTargets());
  restoringLayout = false;
  layout.panelsSettled = true;
  // A pin during the restore window skipped the width watcher: reconcile it now
  // that the splitter can absorb a resize.
  reconcileChatWidth();
}, { immediate: true });
</script>

<template>
  <div ref="shell" class="shell" :class="{ 'panels-ready': layout.panelsSettled }">
    <Transition name="navigator" :css="layout.panelsSettled">
      <div
        id="navigator-panel"
        ref="navigatorElement"
        v-show="!layout.layout.collapsed.navigator"
        class="navigator-container"
        :data-state="layout.layout.collapsed.navigator ? 'collapsed' : 'expanded'"
        :class="{ floating: !layout.layout.navigatorPinned }"
        :style="{ width: `${navigatorWidth}px`, '--navigator-width': `${navigatorWidth}px` }"
        :inert="layout.layout.collapsed.navigator"
        @mouseenter="navigatorHover(true)"
        @mouseleave="navigatorHover(false)"
        @focusin="cancelNavigatorHide"
        @focusout="nextTick(scheduleNavigatorHide)"
      >
        <SessionNavigator
          class="navigator"
          @menu-open-change="navigatorMenuChanged"
          @pick-project="$emit('pickProject')"
          @activate-project="emit('activateProject', $event)"
          @create-project-session="emit('createProjectSession', $event)"
          @open-project-session="openProjectSession"
          @rename="renameSession"
          @remove-project-session="removeProjectSession"
          @forget-project="emit('forgetProject', $event)"
          @settings="$emit('settings')"
        />
        <div
          class="navigator-resize resize-handle"
          role="separator"
          tabindex="0"
          aria-orientation="vertical"
          :aria-label="t('titlebar.resizeNavigator')"
          :aria-valuenow="navigatorWidth"
          :aria-valuemin="210"
          :aria-valuemax="420"
          @pointerdown.prevent="startNavigatorResize"
          @lostpointercapture="finishNavigatorResize"
          @keydown="resizeNavigatorWithKeyboard"
        />
      </div>
    </Transition>
    <!-- Render pixel widths directly: the splitter's rounded flex ratios and
         handle space otherwise change right-panel widths when the group resizes. -->
    <SplitterGroup id="pix-workbench" direction="horizontal" class="workbench-splitter">
      <SplitterPanel id="primary-panels" :order="1">
        <SplitterGroup id="pix-primary" direction="horizontal" class="workbench-splitter">
          <SplitterPanel id="graph-panel" :order="2" :min-size="24">
            <WelcomeScreen v-if="!workspace.project" @open-project="$emit('pickProject')" />
            <GraphPanel v-show="workspace.project" class="graph" @new-session="$emit('newSession')" />
          </SplitterPanel>
          <SplitterResizeHandle
            class="resize-handle"
            :class="{ hidden: layout.layout.collapsed.chat }"
            :aria-label="t('titlebar.resizeChatSplit')"
            :title="t('titlebar.resetChatSplit')"
            @pointerdown="splitGestureDown"
            @pointermove="splitGestureMove"
            @pointerup="splitGestureUp"
            @pointercancel="splitGestureUp"
            @dblclick="resetChatSplit"
          />

          <SplitterPanel
            id="chat-panel"
            ref="chatPanel"
            :style="{ flexGrow: 0, flexBasis: `${layout.layout.collapsed.chat ? 0 : layout.layout.widths.chat}px` }"
            :inert="layout.layout.collapsed.chat"
            :order="3"
            collapsible
            :collapsed-size="0"
            size-unit="px"
            :default-size="layout.layout.widths.chat"
            :min-size="CHAT_MIN_WIDTH"
            @resize="resized('chat', $event)"
            @collapse="panelState('chat', true)"
            @expand="panelState('chat', false)"
          >
            <div class="chat-columns">
              <BranchContextPanel class="chat" />
              <BranchContextPanel
                v-for="id in layout.chatColumns"
                :key="id"
                :node-id="id"
                class="chat"
              />
            </div>
          </SplitterPanel>
        </SplitterGroup>
      </SplitterPanel>
      <SplitterResizeHandle class="resize-handle" :class="{ hidden: layout.layout.collapsed.content }" />

      <SplitterPanel
        id="content-panel"
        ref="contentPanel"
        :style="{ flexGrow: 0, flexBasis: `${layout.layout.collapsed.content ? 0 : layout.layout.widths.content}px` }"
        :inert="layout.layout.collapsed.content"
        :order="2"
        collapsible
        :collapsed-size="0"
        size-unit="px"
        :default-size="layout.layout.widths.content"
        :min-size="300"
        @resize="resized('content', $event)"
        @collapse="panelState('content', true)"
        @expand="panelState('content', false)"
      >
        <ToolPanel class="content" />
      </SplitterPanel>
    </SplitterGroup>
  </div>
</template>
