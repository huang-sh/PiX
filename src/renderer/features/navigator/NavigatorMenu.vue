<script setup lang="ts">
import { DropdownMenuRoot } from "reka-ui";
import { onBeforeUnmount, ref } from "vue";

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
  <DropdownMenuRoot :open="open" @update:open="changed"><slot /></DropdownMenuRoot>
</template>
