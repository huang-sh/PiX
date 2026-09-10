<script setup lang="ts">
import { BookOpen, Brain, ChevronDown, ChevronRight, ChevronUp, LoaderCircle, MessageSquare, MessageSquarePlus, RefreshCw, Square, Terminal, TriangleAlert } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { withoutToolLabels } from "../../../shared/session";
import type { AgentActivity, BranchMessage, PromptImage, RuntimeModel } from "../../../shared/types";
import type { WikiBranchStatus } from "../../../shared/wiki";
import MarkdownRenderer from "../../components/MarkdownRenderer.vue";
import MessageImages from "../../components/MessageImages.vue";
import CopyButton from "../../components/CopyButton.vue";
import BranchHistory, { type HistoryTurn as Turn } from "./BranchHistory.vue";
import PromptComposer from "../../components/PromptComposer.vue";
import { useDraftSubmit } from "../../composables/useDraftSubmit";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";
import { useWorkspaceStore } from "../../stores/workspace";

const session = useSessionStore();
const selectedRun = computed(() => session.selectedRun);
const layout = useLayoutStore();
const workspace = useWorkspaceStore();
// Every branch's store updates immediately; only the visible view is frame-paced.
const latestActivity = computed(() => layout.layout.collapsed.chat ? undefined : session.selectedActivity);
const activity = shallowRef<AgentActivity>();
let activityFrame: number | undefined;
const { submitDraft } = useDraftSubmit();
const { t } = useI18n();
const scroll = ref<HTMLElement>();
const content = ref<HTMLElement>();
const followingOutput = ref(true);
const expandedProcesses = ref(new Set<string>());
const visibleTurnCount = ref(40);
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
const history = computed(() => session.messageWindow(visibleTurnCount.value));
const historyKey = computed(() => JSON.stringify([session.current?.session.path, session.current?.graph?.epoch,
  session.focusedNode ?? session.current?.projection.activeNodeId]));
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
  Boolean(session.current?.runtime.available && (session.current.graph
    ? session.selectedNode?.forkable !== false && !session.focusedNode?.startsWith("pending:")
    : !session.current.runtime.isStreaming)));
const composerModelValue = computed(() => {
  if (composerModel.value !== undefined) return composerModel.value;
  return session.selectedNode?.footer?.model ?? session.current?.runtime.model ?? null;
});
const composerThinkingValue = computed(() =>
  composerThinking.value
  ?? session.selectedNode?.footer?.thinkingLevel
  ?? session.userThinking
  ?? session.current?.runtime.thinkingLevel
  ?? "off");
const composerPlaceholder = computed(() => !composerRunnable.value
  ? t(session.current?.runtime.isStreaming ? "graph.blockedStreaming" : "graph.blockedReadonly")
  : t("draft.placeholder"));
// The composer's send button doubles as the stop control while the branch it
// targets is running: graph runs stop per-branch, plain sessions abort the stream.
const composerRunning = computed(() => Boolean(session.current?.graph
  ? selectedRun.value?.status === "running"
  : session.current?.runtime.isStreaming));

function stopComposer() {
  const run = session.current?.graph ? selectedRun.value : undefined;
  if (run) void session.control({ action: "branchAbort", branchId: run.branchId, runId: run.runId });
  else void session.control({ action: "abort" });
}
const composerTarget = computed(() =>
  session.selectedNode
    ? t("branch.composerFrom", { title: session.selectedNode.title })
    : t("branch.composerRoot"));

watch(
  [() => session.current?.session.path, () => session.selectedNode?.id],
  () => {
    composerModel.value = undefined;
    composerThinking.value = undefined;
  },
);

function setComposerModel(model: RuntimeModel) {
  composerModel.value = model;
  if (model.reasoning === false) composerThinking.value = "off";
}

function setComposerThinking(level: string, explicit: boolean) {
  if (explicit) session.setUserThinking(level);
  composerThinking.value = level;
}

// The host admits the prompt and its model settings as one branch operation.
async function submitComposer(text: string, images?: PromptImage[]) {
  return submitDraft(session.selectedNode?.id ?? null, text, composerModelValue.value, composerThinkingValue.value, images);
}

const showingActivity = computed(() => Boolean(
  activity.value &&
  (session.current?.graph || !session.selectedNode || session.selectedNode.id === session.current?.projection.activeNodeId),
));

// --- Session wiki region -------------------------------------------------
const wiki = computed(() => session.wiki);
const wikiBranchId = computed(() => session.selectedNode?.branchId ?? "main");
const wikiBranch = computed<WikiBranchStatus | undefined>(() =>
  wiki.value?.branches.find(branch => branch.branchId === wikiBranchId.value));
