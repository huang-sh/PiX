<script setup lang="ts">
import { Brain, Check, ChevronDown, ChevronRight, ImagePlus, Send, X } from "@lucide/vue";
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
import Button from "./ui/Button.vue";

// Shared prompt editor used by the graph draft node and the chat panel composer,
// so both input paths expose identical model/thinking controls and submit rules.
export interface ComposerDraft {
  text: string;
  images: PromptImage[];
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
const canAttach = computed(() => props.runnable && !busy.value && !readingImages.value && supportsImages.value);
const canSubmit = computed(() => props.runnable && !busy.value && !readingImages.value
  && !!(draft.value.trim() || images.value.length) && (!images.value.length || supportsImages.value));
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
  draft.value = "";
  images.value = [];
  busy.value = true;
  try {
    const delivered = attachments.length
      ? await props.onSubmit(text, attachments)
      : await props.onSubmit(text);
    if (delivered) {
      imageError.value = "";
    } else {
      draft.value = text;
      images.value = attachments;
    }
  } catch (error) {
    draft.value = text;
    images.value = attachments;
    imageError.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function addImages(files: File[]) {
  if (!files.length || busy.value || readingImages.value || !props.runnable) return;
  imageError.value = "";
  if (!supportsImages.value) {
    imageError.value = t("draft.imagesUnsupported");
    return;
  }
  readingImages.value = true;
  try {
    if (images.value.length + files.length > MAX_PROMPT_IMAGES) throw new Error(t("draft.imagesLimit"));
    if (files.some((file) => !IMAGE_MIME_TYPES.includes(file.type))) throw new Error(t("draft.imagesFormat"));
    if (files.some((file) => file.size > MAX_IMAGE_BYTES)) throw new Error(t("draft.imagesSize"));
    const added = await Promise.all(files.map((file) => new Promise<PromptImage>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ type: "image", mimeType: file.type, data: String(reader.result).split(",")[1] ?? "" });
      reader.onerror = () => reject(new Error(t("draft.imagesReadError")));
      reader.onabort = () => reject(new Error(t("draft.imagesReadError")));
      reader.readAsDataURL(file);
    })));
    images.value = validatePromptImages([...images.value, ...added]);
  } catch (error) {
    imageError.value = error instanceof Error ? error.message : String(error);
  } finally {
    readingImages.value = false;
    if (imagePicker.value) imagePicker.value.value = "";
  }
}

function pasteImages(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (!files.length) return;
  event.preventDefault();
  void addImages(files);
}

function dropImages(event: DragEvent) {
  event.preventDefault();
  void addImages(Array.from(event.dataTransfer?.files ?? []));
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
    <input ref="imagePicker" class="composer-image-picker" type="file" :accept="IMAGE_MIME_TYPES.join(',')" multiple :disabled="!canAttach" tabindex="-1" aria-hidden="true" @change="addImages(Array.from(($event.target as HTMLInputElement).files ?? []))" />
    <div v-if="images.length" class="composer-images">
      <figure v-for="(image, index) in images" :key="index">
        <button class="composer-image-open" type="button" :title="t('draft.previewImage', { n: index + 1 })" :aria-label="t('draft.previewImage', { n: index + 1 })" @click.stop="layout?.previewImage(image, t('draft.imageLabel', { n: index + 1 }))"><img :src="imageDataUrl(image)" :alt="t('draft.imageLabel', { n: index + 1 })" /></button>
        <button class="composer-image-remove" type="button" :disabled="busy || readingImages" :aria-label="t('draft.removeImage', { n: index + 1 })" @click.stop="images.splice(index, 1); imageError = ''"><X :size="12" /></button>
      </figure>
    </div>
    <p v-if="imageError || (images.length && !supportsImages)" class="composer-image-error" role="alert">{{ imageError || t('draft.imagesUnsupported') }}</p>
    <p v-if="readingImages" class="composer-image-status" role="status">{{ t("draft.imagesReading") }}</p>
    <textarea
      ref="editor"
      v-model="draft"
      :disabled="!runnable || busy"
      :placeholder="placeholder ?? t('draft.placeholder')"
      @keydown="onKeydown"
    />
    <footer>
      <span v-if="busy">{{ t("draft.working") }}</span>
      <button class="composer-attach" type="button" :disabled="!canAttach" :title="t(supportsImages ? 'draft.addImages' : 'draft.imagesUnsupported')" :aria-label="t('draft.addImages')" @click="imagePicker?.click()"><ImagePlus :size="16" /></button>
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
