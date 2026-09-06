<script setup lang="ts">
import { Brain, Check, ChevronDown, ChevronRight, FileText, Paperclip, Send, X } from "@lucide/vue";
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
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { THINKING_LEVELS, type PromptImage, type RuntimeModel } from "../../shared/types";
import { IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, MAX_PROMPT_IMAGES, imageDataUrl, validatePromptImages } from "../../shared/images";
import { useLayoutStore } from "../stores/layout";
import { MAX_PROMPT_FILES, promptFilePath, type PromptFile } from "../lib/prompt-files";
import Button from "./ui/Button.vue";

// Shared prompt editor used by the graph draft node and the chat panel composer,
// so both input paths expose identical model/thinking controls and submit rules.
export interface ComposerDraft {
  text: string;
  images: PromptImage[];
  files?: PromptFile[];
  busy: boolean;
  readingImages: boolean;
  error: string;
}
const props = defineProps<{
  draftState?: ComposerDraft;
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
  onSubmit: (text: string, images?: PromptImage[]) => Promise<boolean>;
}>();

const { t } = useI18n();
// The composer is also mounted in isolated tests with no pinia installed; without
// an active pinia keep the default Enter-to-send behavior instead of crashing.
const layout = getActivePinia() ? useLayoutStore() : undefined;
const local = reactive<ComposerDraft>({ text: "", images: [], busy: false, readingImages: false, error: "" });
const state = computed(() => props.draftState ?? local);
const draft = computed({ get: () => state.value.text, set: value => { state.value.text = value; } });
const busy = computed({ get: () => state.value.busy, set: value => { state.value.busy = value; } });
const editor = ref<HTMLTextAreaElement>();
const imagePicker = ref<HTMLInputElement>();
const images = computed({ get: () => state.value.images, set: value => { state.value.images = value; } });
const files = computed({ get: () => state.value.files ?? [], set: value => { state.value.files = value; } });
const readingImages = computed({ get: () => state.value.readingImages, set: value => { state.value.readingImages = value; } });
const imageError = computed({ get: () => state.value.error, set: value => { state.value.error = value; } });
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
const supportsImages = computed(() => selectedModel.value?.input?.includes("image") === true);
const canAttach = computed(() => props.runnable && !busy.value && !readingImages.value);
const canSubmit = computed(() => props.runnable && !busy.value && !readingImages.value
  && !!(draft.value.trim() || images.value.length || files.value.length) && (!images.value.length || supportsImages.value));
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
  if (!canSubmit.value) return;
  const attachments = images.value.map((image) => ({ ...image }));
  const documents = files.value;
  const prompt = [text, ...documents.map(file => `Attached file: ${file.path}`)].filter(Boolean).join("\n\n");
  draft.value = "";
  images.value = [];
  files.value = [];
  busy.value = true;
  try {
    const delivered = attachments.length
      ? await props.onSubmit(prompt, attachments)
      : await props.onSubmit(prompt);
    if (delivered) {
      imageError.value = "";
    } else {
      draft.value = text;
      images.value = attachments;
      files.value = documents;
    }
  } catch (error) {
    draft.value = text;
    images.value = attachments;
    files.value = documents;
    imageError.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function addFiles(selected: File[]) {
  if (!selected.length || !canAttach.value) return;
  // Keep async reads attached to the original draft if its node/session changes.
  const target = state.value;
  imageError.value = "";
  const imageFiles = selected.filter(file => IMAGE_MIME_TYPES.includes(file.type));
  const documents = selected.filter(file => !IMAGE_MIME_TYPES.includes(file.type));
  try {
    if (imageFiles.length && !supportsImages.value) throw new Error(t("draft.imagesUnsupported"));
    if (target.images.length + imageFiles.length > MAX_PROMPT_IMAGES) throw new Error(t("draft.imagesLimit"));
    // Documents resolve to local paths synchronously; the agent reads them itself.
    const added = documents.map(promptFilePath);
    if ((target.files?.length ?? 0) + added.length > MAX_PROMPT_FILES) throw new Error(t("draft.filesLimit"));
    if (imageFiles.some(file => file.size > MAX_IMAGE_BYTES)) throw new Error(t("draft.imagesSize"));
    if (imageFiles.length) {
      readingImages.value = true;
      try {
        const images = await Promise.all(imageFiles.map((file) => new Promise<PromptImage>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ type: "image", mimeType: file.type, data: String(reader.result).split(",")[1] ?? "" });
          reader.onerror = () => reject(new Error(t("draft.imagesReadError")));
          reader.onabort = () => reject(new Error(t("draft.imagesReadError")));
          reader.readAsDataURL(file);
        })));
        target.images = validatePromptImages([...target.images, ...images]);
      } finally { target.readingImages = false; }
    }
    target.files = [...target.files ?? [], ...added];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    target.error = message.startsWith("draft.") ? t(message) : message;
  } finally {
    if (imagePicker.value) imagePicker.value.value = "";
  }
}

function pasteImages(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (!files.length) return;
  event.preventDefault();
  void addFiles(files);
}

function dropImages(event: DragEvent) {
  event.preventDefault();
  void addFiles(Array.from(event.dataTransfer?.files ?? []));
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
  <div class="prompt-composer" @paste="pasteImages" @dragover.prevent @drop.stop="dropImages">
    <input ref="imagePicker" class="composer-image-picker" type="file" multiple :disabled="!canAttach" tabindex="-1" aria-hidden="true" @change="addFiles(Array.from(($event.target as HTMLInputElement).files ?? []))" />
    <div v-if="files.length" class="composer-files">
      <div v-for="(file, index) in files" :key="index" class="composer-file" :title="file.path">
        <FileText :size="14" /><span>{{ file.name }}</span>
        <button type="button" :disabled="busy || readingImages" :aria-label="t('draft.removeFile', { name: file.name })" @click.stop="files = files.filter((_, i) => i !== index); imageError = ''"><X :size="12" /></button>
      </div>
    </div>
    <div v-if="images.length" class="composer-images">
      <figure v-for="(image, index) in images" :key="index">
        <button class="composer-image-open" type="button" :title="t('draft.previewImage', { n: index + 1 })" :aria-label="t('draft.previewImage', { n: index + 1 })" @click.stop="layout?.previewImage(image, t('draft.imageLabel', { n: index + 1 }))"><img :src="imageDataUrl(image)" :alt="t('draft.imageLabel', { n: index + 1 })" /></button>
        <button class="composer-image-remove" type="button" :disabled="busy || readingImages" :aria-label="t('draft.removeImage', { n: index + 1 })" @click.stop="images.splice(index, 1); imageError = ''"><X :size="12" /></button>
      </figure>
    </div>
    <p v-if="imageError || (images.length && !supportsImages)" class="composer-image-error" role="alert">{{ imageError || t('draft.imagesUnsupported') }}</p>
    <p v-if="readingImages" class="composer-image-status" role="status">{{ t("draft.filesReading") }}</p>
    <textarea
      ref="editor"
      v-model="draft"
      :disabled="!runnable || busy"
      :placeholder="placeholder ?? t('draft.placeholder')"
      @keydown="onKeydown"
    />
    <footer>
      <span v-if="busy">{{ t("draft.working") }}</span>
      <button class="composer-attach" type="button" :disabled="!canAttach" :title="t('draft.addFiles')" :aria-label="t('draft.addFiles')" @click="imagePicker?.click()"><Paperclip :size="16" /></button>
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
      <Button class="composer-submit" type="button" size="sm" :aria-label="sendHint" :disabled="!canSubmit" @click="submit">
        <Send :size="14" />
      </Button>
    </footer>
  </div>
</template>
