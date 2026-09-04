<script setup lang="ts">
import { Focus, Map as MapIcon, Network } from "@lucide/vue";
import {
  VueFlow,
  type Edge,
  type Node,
  type NodeMouseEvent,
  type VueFlowStore,
} from "@vue-flow/core";
import { MiniMap } from "@vue-flow/minimap";
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import Button from "../../components/ui/Button.vue";
import { projectSession, clipText } from "../../../shared/session";
import { layoutGraph } from "../../graph-layout";
import { useDraftSubmit } from "../../composables/useDraftSubmit";
import { nextFrame, whenTransitionsSettle, whenVisible } from "../../lib/frame";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import type { GraphNode, RuntimeModel } from "../../../shared/types";
import DraftNode, { type DraftNodeData } from "./DraftNode.vue";
import PromptNode, { type PromptNodeData } from "./PromptNode.vue";

const emit = defineEmits<{ newSession: [] }>();
const layout = useLayoutStore();
const session = useSessionStore();
const { t } = useI18n();
const { submitDraft: runDraftSubmit, acceptSubmittedNode: acceptSubmittedDraft, clearSubmittedDraft } = useDraftSubmit();
const nodes = shallowRef<Node[]>([]);
const edges = shallowRef<Edge[]>([]);
const flow = ref<VueFlowStore>();
const dragged = new Set<string>();
const draftParent = ref<string | null>();
const draftModel = ref<RuntimeModel | null>();
const draftThinking = ref<string>();
let activeSession: string | undefined;
const readableZoom = 0.9;
const booted = ref(false);

const projection = computed(() => session.current?.projection);

function nodeContent(id: string) {
  const current = session.current;
  const node = current?.projection.nodes.find((item) => item.id === id);
  if (!current || !node) return { user: "", assistant: "" };
  const messages = projectSession(current.entries, node.leafEntryId).messages.filter(
    (message) => message.turnId === id,
  );
  return {
    user: messages.find((message) => message.role === "user")?.text ?? node.title,
    assistant: [...messages].reverse().find((message) => message.role === "assistant")?.text ?? node.preview,
  };
}