const wikiTotals = computed(() => (wiki.value?.branches ?? []).reduce(
  (acc, branch) => ({ covered: acc.covered + branch.coveredTurns, total: acc.total + branch.totalTurns }),
  { covered: 0, total: 0 },
));
const wikiStatusLabel = (status: WikiBranchStatus["status"]) => t(`wiki.status.${status}`);
const wikiModelValue = computed(() => wiki.value?.model ? `${wiki.value.model.provider}\u0000${wiki.value.model.id}` : "");
function wikiConfigure(patch: Record<string, unknown>) {
  void session.wikiControl("configure", { patch }).catch(error => {
    layout.showNotice(String(error instanceof Error ? error.message : error), "error");
  });
}
function setWikiModel(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (!value) return wikiConfigure({ provider: "", modelId: "" });
  const [provider, id] = value.split("\u0000");
  wikiConfigure({ provider, modelId: id });
}
// One workspace wiki at <project>/.pi/wiki; the current session owns the
// sessions/<sessionKey>/ section. Open pages with the regular workspace
// viewer (relative path, no extra authority).
async function openWikiFile(file: "index" | "summary") {
  const root = workspace.project?.path;
  const key = wiki.value?.sessionKey;
  if (!root || (file === "summary" && !key)) {
    layout.showNotice(t("wiki.outsideProject"), "warning");
    return;
  }
  const rel = file === "index" ? ".pi/wiki/index.md" : `.pi/wiki/sessions/${key}/branches/${wikiBranchId.value}.md`;
  try {
    await workspace.openFile(rel);
    await layout.openTool("files");
  } catch (error) {
    layout.showNotice(String(error instanceof Error ? error.message : error), "warning");
  }
}

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

