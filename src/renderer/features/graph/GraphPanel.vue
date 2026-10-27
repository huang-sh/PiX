<script setup lang="ts">
import { Focus, Map as MapIcon, Network, Search } from "@lucide/vue";
import {
  VueFlow,
  type Edge,
  type Dimensions,
  type GraphNode as FlowNode,
  type Node,
  type NodeChange,
  type NodeMouseEvent,
  type VueFlowStore,
  type ViewportTransform,
} from "@vue-flow/core";
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { MiniMap } from "@vue-flow/minimap";
import GraphOverview from "./GraphOverview.vue";
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import Button from "../../components/ui/Button.vue";
import type { ComposerDraft } from "../../components/PromptComposer.vue";
import { projectSession, sessionEntryIndex, clipText } from "../../../shared/session";
import { layoutGraph, reserveManualPositions, type BranchDirection, type ManualPosition } from "../../graph-layout";
import { useDraftSubmit } from "../../composables/useDraftSubmit";
import { nextFrame, whenTransitionsSettle, whenVisible } from "../../lib/frame";
import { searchGraphNodeIds } from "../../lib/graph-search";
import { isMac, shortcutForEvent } from "../../keyboard-shortcuts";
import { formatShortcut, shortcutBindings } from "../../../shared/shortcuts";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import { GRAPH_FILTERS, graphFilterIds, matchesGraphFilter } from "../../../shared/graph-filter";
import type { GraphFilter, GraphNode, PromptImage, RuntimeModel } from "../../../shared/types";
import DraftNode, { type DraftNodeData } from "./DraftNode.vue";
import PromptNode, { type PromptNodeData } from "./PromptNode.vue";

const emit = defineEmits<{ newSession: [] }>();
const layout = useLayoutStore();
const session = useSessionStore();
const { t } = useI18n();
const { submitDraft: runDraftSubmit, acceptSubmittedNode: acceptSubmittedDraft, clearSubmittedDraft } = useDraftSubmit();
type RenderNode = Node & { dimensions?: Dimensions; handleBounds?: FlowNode["handleBounds"] };
const nodes = shallowRef<RenderNode[]>([]);
const edges = shallowRef<Edge[]>([]);
const flow = shallowRef<VueFlowStore>();
// Vue Flow updates computedPosition in mounted node components only. Keep
// offscreen nodes in sync too, so visibility checks and edges use the new layout.
watch(nodes, items => {
  for (const node of items) {
    const rendered = flow.value?.findNode(node.id);
    if (rendered && (rendered.computedPosition.x !== node.position.x || rendered.computedPosition.y !== node.position.y)) {
      rendered.computedPosition = { ...rendered.computedPosition, ...node.position };
    }
  }
}, { flush: "post" });
// Keep manual coordinates separate from temporary draft layout positions.
const dragged = new Map<string, ManualPosition>();
// Sessions remember where they were left: manual card positions, measured card
// sizes, and the pane viewport come back unchanged on return instead of
// re-centering. Sizes matter because only visible cards ever measure — without
// them the return would re-stack the lanes from the flat estimate pitch.
const rememberedLayouts = new Map<string, Map<string, ManualPosition>>();
const rememberedDimensions = new Map<string, Map<string, Dimensions>>();
const rememberedViewports = new Map<string, ViewportTransform>();
// Holding the branch modifier at any point of a drag carries the cards after it too.
let dragFollowsBranch = false;
let transientNodeIds = new Set<string>();
const draftParent = ref<string | null>();
const branchOrder = new Map<string, number>();
const preparingSession = computed(() => session.creating || session.creation?.status === "failed");
const sessionKey = computed(() => JSON.stringify([session.activeProjectId,
  preparingSession.value ? "creating" : session.current?.session.path,
  preparingSession.value ? undefined : session.current?.session.id]));
let creatingDraft: string | undefined;
let orderSequence = 0;
let draftOrder = 0;
const emptyDraft = (): ComposerDraft => ({ text: "", images: [], busy: false, readingImages: false, error: "" });
// Survives viewport unmounts, including attachment reads and failed submissions.
const draftState = ref(emptyDraft());
const draftModel = ref<RuntimeModel | null>();
// Local picks and model-driven clamps override the inherited level for this draft.
const draftThinking = ref<string>();
let activeSession: string | undefined;
const readableZoom = 0.9;
// Draft size before Vue Flow measures it, and the vertical slot the layout
// reserves for it: a draft growing past the slot overlays the cards below
// instead of shoving them around on every keystroke.
const DRAFT_SIZE = { width: 440, height: 320 };
const booted = ref(false);
const deleteError = ref("");
const reopenError = ref("");
const graphFilter = ref<GraphFilter>("all");
const filterIds = computed(() => graphFilterIds(projection.value?.nodes ?? [], graphFilter.value));
const filterCount = computed(() => (projection.value?.nodes ?? []).filter(node => matchesGraphFilter(node, graphFilter.value)).length);
const labelTarget = ref<{ entryId: string; path: string }>();
const labelText = ref("");
const labelError = ref("");
const labelSaving = ref(false);
const labelShortcut = computed(() => shortcutBindings("editLabel", layout.settings?.app.keyboardShortcuts)
  .map(binding => formatShortcut(binding, isMac())).join(" / "));
