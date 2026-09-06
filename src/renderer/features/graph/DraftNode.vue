<script setup lang="ts">
import { X } from "@lucide/vue";
import { Handle, Position } from "@vue-flow/core";
import { useI18n } from "vue-i18n";
import type { PromptImage, RuntimeModel } from "../../../shared/types";
import PromptComposer from "../../components/PromptComposer.vue";

export interface DraftNodeData {
  parentId: string | null;
  runnable: boolean;
  model: RuntimeModel | null;
  thinkingLevel: string;
  models: RuntimeModel[];
  onModel: (model: RuntimeModel) => void;
  onThinking: (level: string, explicit: boolean) => void;
  onCancel?: () => void;
  onSubmit: (text: string, images?: PromptImage[]) => Promise<boolean>;
}

defineProps<{ id: string; data: DraftNodeData }>();
const { t } = useI18n();
</script>

<template>
  <article class="draft-node nodrag nowheel" @click.stop>
    <Handle v-if="data.parentId" type="target" :position="Position.Left" />
    <header>
      <span><i />{{ t("draft.title") }}</span>
      <button v-if="data.onCancel" type="button" :title="t('draft.close')" @click="data.onCancel">
        <X :size="14" />
      </button>
    </header>
    <PromptComposer
      :runnable="data.runnable"
      :model="data.model"
      :thinking-level="data.thinkingLevel"
      :models="data.models"
      :placeholder="data.runnable ? t('draft.placeholder') : t('graph.blockedReadonly')"
      autofocus
      :on-model="data.onModel"
      :on-thinking="data.onThinking"
      :on-submit="data.onSubmit"
    />
  </article>
</template>
