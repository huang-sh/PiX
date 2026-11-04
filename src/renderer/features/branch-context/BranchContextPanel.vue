<script setup lang="ts">
import { Brain, ChevronDown, ChevronRight, ChevronUp, LoaderCircle, MessageSquare, MessageSquarePlus, Square, Terminal, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { promptRecall, withoutToolLabels } from "../../../shared/session";
import type { AgentActivity, BranchMessage, PromptImage, RuntimeModel } from "../../../shared/types";
import type { CompactionRecord } from "../../../shared/run-timing";
import MarkdownRenderer from "../../components/MarkdownRenderer.vue";
import MessageImages from "../../components/MessageImages.vue";
import CopyButton from "../../components/CopyButton.vue";
import GitBranchPicker from "../../components/GitBranchPicker.vue";
import BranchHistory, { type HistoryTurn as Turn } from "./BranchHistory.vue";
import ToolDuration from "./ToolDuration.vue";
import PromptComposer, { type ComposerDraft } from "../../components/PromptComposer.vue";
import { useDraftSubmit } from "../../composables/useDraftSubmit";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";

// A pinned column binds every view to one node; the primary column (no nodeId)
// keeps following the graph selection.
const props = defineProps<{ nodeId?: string | null }>();
const session = useSessionStore();
const layout = useLayoutStore();
const panelNodeId = computed(() => {
  const pending = props.nodeId && session.currentPendingPrompts.find(prompt => prompt.columnId === props.nodeId
    && prompt.columnDraft === layout.chatColumnComposers[props.nodeId!]?.draft);
  const run = pending && session.current?.graph?.runs.find(run => run.requestId === pending.requestId);
  return (run && run.status === "running" ? run.nodeId ?? `pending:${run.runId}` : undefined)
    ?? props.nodeId ?? session.focusedNode ?? session.current?.projection.activeNodeId ?? null;
});
const panelNode = computed(() => session.nodeFor(panelNodeId.value));
const selectedRun = computed(() => session.runFor(panelNodeId.value));
// Composer recall list: the session's user prompts, newest first, with
// consecutive duplicates collapsed. Session-wide so a fork can recall the
// latest phrasing even when another branch sent it.
const promptHistory = computed(() => {
  const local = promptRecall(session.current?.entries ?? []);
  const older = session.promptRecall;
  if (!older.length) return local;
  // The pool covers the newest turns; the main process adds the older ones.
  const merged = [...local];
  const seen = new Set(local);
  for (const text of older) if (!seen.has(text)) { seen.add(text); merged.push(text); }
  return merged;
});
const liveCompactions = computed<CompactionRecord[] | undefined>(() => {
  const run = selectedRun.value;
  if (run?.status !== "running") return undefined;
  const timing = run.runtime?.timing;
  if (timing && (!run.pending?.timestamp || run.pending.timestamp === timing.startedAt)) return timing.compactions;
  return run.runtime?.isCompacting ? [{ status: "running" }] : undefined;
});
// Every branch's store updates immediately; only the visible view is frame-paced.
const latestActivity = computed(() => layout.layout.collapsed.chat ? undefined : session.activityFor(panelNodeId.value));
const activity = shallowRef<AgentActivity>();
let activityFrame: number | undefined;
const { submitDraft } = useDraftSubmit();
const { t } = useI18n();
const scroll = ref<HTMLElement>();
const content = ref<HTMLElement>();
const followingOutput = ref(true);
const expandedProcesses = ref(new Set<string>());
const visibleTurnCount = ref(40);
// Older turns may be fetched from the main process on demand; the button says so.
const loadingEarlier = ref(false);
const liveTextLimit = ref(32768);
const expandedLiveTools = ref(new Set<string>());
let resizeObserver: ResizeObserver | undefined;
let contentObserver: ResizeObserver | undefined;
const readingPositions = new Map<string, { top: number; following: boolean; count: number; expanded: Set<string> }>();
let readingScope = "";
let viewVersion = 0;
let restoreTicket = 0;
let restoringPosition = false;
let scrollFrame: number | undefined;
let lastScrollTop = 0;
const history = computed(() => session.messageWindowFor(panelNodeId.value, visibleTurnCount.value));
const historyKey = computed(() => JSON.stringify([session.current?.session.path, session.current?.graph?.epoch, panelNodeId.value]));
watch([latestActivity, historyKey, () => selectedRun.value?.runId], ([latest, key, run], previous) => {
  const showLatest = () => {
    if (activityFrame !== undefined) cancelAnimationFrame(activityFrame);
    activityFrame = undefined;
    activity.value = latestActivity.value;
  };
  // Selection/visibility/settlement must supersede any old branch's queued frame.
  if (!latest || !activity.value || !latest.active || key !== previous?.[1] || run !== previous?.[2]) {
    showLatest();
  } else if (activityFrame === undefined) {
    activityFrame = requestAnimationFrame(showLatest);
  }
}, { immediate: true, flush: "sync" });
const liveOutputClipped = computed(() => activity.value?.items.some(item => item.status === "running" &&
  Math.max(item.text.length, item.thinking?.length ?? 0) > liveTextLimit.value));
const liveText = (text: string) => text.length > liveTextLimit.value ? text.slice(-liveTextLimit.value) : text;
watch(historyKey, () => { liveTextLimit.value = 32768; expandedLiveTools.value.clear(); });
function toggleLiveTool(id: string, event: Event) {
  if ((event.currentTarget as HTMLDetailsElement).open) expandedLiveTools.value.add(id);
  else expandedLiveTools.value.delete(id);
  scrollLatest();
}

// Like graph drafts, inherit the target's settings and keep overrides local.
const composerModel = ref<RuntimeModel | null>();
const composerThinking = ref<string>();

const composerRunnable = computed(() =>
  Boolean(session.current?.runtime.available && (composerRunning.value || (session.current.graph
    ? panelNode.value?.forkable !== false && !panelNodeId.value?.startsWith("pending:")
    : !session.current.runtime.isStreaming))));
const composerModelValue = computed(() => {
  if (composerRunning.value) return selectedRun.value?.runtime?.model ?? session.current?.runtime.model ?? null;
  if (composerModel.value !== undefined) return composerModel.value;
  return panelNode.value?.footer?.model ?? session.current?.runtime.model ?? null;
});
const composerThinkingValue = computed(() =>
  (composerRunning.value ? selectedRun.value?.runtime?.thinkingLevel ?? session.current?.runtime.thinkingLevel : undefined)
  ?? composerThinking.value
  ?? panelNode.value?.footer?.thinkingLevel
  ?? session.userThinking
  ?? session.current?.runtime.thinkingLevel
  ?? "off");
const composerPlaceholder = computed(() => !composerRunnable.value
  ? t(session.current?.runtime.isStreaming ? "graph.blockedStreaming" : "graph.blockedReadonly")
  : t("draft.placeholder"));
// Queue and stop controls target the same run, including pinned branch columns.
const composerRunning = computed(() => Boolean(session.current?.graph
  ? selectedRun.value?.status === "running"
  : session.current?.runtime.isStreaming));
const composerPending = computed(() => selectedRun.value?.runtime?.queuedMessages ?? (!session.current?.graph
  ? session.current?.runtime.queuedMessages : undefined));

function queueTarget() {
  const graph = session.current?.graph, run = selectedRun.value;
  if (!graph) return {};
  if (!run) throw new Error(t("draft.runFinished"));
  return { graphId: graph.id, branchId: run.branchId, runId: run.runId };
}
async function queueComposer(text: string, images?: PromptImage[]) {
  await session.control({ action: "followUp", text, ...(images?.length ? { images } : {}), ...queueTarget() });
  return true;
}
async function updateComposerQueue(id: string, operation: "steer" | "remove" | "edit", text?: string) {
  await session.control({ action: "updateQueuedMessage", id, operation,
    ...(operation === "edit" ? { text } : {}), ...queueTarget() });
}

async function stopComposer() {
  const run = session.current?.graph ? selectedRun.value : undefined;
  try {
    await session.control(run ? { action: "branchAbort", branchId: run.branchId, runId: run.runId } : { action: "abort" });
  } catch (error) {
    layout.showNotice(error instanceof Error ? error.message : String(error), "error");
  }
}
const composerTarget = computed(() =>
  panelNode.value
    ? t("branch.composerFrom", { title: panelNode.value.title })
    : t("branch.composerRoot"));

watch(
  () => session.current?.session.path,
  () => void session.loadPromptRecall(),
  { immediate: true },
);
watch(
  [() => session.current?.session.path, () => panelNode.value?.id],
  () => {
    composerModel.value = undefined;
    composerThinking.value = undefined;
  },
);

function setComposerModel(model: RuntimeModel) {
  composerModel.value = model;
  if (model.reasoning === false) composerThinking.value = "off";
  void session.setDefaultModel(model);
}

function setComposerThinking(level: string, explicit: boolean) {
  if (explicit) session.setUserThinking(level);
  composerThinking.value = level;
}

// The host admits the prompt and its model settings as one branch operation.
// A pinned column submits without moving the global focus, then follows its
// own branch as soon as progress arrives. Its identity stays on the parent
// through initialization so failures cannot merge away the submitting editor.
async function submitComposer(text: string, images?: PromptImage[]) {
  return Boolean(await submitDraft(props.nodeId ?? panelNode.value?.id ?? null, text,
    composerModelValue.value, composerThinkingValue.value, images,
    props.nodeId || composerState.draft.promptOverride !== undefined
      ? { ...(props.nodeId ? { follow: false, columnId: props.nodeId } : {}), ...(composerState.draft.promptOverride !== undefined ? { promptOverride: composerState.draft.promptOverride } : {}) }
      : undefined));
}

// Drafts and submission callbacks must share the same state across a pinned
// column's remounts, including a failed handoff back to the parent node.
const composer = ref<InstanceType<typeof PromptComposer>>();
const savedComposer = props.nodeId ? layout.chatColumnComposers[props.nodeId] : undefined;
const composerState = reactive(savedComposer ?? {
  open: false,
  draft: { text: "", images: [], busy: false, readingImages: false, error: "" } as ComposerDraft,
});
if (props.nodeId) layout.chatColumnComposers[props.nodeId] = composerState;
async function openComposer() {
  composerState.open = true;
  await nextTick();
  void composer.value?.focus();
}
function closeComposer() {
  composerState.open = false;
}
// Reopening the chat panel puts the cursor back in the primary column's
// composer when it is expanded; pinned columns leave the focus alone.
watch(() => layout.layout.collapsed.chat, (collapsed) => {
  if (!collapsed && !props.nodeId) void composer.value?.focus();
});

const showingActivity = computed(() => Boolean(
  activity.value &&
  (session.current?.graph || !panelNode.value || panelNode.value.id === session.current?.projection.activeNodeId),
));
const replacingHistory = computed(() => showingActivity.value && !activity.value?.partial);

const turns = computed(() => {
  const grouped: Array<{ id: string; user?: BranchMessage; body: BranchMessage[] }> = [];
  for (const message of history.value.messages) {
    if (message.role === "user") {
      grouped.push({ id: message.turnId, user: message, body: [] });
    } else {
      const turn = grouped.at(-1) ?? { id: message.turnId, body: [] };
      if (!grouped.length) grouped.push(turn);
      turn.body.push(message);
    }
  }
  if (replacingHistory.value && grouped.length) grouped.at(-1)!.body = [];
  return grouped;
});

const compactionEntries = computed(() => new Map((session.current?.entries ?? [])
  .filter(entry => entry.type === "compaction").map(entry => [entry.timestamp, entry])));
function compactionDetails(record: CompactionRecord): CompactionRecord {
  const entry = record.entryTimestamp ? compactionEntries.value.get(record.entryTimestamp) : undefined;
  return { ...record, ...(typeof entry?.summary === "string" ? { summary: entry.summary } : {}) };
}
const claimedCompactions = computed(() => new Set([
  ...(session.current?.projection.nodes.flatMap(node => node.metrics?.compactions ?? []) ?? []),
  ...(liveCompactions.value ?? []),
].map(record => record.entryTimestamp).filter(Boolean)));

const visibleTurns = computed<Turn[]>(() =>
  turns.value.slice(-visibleTurnCount.value).map(({ id, user, body }) => {
    // A turn ends at its last assistant message, whatever it carries — the same
    // message the projection reads for node.hasError. An empty final reply is a
    // failure, never the earlier text that happened to precede it.
    const terminal = [...body].reverse().find((message) => message.role === "assistant");
    const node = session.nodeFor(id);
    const selected = id === (selectedRun.value?.nodeId ?? `pending:${selectedRun.value?.runId}`);
    const compactions = selected && liveCompactions.value !== undefined ? liveCompactions.value : node?.metrics?.compactions;
    return {
      id,
      fileChanges: node?.fileChanges,
      user,
      terminal,
      running: selectedRun.value?.status === "running" && selected,
      compactions: compactions?.map(compactionDetails),
      trailingCompactions: body.filter(message => message.compaction && !claimedCompactions.value.has(message.compaction.entryTimestamp))
        .map(message => ({ ...message.compaction!, summary: message.text })),
      process: body.filter((message) => message !== terminal && !message.compaction),
    };
  }),
);

// Only visible, expanded history needs normalization. Cache across live-output
// renders; a changed history snapshot or disclosure state invalidates it.
const processMessages = computed(() => {
  const messages = new Map<string, BranchMessage[]>();
  for (const turn of visibleTurns.value) {
    if (!expandedProcesses.value.has(turn.id)) continue;
    messages.set(turn.id, turn.process.map(message => ({ ...message, text: withoutToolLabels(message.text) })));
  }
  return messages;
});

/** Pages one window of earlier turns in: fetched first so the scroll anchor
 * measures the final height, then rendered above with the reading position
 * restored. Reached automatically when the user scrolls to the top. */
async function showEarlierTurns() {
  if (loadingEarlier.value || !history.value.hasEarlier) return;
  const version = viewVersion;
  const root = scroll.value;
  if (!root) return;
  const height = root.scrollHeight;
  const top = root.scrollTop;
  // Only a real scroll releases following; paging in a window shorter than
  // the panel (byte-capped pages) never interrupts the pinned tip.
  if (root.scrollHeight > root.clientHeight) followingOutput.value = false;
  const target = visibleTurnCount.value + 40;
  const plan = session.windowPlanFor(panelNodeId.value, target);
  if (plan?.request) {
    // These turns are not in the pool yet. Fetch before rendering so the anchor
    // restore below measures the final height instead of jumping afterwards.
    loadingEarlier.value = true;
    try { await session.fetchWindow(plan.leaf, plan.request.limit, plan.request.bytes); }
    finally { loadingEarlier.value = false; }
    if (version !== viewVersion) return;
  }
  visibleTurnCount.value = target;
  await nextTick();
  const element = scroll.value;
  if (element) element.scrollTop = top + element.scrollHeight - height;
  pageIfUnfilled();
}

/** True once the history overflows the panel. A short panel stuck with more
 * history (a failed fetch or a byte cap repeating its page) has no top to
 * scroll to, so its only affordance is the retry row. */
const historyScrollable = ref(true);

/** A byte-capped window can arrive shorter than the panel itself; nothing
 * would ever be scrollable, so keep paging until history fills the view.
 * Stops as soon as a page stops growing the rendered turns — a byte cap
 * repeating its newest turn must not loop. */
let lastCascadeRendered = -1;
function pageIfUnfilled() {
  const root = scroll.value;
  const overflow = root ? root.scrollHeight - root.clientHeight : 0;
  historyScrollable.value = overflow > 96;
  if (!root || loadingEarlier.value || !history.value.hasEarlier || overflow >= 96) return;
  const rendered = history.value.messages.length;
  if (rendered === lastCascadeRendered) return;
  lastCascadeRendered = rendered;
  void showEarlierTurns();
}

function duration(turn: Turn) {
  const execution = session.nodeFor(turn.id)?.metrics?.agentDurationMs;
  const start = new Date(turn.user?.timestamp ?? "").getTime();
  const end = new Date(turn.terminal?.timestamp ?? turn.process.at(-1)?.timestamp ?? "").getTime();
  const elapsed = execution ?? end - start;
  if (!Number.isFinite(elapsed)) return t("time.aMoment");
  const seconds = Math.max(0, Math.round(elapsed / 1000));
  return seconds >= 60
    ? `${t("time.minutes", { n: Math.floor(seconds / 60) })} ${t("time.seconds", { n: seconds % 60 })}`
    : t("time.seconds", { n: seconds });
}

// Model failures arrive as e.g. `401: {"message":"…","type":"authentication_error"}`;
// unwrap the trailing JSON payload so the panel shows a readable one-liner.
function errorText(message: { errorMessage?: string }) {
  const raw = message.errorMessage?.trim();
  if (!raw) return t("branch.requestFailed");
  const at = raw.lastIndexOf("{");
  if (at > 0) {
    try {
      const detail = JSON.parse(raw.slice(at)) as { message?: unknown };
      if (typeof detail.message === "string" && detail.message.trim())
        return `${raw.slice(0, at).replace(/[\s:]+$/, "")}: ${detail.message.trim()}`;
    } catch {
      // not JSON — fall through to the raw text
    }
  }
  return raw;
}

function updateScrollFollow() {
  const root = scroll.value;
  if (!root || root.scrollTop === lastScrollTop) return;
  lastScrollTop = root.scrollTop;
  // A user scroll between selection and DOM commit supersedes restoration.
  if (restoringPosition) { viewVersion++; restoringPosition = false; }
  const overflow = root.scrollHeight - root.clientHeight;
  followingOutput.value = overflow - root.scrollTop < 48;
  historyScrollable.value = overflow > 96;
  // Reaching the top pages older history in automatically; the anchor restore
  // in showEarlierTurns keeps the reading position in place while it lands.
  // Only a genuinely scrollable list has a "top" to reach: with less than a
  // page of overflow the programmatic follow-scroll would otherwise page (and
  // unpin following) while a run streams — pageIfUnfilled owns that regime.
  if (root.scrollTop <= 96 && overflow > 96) void showEarlierTurns();
}

function scrollLatest() {
  if (restoringPosition || scrollFrame !== undefined) return;
  const version = viewVersion;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = undefined;
    const root = scroll.value;
    if (!root || version !== viewVersion) return;
    root.querySelectorAll<HTMLElement>(
      ".agent-process.live .process-items, .agent-process.live .process-tool[open] > pre",
    ).forEach(element => (element.scrollTop = element.scrollHeight));
    if (followingOutput.value) {
      root.scrollTop = root.scrollHeight;
      // The scroll event can arrive after content has grown again.
      lastScrollTop = root.scrollTop;
    }
    // Streaming growth can push a short panel past a full page; the retry
    // row must retire the moment there is a top to scroll to.
    historyScrollable.value = root.scrollHeight - root.clientHeight > 96;
  });
}

