import { nextTick } from "vue";
import type { ComponentPublicInstance } from "vue";

export interface InspectorFocus {
  /** Focuses the panel's close button once it has rendered. */
  open(event: MouseEvent): Promise<void>;
  /** Returns focus to the element that opened the panel. */
  restore(): void;
  /** Bound as the close button's `:ref`; only one inspector is mounted. */
  register(el: Element | ComponentPublicInstance | null): void;
}

// The model and extension inspectors share one trigger and one close button
// because only one of them can be open at a time.
export function createInspectorFocus(): InspectorFocus {
  let closeButton: HTMLButtonElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  async function open(event: MouseEvent) {
    trigger = event.currentTarget as HTMLButtonElement;
    await nextTick();
    closeButton?.focus();
  }
  function restore() {
    trigger?.focus();
  }
  function register(el: Element | ComponentPublicInstance | null) {
    closeButton = el instanceof HTMLButtonElement ? el : undefined;
  }
  return { open, restore, register };
}
