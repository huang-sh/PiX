import { historyEnabled } from "./enabled";
import { redoSteps, undoSteps } from "./store";

/**
 * Handle Cmd/Ctrl+Z (undo) and Cmd/Ctrl+Shift+Z (redo) natively.
 * Returns true when the event was consumed so the caller can skip the
 * global shortcut registry lookup.
 */
export function handleHistoryKeys(event: KeyboardEvent): boolean {
  if (!historyEnabled.value) return false;
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  const key = event.key.toLowerCase();
  if (key !== "z") return false;

  const target = event.target instanceof Element ? event.target : null;
  if (
    target?.tagName === "INPUT" ||
    target?.tagName === "TEXTAREA" ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) {
    return false;
  }

  event.preventDefault();
  void (event.shiftKey ? redoSteps(1) : undoSteps(1));
  return true;
}
