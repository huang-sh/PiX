import type { PowerSaveBlocker } from "electron";

/** One desktop-owned assertion, independent of window visibility. */
export function createKeepAwake(blocker: Pick<PowerSaveBlocker, "start" | "stop">, isQuitting: () => boolean) {
  let current: { id: number; type: Parameters<PowerSaveBlocker["start"]>[0] } | undefined;
  return (active: boolean, keepScreenOn = false) => {
    if (!active) {
      if (current) {
        blocker.stop(current.id);
        current = undefined;
      }
      return;
    }
    const type = keepScreenOn ? "prevent-display-sleep" : "prevent-app-suspension";
    if (isQuitting() || current?.type === type) return;
    // Acquire before releasing: changing modes must not briefly allow sleep.
    const next = { id: blocker.start(type), type } as const;
    const previous = current;
    current = next;
    if (previous) blocker.stop(previous.id);
  };
}
