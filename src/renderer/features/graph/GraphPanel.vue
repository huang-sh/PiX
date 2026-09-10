<script setup lang="ts">
import { Focus, Map as MapIcon, Network } from "@lucide/vue";
import {
  VueFlow,
  type Edge,
  type Dimensions,
  type GraphNode as FlowNode,
  type Node,
  type NodeChange,
  type NodeMouseEvent,
  type VueFlowStore,
} from "@vue-flow/core";
import { MiniMap } from "@vue-flow/minimap";
import GraphOverview from "./GraphOverview.vue";
import { computed, markRaw, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import Button from "../../components/ui/Button.vue";
import type { ComposerDraft } from "../../components/PromptComposer.vue";
import { projectSession, sessionEntryIndex, clipText } from "../../../shared/session";
import { layoutGraph, reserveManualPositions, type BranchDirection, type ManualPosition } from "../../graph-layout";
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
// Holding the branch modifier at any point of a drag carries the cards after it too.
let dragFollowsBranch = false;
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
// Local picks and model-driven clamps override the inherited level for this draft.
const draftThinking = ref<string>();
let activeSession: string | undefined;
const readableZoom = 0.9;
const booted = ref(false);
const deleteError = ref("");
const recoveringDeletion = ref(false);
const deletionNeedsRecovery = computed(() => Boolean(session.current?.graph?.storageError && !session.current.runtime.available));
const promptCache = new Map<string, PromptNodeData>();
function stablePrompt(data: PromptNodeData) {
  const previous = promptCache.get(data.node.id);
  if (previous && (Object.keys(data) as Array<keyof PromptNodeData>).every(key =>
    typeof data[key] === "function" || data[key] === previous[key])) return previous;
  const raw = markRaw(data);
  promptCache.set(data.node.id, raw);
  return raw;
}
// Auto (pre-manual) positions from the last rebuild: measured-size based and
// restricted to real nodes, so draft open/close never invalidates manual slots.
let autoPositions: Map<string, { x: number; y: number; width: number; height: number }> | undefined;

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
    promptCache.clear();
    activeSession = sessionKey.value;
    draftState.value = emptyDraft();
    draftParent.value = undefined;
    draftModel.value = undefined;
    draftThinking.value = undefined;
    clearSubmittedDraft();
    deleteError.value = "";
  }
  if (draftParent.value && !value.nodes.some(node => node.id === draftParent.value)) resetDraft();
  for (const run of session.current?.graph?.runs ?? []) {
    const pendingId = `pending:${run.runId}`;
    const order = branchOrder.get(pendingId);
    if (run.nodeId && order !== undefined) {
      rememberBranchOrder(run.nodeId, order, pendingId);
    }
  }
  const previousNodes = new Map(nodes.value.map(node => [node.id, node]));
  // Settled positions use the same measured card sizes the pane renders, so
  // lanes track real heights instead of the fixed 280×146 estimate pitch.
  // Unmeasured nodes keep the estimate until Vue Flow reports dimensions.
  const sizes = new Map(value.nodes.map(n => [n.id, previousNodes.get(n.id)?.dimensions ?? { width: 280, height: 146 }]));
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
      onCompose: direction => compose(node.id, direction),
      onDelete: () => { void deleteNode(node.id); },
      deleteBlockedReason: session.deleteBlockedReason,
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
        if (explicit) session.setUserThinking(level);
        draftThinking.value = level;
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
      data: { node, active: true, current: false, running: true, runnable: false,
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
  // heights; transients reserve vertical space but never widen columns.
  const visible = items.filter(node => !(node.type === "draft" && session.pendingPrompt));
  const depths = new Map(projection.value?.nodes.map(node => [node.id, node.depth]));
  const tree = visible.map(node => node.type === "draft"
    ? { id: node.id, parentId: node.data.parentId, timestamp: "\uffff", depth: (depths.get(node.data.parentId) ?? -1) + 1 }
    : { ...node.data.node, timestamp: transientNodeIds.has(node.id) ? "\uffff" : node.data.node.timestamp });
  const order = new Map(branchOrder);
  if (draftParent.value !== undefined) order.set(draftParent.value ? `draft:${draftParent.value}` : "draft:root", draftOrder);
  const pending = session.pendingPrompt;
  if (pending && pending.targetNodeId === draftParent.value) order.set(pending.message.entryId, draftOrder);
  const placed = layoutGraph({ nodes: tree }, new Map(visible.map(node => [node.id, node.dimensions!])), order, transientNodeIds);
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

async function recoverDeletion() {
  const path = session.current?.session.path;
  if (!path || recoveringDeletion.value) return;
  recoveringDeletion.value = true;
  deleteError.value = "";
  try { await session.open(path); }
  catch (error) { deleteError.value = String(error); }
  finally { recoveringDeletion.value = false; }
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
    position.x + (size?.width || (id.startsWith("draft:") ? 360 : 280)) / 2,
    position.y + (size?.height || (id.startsWith("draft:") ? 280 : 146)) / 2,
    // D3's zoom interpolation zooms far out between distant nodes, transiently
    // mounting thousands of cards. Jump directly across large branches.
    { zoom: ensureReadable ? Math.max(zoom, readableZoom) : zoom, duration: animate && !distant ? 280 : 0 },
  );
  if (request !== centerRequest) return;
  if (id.startsWith("draft:"))
    document.querySelector<HTMLTextAreaElement>(".draft-node textarea")?.focus({ preventScroll: true });
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

function focusNodeVisible() {
  const id = defaultFocusId();
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
    await center(defaultFocusId(), true, false);
  } finally {
    booted.value = true;
  }
}

