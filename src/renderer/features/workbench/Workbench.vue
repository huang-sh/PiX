<script setup lang="ts">
import {
  SplitterGroup,
  SplitterPanel,
  SplitterResizeHandle,
} from "reka-ui";
import { nextTick, ref, watch } from "vue";
import type { PanelId } from "../../../shared/types";
import type { ProjectGroup } from "../../../shared/types";
import BranchContextPanel from "../branch-context/BranchContextPanel.vue";
import GraphPanel from "../graph/GraphPanel.vue";
import SessionNavigator from "../navigator/SessionNavigator.vue";
import ToolPanel from "../tools/ToolPanel.vue";
import { whenMeasured, whenPanelsSettle, whenVisible, type PanelSettleTarget } from "../../lib/frame";
import { useLayoutStore } from "../../stores/layout";

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
const shell = ref<HTMLElement>();
const navigatorPanel = ref<PanelHandle>();
const chatPanel = ref<PanelHandle>();
const contentPanel = ref<PanelHandle>();
const saveTimer = ref<ReturnType<typeof setTimeout>>();
let restoringLayout = true;

// reka-ui 2.10.4 (latest) mis-handles px-sized panels: the initial layout is
// computed before the group is measured, so px panels boot at their min size
// (and programmatic resize is unreliable for them). Panels are therefore
// declared in percent and converted to/from the persisted pixel widths here.
// The inner group estimate only bootstraps the first render; drag events and
// settle checks measure the real group afterwards.
const innerEstimate = Math.max(
  1,
  window.innerWidth - (layout.layout.collapsed.content ? 0 : layout.layout.widths.content),
);
const pct = (px: number) => Math.min(80, Math.max(0, (px / innerEstimate) * 100));
const groupWidth = (id: string) =>
  document.querySelector(`[data-panel-group-id="${id}"]`)?.getBoundingClientRect().width ||
  innerEstimate;

function sync(panel: PanelId, handle?: PanelHandle) {
  if (!handle) return;
  // expand() alone restores the panel's pre-collapse size, which starts as the
  // persisted width (default-size) and tracks drags afterwards. Calling
  // resize() here is redundant: reka-ui mis-computes the delta for the last
  // panel of a group (chat, content), clamping them to min size or collapsing
  // them outright.
  if (layout.layout.collapsed[panel]) handle.collapse();
  else handle.expand();
}

function resized(panel: PanelId, size: number) {
  if (restoringLayout) return;
  if (size <= 0) return;
  const width = Math.round((size / 100) * groupWidth(panel === "content" ? "pix-workbench" : "pix-primary"));
  if (width <= 0) return;
  layout.layout.widths[panel] = width;
  if (saveTimer.value) clearTimeout(saveTimer.value);
  saveTimer.value = setTimeout(() => void layout.save(), 250);
}

function panelState(panel: PanelId, collapsed: boolean) {
  if (restoringLayout) return;
  if (layout.layout.collapsed[panel] === collapsed) return;
  layout.layout.collapsed[panel] = collapsed;
  void layout.save();
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

watch(() => layout.layout.collapsed.navigator, () => sync("navigator", navigatorPanel.value));
watch(() => layout.layout.collapsed.chat, () => sync("chat", chatPanel.value));
watch(() => layout.layout.collapsed.content, () => sync("content", contentPanel.value));

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
        width: layout.layout.widths[panel],
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
  sync("navigator", navigatorPanel.value);
  sync("chat", chatPanel.value);
  sync("content", contentPanel.value);
  await whenPanelsSettle(restoreTargets());
  restoringLayout = false;
  layout.panelsSettled = true;
}, { immediate: true });
</script>

<template>
  <div ref="shell" class="shell">
    <SplitterGroup id="pix-workbench" direction="horizontal" class="workbench-splitter">
      <SplitterPanel id="primary-panels" :order="1">
        <SplitterGroup id="pix-primary" direction="horizontal" class="workbench-splitter">
          <SplitterPanel
            id="navigator-panel"
            ref="navigatorPanel"
            :order="1"
            collapsible
            :collapsed-size="0"
            :default-size="pct(layout.layout.widths.navigator)"
            :min-size="pct(210)"
            :max-size="pct(420)"
            @resize="resized('navigator', $event)"
            @collapse="panelState('navigator', true)"
            @expand="panelState('navigator', false)"
          >
            <SessionNavigator
              class="navigator"
              @pick-project="$emit('pickProject')"
              @activate-project="emit('activateProject', $event)"
              @create-project-session="emit('createProjectSession', $event)"
              @open-project-session="openProjectSession"
              @rename="renameSession"
              @remove-project-session="removeProjectSession"
              @forget-project="emit('forgetProject', $event)"
              @settings="$emit('settings')"
            />
          </SplitterPanel>
          <SplitterResizeHandle class="resize-handle" />

          <SplitterPanel id="graph-panel" :order="2" :min-size="24">
            <GraphPanel class="graph" @new-session="$emit('newSession')" />
          </SplitterPanel>
          <SplitterResizeHandle class="resize-handle" :class="{ hidden: layout.layout.collapsed.chat }" />

          <SplitterPanel
            id="chat-panel"
            ref="chatPanel"
            :order="3"
            collapsible
            :collapsed-size="0"
            :default-size="pct(layout.layout.widths.chat)"
            :min-size="pct(310)"
            @resize="resized('chat', $event)"
            @collapse="panelState('chat', true)"
            @expand="panelState('chat', false)"
          >
            <BranchContextPanel class="chat" />
          </SplitterPanel>
        </SplitterGroup>
      </SplitterPanel>
      <SplitterResizeHandle class="resize-handle" :class="{ hidden: layout.layout.collapsed.content }" />

      <SplitterPanel
        id="content-panel"
        ref="contentPanel"
        :order="2"
        collapsible
        :collapsed-size="0"
        :default-size="pct(layout.layout.widths.content)"
        :min-size="pct(300)"
        @resize="resized('content', $event)"
        @collapse="panelState('content', true)"
        @expand="panelState('content', false)"
      >
        <ToolPanel class="content" />
      </SplitterPanel>
    </SplitterGroup>
  </div>
</template>