const visibleTurns = computed<Turn[]>(() =>
  turns.value.slice(-visibleTurnCount.value).map(({ id, user, body }) => {
    const final = [...body].reverse().find(
      (message) => message.role === "assistant" && message.text,
    );
    const error = final
      ? undefined
      : [...body].reverse().find((message) => message.role === "assistant" && message.isError);
    return {
      id,
      user,
      final,
      error,
      running: selectedRun.value?.status === "running" && id === selectedRun.value.nodeId,
      process: body.filter((message) => message !== final && message !== error),
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

async function showEarlierTurns() {
  const version = viewVersion;
  const root = scroll.value;
  const height = root?.scrollHeight ?? 0;
  const top = root?.scrollTop ?? 0;
  followingOutput.value = false;
  visibleTurnCount.value += 40;
  await nextTick();
  if (root && version === viewVersion) root.scrollTop = top + root.scrollHeight - height;
}

function duration(turn: Turn) {
  const start = new Date(turn.user?.timestamp ?? "").getTime();
  const end = new Date(turn.final?.timestamp ?? turn.error?.timestamp ?? turn.process.at(-1)?.timestamp ?? "").getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return t("time.aMoment");
  const seconds = Math.max(0, Math.round((end - start) / 1000));
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
  followingOutput.value = root.scrollHeight - root.scrollTop - root.clientHeight < 48;
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
  });
}

watch([() => JSON.stringify([session.current?.session.path, session.current?.graph?.epoch]),
  () => session.focusedNode ?? session.current?.projection.activeNodeId], ([scope, id], previous) => {
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
        <span>
          <strong>{{ t("branch.title") }}</strong>
          <small>{{ session.selectedNode?.title ?? t("branch.noNodeSelected") }}</small>
        </span>
      </span>
    </header>
    <div v-if="selectedRun?.error" class="graph-storage-state" role="status">
      <small>{{ selectedRun.error }}</small>
    </div>
    <div v-if="session.current?.graph?.storageError" class="graph-storage-state" role="status">
      {{ t('graph.storageNotice') }}
      <small>{{ session.current.graph.storageError }}</small>
    </div>

    <details v-if="wiki" class="wiki-region">
      <summary>
        <BookOpen :size="13" />
        <strong>{{ t("wiki.title") }}</strong>
        <span v-if="wiki.available" class="wiki-coverage">{{ t("wiki.coverage", wikiTotals) }}</span>
        <span v-else class="wiki-coverage">{{ t("wiki.remoteDisabled") }}</span>
        <ChevronRight class="disclosure" :size="13" />
      </summary>
      <div v-if="wiki.available" class="wiki-body">
        <p v-if="wiki.paused" class="wiki-note"><TriangleAlert :size="13" /> {{ t("wiki.budgetPaused") }}</p>
        <dl class="wiki-facts">
          <div>
            <dt>{{ t("wiki.branchState") }}</dt>
            <dd :class="`wiki-state-${wikiBranch?.status ?? 'dirty'}`">
              {{ wikiBranch ? `${wikiStatusLabel(wikiBranch.status)} · ${t("wiki.coverage", { covered: wikiBranch.coveredTurns, total: wikiBranch.totalTurns })}` : t("wiki.notGenerated") }}
            </dd>
          </div>
          <div>
            <dt>{{ t("wiki.model") }}</dt>
            <dd>
              <select class="wiki-model" :value="wikiModelValue" @change="setWikiModel" :aria-label="t('wiki.model')">
                <option value="">{{ t("wiki.followSession") }}</option>
                <option v-for="model in session.models" :key="`${model.provider}/${model.id}`" :value="`${model.provider}\u0000${model.id}`">
                  {{ model.name || model.id }}
                </option>
              </select>
            </dd>
          </div>
          <div>
            <dt>{{ t("wiki.usage") }}</dt>
            <dd>{{ t("wiki.tokens", { n: wiki.usage.input + wiki.usage.output }) }} · {{ t("wiki.calls", { n: wiki.usage.calls }) }}</dd>
          </div>
        </dl>
        <p v-if="wikiBranch?.error" class="wiki-error">{{ wikiBranch.error }}</p>
        <div class="wiki-actions">
          <label class="wiki-toggle">
            <input type="checkbox" :checked="wiki.enabled"
              @change="wikiConfigure({ enabled: ($event.target as HTMLInputElement).checked })" />
            {{ t("wiki.enabled") }}
          </label>
          <button type="button" @click="session.wikiControl('refresh')">
            <RefreshCw :size="12" /> {{ t("wiki.refresh") }}
          </button>
          <button type="button" @click="session.wikiControl('update', wikiBranch ? { branchId: wikiBranch.branchId } : {})">
            {{ t("wiki.updateNow") }}
          </button>
          <button v-if="wikiBranch?.status === 'failed'" type="button" @click="session.wikiControl('retry', { branchId: wikiBranch.branchId })">
            {{ t("wiki.retry") }}
          </button>
          <button type="button" @click="openWikiFile('summary')">{{ t("wiki.viewSummary") }}</button>
          <button type="button" @click="openWikiFile('index')">{{ t("wiki.viewIndex") }}</button>
        </div>
      </div>
    </details>

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
      <button v-if="history.hasEarlier" type="button" class="load-earlier-turns" @click="showEarlierTurns">
        {{ t('branch.loadEarlier') }}
      </button>
      <!-- Keep a few recently viewed histories mounted: switching back should
           not parse and mount all their Markdown again. Inactive views receive
           no live session updates; the cache is bounded independently of nodes. -->
      <KeepAlive :key="readingScope" :max="4">
        <BranchHistory :key="historyKey" :view-key="historyKey" :turns="visibleTurns"
          :process-messages="processMessages" :expanded-processes="expandedProcesses"
          :duration="duration" :error-text="errorText" @toggle="toggleProcess" />
      </KeepAlive>

      <div v-if="selectedRun?.status === 'running' && !showingActivity" class="process-item waiting" role="status">
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
          {{ t("branch.working", { n: activity.pass }) }}
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
              <pre v-if="item.status === 'running' || expandedLiveTools.has(item.id)">{{ (item.status === 'running' ? liveText(item.text) : item.text) || (item.status === "running" ? t("branch.running") : t("common.noOutput")) }}</pre>
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
      <div v-if="!layout.layout.composer.open" class="composer-bar">
        <button
          type="button"
          class="composer-collapsed"
          :title="composerTarget"
          @click="layout.setComposerOpen(true)"
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
        <div class="composer-head">
          <button
            type="button"
            :title="t('branch.composerClose')"
            :aria-label="t('branch.composerClose')"
            @click="layout.setComposerOpen(false)"
          >
            <ChevronDown :size="14" />
          </button>
        </div>
        <PromptComposer
          :runnable="composerRunnable"
          :model="composerModelValue"
          :thinking-level="composerThinkingValue"
          :models="session.models"
          :placeholder="composerPlaceholder"
          :running="composerRunning"
          autofocus
          :on-model="setComposerModel"
          :on-thinking="setComposerThinking"
          :on-submit="submitComposer"
          :on-stop="stopComposer"
        />
      </div>
    </footer>
  </section>
</template>
