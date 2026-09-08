<script setup lang="ts">
import { PopoverContent, PopoverRoot } from "reka-ui";
import { ref, watch } from "vue";
import type { RuntimeCommand } from "../../shared/types";

const props = defineProps<{
  commands: RuntimeCommand[];
  activeIndex: number;
  anchor: HTMLElement | null;
  describe: (command: RuntimeCommand) => string;
  label: string;
  emptyLabel: string;
}>();
const emit = defineEmits<{ select: [index: number]; hover: [index: number] }>();

const scrollEl = ref<HTMLElement>();

// Focus stays in the textarea, so the browser never auto-reveals the
// highlighted option — drive it manually like any aria-activedescendant listbox.
function revealActive() {
    const option = scrollEl.value?.querySelector(`[data-index="${props.activeIndex}"]`);
    // jsdom lacks scrollIntoView; the guard keeps component tests mountable.
    if (option && typeof option.scrollIntoView === "function") option.scrollIntoView({ block: "nearest" });
}
watch(() => props.activeIndex, revealActive, { flush: "post" });
// Collision handling can shrink the menu after the keyboard selection changes.
watch(scrollEl, (element, _previous, onCleanup) => {
  if (!element || typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(revealActive);
  observer.observe(element);
  onCleanup(() => observer.disconnect());
});

function badge(command: RuntimeCommand) {
  return command.source === "prompt" || command.source === "skill" || command.source === "extension"
    ? command.source
    : "";
}
</script>

<template>
  <PopoverRoot v-if="anchor" :open="true">
    <Teleport to="body">
      <PopoverContent
        id="slash-menu-listbox"
        class="slash-menu"
        :reference="anchor"
        side="top"
        align="start"
        :side-offset="6"
        :collision-padding="8"
        update-position-strategy="always"
        role="listbox"
        :aria-label="label"
        @open-auto-focus.prevent
        @close-auto-focus.prevent
        @interact-outside.prevent
        @mousedown.prevent
      >
        <div ref="scrollEl" class="slash-menu-scroll">
          <button
            v-for="(command, index) in commands"
            :id="`slash-option-${index}`"
            :key="`${command.source}:${command.name}`"
            type="button"
            role="option"
            class="menu-item slash-item"
            :data-index="index"
            :data-highlighted="index === activeIndex ? '' : undefined"
            :aria-selected="index === activeIndex"
            @mousemove="emit('hover', index)"
            @click="emit('select', index)"
          >
            <span class="slash-name">/{{ command.name }}</span>
            <span class="slash-desc">{{ describe(command) }}</span>
            <span v-if="command.argumentHint" class="slash-hint">{{ command.argumentHint }}</span>
            <span v-if="badge(command)" class="slash-badge">{{ badge(command) }}</span>
          </button>
          <p v-if="!commands.length" class="slash-empty">{{ emptyLabel }}</p>
        </div>
      </PopoverContent>
    </Teleport>
  </PopoverRoot>
</template>