watch([() => JSON.stringify([session.current?.session.path, session.current?.graph?.epoch]),
  () => panelNodeId.value], ([scope, id], previous) => {
  const version = ++viewVersion;
  if (scrollFrame !== undefined) { cancelAnimationFrame(scrollFrame); scrollFrame = undefined; }
  if (readingScope !== scope) { readingPositions.clear(); readingScope = scope; }
  else if (previous?.[1]) readingPositions.set(previous[1], {
    top: scroll.value?.scrollTop ?? 0, following: followingOutput.value,
    count: visibleTurnCount.value, expanded: new Set(expandedProcesses.value),
  });
  const saved = id ? readingPositions.get(id) : undefined;
  if (id) readingPositions.delete(id);
  if (readingPositions.size > 16) readingPositions.delete(readingPositions.keys().next().value!);
  expandedProcesses.value = new Set(saved?.expanded);
  visibleTurnCount.value = saved?.count ?? 40;
  lastCascadeRendered = -1;
  followingOutput.value = saved?.following ?? true;
  const ticket = ++restoreTicket;
  restoringPosition = true;
  void nextTick(() => {
    // A user scroll (updateScrollFollow) or a newer selection superseded this
    // restore; it must not move the scroll position. Only the newest ticket
    // may clear the flag, so a superseded restore can never leave scrollLatest
    // permanently disabled.
    if (version !== viewVersion) {
      if (ticket === restoreTicket) restoringPosition = false;
      return;
    }
    const root = scroll.value;
    if (root) {
      root.scrollTop = followingOutput.value ? root.scrollHeight : saved?.top ?? 0;
      lastScrollTop = root.scrollTop;
    }
    restoringPosition = false;
    // A first window shorter than the panel (byte-capped pages) has nothing
    // to scroll; fill it before the user ever meets a dead end.
    pageIfUnfilled();
  });
}, { immediate: true });

