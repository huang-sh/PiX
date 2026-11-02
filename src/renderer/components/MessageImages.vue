<script setup lang="ts">
import type { SessionImage } from "../../shared/types";
import MessageImage from "./MessageImage.vue";
defineProps<{ images?: SessionImage[] }>();
</script>

<template>
  <div v-if="images?.length" class="message-images">
    <MessageImage v-for="(image, index) in images" :key="index" :image="image" :index="index" />
  </div>
</template>

<style scoped>
.message-images { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; min-width: 0; }
</style>