function rebuild() {
  const value = projection.value;
  if (!value) {
    nodes.value = [];
    edges.value = [];
    return;
  }
  if (activeSession !== session.current?.session.path) {
    dragged.clear();
    activeSession = session.current?.session.path;
    draftParent.value = undefined;
    draftModel.value = undefined;
    draftThinking.value = undefined;
    clearSubmittedDraft();
  }
  const previous = new Map(nodes.value.map((node) => [node.id, node.position]));
  const placed = layoutGraph(value);
  const active = new Set(value.activeBranchNodeIds);
  const children = new Map<string, typeof placed.nodes>();
  for (const node of placed.nodes) {
    if (!node.parentId) continue;
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  // While a submitted prompt is being processed the runtime is busy even though
  // the streaming flag only lands with the next snapshot, so both gate composing.
  const busy = Boolean(session.current?.runtime.isStreaming || session.pendingPrompt);
  const turns: Node<PromptNodeData>[] = placed.nodes.map((node) => ({
    id: node.id,
    type: "prompt",
    position: dragged.has(node.id) ? previous.get(node.id) ?? { x: node.x, y: node.y } : { x: node.x, y: node.y },
    data: {
      node,
      active: active.has(node.id),
      current: value.activeNodeId === node.id,
      selected: session.focusedNode === node.id,
      runnable: Boolean(session.current?.runtime.available && !busy),
      blockedReason: busy
        ? "graph.blockedStreaming"
        : "graph.blockedReadonly",
      content: () => nodeContent(node.id),
      onCompose: () => compose(node.id),
    },
  }));
  const rootDraft = !placed.nodes.length;
  if (rootDraft) draftParent.value = null;
  // The submitted prompt renders as a result-shaped node showing the agent at
  // work until the real node arrives with the settled snapshot.
  const pending = session.pendingPrompt;
  const pendingParent = pending?.targetNodeId
    ? placed.nodes.find((node) => node.id === pending.targetNodeId)
    : undefined;
  const pendingSiblings = pendingParent ? children.get(pendingParent.id) ?? [] : [];
  const pendingTurn: Node<PromptNodeData> | undefined = pending ? {
    id: pending.message.entryId,
    type: "prompt",
    position: pendingParent
      ? { x: pendingParent.x + pendingParent.width + 92, y: pendingSiblings.length ? Math.max(...pendingSiblings.map((node) => node.y)) + 178 : pendingParent.y }
      : { x: 48, y: 48 },
    data: {
      node: {
        id: pending.message.entryId,
        userEntryId: pending.message.entryId,
        parentId: pending.targetNodeId,
        title: clipText(pending.message.text, 58) || "Untitled prompt",
        preview: "",
        timestamp: pending.message.timestamp,
        rawEntryIds: [pending.message.entryId],
        leafEntryId: pending.message.entryId,
        toolCallCount: 0,
        hasError: false,
        depth: (pendingParent?.depth ?? -1) + 1,
        footer: {
          model: pending.model ?? session.current?.runtime.model ?? null,
          thinkingLevel: pending.thinkingLevel ?? session.current?.runtime.thinkingLevel ?? "off",
        },
      } satisfies GraphNode,
      active: true,
      current: false,
      selected: false,
      running: true,
      runnable: false,
      blockedReason: "graph.blockedStreaming",
      content: () => ({ user: pending.message.text, assistant: t("graph.agentRunning") }),
      onCompose: () => {},
    },
  } : undefined;
  const parent = draftParent.value ? placed.nodes.find((node) => node.id === draftParent.value) : undefined;
  const model = draftModel.value === undefined
    ? parent?.footer?.model ?? session.current?.runtime.model ?? null
    : draftModel.value;
  const thinkingLevel = draftThinking.value
    ?? parent?.footer?.thinkingLevel
    ?? session.current?.runtime.thinkingLevel
    ?? "off";
  const draftId = parent ? `draft:${parent.id}` : "draft:root";
  const siblings = parent ? children.get(parent.id) ?? [] : [];
  const draft: Node<DraftNodeData> | undefined = (parent || rootDraft) && !pending ? {
    id: draftId,
    type: "draft",
    position: parent
      ? { x: parent.x + parent.width + 92, y: siblings.length ? Math.max(...siblings.map((node) => node.y)) + 178 : parent.y }
      : { x: 48, y: 48 },
    data: {
      parentId: parent?.id ?? null,
      runnable: Boolean(session.current?.runtime.available),
      model,
      thinkingLevel,
      models: session.models,
      onModel: (next: RuntimeModel) => {
        draftModel.value = next;
        if (next.reasoning === false) draftThinking.value = "off";
        rebuild();
      },
      onThinking: (level: string) => {
        draftThinking.value = level;
        rebuild();
      },
      onCancel: parent ? cancelDraft : undefined,
      onSubmit: submitDraft,
    },
  } : undefined;
  nodes.value = [...turns, ...(pendingTurn ? [pendingTurn] : []), ...(draft ? [draft] : [])];
  edges.value = value.edges.map((edge) => ({
    ...edge,
    class: active.has(edge.source) && active.has(edge.target) ? "active-edge" : "",
  }));
  if (pending && pendingParent)
    edges.value.push({ id: `edge:${pending.message.entryId}`, source: pendingParent.id, target: pending.message.entryId, class: "draft-edge", animated: true });
  if (parent && draft) edges.value.push({ id: `edge:${draftId}`, source: parent.id, target: draftId, class: "draft-edge", animated: true });
}

async function select(id: string, openChat = false) {
  if (id.startsWith("draft:") || id.startsWith("pending:")) return;
  await session.selectNode(id);
  const openingChat = openChat && layout.layout.collapsed.chat;
  if (openingChat) {
    void layout.setCollapsed("chat", false);
    await nextTick();
    await whenTransitionsSettle(isPanelElement);
  }
  await center(id);
}

async function compose(id: string) {
  const node = projection.value?.nodes.find((item) => item.id === id);
  draftParent.value = id;
  draftModel.value = node?.footer?.model ?? session.current?.runtime.model ?? null;
  draftThinking.value = node?.footer?.thinkingLevel ?? session.current?.runtime.thinkingLevel ?? "off";
  rebuild();
  await center(`draft:${id}`, true);
}

function cancelDraft() {
  resetDraft();
  rebuild();
}

function resetDraft() {
  draftParent.value = undefined;
  draftModel.value = undefined;
  draftThinking.value = undefined;
}

async function submitDraft(text: string) {
  const delivered = await runDraftSubmit(draftParent.value ?? null, text, draftModel.value, draftThinking.value);
  if (!delivered) return false;
  const id = acceptSubmittedNode();
  if (id) {
    rebuild();
    await center(id, true);
  }
  return true;
}

function acceptSubmittedNode() {
  const id = acceptSubmittedDraft();
  if (id) resetDraft();
  return id;
}

function defaultFocusId() {
  const value = projection.value;
  if (!value) return undefined;
  if (value.nodes.length) return session.focusedNode ?? value.activeNodeId;
  return session.pendingPrompt?.message.entryId ?? "draft:root";
}

const isPanelElement = (target: Element) => target.matches(".workbench-splitter > [data-panel]");

async function center(id = defaultFocusId(), ensureReadable = false, animate = true) {
  if (!flow.value || !id) return;
  await nextTick();
  await nextFrame();
  if (ensureReadable) await whenTransitionsSettle(isPanelElement);
  const node = flow.value.findNode(id);
  if (!node) return;
  const zoom = flow.value.getViewport().zoom;
  await flow.value.setCenter(
    node.computedPosition.x + node.dimensions.width / 2,
    node.computedPosition.y + node.dimensions.height / 2,
    { zoom: ensureReadable ? Math.max(zoom, readableZoom) : zoom, duration: animate ? 280 : 0 },
  );
  if (id.startsWith("draft:"))
    document.querySelector<HTMLTextAreaElement>(".draft-node textarea")?.focus({ preventScroll: true });
}

function focusNodeVisible() {
  const id = defaultFocusId();
  if (!id || !flow.value) return true;
  const node = flow.value.findNode(id);
  if (!node || !node.dimensions.width || !node.dimensions.height) return true;
  const viewport = flow.value.getViewport();
  const pane = flow.value.dimensions.value;
  const left = node.computedPosition.x * viewport.zoom + viewport.x;
  const top = node.computedPosition.y * viewport.zoom + viewport.y;
  const right = left + node.dimensions.width * viewport.zoom;
  const bottom = top + node.dimensions.height * viewport.zoom;
  const tolerance = 8;
  return left >= -tolerance && top >= -tolerance && right <= pane.width + tolerance && bottom <= pane.height + tolerance;
}

// When splitter transitions resize the pane, wait until they truly settle
// (event-driven, not a fixed 340ms guess) and only then bring the focus node
// back into view if the new bounds clipped it.
let recenterPending = false;

watch(
  () => flow.value?.dimensions.value,
  (size, previous) => {
    if (!booted.value || !size || !previous) return;
    if (Math.abs(size.width - previous.width) < 1 && Math.abs(size.height - previous.height) < 1) return;
    if (recenterPending) return;
    recenterPending = true;
    void whenTransitionsSettle(isPanelElement).then(() => {
      recenterPending = false;
      if (focusNodeVisible()) return;
      void center(defaultFocusId(), false, false);
    });
  },
);

async function ready(store: VueFlowStore) {
  flow.value = store;
  try {
    await whenVisible();
    if (!layout.panelsSettled) {
      await Promise.race([
        new Promise<void>((resolve) => {
          const stop = watch(() => layout.panelsSettled, (settled) => {
            if (!settled) return;
            stop();
            resolve();
          });
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    await center(defaultFocusId(), true, false);
  } finally {
    booted.value = true;
  }
}

function rememberDrag(event: NodeMouseEvent) {
  dragged.add(event.node.id);
}

watch(
  () => [session.current?.session.path, session.current?.projection, session.focusedNode, session.models, draftParent.value, session.pendingPrompt],
  () => {
    if (!session.current) booted.value = false;
    const changedSession = activeSession !== session.current?.session.path;
    const submittedNode = acceptSubmittedNode();
    rebuild();
    if (submittedNode) void center(submittedNode, true);
    else if (changedSession) void center(defaultFocusId(), true);
  },
  { immediate: true },
);
</script>

<template>
  <main class="panel graph-panel">
    <div v-if="!session.current" class="graph-empty">
      <div><Network :size="36" /></div>
      <span>
        {{ t("graph.empty") }}
      </span>
      <Button @click="emit('newSession')">{{ t("graph.newSession") }}</Button>
    </div>

    <VueFlow
      v-else
      v-model:nodes="nodes"
      v-model:edges="edges"
      class="session-flow"
      :class="{ booting: !booted }"
      :min-zoom="0.25"
      :max-zoom="1.6"
      :nodes-draggable="true"
      :pan-on-drag="true"
      :zoom-on-scroll="true"
      @pane-ready="ready"
      @node-click="({ node }: NodeMouseEvent) => select(node.id)"
      @node-double-click="({ node }: NodeMouseEvent) => select(node.id, true)"
      @node-drag-stop="rememberDrag"
    >
      <template #node-prompt="props">
        <PromptNode v-bind="props" />
      </template>
      <template #node-draft="props">
        <DraftNode v-bind="props" />
      </template>
      <MiniMap
        v-if="layout.layout.minimap"
        pannable
        zoomable
        node-color="var(--accent)"
        mask-color="color-mix(in srgb, var(--surface) 72%, transparent)"
        :aria-label="t('graph.minimapLabel')"
      />
    </VueFlow>

    <nav class="graph-controls">
      <Button
        variant="ghost"
        size="icon"
        :aria-pressed="layout.layout.minimap"
        :aria-label="t('graph.toggleMinimap')"
        :title="t('graph.toggleMinimap')"
        @click="layout.toggleMinimap()"
      ><MapIcon :size="15" /></Button>
      <Button variant="ghost" size="icon" :aria-label="t('graph.centerCurrent')" :title="t('graph.centerCurrent')" @click="center(defaultFocusId(), true)"><Focus :size="15" /></Button>
    </nav>

    <footer class="graph-footer">
      <span>{{ t("graph.turnsLinks", { turns: projection?.nodes.length ?? 0, links: projection?.edges.length ?? 0 }) }}</span>
      <span>{{ t("graph.activeBranch", { n: projection?.activeBranchNodeIds.length ?? 0 }) }}</span>
    </footer>
  </main>
</template>
