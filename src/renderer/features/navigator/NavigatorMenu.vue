<script setup lang="ts">
import { ContextMenuRoot, DropdownMenuRoot } from "reka-ui";
import { onBeforeUnmount, ref } from "vue";

defineProps<{ context?: boolean }>();
const emit = defineEmits<{ openChange: [open: boolean] }>();
const open = ref(false);
function changed(value: boolean) {
  if (open.value === value) return;
  open.value = value;
  emit("openChange", value);
}
// A list refresh can remove the trigger without a normal menu close event.
onBeforeUnmount(() => { if (open.value) emit("openChange", false); });
</script>

<template>
  <component :is="context ? ContextMenuRoot : DropdownMenuRoot" :open="open" @update:open="changed"><slot /></component>
</template>