function labelKeydown(event: KeyboardEvent) {
  if (layout.screen !== "workbench" || shortcutForEvent(event, layout.settings?.app.keyboardShortcuts) !== "editLabel") return;
  const node = session.selectedNode;
  if (!node || !canEditLabel(node)) return;
  event.preventDefault();
  editLabel(node);
}
onMounted(() => window.addEventListener("keydown", labelKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", labelKeydown));
function canEditLabel(node: GraphNode) {
  const current = session.current;
  return Boolean(current?.runtime.available && !node.running && !(current.graph
    ? current.graph.runs.some(run => run.branchId === (node.branchId ?? "main") && run.status === "running")
    : current.runtime.isStreaming || session.pendingPrompt));
}
function editLabel(node: GraphNode) {
  if (!session.current || !canEditLabel(node)) return;
  labelTarget.value = { entryId: node.userEntryId, path: session.current.session.path };
  labelText.value = node.label ?? ""; labelError.value = "";
}
async function saveLabel() {
  const target = labelTarget.value;
  if (!target || labelSaving.value || target.path !== session.current?.session.path) return;
  labelSaving.value = true; labelError.value = "";
  try {
    await session.control({ action: "setLabel", entryId: target.entryId, label: labelText.value });
    if (labelTarget.value === target) labelTarget.value = undefined;
  } catch (error) { labelError.value = String(error instanceof Error ? error.message : error); }
  finally { labelSaving.value = false; }
}
watch(sessionKey, () => { labelTarget.value = undefined; graphFilter.value = "all"; });
const searchOpen = ref(false);
const searchQuery = ref("");
// A plain click highlights a card without rebinding the chat panel — only a
// double-click, a Ctrl gesture, or a submission moves panel content. The card
// lives in the session store, so commands on "the selected node" follow it.
watch(() => session.focusedNode, () => { session.highlightedNode = null; });
const searchInput = ref<HTMLInputElement>();
// -1 = no hit visited yet, so the first Enter lands on the first hit.
const searchPosition = ref(-1);
const reopeningSession = ref(false);
const sessionNeedsRecovery = computed(() => Boolean(session.current?.graph?.storageError && !session.current.runtime.available));
watch(() => session.current?.session.path, () => { deleteError.value = ""; reopenError.value = ""; });
const promptCache = new Map<string, PromptNodeData>();
function stablePrompt(data: PromptNodeData) {
  const previous = promptCache.get(data.node.id);
  if (previous && (Object.keys(data) as Array<keyof PromptNodeData>).every(key =>
    data[key] === previous[key] || (typeof data[key] === "function" && typeof previous[key] === "function"))) return previous;
  const raw = markRaw(data);
  promptCache.set(data.node.id, raw);
  return raw;
}
// Auto (pre-manual) positions from the last rebuild: measured-size based and
// restricted to real nodes, so draft open/close never invalidates manual slots.
let autoPositions: Map<string, { x: number; y: number; width: number; height: number }> | undefined;

const projection = computed(() => preparingSession.value ? projectSession([], null) : session.current?.projection);
const searchHits = computed<string[]>(() => {
  const value = projection.value;
  if (!searchOpen.value || !value || !session.current) return [];
  const matched = new Set(value.nodes.filter(node => matchesGraphFilter(node, graphFilter.value)).map(node => node.id));
  return searchGraphNodeIds(value, session.current.entries, searchQuery.value).filter(id => matched.has(id));
});
const searchHitIds = computed(() => new Set(searchHits.value));
const searchCount = computed(() => {
  if (!searchOpen.value || !searchQuery.value.trim()) return "";
  const n = searchHits.value.length;
  if (!n) return t("graph.searchNoHits");
  return n === 1 ? t("graph.searchHitOne") : t("graph.searchHits", { n });
});
function rememberBranchOrder(id: string, order: number | undefined, pendingId?: string) {
  if (branchOrder.get(id) === order && (!pendingId || !branchOrder.has(pendingId))) return;
  if (pendingId) branchOrder.delete(pendingId);
  if (order === undefined) branchOrder.delete(id);
  else branchOrder.set(id, order);
  (layout.layout.branchOrders ??= {})[sessionKey.value] = [...branchOrder];
  void layout.save().catch(error => layout.showNotice(String(error), "error"));
}
const filteredGraph = computed(() => {
  if (graphFilter.value === "all") return { nodes: nodes.value, edges: edges.value };
  const visible = new Set(filterIds.value);
  const byId = new Map(nodes.value.map(node => [node.id, node]));
  // Preserve an open draft and its path even when its parent doesn't match.
  for (const node of nodes.value) if (node.type === "draft" || transientNodeIds.has(node.id)) {
    visible.add(node.id);
    let parent = node.type === "draft" ? draftParent.value : node.data?.node?.parentId;
    while (parent && !visible.has(parent)) {
      visible.add(parent); parent = byId.get(parent)?.data?.node?.parentId;
    }
  }
  return { nodes: nodes.value.filter(node => visible.has(node.id)),
    edges: edges.value.filter(edge => visible.has(edge.source) && visible.has(edge.target)) };
});
const renderGraph = computed(() => {
  const nodes = filteredGraph.value.nodes, edges = filteredGraph.value.edges;
  if (nodes.length < 500) return { nodes, edges };
  if (!flow.value) return { nodes: nodes.filter(node => node.id === defaultFocusId()), edges: [] };
  const viewport = flow.value.getViewport();
  const size = flow.value.dimensions.value;
  const targets = new Set(nodes.filter(node => {
    const x = node.position.x * viewport.zoom + viewport.x;
    const y = node.position.y * viewport.zoom + viewport.y;
    return x < size.width + 100 && x + 360 * viewport.zoom > -100
      && y < size.height + 100 && y + 280 * viewport.zoom > -100;
  }).map(node => node.id));
  // A wide fork can have thousands of curves starting at one visible parent.
  // Keep incoming connections to visible cards; the overview shows the full tree.
  const visibleEdges = edges.filter(edge => targets.has(edge.target));
  const included = new Set(targets);
  for (const edge of visibleEdges) included.add(edge.source);
  return { nodes: nodes.filter(node => included.has(node.id)), edges: visibleEdges };
});

// Continue with the parent's level; saved preferences only fill missing settings.
function inheritThinking(parentId: string | null | undefined): string {
  const parent = parentId ? projection.value?.nodes.find((item) => item.id === parentId) : undefined;
  return parent?.footer?.thinkingLevel
    ?? session.userThinking
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
    creatingDraft = undefined;
    nodes.value = [];
    edges.value = [];
    return;
  }
  if (session.highlightedNode && !value.nodes.some(node => node.id === session.highlightedNode)) session.highlightedNode = null;
  let restoredLayout: Map<string, ManualPosition> | undefined;
  let restoredSizes: Map<string, Dimensions> | undefined;
  if (activeSession !== sessionKey.value) {
    const adoptDraft = creatingDraft === session.activeProjectId && session.creation?.status === "ready"
      && session.current?.session.path === session.creation.path;
    creatingDraft = preparingSession.value ? session.activeProjectId : undefined;
    dragged.clear();
    restoredLayout = rememberedLayouts.get(sessionKey.value);
    restoredSizes = rememberedDimensions.get(sessionKey.value);
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
    promptCache.clear();
    activeSession = sessionKey.value;
    if (!adoptDraft) draftState.value = emptyDraft();
    draftParent.value = undefined;
    if (!adoptDraft) {
      draftModel.value = undefined;
      draftThinking.value = undefined;
    }
    clearSubmittedDraft();
    deleteError.value = "";
  }
  if (draftParent.value && !value.nodes.some(node => node.id === draftParent.value)) resetDraft();
  // The same submission changes ids as admission and the real turn arrive.
  for (const run of session.current?.graph?.runs ?? []) {
    const pendingId = `pending:${run.runId}`;
    const submittedId = run.requestId ? `pending:${run.requestId}` : pendingId;
    const from = branchOrder.has(pendingId) ? pendingId : submittedId;
    const order = branchOrder.get(from);
    const to = run.nodeId ?? pendingId;
    if (order !== undefined) {
      // A failed preflight can still report the existing source node.
      const failedBeforeTurn = run.error && run.nodeId && nodes.value.some(node => node.id === run.nodeId);
      if (failedBeforeTurn || (!run.nodeId && run.status !== "running")) rememberBranchOrder(from, undefined);
      else if (to !== from) rememberBranchOrder(to, order, from);
    }
  }
  const previousNodes = new Map(nodes.value.map(node => [node.id, node]));
  // Settled positions use the same measured card sizes the pane renders, so
  // lanes track real heights instead of the fixed 280×146 estimate pitch.
  // Unmeasured nodes keep the estimate until Vue Flow reports dimensions; a
  // returning session starts from the sizes it left with.
  const sizes = new Map(value.nodes.map(n => [n.id, previousNodes.get(n.id)?.dimensions ?? restoredSizes?.get(n.id) ?? { width: 320, height: 146 }]));
  const calculated = layoutGraph(value, sizes, branchOrder);
  const positions = new Map(calculated.nodes.map(n => [n.id, { x: n.x, y: n.y, width: n.width, height: n.height }]));
  const removed = autoPositions && [...autoPositions.keys()].some(id => !positions.has(id));
  // Only deletions invalidate moved manual slots to close gaps. Adding a
  // branch must preserve the user's coordinates even when its auto slots move.
  // Transient cards (composer, pending) are never in the projection, so they keep a
  // slot made for them until they leave the screen.
  for (const id of dragged.keys()) {
    const before = autoPositions?.get(id);
    const after = positions.get(id);
    if (!after && !before && nodes.value.some(node => node.id === id)) continue;
    if (!before || !after || (removed && (before.x !== after.x || before.y !== after.y))) dragged.delete(id);
  }
  autoPositions = positions;
  // Returning to a session resumes the manual arrangement saved on leaving;
  // only nodes still present here can carry their remembered slot.
  if (restoredLayout) for (const [id, position] of restoredLayout) if (positions.has(id)) dragged.set(id, position);
  const placed = { nodes: value.nodes.map(node => ({ ...node, ...positions.get(node.id)!,
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
  const turns: Node<PromptNodeData>[] = placed.nodes.map((node, index) => ({
    id: node.id,
    type: "prompt",
    position: { x: node.x, y: node.y },
    data: stablePrompt({
      node: value.nodes[index]!,
      active: active.has(node.id),
      current: value.activeNodeId === node.id,
      runnable: Boolean(session.current?.runtime.available && !busy && node.forkable !== false),
      running: node.running,
      blockedReason: busy
        ? "graph.blockedStreaming"
        : "graph.blockedReadonly",
      content: () => nodeContent(node.id),
      activity: () => session.activityFor(node.id),
      searchHit: searchHitIds.value.has(node.id),
      filterContext: !matchesGraphFilter(node, graphFilter.value),
      onEditLabel: canEditLabel(node) ? () => editLabel(node) : undefined,
      editLabelShortcut: labelShortcut.value,
      onCompose: direction => compose(node.id, direction),
      onOpenPanel: session.current?.graph ? () => openChatColumn(node.id) : undefined,
      onRetry: node.hasError && Boolean(session.current?.runtime.available && !busy && node.forkable !== false)
        ? () => { void retryTurn(node.id); }
        : undefined,
      onExportSession: session.current?.graph ? () => { void exportSession(node.id); } : undefined,
      // The export target is the node the chat panel shows: that node becomes
      // the new session's tip and everything after it stays in the original
      // graph. The chat column follows focusedNode, while the projection's
      // activeNodeId is only the main branch's cursor, so the viewed id stays a
      // live getter: focus moves never rebuild the cards.
      viewedNodeId: session.current?.graph
        ? () => session.focusedNode && !session.focusedNode.startsWith("pending:")
          ? session.focusedNode : session.current?.projection.activeNodeId ?? null
        : undefined,
      exportBlockedReason: node.running
        ? "graph.blockedStreaming"
        : !session.current?.runtime.available ? "graph.blockedReadonly" : undefined,
      onDelete: () => { void deleteNode(node.id); },
      deleteBlockedReason: session.deleteBlockedReason,
    }),
  }));
  const rootDraft = !placed.nodes.length;
  if (rootDraft) draftParent.value = null;
  // Graph branches own their submission state. Only the automatic root editor
  // (or a single-runtime session) follows sends from other input surfaces.
  const draftSending = Boolean(draftState.value.busy || (!preparingSession.value && (
    ((rootDraft || !session.current?.graph) && session.pendingPrompt)
    || (rootDraft && session.current?.graph?.runs.some(run => run.status === "running" && run.pending)))));
  // The submitted prompt renders as a result-shaped node showing the agent at
  // work until the real node arrives with the settled snapshot.
  const pendingTurns = (preparingSession.value ? [] : session.currentPendingPrompts).filter(pending =>
    !pending.requestId || !session.current?.graph?.runs.some(run => run.requestId === pending.requestId)
  ).map((pending): Node<PromptNodeData> => {
    const pendingParent = pending.targetNodeId ? placed.nodes.find(node => node.id === pending.targetNodeId) : undefined;
    const pendingSiblings = pendingParent ? children.get(pendingParent.id) ?? [] : [];
    return {
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
        running: true,
        runnable: false,
        blockedReason: "graph.blockedStreaming",
        content: () => ({ user: pending.message.text, images: pending.message.images, assistant: t("graph.agentRunning") }),
        onCompose: () => {},
      },
    };
  });
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
    // Keep the editor mounted for failure recovery, but hidden through both
    // the local submission and the server's pending-to-real-node handoff.
    style: { visibility: draftSending ? "hidden" : "visible", pointerEvents: draftSending ? "none" : "auto" },
    position: parent
      ? { x: parent.x + parent.width + 92, y: siblings.length ? Math.max(...siblings.map((node) => node.y)) + 178 : parent.y }
      : { x: 48, y: 48 },
    data: {
      draftState: draftState.value,
      parentId: parent?.id ?? null,
      runnable: !preparingSession.value && Boolean(session.current?.runtime.available),
      initializing: session.creating,
      creationError: session.creation?.status === "failed" ? session.creation.error : undefined,
      onRetry: session.creation?.status === "failed" ? () => {
        void session.create().catch(error => layout.showNotice(String(error), "error"));
      } : undefined,
      model,
      thinkingLevel,
      models: session.models,
      onModel: (next: RuntimeModel) => {
        draftModel.value = next;
        if (next.reasoning === false) draftThinking.value = "off";
        void session.setDefaultModel(next);
        rebuild();
      },
      onThinking: (level: string, explicit: boolean) => {
        if (explicit) session.setUserThinking(level);
        draftThinking.value = level;
        rebuild();
      },
      onCancel: parent ? cancelDraft : undefined,
      onSubmit: submitDraft,
    },
  } : undefined;
  const nextNodes: RenderNode[] = [...turns, ...pendingTurns, ...(draft ? [draft] : [])];
  const nextEdges: Edge[] = value.edges.map((edge) => ({
    ...edge,
    class: "",
  }));
  for (const pending of pendingTurns)
    if (pending.data!.node.parentId && positions.has(pending.data!.node.parentId))
      nextEdges.push({ id: `edge:${pending.id}`, source: pending.data!.node.parentId, target: pending.id, class: "draft-edge", animated: true });
  if (parent && draft && !draftSending) nextEdges.push({ id: `edge:${draftId}`, source: parent.id, target: draftId, class: "draft-edge", animated: true });
  const pendingRows = new Map<string | null, number>();
  for (const run of preparingSession.value ? [] : session.current?.graph?.runs ?? []) {
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
      data: { node, active: true, current: false, running: true, runnable: false,
        activity: () => session.activityFor(id),
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
        : previous?.dimensions ?? restoredSizes?.get(node.id) ?? (node.type === "draft" ? DRAFT_SIZE : { width: 320, height: 146 }),
      handleBounds: existing?.handleBounds.source?.length ? existing.handleBounds : previous?.handleBounds ?? {
        source: [{ type: "source", nodeId: node.id, position: "right", x: 316, y: 69, width: 8, height: 8 }],
        target: [{ type: "target", nodeId: node.id, position: "left", x: -4, y: 69, width: 8, height: 8 }],
      },
    });
  }
  transientNodeIds = new Set(nextNodes.slice(turns.length).map(node => node.id));
  layoutBranches(nextNodes);
  const stableNodes = nextNodes.map(node => {
    const previous = previousNodes.get(node.id);
    return previous && previous.type === node.type && previous.data === node.data
      && previous.position.x === node.position.x && previous.position.y === node.position.y ? previous : node;
  });
  if (stableNodes.length !== nodes.value.length || stableNodes.some((node, i) => node !== nodes.value[i])) nodes.value = stableNodes;
  if (nextEdges.length !== edges.value.length || nextEdges.some((edge, i) => {
    const old = edges.value[i];
    return !old || edge.id !== old.id || edge.source !== old.source || edge.target !== old.target || edge.class !== old.class || edge.animated !== old.animated;
  })) edges.value = nextEdges;
  const ids = new Set(nodes.value.map(node => node.id));
  for (const id of promptCache.keys()) if (!ids.has(id)) promptCache.delete(id);
}

function layoutBranches(items: RenderNode[]) {
  // Runs on every rebuild and resize so settled lanes follow measured card
  // heights; transients reserve vertical space but never widen columns, and a
  // draft's reservation is capped at its opening slot so growth only overlays.
  const visible = items.filter(node => typeof node.style === "function" || node.style?.visibility !== "hidden");
  const depths = new Map(projection.value?.nodes.map(node => [node.id, node.depth]));
  const tree = visible.map(node => node.type === "draft"
    ? { id: node.id, parentId: node.data.parentId, timestamp: "\uffff", depth: (depths.get(node.data.parentId) ?? -1) + 1 }
    : { ...node.data.node, timestamp: transientNodeIds.has(node.id) ? "\uffff" : node.data.node.timestamp });
  const order = new Map(branchOrder);
  if (draftParent.value !== undefined) order.set(draftParent.value ? `draft:${draftParent.value}` : "draft:root", draftOrder);
  const pending = !session.current?.graph && session.pendingPrompt;
  if (pending && pending.targetNodeId === draftParent.value) order.set(pending.message.entryId, draftOrder);
  const placed = layoutGraph({ nodes: tree }, new Map(visible.map(node => [node.id, node.type === "draft"
    ? { width: node.dimensions!.width, height: DRAFT_SIZE.height }
    : node.dimensions!])), order, transientNodeIds);
  // Cards that were not on screen yet may be moved out of a pinned card's way;
  // the ones the user can already see keep the position they have.
  const known = new Set(nodes.value.map(node => node.id));
  // A card that made way for a pin is held there, so the next rebuild cannot drop
  // it back on top of the pin it just cleared.
  for (const [id, position] of reserveManualPositions(placed.nodes, dragged, new Set(visible.filter(node => !known.has(node.id)).map(node => node.id))))
    dragged.set(id, position);
  let moved = false;
  for (let i = 0; i < visible.length; i++) {
    const node = visible[i]!, position = placed.nodes[i]!;
    if (node.position.x === position.x && node.position.y === position.y) continue;
    node.position = { x: position.x, y: position.y };
    moved = true;
  }
  return moved;
}

let selectionRequest = 0;
let centerRequest = 0;
onBeforeUnmount(() => { selectionRequest++; centerRequest++; flow.value = undefined; });

async function select(id: string, openChat = false) {
  if (id.startsWith("draft:") || (id.startsWith("pending:") && !session.current?.graph)) return;
  const request = ++selectionRequest;
  centerRequest++;
  const current = session.current?.session.path;
  await session.selectNode(id);
  const openingChat = openChat && layout.layout.collapsed.chat;
  if (openingChat) {
    void layout.setCollapsed("chat", false);
    await nextTick();
    await whenTransitionsSettle(isPanelElement);
  }
  if (request !== selectionRequest || current !== session.current?.session.path || session.focusedNode !== id) return;
  if (!focusNodeVisible()) await center(id, false, false);
}

async function deleteNode(id: string) {
  deleteError.value = "";
  try {
    await session.deleteNode(id);
    rebuild();
    await center(defaultFocusId());
  } catch (error) { deleteError.value = String(error); }
}

async function exportSession(id: string) {
  try {
    const result = await session.exportBranchSession(id);
    if (result?.path) layout.showNotice(t("notice.exportedTo", { path: result.path }));
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  }
}

async function reopenSession() {
  const path = session.current?.session.path;
  if (!path || reopeningSession.value) return;
  reopeningSession.value = true;
  deleteError.value = "";
  reopenError.value = "";
  try { await session.open(path); }
  catch (error) { reopenError.value = String(error); }
  finally { reopeningSession.value = false; }
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

// Retry reopens the failed turn's prompt as a draft attached to its parent, so
// submitting grows a sibling branch and the failed turn stays untouched. A
// failed root turn has no earlier parent; its draft attaches to itself, which
// continues that branch — the failure remains visible in the history either way.
async function retryTurn(id: string) {
  const node = projection.value?.nodes.find((item) => item.id === id);
  if (!node) return;
  const content = nodeContent(id);
  if (!content.user.trim() && !content.images?.length) return;
  const parent = node.parentId ?? node.id;
  const parentNode = projection.value?.nodes.find((item) => item.id === parent);
  resetDraft();
  draftParent.value = parent;
  draftModel.value = node.footer?.model ?? parentNode?.footer?.model ?? session.current?.runtime.model ?? null;
  draftThinking.value = undefined;
  draftState.value = { ...emptyDraft(), text: content.user, images: [...(content.images ?? [])] };
  rebuild();
  await center(`draft:${parent}`, true);
}

async function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  if (!searchOpen.value) {
    searchQuery.value = "";
    searchPosition.value = -1;
  } else {
    await nextTick();
    searchInput.value?.focus({ preventScroll: true });
  }
}

async function stepSearch(back: boolean) {
  const hits = searchHits.value;
  if (!hits.length) return;
  searchPosition.value = (searchPosition.value + (back ? -1 : 1) + hits.length) % hits.length;
  await select(hits[searchPosition.value]!, true);
}

watch(searchQuery, () => { searchPosition.value = -1; });

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
  const targetDraft = draftState.value;
  const requestId = order && session.current?.graph ? crypto.randomUUID() : undefined;
  if (requestId && order) rememberBranchOrder(`pending:${requestId}`, order);
  const delivered = await runDraftSubmit(
    draftParent.value ?? null,
    text,
    draftModel.value,
    draftThinking.value ?? inheritThinking(draftParent.value),
    images,
    requestId ? { requestId } : undefined,
  );
  if (!delivered) {
    if (requestId && targetSession === sessionKey.value) rememberBranchOrder(`pending:${requestId}`, undefined);
    return false;
  }
  if (targetSession !== sessionKey.value) return true;
  if (delivered.nodeId && order) rememberBranchOrder(delivered.nodeId, order, requestId ? `pending:${requestId}` : undefined);
  if (targetDraft !== draftState.value) {
    rebuild();
    return true;
  }
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

// One click discards every manual slot: the automatic layout then puts each
// branch back into its own lane, and the current card comes back into view.
async function tidy() {
  dragged.clear();
  rebuild();
  await center(defaultFocusId(), true);
}

function defaultFocusId() {
  const value = projection.value;
  if (!value) return undefined;
  if (value.nodes.length) return session.focusedNode ?? value.activeNodeId;
  return session.pendingPrompt?.message.entryId ?? "draft:root";
}

const isPanelElement = (target: Element) => target.matches(".workbench-splitter > [data-panel], .navigator-container");

async function center(id = defaultFocusId(), ensureReadable = false, animate = true) {
  const request = ++centerRequest;
  if (!flow.value || !id) return;
  await nextTick();
  await nextFrame();
  if (ensureReadable) await whenTransitionsSettle(isPanelElement);
  if (request !== centerRequest || !flow.value) return;
  const node = flow.value.findNode(id);
  const cached = nodes.value.find(node => node.id === id);
  const position = node?.computedPosition ?? cached?.position;
  // Large graphs remove offscreen nodes from Vue Flow. Retain their measured
  // size when centering, rather than falling back to an inaccurate card estimate.
  const size = node?.dimensions ?? cached?.dimensions;
  if (!position) return;
  const zoom = flow.value.getViewport().zoom;
  const viewport = flow.value.getViewport();
  const pane = flow.value.dimensions.value;
  const distant = Math.hypot(position.x * zoom + viewport.x - pane.width / 2,
    position.y * zoom + viewport.y - pane.height / 2) > Math.hypot(pane.width, pane.height) * 2;
  await flow.value.setCenter(
    position.x + (size?.width || (id.startsWith("draft:") ? DRAFT_SIZE.width : 320)) / 2,
    position.y + (size?.height || (id.startsWith("draft:") ? DRAFT_SIZE.height : 146)) / 2,
    // D3's zoom interpolation zooms far out between distant nodes, transiently
    // mounting thousands of cards. Jump directly across large branches.
    { zoom: ensureReadable ? Math.max(zoom, readableZoom) : zoom, duration: animate && !distant ? 280 : 0 },
  );
  if (request !== centerRequest) return;
  if (id.startsWith("draft:"))
    document.querySelector<HTMLTextAreaElement>(".draft-node textarea")?.focus({ preventScroll: true });
}

watch(graphFilter, async mode => {
  if (mode === "all") return;
  const target = projection.value?.nodes.find(node => matchesGraphFilter(node, mode));
  if (target) await center(target.id, true, false);
}, { flush: "post" });

// A session switch resumes that session's remembered viewport instead of
// re-centering; sessions seen for the first time still focus their active node.
async function restoreView() {
  const saved = rememberedViewports.get(sessionKey.value);
  if (!saved) {
    void center(defaultFocusId(), true);
    return;
  }
  // Cancel any in-flight centering so it cannot override the restore. A 1ms
  // transition is visually instant, but it interrupts a running 280ms center
  // animation (d3 same-name transitions), so the restore is the final word.
  const request = ++centerRequest;
  await nextTick();
  if (request !== centerRequest || !flow.value) return;
  await flow.value.setViewport(saved, { duration: 1 });
}

// The minimap colors nodes by the same running flag the pane cards use.
// Only prompt nodes carry the flag, so gate on the node type: draft nodes
// must never light up even if DraftNodeData grows a running field someday.
// Amber --running contrasts with the blue/green accent nodes around it.
function minimapNodeRunning(node: FlowNode) {
  return node.type === "prompt" && (node.data as PromptNodeData | undefined)?.running === true;
}

function minimapNodeColor(node: FlowNode) {
  return minimapNodeRunning(node) ? "var(--running)" : "var(--accent)";
}

function navigateMinimap({ position }: { position: { x: number; y: number } }) {
  centerRequest++;
  if (!flow.value) return;
  // MiniMap emits graph coordinates, but pannable only wires dragging, not
  // click-to-navigate. Jump without a zoom animation, as GraphOverview does.
  void flow.value.setCenter(position.x, position.y, { zoom: flow.value.getViewport().zoom });
}

function focusNodeVisible(id = defaultFocusId()) {
  if (!id || !flow.value) return true;
  const node = flow.value.findNode(id);
  const cached = nodes.value.find(node => node.id === id);
  const position = node?.computedPosition ?? cached?.position;
  const size = node?.dimensions ?? cached?.dimensions;
  if (!position || !size?.width || !size.height) return false;
  const viewport = flow.value.getViewport();
  const pane = flow.value.dimensions.value;
  const left = position.x * viewport.zoom + viewport.x;
  const top = position.y * viewport.zoom + viewport.y;
  const right = left + size.width * viewport.zoom;
  const bottom = top + size.height * viewport.zoom;
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
    // A remount (project switch) re-enters the remembered viewport instead of
    // resetting to the active node; first views still center on it.
    const remembered = rememberedViewports.get(sessionKey.value);
    if (remembered) await store.setViewport(remembered);
    else await center(defaultFocusId(), true, false);
  } finally {
    booted.value = true;
  }
}

function holdsBranchModifier(event: NodeMouseEvent) {
  return Boolean((event as { event?: { shiftKey?: boolean } }).event?.shiftKey);
}

// Ctrl/Cmd held through a double-click pins the node into a side column.
function holdsPanelModifier(event: NodeMouseEvent) {
  const raw = (event as { event?: { ctrlKey?: boolean; metaKey?: boolean } }).event;
  return Boolean(raw?.ctrlKey || raw?.metaKey);
}

function openChatColumn(id: string) {
  if (id.startsWith("draft:") || id.startsWith("pending:") || !session.current?.graph) return;
  // One panel per branch: a column pinned to another node on the same
  // root-to-node path shows a subset of this node's history, so retarget it
  // instead of opening a redundant column beside it.
  const parents = new Map(session.current.projection.nodes.map(node => [node.id, node.parentId ?? null]));
  const onPath = (from: string, onto: string) => {
    for (let cur: string | null = from; cur; cur = parents.get(cur) ?? null)
      if (cur === onto) return true;
    return false;
  };
  const clash = layout.chatColumns.find(pinned => pinned !== id && (onPath(id, pinned) || onPath(pinned, id)));
  if (clash) {
    layout.advanceChatColumn(clash, id);
    void layout.setCollapsed("chat", false);
  } else {
    void layout.openChatColumn(id);
  }
}

function nodeClicked(event: NodeMouseEvent) {
  // Any single click, Ctrl held or not, only highlights — the Ctrl gesture
  // for side columns lives on the double-click.
  session.highlightedNode = event.node.id;
  if (!focusNodeVisible(event.node.id)) void center(event.node.id, false, false);
}

// A plain double-click reveals the node in the primary chat panel; holding
// Ctrl pins it into a side column instead.
function nodeDoubleClicked(event: NodeMouseEvent) {
  if (holdsPanelModifier(event)) openChatColumn(event.node.id);
  else void select(event.node.id, true);
}

function startDrag(event: NodeMouseEvent) {
  dragFollowsBranch = holdsBranchModifier(event);
}

function trackDrag(event: NodeMouseEvent) {
  if (holdsBranchModifier(event)) dragFollowsBranch = true;
  // Rebuilds and measurements during a drag must use the current pointer position.
  dragged.set(event.node.id, { ...event.node.position, branch: dragFollowsBranch });
  const node = nodes.value.find(node => node.id === event.node.id);
  if (node) node.position = { ...event.node.position };
}

function rememberDrag(event: NodeMouseEvent) {
  trackDrag(event);
  dragFollowsBranch = false;
  // Lay out from the drop at once, so a branch dragged along moves with its card
  // instead of following on some later rebuild.
  layoutBranches(nodes.value);
  nodes.value = [...nodes.value];
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
  [() => sessionKey.value, () => session.creation, () => projection.value?.nodes, () => projection.value?.edges,
    () => projection.value?.activeBranchNodeIds, () => projection.value?.activeNodeId,
    () => session.current?.runtime.available, () => !session.current?.graph && session.current?.runtime.isStreaming,
    () => session.models, () => draftParent.value, () => draftState.value.busy,
    () => session.currentPendingPrompts, () => session.deleteBlockedReason, pendingRuns,
    searchHitIds, graphFilter, labelShortcut],
  () => {
    if (!session.current && !preparingSession.value) booted.value = false;
    const changedSession = activeSession !== sessionKey.value;
    // Stash the outgoing session's arrangement and pane position before the
    // rebuild resets per-session state. A teardown (no projection) clears the
    // cards without adopting a new session, so the next fire must not overwrite
    // the good snapshot with the torn-down state; rendered sessions always
    // carry at least the draft card, so empty means torn down.
    if (changedSession && activeSession !== undefined && nodes.value.length) {
      const viewport = flow.value?.getViewport();
      if (viewport) rememberedViewports.set(activeSession, viewport);
      rememberedLayouts.set(activeSession, new Map(dragged));
      rememberedDimensions.set(activeSession, new Map(nodes.value
        .filter(node => node.dimensions?.width)
        .map(node => [node.id, node.dimensions!])));
    }
    const submittedNode = acceptSubmittedNode();
    rebuild();
    if (submittedNode) void center(submittedNode, true);
    else if (changedSession) void restoreView();
  },
  { immediate: true },
);

</script>

<template>
  <main class="panel graph-panel">
    <div v-if="deleteError || reopenError || sessionNeedsRecovery" class="graph-delete-error" role="alert">
      {{ t(deleteError ? 'graph.deleteFailed' : 'graph.recoveryNeeded', { error: deleteError || reopenError || session.current?.graph?.storageError }) }}
      <Button v-if="sessionNeedsRecovery" data-action="node-delete-recover" variant="outline" :disabled="reopeningSession" @click="reopenSession">
        {{ t('graph.reopenSession') }}
      </Button>
    </div>
    <div v-if="!session.current && !preparingSession" class="graph-empty">
      <div aria-hidden="true"><Network :size="64" :stroke-width="1.6" /></div>
      <span>
        {{ t("graph.empty") }}
      </span>
      <Button :disabled="session.loading" :aria-busy="session.loading" @click="emit('newSession')">
        {{ t(session.loading ? "graph.startingSession" : "graph.newSession") }}
      </Button>
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
      :delete-key-code="null"
      @pane-ready="ready"
      @node-click="nodeClicked"
      @node-double-click="nodeDoubleClicked"
      @node-drag-start="startDrag"
      @node-drag="trackDrag"
      @node-drag-stop="rememberDrag"
      @nodes-change="syncNodeDimensions"
    >
      <template #node-prompt="props">
        <!-- Selection is presentation state; changing it must not call Vue Flow's setNodes. -->
        <PromptNode v-bind="props" :selected="(session.highlightedNode || session.focusedNode) === props.id" />
      </template>
      <template #node-draft="props">
        <DraftNode v-bind="props" />
      </template>
      <MiniMap
        v-if="layout.layout.minimap && nodes.length < 500"
        pannable
        zoomable
        :node-color="minimapNodeColor"
        mask-color="color-mix(in srgb, var(--surface) 72%, transparent)"
        :aria-label="t('graph.minimapLabel')"
        @click="navigateMinimap"
      />
      <GraphOverview v-if="layout.layout.minimap && nodes.length >= 500" :nodes="filteredGraph.nodes" :highlight="searchHitIds.size ? searchHitIds : undefined" />
    </VueFlow>

    <p v-if="graphFilter !== 'all' && !filterCount" class="graph-filter-empty" role="status">{{ t("graph.filterEmpty") }}</p>
    <nav class="graph-controls">
      <select v-model="graphFilter" data-action="graph-filter" :aria-label="t('graph.filterLabel')" class="graph-filter">
        <option v-for="mode in GRAPH_FILTERS" :key="mode" :value="mode">{{ t(`graph.filters.${mode}`) }}</option>
      </select>
      <div v-if="searchOpen" class="graph-search nodrag nowheel" @mousedown.stop @wheel.stop>
        <input
          ref="searchInput"
          v-model="searchQuery"
          type="text"
          data-action="graph-search-input"
          :placeholder="t('graph.searchPlaceholder')"
          :title="t('graph.searchNavigate')"
          @keydown.enter.prevent="stepSearch($event.shiftKey)"
          @keydown.esc.stop.prevent="toggleSearch"
        />
        <span class="graph-search-count">{{ searchCount }}</span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        :aria-expanded="searchOpen"
        :aria-label="t('graph.searchLabel')"
        :title="t('graph.searchLabel')"
        @click="toggleSearch"
      ><Search :size="15" /></Button>
      <Button
        variant="ghost"
        size="icon"
        :aria-pressed="layout.layout.minimap"
        :aria-label="t('graph.toggleMinimap')"
        :title="t('graph.toggleMinimap')"
        @click="layout.toggleMinimap()"
      ><MapIcon :size="15" /></Button>
      <Button variant="ghost" size="icon" :aria-label="t('graph.tidyLayout')" :title="t('graph.tidyLayout')" @click="tidy()"><Focus :size="15" /></Button>
    </nav>

    <footer class="graph-footer">
      <span v-if="graphFilter !== 'all'">{{ t("graph.filterCount", { n: filterCount }) }}</span>
      <span>{{ t("graph.turnsLinks", { turns: projection?.nodes.length ?? 0, links: projection?.edges.length ?? 0 }) }}</span>
      <span>{{ t("graph.activeBranch", { n: projection?.activeBranchNodeIds.length ?? 0 }) }}</span>
      <span v-if="session.current?.graph">{{ t("graph.parallelRuns", { n: session.current.graph.runs.filter(r => r.status === 'running').length }) }}</span>
    </footer>
    <DialogRoot :open="!!labelTarget" @update:open="!$event && !labelSaving && (labelTarget = undefined)">
      <DialogPortal>
        <DialogOverlay class="dialog-overlay" />
        <DialogContent class="rename-dialog" :aria-describedby="undefined" @escape-key-down="labelSaving && $event.preventDefault()" @interact-outside="labelSaving && $event.preventDefault()">
          <DialogTitle>{{ t("graph.editLabel") }}</DialogTitle>
          <form @submit.prevent="saveLabel">
            <input v-model="labelText" data-action="node-label-input" :aria-label="t('graph.editLabel')" maxlength="200" :disabled="labelSaving" />
            <p>{{ t("graph.labelHint") }}</p>
            <p v-if="labelError" role="alert">{{ labelError }}</p>
            <footer>
              <Button type="button" variant="ghost" :disabled="labelSaving" @click="labelTarget = undefined">{{ t("common.cancel") }}</Button>
              <Button type="submit" data-action="node-label-save" :disabled="labelSaving">{{ t("common.save") }}</Button>
            </footer>
          </form>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </main>
</template>
