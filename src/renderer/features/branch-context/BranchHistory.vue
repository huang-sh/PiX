<script setup lang="ts">
import { Brain, ChevronRight, LoaderCircle, Terminal } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { BranchMessage } from "../../../shared/types";
import MarkdownRenderer from "../../components/MarkdownRenderer.vue";
import MessageImages from "../../components/MessageImages.vue";
import CopyButton from "../../components/CopyButton.vue";
import FileChanges from "./FileChanges.vue";
import type { FileChange } from "../../../shared/file-changes";

export interface HistoryTurn {
  id: string;
  user?: BranchMessage;
  process: BranchMessage[];
  /** The turn's last assistant message: its text is the answer, its isError the failure. */
  terminal?: BranchMessage;
  running?: boolean;
  fileChanges?: FileChange[];
}

defineProps<{
  viewKey: string;
  sessionPath?: string;
  turns: HistoryTurn[];
  processMessages: Map<string, BranchMessage[]>;
  expandedProcesses: Set<string>;
  duration: (turn: HistoryTurn) => string;
  errorText: (message: { errorMessage?: string }) => string;
}>();
const emit = defineEmits<{ toggle: [id: string, event: Event, viewKey: string] }>();
const { t } = useI18n();
</script>

<template>
  <div class="branch-history" style="display: contents">
      <section v-for="turn in turns" :key="turn.id" class="chat-turn">
        <article v-if="turn.user" class="branch-message user">
          <p v-if="turn.user.text || !turn.user.images?.length">{{ turn.user.text || t("common.empty") }}</p>
          <MessageImages :images="turn.user.images" />
          <CopyButton :text="turn.user.text" />
        </article>

        <details v-if="turn.process.length || turn.terminal?.thinking" class="agent-process"
          :open="expandedProcesses.has(turn.id)" @toggle="emit('toggle', turn.id, $event, viewKey)">
          <summary>
            <template v-if="turn.running"><LoaderCircle :size="14" class="spin" /> {{ t('branch.running') }}</template>
            <template v-else>{{ t("branch.worked", { duration: duration(turn), n: turn.process.length + (turn.terminal?.thinking ? 1 : 0) }) }}</template>
            <ChevronRight class="disclosure" :size="13" />
          </summary>
          <div v-if="expandedProcesses.has(turn.id)" class="process-items">
            <template v-for="message in processMessages.get(turn.id)" :key="message.entryId">
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
                <CopyButton :text="message.text" />
              </div>
            </template>
            <details v-if="turn.terminal?.thinking" class="process-item process-thinking">
              <summary><Brain :size="13" /><strong>{{ t("branch.thinking") }}</strong></summary>
              <p>{{ turn.terminal.thinking }}</p>
            </details>
          </div>
        </details>

        <article v-if="turn.terminal?.isError" class="branch-message assistant error-response">
          <p class="error-message">{{ errorText(turn.terminal) }}</p>
          <CopyButton :text="errorText(turn.terminal)" />
        </article>

        <article v-if="turn.terminal?.text" class="branch-message assistant"
          :class="turn.running || turn.terminal.isError ? 'progress-response' : 'final-response'">
          <MarkdownRenderer :content="turn.terminal.text" :custom-id="turn.terminal.entryId" />
          <CopyButton :text="turn.terminal.text" />
        </article>
        <FileChanges v-if="!turn.running && turn.fileChanges?.length && sessionPath" :changes="turn.fileChanges" :session-path="sessionPath" />
      </section>
  </div>
</template>
