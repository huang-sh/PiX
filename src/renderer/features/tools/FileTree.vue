<script setup lang="ts">
import { ChevronRight, File, Folder } from "@lucide/vue";
import type { FileNode } from "../../../shared/types";

withDefaults(
  defineProps<{ nodes: FileNode[]; depth?: number; query?: string; activePath?: string }>(),
  { depth: 0, query: "", activePath: "" },
);
const emit = defineEmits<{ open: [path: string]; expand: [node: FileNode] }>();

function toggle(event: Event, node: FileNode) {
  if ((event.currentTarget as HTMLDetailsElement).open && node.children === undefined)
    emit("expand", node);
}
</script>

<template>
  <template v-for="node in nodes" :key="node.path">
    <details
      v-if="node.kind === 'directory'"
      :data-directory-path="node.path"
      :open="Boolean(query)"
      @toggle="toggle($event, node)"
    >
      <summary :style="{ paddingLeft: `${8 + depth * 14}px` }">
        <ChevronRight class="tree-chevron" :size="13" />
        <Folder :size="14" />
        <span>{{ node.name }}</span>
      </summary>
      <FileTree
        :nodes="node.children ?? []"
        :depth="depth + 1"
        :query="query"
        :active-path="activePath"
        @open="emit('open', $event)"
        @expand="emit('expand', $event)"
      />
    </details>
    <button
      v-else
      type="button"
      class="tree-file"
      :data-file-path="node.path"
      :class="{ active: node.path === activePath }"
      :style="{ paddingLeft: `${8 + depth * 14}px` }"
      @click="emit('open', node.path)"
    >
      <File :size="14" />
      <span>{{ node.name }}</span>
    </button>
  </template>
</template>
