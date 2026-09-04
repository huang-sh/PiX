<script setup lang="ts">
import NodeRenderer from "markstream-vue";

withDefaults(defineProps<{
  content: string;
  customId: string;
  streaming?: boolean;
}>(), {
  streaming: false,
});
</script>

<template>
  <div class="agent-markdown" :data-streaming="streaming">
    <NodeRenderer
      :content="content"
      :custom-id="customId"
      mode="chat"
      :final="!streaming"
      :smooth-streaming="streaming ? 'auto' : false"
      :typewriter="streaming ? 'simple' : false"
      :fade="false"
      html-policy="safe"
      :render-code-blocks-as-pre="true"
    />
  </div>
</template>