function holdsBranchModifier(event: NodeMouseEvent) {
  return Boolean((event as { event?: { shiftKey?: boolean } }).event?.shiftKey);
}

function startDrag(event: NodeMouseEvent) {
  dragFollowsBranch = holdsBranchModifier(event);
}

function trackDragModifier(event: NodeMouseEvent) {
  if (holdsBranchModifier(event)) dragFollowsBranch = true;
}

function rememberDrag(event: NodeMouseEvent) {
  const branch = dragFollowsBranch || holdsBranchModifier(event);
  dragFollowsBranch = false;
  dragged.set(event.node.id, { ...event.node.position, branch });
  const node = nodes.value.find(node => node.id === event.node.id);
  if (!node) return;
  node.position = { ...event.node.position };
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
  [() => sessionKey.value, () => projection.value?.nodes, () => projection.value?.edges,
    () => projection.value?.activeBranchNodeIds, () => projection.value?.activeNodeId,
    () => session.current?.runtime.available, () => !session.current?.graph && session.current?.runtime.isStreaming,
    () => session.models, () => draftParent.value, () => session.pendingPrompt, () => session.deleteBlockedReason, pendingRuns],
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
    <div v-if="deleteError || deletionNeedsRecovery" class="graph-delete-error" role="alert">
      {{ t('graph.deleteFailed', { error: deleteError || session.current?.graph?.storageError }) }}
      <Button v-if="deletionNeedsRecovery" data-action="node-delete-recover" variant="outline" :disabled="recoveringDeletion" @click="recoverDeletion">
        {{ t('graph.reopenSession') }}
      </Button>
    </div>
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
      :delete-key-code="null"
      @pane-ready="ready"
      @node-click="({ node }: NodeMouseEvent) => select(node.id)"
      @node-double-click="({ node }: NodeMouseEvent) => select(node.id, true)"
      @node-drag-start="startDrag"
      @node-drag="trackDragModifier"
      @node-drag-stop="rememberDrag"
      @nodes-change="syncNodeDimensions"
    >
      <template #node-prompt="props">
        <!-- Selection is presentation state; changing it must not call Vue Flow's setNodes. -->
        <PromptNode v-bind="props" :selected="session.focusedNode === props.id" />
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
