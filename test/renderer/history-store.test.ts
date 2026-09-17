import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryKind } from "../../src/renderer/experimental/history/store";
import { i18n } from "../../src/renderer/i18n";

// The history module is a run-scoped singleton, so every test grabs a fresh
// instance via vi.resetModules + dynamic import.

function kind(): HistoryKind {
  return "pin";
}

async function boot() {
  vi.resetModules();
  return await import("../../src/renderer/experimental/history/store");
}

type HistoryMod = Awaited<ReturnType<typeof boot>>;

/** Record one undoable entry with scripted undo/redo closures. */
function recordEntry(
  h: HistoryMod,
  undoImpl: () => Promise<boolean> = async () => true,
  redoImpl: () => Promise<boolean> = async () => true,
) {
  const undo = vi.fn(undoImpl);
  const redo = vi.fn(redoImpl);
  const entry = h.track({
    kind: kind(),
    label: "Pin session",
    undo,
    redo,
  });
  return { entry, undo, redo };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("history journal", () => {
  it("tracks an entry at the tail and undo/redo walk the cursor", async () => {
    const h = await boot();
    const { undo, redo, entry } = recordEntry(h);
    expect(h.history.entries).toHaveLength(1);
    expect(h.history.cursor).toBe(1);
    expect(h.history.entries[0]?.id).toBe(entry.id);

    await h.undoSteps(1);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(h.history.cursor).toBe(0);

    await h.redoSteps(1);
    expect(redo).toHaveBeenCalledTimes(1);
    expect(h.history.cursor).toBe(1);
  });

  it("undoes multiple entries LIFO, newest first", async () => {
    const h = await boot();
    const a = recordEntry(h, async () => true);
    const b = recordEntry(h, async () => true);
    const c = recordEntry(h, async () => true);
    expect(h.history.cursor).toBe(3);

    await h.undoSteps(2);
    // Newest two undone, in reverse order.
    expect(c.undo).toHaveBeenCalledTimes(1);
    expect(b.undo).toHaveBeenCalledTimes(1);
    expect(a.undo).not.toHaveBeenCalled();
    expect(h.history.cursor).toBe(1);
  });

  it("truncates the redo segment when a fresh op lands after an undo", async () => {
    const h = await boot();
    const a = recordEntry(h);
    const b = recordEntry(h);
    await h.undoSteps(1);
    expect(h.history.cursor).toBe(1);

    const c = recordEntry(h); // a new operation truncates the undone entry
    expect(h.history.cursor).toBe(2);
    expect(h.history.entries.map((e) => e.id)).toEqual([a.entry.id, c.entry.id]);
  });

  it("stops the undo walk at a lock entry and toasts the locked message", async () => {
    const h = await boot();
    const first = recordEntry(h);
    h.trackEvent({ kind: "sendPrompt", label: "Send prompt" });
    expect(h.history.cursor).toBe(2);
    expect(h.history.entries[1]?.undoable).toBe(false);

    const ret = await h.undoSteps(1);
    expect(ret).toBe(false);
    expect(first.undo).not.toHaveBeenCalled();
    expect(h.history.cursor).toBe(2);
    expect(h.history.toast).toBe(i18n.global.t("history.locked", { label: "Send prompt" }));
  });

  it("undoTo walks down to the named entry inclusive; unknown id returns false", async () => {
    const h = await boot();
    const a = recordEntry(h);
    const b = recordEntry(h);
    const c = recordEntry(h);

    const ret = await h.undoTo(a.entry.id);
    expect(ret).toBe(true);
    expect(a.undo).toHaveBeenCalledTimes(1);
    expect(b.undo).toHaveBeenCalledTimes(1);
    expect(c.undo).toHaveBeenCalledTimes(1);
    expect(h.history.cursor).toBe(0);

    const missing = await h.undoTo(9999);
    expect(missing).toBe(false);
  });

  it("redoTo walks the entry from an undone position", async () => {
    const h = await boot();
    const a = recordEntry(h);
    const b = recordEntry(h);
    await h.undoSteps(2);
    expect(h.history.cursor).toBe(0);

    const ret = await h.redoTo(b.entry.id);
    expect(ret).toBe(true);
    expect(b.redo).toHaveBeenCalledTimes(1);
    expect(h.history.cursor).toBe(2);
  });

  it("marks an entry failed and toasts the reason when its undo throws", async () => {
    const h = await boot();
    const { entry } = recordEntry(h, async () => {
      throw new Error("server 500");
    });
    await h.undoSteps(1);
    expect(entry.failed).toBe(true);
    expect(h.history.cursor).toBe(1);
    expect(h.history.toast).toBe(i18n.global.t("history.undoFailed", { reason: "server 500" }));
  });

  it("a mid-walk failure toasts the reason, not the earlier success", async () => {
    const h = await boot();
    const bad = recordEntry(h, async () => {
      throw new Error("boom");
    });
    recordEntry(h); // undoes fine; LIFO walks it first
    await h.undoSteps(2);
    expect(bad.entry.failed).toBe(true);
    expect(h.history.cursor).toBe(1);
    // The failure must not be overwritten by the step that did succeed.
    expect(h.history.toast).toBe(i18n.global.t("history.undoFailed", { reason: "boom" }));
    expect(h.history.toast).not.toContain("Undid");
  });

  it("appends an op that lands mid-walk only after the walk finishes", async () => {
    const h = await boot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = recordEntry(h, async () => {
      await gate;
      return true;
    });
    const walk = h.undoSteps(1); // in flight: its cursor write is still pending
    const b = recordEntry(h); // must queue behind the walk, not cut in front
    release();
    await walk;
    // The deferred append lands a couple of microtasks after the walk resolves.
    await vi.advanceTimersByTimeAsync(1);
    expect(a.undo).toHaveBeenCalledTimes(1);
    // The walk finished first, so a is undone; b then truncates it like any
    // new op after an undo.
    expect(h.history.entries.map((e) => e.id)).toEqual([b.entry.id]);
    expect(h.history.cursor).toBe(1);
  });

  it("stops silently and keeps the entry clean when undo returns false", async () => {
    const h = await boot();
    const { entry } = recordEntry(h, async () => false);
    const ret = await h.undoSteps(1);
    expect(ret).toBe(false);
    expect(entry.failed).toBe(false);
    expect(h.history.cursor).toBe(1);
  });

  it("caps the journal at 200 entries", async () => {
    const h = await boot();
    for (let i = 0; i < 205; i += 1) recordEntry(h);
    expect(h.history.entries).toHaveLength(200);
    expect(h.history.cursor).toBe(200);
  });
});
