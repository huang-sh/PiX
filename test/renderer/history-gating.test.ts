// The operation history is an experimental module: with the setting off it
// must be inert (nothing journaled, keys untouched), and a runtime flip of the
// setting must apply immediately without losing what the module already holds.
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function boot(enabled: boolean) {
  vi.resetModules();
  setActivePinia(createPinia());
  const { useLayoutStore } = await import("../../src/renderer/stores/layout");
  const layout = useLayoutStore();
  layout.settings = { app: { experimentalHistory: enabled } } as never;
  const history = await import("../../src/renderer/experimental/history");
  const session = await import("../../src/renderer/stores/session");
  return { history, layout, store: session.useSessionStore() };
}

let lib: ReturnType<typeof vi.fn>;

beforeEach(() => {
  lib = vi.mocked(window.pix!.invoke);
  lib.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function keyEvent(): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "z" });
}

describe("experimental history gating", () => {
  it("disabled: management actions journal nothing", async () => {
    const { history, store } = await boot(false);
    lib.mockResolvedValue({ projects: [] });

    await store.pin("s.jsonl", true);
    await store.rename("s.jsonl", "New Name");
    expect(history.history.entries).toHaveLength(0);
  });

  it("disabled: undo/redo keys pass through untouched", async () => {
    const { history } = await boot(false);
    const event = keyEvent();
    expect(history.handleHistoryKeys(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it("enabled: management actions journal and undo walks", async () => {
    const { history, store } = await boot(true);
    store.sessions = [];
    lib.mockResolvedValue({ projects: [] });

    await store.pin("s.jsonl", true);
    expect(history.history.entries).toHaveLength(1);
    await history.undoSteps(1);
    expect(history.history.cursor).toBe(0);
    expect(lib).toHaveBeenLastCalledWith("library.pin", { path: "s.jsonl", pinned: false });
  });

  it("flipping the setting at runtime applies immediately", async () => {
    const { history, layout, store } = await boot(false);
    lib.mockResolvedValue({ projects: [] });

    await store.pin("s.jsonl", true);
    expect(history.history.entries).toHaveLength(0);

    layout.settings = { app: { experimentalHistory: true } } as never;
    await store.pin("s.jsonl", false);
    expect(history.history.entries).toHaveLength(1);
  });
});
