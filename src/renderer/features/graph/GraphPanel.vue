<script setup lang="ts">
import { Focus, Map as MapIcon, Network } from "@lucide/vue";
import {
  VueFlow,
  type Edge,
  type Dimensions,
  type GraphNode as FlowNode,
  type NodeChange,
  type Node,
  type NodeMouseEvent,
  type VueFlowStore,
} from "@vue-flow/core";
import { MiniMap } from "@vue-flow/minimap";
import GraphOverview from "./GraphOverview.vue";
import { computed, markRaw, nextTick, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import Button from "../../components/ui/Button.vue";
import type { ComposerDraft } from "../../components/PromptComposer.vue";
import { projectSession, sessionEntryIndex, clipText } from "../../../shared/session";
import { layoutGraph, reserveManualPositions, type BranchDirection } from "../../graph-layout";
import { useDraftSubmit } from "../../composables/useDraftSubmit";
import { nextFrame, whenTransitionsSettle, whenVisible } from "../../lib/frame";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import type { GraphNode, PromptImage, RuntimeModel } from "../../../shared/types";
import DraftNode, { type DraftNodeData } from "./DraftNode.vue";
import PromptNode, { type PromptNodeData } from "./PromptNode.vue";

const emit = defineEmits<{ newSession: [] }>();
const layout = useLayoutStore();
const session = useSessionStore();
const { t } = useI18n();
const { submitDraft: runDraftSubmit, acceptSubmittedNode: acceptSubmittedDraft, clearSubmittedDraft, submittedNodeId } = useDraftSubmit();
type RenderNode = Node & { dimensions?: Dimensions; handleBounds?: FlowNode["handleBounds"] };
const nodes = shallowRef<RenderNode[]>([]);
const edges = shallowRef<Edge[]>([]);
const flow = shallowRef<VueFlowStore>();
// Keep manual coordinates separate from temporary draft layout positions.
const dragged = new Map<string, { x: number; y: number }>();
let transientNodeIds = new Set<string>();
const draftParent = ref<string | null>();
const branchOrder = new Map<string, number>();
const sessionKey = computed(() => JSON.stringify([session.activeProjectId, session.current?.session.path, session.current?.session.id]));
let orderSequence = 0;
let draftOrder = 0;
const emptyDraft = (): ComposerDraft => ({ text: "", images: [], busy: false, readingImages: false, error: "" });
// Survives viewport unmounts, including attachment reads and failed submissions.
const draftState = ref(emptyDraft());
const draftModel = ref<RuntimeModel | null>();
// Draft-local thinking override for model-driven clamps only; explicit picks go
// to session.userThinking so they outlive this draft.
const draftThinking = ref<string>();
let activeSession: string | undefined;
const readableZoom = 0.9;
const booted = ref(false);
const promptCache = new Map<string, { key: string; data: PromptNodeData }>();
function stablePrompt(data: PromptNodeData) {
  const key = JSON.stringify(data);
  const previous = promptCache.get(data.node.id);
  if (previous?.key === key) return previous.data;
  const raw = markRaw(data);
  promptCache.set(data.node.id, { key, data: raw });
  return raw;
}
let layoutCache: { key: string; positions: Map<string, { x: number; y: number; width: number; height: number }> } | undefined;

const projection = computed(() => session.current?.projection);
function rememberBranchOrder(id: string, order: number, pendingId?: string) {
  if (!pendingId && branchOrder.get(id) === order) return;
  if (pendingId) branchOrder.delete(pendingId);
  branchOrder.set(id, order);
  (layout.layout.branchOrders ??= {})[sessionKey.value] = [...branchOrder];
  void layout.save().catch(error => layout.showNotice(String(error), "error"));
}
const renderGraph = computed(() => {
  if (nodes.value.length < 500) return { nodes: nodes.value, edges: edges.value };
  if (!flow.value) return { nodes: nodes.value.filter(node => node.id === defaultFocusId()), edges: [] };
  const viewport = flow.value.getViewport();
  const size = flow.value.dimensions.value;
  const targets = new Set(nodes.value.filter(node => {
    const x = node.position.x * viewport.zoom + viewport.x;
    const y = node.position.y * viewport.zoom + viewport.y;
    return x < size.width + 100 && x + 360 * viewport.zoom > -100
      && y < size.height + 100 && y + 280 * viewport.zoom > -100;
  }).map(node => node.id));
  // A wide fork can have thousands of curves starting at one visible parent.
  // Keep incoming connections to visible cards; the overview shows the full tree.
  const visibleEdges = edges.value.filter(edge => targets.has(edge.target));
  const included = new Set(targets);
  for (const edge of visibleEdges) included.add(edge.source);
  return { nodes: nodes.value.filter(node => included.has(node.id)), edges: visibleEdges };
});

// Default thinking for a draft: the user's last explicit pick wins over the
// parent node's footer, which in turn wins over the live runtime level.
function inheritThinking(parentId: string | null | undefined): string {
  const parent = parentId ? projection.value?.nodes.find((item) => item.id === parentId) : undefined;
  return session.userThinking
    ?? parent?.footer?.thinkingLevel
    ?? session.current?.runtime.thinkingLevel
    ?? "off";
}

function nodeContent(id: string) {
  const current = session.current;
  const node = current?.projection.nodes.find((item) => item.id === id);
  if (!current || !node) return { user: "", assistant: "" };
  const index = sessionEntryIndex(current.entries);
  const entries = node.rawEntryIds.flatMap(id => index.get(id) ?? []);
  const messages = projectSession(entries, node.leafEntryId).messages.filter(
    (message) => message.turnId === id,
  );
  return {
    user: messages.find((message) => message.role === "user")?.text ?? node.title,
    images: messages.find((message) => message.role === "user")?.images,
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
  if (activeSession !== sessionKey.value) {
    dragged.clear();
    branchOrder.clear();
    orderSequence = 0;
    const saved = layout.layout.branchOrders?.[sessionKey.value];
    if (Array.isArray(saved)) for (const entry of saved) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && Number.isSafeInteger(entry[1]) && entry[1] < 0) {
        branchOrder.set(entry[0], entry[1]);
        orderSequence = Math.max(orderSequence, -entry[1]);
      }
    }
    draftOrder = 0;
    activeSession = sessionKey.value;
    draftState.value = emptyDraft();
    draftParent.value = undefined;
    draftModel.value = undefined;
    draftThinking.value = undefined;
    clearSubmittedDraft();
  }
  for (const run of session.current?.graph?.runs ?? []) {
    const pendingId = `pending:${run.runId}`;
    const order = branchOrder.get(pendingId);
    if (run.nodeId && order !== undefined) {
      rememberBranchOrder(run.nodeId, order, pendingId);
    }
  }
  const previousNodes = new Map(nodes.value.map(node => [node.id, node]));
  const layoutKey = value.nodes.map(n => `${n.id}/${n.parentId}/${n.depth}/${branchOrder.get(n.id) ?? 0}`).join(";");
  if (layoutCache?.key !== layoutKey) {
    const calculated = layoutGraph(value, undefined, branchOrder);
    const positions = new Map(calculated.nodes.map(n => [n.id, { x: n.x, y: n.y, width: n.width, height: n.height }]));
    const removed = layoutCache && [...layoutCache.positions.keys()].some(id => !positions.has(id));
    // Only deletions invalidate moved manual slots to close gaps. Adding a
    // branch must preserve the user's coordinates even when its auto slots move.
    for (const id of dragged.keys()) {
      const before = layoutCache?.positions.get(id);
      const after = positions.get(id);
      if (!before || !after || (removed && (before.x !== after.x || before.y !== after.y))) dragged.delete(id);
    }
    layoutCache = { key: layoutKey, positions };
  }
  const placed = { nodes: value.nodes.map(node => ({ ...node, ...layoutCache!.positions.get(node.id)!,
    ...dragged.get(node.id),
  })) };
  const active = new Set(value.activeBranchNodeIds);
  const children = new Map<string, typeof placed.nodes>();
  for (const node of placed.nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  // While a submitted prompt is being processed the runtime is busy even though
  // the streaming flag only lands with the next snapshot, so both gate composing.
  const busy = !session.current?.graph && Boolean(session.current?.runtime.isStreaming || session.pendingPrompt);
  const turns: Node<PromptNodeData>[] = placed.nodes.map((node) => ({
    id: node.id,
    type: "prompt",
    position: { x: node.x, y: node.y },
    data: stablePrompt({
      node,
      active: active.has(node.id),
      current: value.activeNodeId === node.id,
      selected: session.focusedNode === node.id,
      runnable: Boolean(session.current?.runtime.available && !busy && node.forkable !== false),
      running: node.running,
      blockedReason: busy
        ? "graph.blockedStreaming"
        : "graph.blockedReadonly",
      content: () => nodeContent(node.id),
      onCompose: direction => compose(node.id, direction),
    }),
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
        title: clipText(pending.message.text, 58) || (pending.message.images?.length ? `🖼 × ${pending.message.images.length}` : "Untitled prompt"),
        imageCount: pending.message.images?.length,
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
      content: () => ({ user: pending.message.text, images: pending.message.images, assistant: t("graph.agentRunning") }),
      onCompose: () => {},
    },
  } : undefined;
  const parent = draftParent.value ? placed.nodes.find((node) => node.id === draftParent.value) : undefined;
  const model = draftModel.value === undefined
    ? parent?.footer?.model ?? session.current?.runtime.model ?? null
    : draftModel.value;
  const thinkingLevel = draftThinking.value ?? inheritThinking(draftParent.value);
  const draftId = parent ? `draft:${parent.id}` : "draft:root";
  const siblings = parent ? children.get(parent.id) ?? [] : [];
  const draft: Node<DraftNodeData> | undefined = (parent || rootDraft) ? {
    id: draftId,
    type: "draft",
    // Keep the editor mounted while sending so failures retain text and images.
    style: { visibility: pending ? "hidden" : "visible", pointerEvents: pending ? "none" : "auto" },
    position: parent
      ? { x: parent.x + parent.width + 92, y: siblings.length ? Math.max(...siblings.map((node) => node.y)) + 178 : parent.y }
      : { x: 48, y: 48 },
    data: {
      draftState: draftState.value,
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
      onThinking: (level: string, explicit: boolean) => {
        if (explicit) {
          session.setUserThinking(level);
          draftThinking.value = undefined;
        } else {
          draftThinking.value = level;
        }
        rebuild();
      },
      onCancel: parent ? cancelDraft : undefined,
      onSubmit: submitDraft,
    },
  } : undefined;
  const nextNodes: RenderNode[] = [...turns, ...(pendingTurn ? [pendingTurn] : []), ...(draft ? [draft] : [])];
  const nextEdges: Edge[] = value.edges.map((edge) => ({
    ...edge,
    class: "",
  }));
  if (pending && pendingParent)
    nextEdges.push({ id: `edge:${pending.message.entryId}`, source: pendingParent.id, target: pending.message.entryId, class: "draft-edge", animated: true });
  if (parent && draft) nextEdges.push({ id: `edge:${draftId}`, source: parent.id, target: draftId, class: "draft-edge", animated: true });
  const pendingRows = new Map<string | null, number>();
  for (const run of session.current?.graph?.runs ?? []) {
    if (!run.pending || run.status !== "running") continue;
    const parentId = run.pending.parentNodeId;
    const anchor = placed.nodes.find(n => n.id === parentId);
    const offset = pendingRows.get(parentId) ?? 0;
    pendingRows.set(parentId, offset + 1);
    const siblings = parentId ? children.get(parentId) ?? [] : placed.nodes;
    const id = `pending:${run.runId}`;
    const node: GraphNode = { id, userEntryId: id, parentId, title: clipText(run.pending.text, 58), preview: "",
      timestamp: "", rawEntryIds: [], leafEntryId: id, toolCallCount: 0, hasError: false, depth: (anchor?.depth ?? -1) + 1 };
    nextNodes.push({ id, type: "prompt", position: { x: anchor ? anchor.x + anchor.width + 92 : 48,
      y: (siblings.length ? Math.max(...siblings.map(n => n.y)) + 178 : anchor?.y ?? 48) + offset * 178 },
      data: { node, active: true, current: false, selected: session.focusedNode === id, running: true, runnable: false,
        blockedReason: "graph.blockedStreaming", content: () => ({ user: run.pending!.text, assistant: t("graph.agentRunning"), images: run.pending!.images }), onCompose: () => {} } });
    if (parentId) nextEdges.push({ id: `edge:${id}`, source: parentId, target: id, animated: true });
  }
  // Highlight paths to running turns, including submitted turns awaiting a node.
  // Shared ancestors are visited once, even when multiple branches are running.
  const parents = new Map<string, string | null>(nextNodes
    .filter(node => node.type === "prompt").map(node => [node.id, node.data.node.parentId]));
  const runningPath = new Set<string>();
  for (const node of nextNodes) {
    if (node.type !== "prompt" || !node.data.running) continue;
    let id: string | null = node.id;
    while (id && !runningPath.has(id)) {
      runningPath.add(id);
      id = parents.get(id) ?? null;
    }
  }
  for (const edge of nextEdges) {
    if (runningPath.has(edge.source) && runningPath.has(edge.target)) edge.class = "running-edge";
  }
  // Vue Flow treats zero-size, unmeasured nodes as visible everywhere. Supply
  // initial dimensions so opening a large graph never mounts all its cards.
  for (const node of nextNodes) {
    const existing = flow.value?.findNode(node.id);
    const previous = previousNodes.get(node.id);
    Object.assign(node, {
      dimensions: existing?.dimensions.width ? existing.dimensions
        : previous?.dimensions ?? { width: node.type === "draft" ? 360 : 280, height: node.type === "draft" ? 280 : 146 },
      handleBounds: existing?.handleBounds.source?.length ? existing.handleBounds : previous?.handleBounds ?? {
        source: [{ type: "source", nodeId: node.id, position: "right", x: 276, y: 69, width: 8, height: 8 }],
        target: [{ type: "target", nodeId: node.id, position: "left", x: -4, y: 69, width: 8, height: 8 }],
      },
    });
  }
  transientNodeIds = new Set(nextNodes.slice(turns.length).map(node => node.id));
  layoutBranches(nextNodes);
  nodes.value = nextNodes;
  edges.value = nextEdges;
  const ids = new Set(nodes.value.map(node => node.id));
  for (const id of promptCache.keys()) if (!ids.has(id)) promptCache.delete(id);
}

function layoutBranches(items: RenderNode[]) {
  if (!transientNodeIds.size && !dragged.size && !branchOrder.size) return false;
  // Reserve space inside each branch; moving only the draft can cross other branches.
  const visible = items.filter(node => !(node.type === "draft" && session.pendingPrompt));
  const depths = new Map(projection.value?.nodes.map(node => [node.id, node.depth]));
  const tree = visible.map(node => node.type === "draft"
    ? { id: node.id, parentId: node.data.parentId, timestamp: "\uffff", depth: (depths.get(node.data.parentId) ?? -1) + 1 }
    : { ...node.data.node, timestamp: transientNodeIds.has(node.id) ? "\uffff" : node.data.node.timestamp });
  const order = new Map(branchOrder);
  if (draftParent.value !== undefined) order.set(draftParent.value ? `draft:${draftParent.value}` : "draft:root", draftOrder);
  const pending = session.pendingPrompt;
  if (pending && pending.targetNodeId === draftParent.value) order.set(pending.message.entryId, draftOrder);
  const placed = layoutGraph({ nodes: tree }, new Map(visible.map(node => [node.id, node.dimensions!])), order);
  reserveManualPositions(placed.nodes, dragged);
  let moved = false;
  for (let i = 0; i < visible.length; i++) {
    const node = visible[i]!, position = placed.nodes[i]!;
    if (node.position.x === position.x && node.position.y === position.y) continue;
    node.position = { x: position.x, y: position.y };
    moved = true;
  }
  return moved;
}

async function select(id: string, openChat = false) {
  if (id.startsWith("draft:") || (id.startsWith("pending:") && !session.current?.graph)) return;
  await session.selectNode(id);
  const openingChat = openChat && layout.layout.collapsed.chat;
  if (openingChat) {
    void layout.setCollapsed("chat", false);
    await nextTick();
    await whenTransitionsSettle(isPanelElement);
  }
  await center(id);
}

async function compose(id: string, direction?: BranchDirection) {
  if (draftParent.value !== id) draftState.value = emptyDraft();
  draftOrder = direction === "up" ? -++orderSequence : 0;
  const node = projection.value?.nodes.find((item) => item.id === id);
  draftParent.value = id;
  draftModel.value = node?.footer?.model ?? session.current?.runtime.model ?? null;
  draftThinking.value = undefined;
  rebuild();
  await center(`draft:${id}`, true);
}

function cancelDraft() {
  resetDraft();
  rebuild();
}

function resetDraft() {
  draftState.value = emptyDraft();
  draftParent.value = undefined;
  draftModel.value = undefined;
  draftThinking.value = undefined;
  draftOrder = 0;
}

async function submitDraft(text: string, images?: PromptImage[]) {
  const order = draftOrder;
  const targetSession = sessionKey.value;
  const delivered = await runDraftSubmit(
    draftParent.value ?? null,
    text,
    draftModel.value,
    draftThinking.value ?? inheritThinking(draftParent.value),
    images,
  );
  if (!delivered) return false;
  if (targetSession !== sessionKey.value) return true;
  if (submittedNodeId.value && order) rememberBranchOrder(submittedNodeId.value, order);
  if (session.current?.graph) {
    resetDraft(); rebuild();
    await center(session.focusedNode ?? undefined, true);
    return true;
  }
  const id = acceptSubmittedNode();
  if (id) {
    rebuild();
    await center(id, true);
  }
  return true;
}

function acceptSubmittedNode() {
  const id = acceptSubmittedDraft();
  if (id && draftOrder && activeSession === sessionKey.value) rememberBranchOrder(id, draftOrder);
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
  const position = node?.computedPosition ?? nodes.value.find(node => node.id === id)?.position;
  if (!position) return;
  const zoom = flow.value.getViewport().zoom;
  const viewport = flow.value.getViewport();
  const pane = flow.value.dimensions.value;
  const distant = Math.hypot(position.x * zoom + viewport.x - pane.width / 2,
    position.y * zoom + viewport.y - pane.height / 2) > Math.hypot(pane.width, pane.height) * 2;
  await flow.value.setCenter(
    position.x + (node?.dimensions.width || (id.startsWith("draft:") ? 360 : 280)) / 2,
    position.y + (node?.dimensions.height || (id.startsWith("draft:") ? 280 : 146)) / 2,
    // D3's zoom interpolation zooms far out between distant nodes, transiently
    // mounting thousands of cards. Jump directly across large branches.
    { zoom: ensureReadable ? Math.max(zoom, readableZoom) : zoom, duration: animate && !distant ? 280 : 0 },
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
  dragged.set(event.node.id, { ...event.node.position });
  const node = nodes.value.find(node => node.id === event.node.id);
  if (node) {
    node.position = { ...event.node.position };
    nodes.value = [...nodes.value];
  }
}

function syncNodeDimensions(changes: NodeChange[]) {
  let resized = false;
  for (const change of changes) {
    if (change.type !== "dimensions") continue;
    const measured = flow.value?.findNode(change.id);
    const node = nodes.value.find(node => node.id === change.id);
    // Viewport filtering re-submits these nodes; keep it from restoring the
    // estimated handles over Vue Flow's measured positions.
    // Initial measurements can arrive before pane-ready gives us the store.
    // The event carries the actual size even when findNode is unavailable.
    if (node && change.dimensions) {
      resized ||= node.dimensions?.width !== change.dimensions.width || node.dimensions?.height !== change.dimensions.height;
      node.dimensions = change.dimensions;
    }
    if (node && measured) node.handleBounds = measured.handleBounds;
  }
  if (resized && layoutBranches(nodes.value)) nodes.value = [...nodes.value];
}

const pendingRuns = computed(() => JSON.stringify(session.current?.graph?.runs.filter(run => run.pending && run.status === "running") ?? []));
watch(
  () => [sessionKey.value, session.current?.projection, session.focusedNode, session.models, draftParent.value, session.pendingPrompt, pendingRuns.value],
  () => {
    if (!session.current) booted.value = false;
    const changedSession = activeSession !== sessionKey.value;
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
      <div aria-hidden="true"><Network :size="64" :stroke-width="1.6" /></div>
      <span>
        {{ t("graph.empty") }}
      </span>
      <Button @click="emit('newSession')">{{ t("graph.newSession") }}</Button>
    </div>

    <VueFlow
      v-else
      :nodes="renderGraph.nodes"
      :edges="renderGraph.edges"
      class="session-flow"
      :class="{ booting: !booted }"
      :min-zoom="0.25"
      :max-zoom="1.6"
      :nodes-draggable="true"
      :pan-on-drag="true"
      :zoom-on-scroll="true"
      :only-render-visible-elements="true"
      @pane-ready="ready"
      @node-click="({ node }: NodeMouseEvent) => select(node.id)"
      @node-double-click="({ node }: NodeMouseEvent) => select(node.id, true)"
      @node-drag-stop="rememberDrag"
      @nodes-change="syncNodeDimensions"
    >
      <template #node-prompt="props">
        <PromptNode v-bind="props" />
      </template>
      <template #node-draft="props">
        <DraftNode v-bind="props" />
      </template>
      <MiniMap
        v-if="layout.layout.minimap && nodes.length < 500"
        pannable
        zoomable
        node-color="var(--accent)"
        mask-color="color-mix(in srgb, var(--surface) 72%, transparent)"
        :aria-label="t('graph.minimapLabel')"
      />
      <GraphOverview v-if="layout.layout.minimap && nodes.length >= 500" :nodes="nodes" />
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
      <span v-if="session.current?.graph">{{ t("graph.parallelRuns", { n: session.current.graph.runs.filter(r => r.status === 'running').length }) }}</span>
    </footer>
  </main>
</template>