function toggleProcess(id: string, event: Event, viewKey: string) {
  if (viewKey !== historyKey.value) return;
  const open = (event.currentTarget as HTMLDetailsElement).open;
  if (open) expandedProcesses.value.add(id);
  else expandedProcesses.value.delete(id);
}

watch(() => session.pendingPrompt?.message.entryId, (entryId) => {
  if (!entryId) return;
  followingOutput.value = true;
  scrollLatest();
});

watch(
  () => [
    history.value.messages.length,
    activity.value?.items
      .map((item) => `${item.text.length}:${item.thinking?.length ?? 0}:${item.status}`)
      .join(":"),
  ],
  scrollLatest,
);

onMounted(() => {
  // Follow panel resizing and late content growth (images, Markdown layout).
  if (typeof ResizeObserver === "undefined" || !scroll.value || !content.value) return;
  resizeObserver = new ResizeObserver(scrollLatest);
  resizeObserver.observe(scroll.value);
  contentObserver = new ResizeObserver(scrollLatest);
  contentObserver.observe(content.value);
});

onBeforeUnmount(() => {
  viewVersion++;
  resizeObserver?.disconnect();
  contentObserver?.disconnect();
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
  if (activityFrame !== undefined) cancelAnimationFrame(activityFrame);
});
</script>

