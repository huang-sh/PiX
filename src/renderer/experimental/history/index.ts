/**
 * Facade of the experimental operation-history module — the only surface the
 * host app imports. `track`/`trackEvent` no-op while the module is disabled so
 * instrumentation call sites need no conditionals; undo/redo still reach the
 * entries recorded while it was enabled.
 */
import { historyEnabled } from "./enabled";
import * as store from "./store";

export { historyEnabled };
export { handleHistoryKeys } from "./keys";
export { default as HistoryPanel } from "./HistoryPanel.vue";
export { default as HistoryButton } from "./HistoryButton.vue";
export { history, undoSteps, redoSteps, undoTo, redoTo, undoDepth, redoDepth, lockIndex, togglePanel, closePanel, resetForTest } from "./store";
export type { HistoryEntry, HistoryKind } from "./store";

export function track(spec: Parameters<typeof store.track>[0]): ReturnType<typeof store.track> | undefined {
  if (!historyEnabled.value) return;
  return store.track(spec);
}

export function trackEvent(spec: Parameters<typeof store.trackEvent>[0]): ReturnType<typeof store.trackEvent> | undefined {
  if (!historyEnabled.value) return;
  return store.trackEvent(spec);
}
