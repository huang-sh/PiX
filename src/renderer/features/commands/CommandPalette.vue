<script setup lang="ts">
import { Search } from "@lucide/vue";
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { APP_COMMANDS } from "../../../shared/commands";
import type { RuntimeCommand } from "../../../shared/types";
import { useLayoutStore } from "../../stores/layout";
import { useSessionStore } from "../../stores/session";

const emit = defineEmits<{ run: [name: string] }>();
const layout = useLayoutStore();
const session = useSessionStore();
const { t, te } = useI18n();
const search = ref<HTMLInputElement>();
const commands = computed(() => {
  const map = new Map<string, RuntimeCommand>();
  [...session.commands, ...APP_COMMANDS].forEach((command) => map.set(command.name, command));
  const query = layout.commandQuery.toLowerCase();
  return [...map.values()]
    .filter((command) =>
      !query || `${command.name} ${command.description ?? ""}`.toLowerCase().includes(query),
    )
    .slice(0, 18);
});

function describe(command: RuntimeCommand) {
  const key = `command.${command.name}`;
  return te(key) ? t(key) : command.description ?? "";
}

watch(
  () => layout.commandOpen,
  async (open) => {
    if (open) {
      await nextTick();
      search.value?.focus();
    } else layout.commandQuery = "";
  },
);

function run(name: string) {
  layout.commandOpen = false;
  emit("run", name);
}
</script>

<template>
  <DialogRoot :open="layout.commandOpen" @update:open="layout.commandOpen = $event">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="command-dialog">
        <DialogTitle class="sr-only">{{ t("palette.title") }}</DialogTitle>
        <label>
          <Search :size="18" />
          <input ref="search" v-model="layout.commandQuery" :placeholder="t('palette.placeholder')" />
        </label>
        <div class="command-list">
          <button v-for="command in commands" :key="command.name" type="button" @click="run(command.name)">
            <span><strong>/{{ command.name }}</strong><small>{{ describe(command) }}</small></span>
            <em>{{ command.source }}</em>
          </button>
        </div>
        <footer><span><kbd>Esc</kbd> {{ t("palette.close") }}</span></footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