<template>
  <section class="panel branch-panel">
    <header class="panel-header">
      <span class="branch-title">
        <MessageSquare :size="17" />
        <small>{{ panelNode?.title ?? t("branch.noNodeSelected") }}</small>
      </span>
      <GitBranchPicker />
      <button
        type="button"
        class="branch-close"
        :data-action="nodeId ? 'chat-column-close' : 'chat-panel-close'"
        :aria-label="nodeId ? t('branch.closePanel') : t('branch.closeChat')"
        :title="nodeId ? t('branch.closePanel') : t('branch.closeChat')"
        @click="nodeId ? layout.closeChatColumn(nodeId) : layout.setCollapsed('chat', true)"
      ><X :size="14" /></button>
    </header>
    <div v-if="selectedRun?.error" class="graph-storage-state" role="status">
      <small>{{ selectedRun.error }}</small>
    </div>
    <div v-if="session.current?.graph?.storageError" class="graph-storage-state" role="status">
      {{ t('graph.storageNotice') }}
      <small>{{ session.current.graph.storageError }}</small>
    </div>

    <div ref="scroll" class="branch-messages" @scroll="updateScrollFollow">
      <div ref="content" class="branch-messages-inner">
      <details v-if="session.current?.graph?.recoveredInputs?.length" class="graph-storage-state">
        <summary>{{ t('graph.recoveredInputs') }}</summary>
        <small>{{ t('graph.recoveredInputsHint') }}</small>
        <article v-for="input in session.current.graph.recoveredInputs" :key="input.requestId" class="branch-message user">
          <p>{{ input.text }}</p>
          <MessageImages :images="input.images" />
          <CopyButton :text="input.text" />
        </article>
      </details>
      <!-- Older history pages in as the user scrolls to the top; this row only
         marks the (remote-slow) fetch in flight. -->
      <p v-if="history.hasEarlier && loadingEarlier" class="load-earlier-status" role="status">
        {{ t('branch.loadingEarlier') }}
      </p>
      <!-- A panel too short to scroll (a failed fetch, or a byte cap repeating
         its page) has no top to reach; retrying is its only way forward. -->
      <button v-else-if="history.hasEarlier && !historyScrollable" type="button"
        class="load-earlier-status" @click="showEarlierTurns">
        {{ t('branch.retryEarlier') }}
      </button>
      <!-- Keep a few recently viewed histories mounted: switching back should
           not parse and mount all their Markdown again. Inactive views receive
           no live session updates; the cache is bounded independently of nodes. -->
      <KeepAlive :key="readingScope" :max="4">
        <BranchHistory :key="historyKey" :view-key="historyKey" :turns="visibleTurns"
          :session-path="session.current?.session.path"
          :process-messages="processMessages" :expanded-processes="expandedProcesses"
          :duration="duration" :error-text="errorText" @toggle="toggleProcess" />
      </KeepAlive>

      <div v-if="selectedRun?.status === 'running' && !showingActivity && !liveCompactions?.some(item => item.status === 'running')" class="process-item waiting" role="status">
        <LoaderCircle :size="14" class="spin" /> {{ t('branch.running') }}
      </div>

      <details
        v-if="showingActivity && activity"
        :key="historyKey"
        class="agent-process live"
        :open="activity.active"
        @toggle="scrollLatest()"
      >
        <summary>
          <LoaderCircle :size="14" class="spin" />
          {{ activity.pass > 1 ? t("branch.workingPass", { n: activity.pass }) : t("branch.working") }}
          <ChevronRight class="disclosure" :size="13" />
        </summary>
        <div class="process-items">
          <button v-if="liveOutputClipped" type="button" class="load-earlier-turns" @click="liveTextLimit *= 2">
            {{ t('branch.liveOutputTail', { n: liveTextLimit }) }}
          </button>
          <template v-for="item in activity.items" :key="item.id">
            <details
              v-if="item.thinking"
              class="process-item process-thinking"
              :open="item.status === 'running'"
              @toggle="scrollLatest()"
            >
              <summary><Brain :size="13" /><strong>{{ t("branch.thinking") }}</strong></summary>
              <p>{{ item.status === 'running' ? liveText(item.thinking) : item.thinking }}</p>
            </details>
            <details
              v-if="item.kind === 'tool'"
              class="process-item process-tool"
              :class="[item.status, { 'nested-tool': item.parentToolCallId }]"
              :data-parent-tool-call="item.parentToolCallId"
              :open="item.status === 'running'"
              @toggle="toggleLiveTool(item.id, $event)"
            >
              <summary>
                <LoaderCircle v-if="item.status === 'running'" :size="13" class="spin" />
                <Terminal v-else :size="13" />
                <strong>{{ item.title }}</strong>
                <code v-if="item.input" :title="item.input">{{ item.input }}</code>
                <ToolDuration :running="activity.active && item.status === 'running'" :started-at="item.timestamp" :duration-ms="item.durationMs" />
              </summary>
              <pre v-if="item.status === 'running' || expandedLiveTools.has(item.id)">{{ (item.status === 'running' ? liveText(item.text) : item.text) || (item.status === "running" ? t("branch.running") : t("common.noOutput")) }}</pre>
              <MessageImages v-if="item.status === 'running' || expandedLiveTools.has(item.id)" :images="item.images" />
            </details>
            <div v-else-if="item.text" class="process-item assistant">
              <MarkdownRenderer
                :content="item.status === 'running' ? liveText(item.text) : item.text"
                :custom-id="`${historyKey}:${item.id}`"
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

      <p v-if="!turns.length && !showingActivity" class="empty-copy">
        {{ t("branch.selectNode") }}
      </p>
      </div>
    </div>

    <footer v-if="session.current" class="chat-composer">
      <div v-if="!composerState.open" class="composer-bar">
        <button
          type="button"
          class="composer-collapsed"
          :title="composerTarget"
          @click="openComposer"
        >
          <MessageSquarePlus :size="14" />
          <span>{{ composerTarget }}</span>
          <ChevronUp :size="14" />
        </button>
        <!-- Collapsed form of the send button: stopping stays on the composer,
             reachable even when a run was started from the graph draft node. -->
        <button
          v-if="composerRunning"
          type="button"
          class="composer-collapsed-stop"
          :aria-label="t('graph.stopBranch')"
          :title="t('graph.stopBranch')"
          @click="stopComposer"
        >
          <Square :size="12" :stroke-width="0" fill="currentColor" />
        </button>
      </div>
      <div v-else class="composer-expanded">
        <PromptComposer
          ref="composer"
          :draft-state="composerState.draft"
          :history="promptHistory"
          :runnable="composerRunnable"
          :model="composerModelValue"
          :thinking-level="composerThinkingValue"
          :models="session.models"
          :personas="layout.settings?.app.personas ?? []"
          :prompt-override="session.promptOverrideAt(props.nodeId ?? panelNode?.id ?? null)"
          :placeholder="composerPlaceholder"
          :running="composerRunning"
          :on-model="setComposerModel"
          :on-thinking="setComposerThinking"
          :on-submit="submitComposer"
          :on-stop="stopComposer"
          :on-queue="queueComposer"
          :queued-messages="composerRunning ? composerPending : undefined"
          :on-queued-action="updateComposerQueue"
        >
          <template #header>
            <div class="composer-head">
              <button type="button" :title="t('branch.composerClose')" :aria-label="t('branch.composerClose')" @click="closeComposer">
                <ChevronDown :size="14" />
              </button>
            </div>
          </template>
        </PromptComposer>
      </div>
    </footer>
  </section>
</template>
