import { nextTick } from "vue";
import type { Ref } from "vue";

export interface InspectorFocus {
  /** Focuses the close button after the panel has rendered. */
  open(event: MouseEvent): Promise<void>;
  /** Returns focus to the element that opened the panel. */
  restore(): void;
}

// The model and extension inspectors share one close button ref and one trigger
// because only one of them can be open at a time.
export function createInspectorFocus(closeButton: Ref<HTMLButtonElement | undefined>): InspectorFocus {
  let trigger: HTMLButtonElement | undefined;
  async function open(event: MouseEvent) {
    trigger = event.currentTarget as HTMLButtonElement;
    await nextTick();
    closeButton.value?.focus();
  }
  function restore() {
    trigger?.focus();
  }
  return { open, restore };
}
