<script setup lang="ts">
import { Brain, Check, ChevronDown, ChevronRight, Send } from "@lucide/vue";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "reka-ui";
import { getActivePinia } from "pinia";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { THINKING_LEVELS, type RuntimeModel } from "../../shared/types";
import { useLayoutStore } from "../stores/layout";
import Button from "./ui/Button.vue";

// Shared prompt editor used by the graph draft node and the chat panel composer,
// so both input paths expose identical model/thinking controls and submit rules.
const props = defineProps<{
  runnable: boolean;
  model: RuntimeModel | null;
  thinkingLevel: string;
  models: RuntimeModel[];
  placeholder?: string;
  autofocus?: boolean;
  onModel: (model: RuntimeModel) => void;
  // explicit=true marks a user pick from the thinking menu; explicit=false marks a
  // model-driven adjustment so hosts can avoid persisting it as a user choice.
  onThinking: (level: string, explicit: boolean) => void;
  onSubmit: (text: string) => Promise<boolean>;
}>();

const { t } = useI18n();
// The composer is also mounted in isolated tests with no pinia installed; without
// an active pinia keep the default Enter-to-send behavior instead of crashing.
const layout = getActivePinia() ? useLayoutStore() : undefined;
const draft = ref("");
const busy = ref(false);
const editor = ref<HTMLTextAreaElement>();
const modelOptions = computed(() => {
  const selected = props.model;
  return selected && !props.models.some((item) => item.provider === selected.provider && item.id === selected.id)
    ? [selected, ...props.models]
    : props.models;
});
const modelProviders = computed(() =>
  [...new Set(modelOptions.value.map((item) => item.provider))].map((provider) => ({
    provider,
    models: modelOptions.value.filter((item) => item.provider === provider),
  })),
);
const selectedModel = computed(() => modelOptions.value.find((item) =>
  item.provider === props.model?.provider && item.id === props.model?.id) ?? props.model);
const thinkingLevels = computed(() => selectedModel.value?.thinkingLevels
  ?? (selectedModel.value?.reasoning === false ? ["off"] : [...THINKING_LEVELS]));

function providerName(value?: string) {
  if (!value) return "—";
  return value.toLowerCase() === "openai" ? "OpenAI" : value.charAt(0).toUpperCase() + value.slice(1);
}

function modelName(value?: RuntimeModel | null) {
  return value?.name || value?.id || "—";
}

function selectModel(model: RuntimeModel) {
  props.onModel(model);
  const levels = model.thinkingLevels ?? (model.reasoning === false ? ["off"] : [...THINKING_LEVELS]);
  if (levels.includes(props.thinkingLevel)) return;
  const requested = THINKING_LEVELS.indexOf(props.thinkingLevel as typeof THINKING_LEVELS[number]);
  props.onThinking(levels.find((level) => THINKING_LEVELS.indexOf(level as typeof THINKING_LEVELS[number]) >= requested)
    ?? levels.at(-1)
    ?? "off", false);
}

async function submit() {
  const text = draft.value.trim();
  if (!text || busy.value || !props.runnable) return;
  draft.value = "";
  busy.value = true;
  try {
    // Restore the text on failure so the user can retry after fixing the error.
    if (!(await props.onSubmit(text))) draft.value = text;
  } finally {
    busy.value = false;
  }
}

const enterToSend = computed(() => layout?.settings?.app.enterToSend !== false);
const sendHint = computed(() => t(enterToSend.value ? "draft.sendHint" : "draft.sendHintCtrl"));

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
  // Enter confirming an IME composition (e.g. pinyin) must insert text, not send the draft.
  if (event.isComposing || event.keyCode === 229) return;
  if (!enterToSend.value && !event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  void submit();
}

async function focusEditor() {
  await nextTick();
  editor.value?.focus();
}

onMounted(() => {
  if (props.autofocus) editor.value?.focus();
});

watch(() => props.autofocus, (value) => {
  if (value) void focusEditor();
});

defineExpose({ focus: focusEditor });
</script>

<template>
  <div class="prompt-composer">
    <textarea
      ref="editor"
      v-model="draft"
      :disabled="!runnable || busy"
      :placeholder="placeholder ?? t('draft.placeholder')"
      @keydown="onKeydown"
    />
    <footer>
      <span v-if="busy">{{ t("draft.working") }}</span>
      <div class="composer-settings">
      <DropdownMenuRoot :modal="false">
        <DropdownMenuTrigger as-child :disabled="!runnable || busy || !modelOptions.length">
          <button
            type="button"
            class="node-footer-select node-model-select"
            :disabled="!runnable || busy || !modelOptions.length"
            :title="`${providerName(model?.provider)} / ${modelName(model)}`"
            aria-label="Draft model"
          >
            <span>{{ providerName(model?.provider) }} / {{ modelName(model) }}</span>
            <ChevronDown :size="11" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent class="menu-content node-model-menu" align="end" :side-offset="5">
            <DropdownMenuSub v-for="group in modelProviders" :key="group.provider">
              <DropdownMenuSubTrigger class="menu-item node-model-provider" :data-model-provider="group.provider">
                <span>{{ providerName(group.provider) }}</span>
                <ChevronRight :size="13" />
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent class="menu-content node-model-menu" :side-offset="4" :align-offset="-5">
                  <DropdownMenuItem
                    v-for="item in group.models"
                    :key="item.id"
                    class="menu-item node-model-option"
                    :data-model-id="item.id"
                    @select="selectModel(item)"
                  >
                    <Check v-if="item.provider === model?.provider && item.id === model?.id" :size="12" />
                    <i v-else />
                    <span>{{ modelName(item) }}</span>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
      <DropdownMenuRoot :modal="false">
        <DropdownMenuTrigger as-child :disabled="!runnable || busy">
          <button
            type="button"
            class="node-footer-select node-thinking-select"
            :disabled="!runnable || busy"
            title="Draft thinking level"
            aria-label="Draft thinking level"
          >
            <Brain :size="12" />
            <span>{{ thinkingLevel || "off" }}</span>
            <ChevronDown :size="11" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent class="menu-content node-thinking-menu" align="end" :side-offset="5">
            <DropdownMenuItem
              v-for="level in thinkingLevels"
              :key="level"
              class="menu-item node-model-option"
              :data-thinking-level="level"
              @select="onThinking(level, true)"
            >
              <Check v-if="level === (thinkingLevel || 'off')" :size="12" />
              <i v-else />
              <span>{{ level }}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
      </div>
      <Button class="composer-submit" type="button" size="sm" :aria-label="sendHint" :disabled="!draft.trim() || busy || !runnable" @click="submit">
        <Send :size="14" />
      </Button>
    </footer>
  </div>
</template>
