<script setup lang="ts">
import { Brain, ChevronDown, ChevronRight, ChevronUp, LoaderCircle, MessageSquare, MessageSquarePlus, Terminal } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { withoutToolLabels } from "../../../shared/session";
import type { BranchMessage, RuntimeModel } from "../../../shared/types";
import MarkdownRenderer from "../../components/MarkdownRenderer.vue";
import PromptComposer from "../../components/PromptComposer.vue";
import { useDraftSubmit } from "../../composables/useDraftSubmit";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";

const session = useSessionStore();
const layout = useLayoutStore();
const { submitDraft } = useDraftSubmit();
const { t } = useI18n();
const scroll = ref<HTMLElement>();
const followingOutput = ref(true);
let resizeObserver: ResizeObserver | undefined;

// Composer overrides follow the same inheritance rules as the graph draft node:
// undefined = inherit from the target node footer (or session runtime) until picked.
const composerModel = ref<RuntimeModel | null>();
const composerThinking = ref<string>();

const composerRunnable = computed(() =>
  Boolean(session.current?.runtime.available && !session.current.runtime.isStreaming));
const composerModelValue = computed(() => {
  if (composerModel.value !== undefined) return composerModel.value;
  return session.selectedNode?.footer?.model ?? session.current?.runtime.model ?? null;
});
const composerThinkingValue = computed(() =>
  composerThinking.value
  ?? session.selectedNode?.footer?.thinkingLevel
  ?? session.current?.runtime.thinkingLevel
  ?? "off");
const composerPlaceholder = computed(() => !composerRunnable.value
  ? t(session.current?.runtime.isStreaming ? "graph.blockedStreaming" : "graph.blockedReadonly")
  : t("draft.placeholder"));
const composerTarget = computed(() =>
  session.selectedNode
    ? t("branch.composerFrom", { title: session.selectedNode.title })
    : t("branch.composerRoot"));

watch(
  () => [session.current?.session.path, session.selectedNode?.id],
  () => {
    composerModel.value = undefined;
    composerThinking.value = undefined;
  },
);

function setComposerModel(model: RuntimeModel) {
  composerModel.value = model;
  if (model.reasoning === false) composerThinking.value = "off";
}

function setComposerThinking(level: string) {
  composerThinking.value = level;
}

// Same delivery path as the graph draft node: branch from the selected node,
// navigate the tree, apply model/thinking, and let the graph center the new node.
async function submitComposer(text: string) {
  return submitDraft(session.selectedNode?.id ?? null, text, composerModelValue.value, composerThinkingValue.value);
}

interface Turn {
  id: string;
  user?: BranchMessage;
  process: BranchMessage[];
  final?: BranchMessage;
  error?: BranchMessage;
}

const showingActivity = computed(() => Boolean(
  session.activity &&
  (!session.selectedNode || session.selectedNode.id === session.current?.projection.activeNodeId),
));

const turns = computed<Turn[]>(() => {
  const grouped: Array<{ id: string; user?: BranchMessage; body: BranchMessage[] }> = [];
  for (const original of session.selectedMessages) {
    const message = original.role === "user"
      ? original
      : { ...original, text: withoutToolLabels(original.text) };
    if (message.role === "user") {
      grouped.push({ id: message.turnId, user: message, body: [] });
    } else {
      const turn = grouped.at(-1) ?? { id: message.turnId, body: [] };
      if (!grouped.length) grouped.push(turn);
      turn.body.push(message);
    }
  }
  if (showingActivity.value && grouped.length) grouped.at(-1)!.body = [];
  return grouped.map(({ id, user, body }) => {
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
      process: body.filter((message) => message !== final && message !== error),
    };
  });
});

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
  if (root) followingOutput.value = root.scrollHeight - root.scrollTop - root.clientHeight < 48;
}

async function scrollLatest() {
  await nextTick();
  const root = scroll.value;
  if (!root) return;
  root
    .querySelectorAll<HTMLElement>(
      ".agent-process.live .process-items, .agent-process.live .process-tool[open] > pre",
    )
    .forEach((element) => (element.scrollTop = element.scrollHeight));
  if (followingOutput.value) root.scrollTop = root.scrollHeight;
}

watch(() => session.selectedNode?.id, () => {
  followingOutput.value = true;
  scrollLatest();
});

watch(() => session.pendingPrompt?.message.entryId, (entryId) => {
  if (!entryId) return;
  followingOutput.value = true;
  scrollLatest();
});

watch(
  () => [
    session.selectedMessages.length,
    session.activity?.items
      .map((item) => `${item.text.length}:${item.thinking?.length ?? 0}:${item.status}`)
      .join(":"),
  ],
  scrollLatest,
);

onMounted(() => {
  if (typeof ResizeObserver === "undefined" || !scroll.value) return;
  resizeObserver = new ResizeObserver(scrollLatest);
  resizeObserver.observe(scroll.value);
});

