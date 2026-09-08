import fuzzysort from "fuzzysort";
import type { RuntimeCommand } from "../../shared/types";

export const SLASH_MENU_LIMIT = 12;

// The slash menu is open while the whole draft is a single pending command:
// "/" at the start and no whitespace yet — any space or newline closes it.
const SLASH_TRIGGER = /^\/(\S*)$/;

export function matchSlashTrigger(text: string): string | null {
  const match = text.match(SLASH_TRIGGER);
  return match ? (match[1] ?? "") : null;
}

export function filterSlashCommands(commands: readonly RuntimeCommand[], query: string): RuntimeCommand[] {
  if (!query) return [...commands];
  return fuzzysort
    .go(query, [...commands], { keys: ["name", "description"], limit: SLASH_MENU_LIMIT })
    .map((result) => result.obj);
}

export function describeCommand(
  command: RuntimeCommand,
  t: (key: string) => string,
  te: (key: string) => boolean,
): string {
  const key = `command.${command.name}`;
  return te(key) ? t(key) : command.description ?? "";
}

// Triple IME guard: isComposing, keyCode 229, plus a short window after
// compositionend — Safari delivers the closing keydown after compositionend,
// which the first two checks miss.
const IME_SETTLE_MS = 10;

export function createImeGuard() {
  let lastCompositionEnd = 0;
  return {
    onCompositionEnd() {
      lastCompositionEnd = Date.now();
    },
    isGuarded(event: KeyboardEvent) {
      return event.isComposing || event.keyCode === 229 || Date.now() - lastCompositionEnd < IME_SETTLE_MS;
    },
  };
}