onBeforeUnmount(() => resizeObserver?.disconnect());
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

    <div ref="scroll" class="branch-messages" @scroll="updateScrollFollow">
      <section v-for="turn in turns" :key="turn.id" class="chat-turn">
        <article v-if="turn.user" class="branch-message user">
          <p>{{ turn.user.text || t("common.empty") }}</p>
        </article>

        <details v-if="turn.process.length || turn.final?.thinking" class="agent-process">
          <summary>
            {{ t("branch.worked", { duration: duration(turn), n: turn.process.length + (turn.final?.thinking ? 1 : 0) }) }}
            <ChevronRight class="disclosure" :size="13" />
          </summary>
          <div class="process-items">
            <template v-for="message in turn.process" :key="message.entryId">
              <details v-if="message.thinking" class="process-item process-thinking">
                <summary><Brain :size="13" /><strong>{{ t("branch.thinking") }}</strong></summary>
                <p>{{ message.thinking }}</p>
              </details>
              <details
                v-if="message.role === 'tool'"
                class="process-item process-tool"
                :class="{ error: message.isError }"
              >
                <summary>
                  <Terminal :size="13" />
                  <strong>{{ message.toolName || t("branch.tool") }}</strong>
                  <code v-if="message.toolInput" :title="message.toolInput">{{ message.toolInput }}</code>
                </summary>
                <pre>{{ message.text || t("common.noOutput") }}</pre>
              </details>
              <div v-else-if="message.text" class="process-item assistant">
                <MarkdownRenderer :content="message.text" :custom-id="message.entryId" />
              </div>
            </template>
            <details v-if="turn.final?.thinking" class="process-item process-thinking">
              <summary><Brain :size="13" /><strong>{{ t("branch.thinking") }}</strong></summary>
              <p>{{ turn.final.thinking }}</p>
            </details>
          </div>
        </details>

        <article v-if="turn.error" class="branch-message assistant error-response">
          <p class="error-message">{{ errorText(turn.error) }}</p>
        </article>

        <article v-if="turn.final" class="branch-message assistant final-response">
          <MarkdownRenderer
            :content="turn.final.text || t('common.empty')"
            :custom-id="turn.final.entryId"
          />
        </article>
      </section>

      <details
        v-if="showingActivity && session.activity"
        class="agent-process live"
        :open="session.activity.active"
        @toggle="scrollLatest()"
      >
        <summary>
          <LoaderCircle :size="14" class="spin" />
          {{ t("branch.working", { n: session.activity.pass }) }}
          <ChevronRight class="disclosure" :size="13" />
        </summary>
        <div class="process-items">
          <template v-for="item in session.activity.items" :key="item.id">
            <details
              v-if="item.thinking"
              class="process-item process-thinking"
              :open="item.status === 'running'"
              @toggle="scrollLatest()"
            >
              <summary><Brain :size="13" /><strong>{{ t("branch.thinking") }}</strong></summary>
              <p>{{ item.thinking }}</p>
            </details>
            <details
              v-if="item.kind === 'tool'"
              class="process-item process-tool"
              :class="item.status"
              :open="item.status === 'running'"
              @toggle="scrollLatest()"
            >
              <summary>
                <LoaderCircle v-if="item.status === 'running'" :size="13" class="spin" />
                <Terminal v-else :size="13" />
                <strong>{{ item.title }}</strong>
                <code v-if="item.input" :title="item.input">{{ item.input }}</code>
              </summary>
              <pre>{{ item.text || (item.status === "running" ? t("branch.running") : t("common.noOutput")) }}</pre>
            </details>
            <div v-else-if="withoutToolLabels(item.text)" class="process-item assistant">
              <MarkdownRenderer
                :content="withoutToolLabels(item.text)"
                :custom-id="item.id"
                :streaming="item.status === 'running'"
              />
            </div>
            <div v-if="item.kind === 'assistant' && item.status === 'error'" class="process-item error">
              {{ errorText(item) }}
            </div>
          </template>
          <div v-if="!session.activity.items.length" class="process-item waiting">
            {{ t("branch.waiting") }}
          </div>
        </div>
      </details>

      <p v-if="!turns.length && !showingActivity" class="empty-copy">
        {{ t("branch.selectNode") }}
      </p>
    </div>

    <footer v-if="session.current" class="chat-composer">
      <button
        v-if="!layout.layout.composer.open"
        type="button"
        class="composer-collapsed"
        :title="composerTarget"
        @click="layout.setComposerOpen(true)"
      >
        <MessageSquarePlus :size="14" />
        <span>{{ composerTarget }}</span>
        <ChevronUp :size="14" />
      </button>
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
          autofocus
          :on-model="setComposerModel"
          :on-thinking="setComposerThinking"
          :on-submit="submitComposer"
        />
      </div>
    </footer>
  </section>
</template>
