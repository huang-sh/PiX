import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryKind } from "../../src/renderer/experimental/history/store";
import { i18n } from "../../src/renderer/i18n";
import { resetForTest } from "../../src/renderer/experimental/history/store";
import HistoryPanel from "../../src/renderer/experimental/history/HistoryPanel.vue";

// resetForTest() (exported from the history module) clears all mutable state
// on the live singleton so tests share the same module instance that
// HistoryPanel.vue imports.  No vi.resetModules() needed.

async function boot() {
  resetForTest();
  setActivePinia(createPinia());
  const historyMod = await import("../../src/renderer/experimental/history/store");
  return historyMod;
}

type HistoryMod = Awaited<ReturnType<typeof boot>>;

function trackEntry(
  h: HistoryMod,
  kind: HistoryKind = "pin",
  label = "Pin session",
  undoable = true,
  undoImpl: () => Promise<boolean> = async () => true,
  redoImpl: () => Promise<boolean> = async () => true,
) {
  const undo = vi.fn(undoImpl);
  const redo = vi.fn(redoImpl);
  const entry = h.track({ kind, label, undo, redo });
  return { entry, undo, redo };
}

function trackLock(h: HistoryMod, kind: HistoryKind = "sendPrompt", label = "Send prompt") {
  return h.trackEvent({ kind, label });
}

describe("HistoryPanel", () => {
  let wrapper: ReturnType<typeof mount<HistoryPanel>>;
  let h: HistoryMod;

  beforeEach(() => { vi.useFakeTimers(); });

  afterEach(async () => {
    wrapper?.unmount();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  function mountPanel() {
    wrapper = mount(HistoryPanel, {
      attachTo: document.body,
      // Render the teleported panel inline so wrapper queries reach it.
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
  }

  it("renders empty state when no entries", async () => {
    h = await boot();
    h.togglePanel();
    mountPanel();
    expect(wrapper.get(".history-panel-empty").text()).toBe(i18n.global.t("history.panel.empty"));
  });

  it("lists entries newest-first", async () => {
    h = await boot();
    trackEntry(h, "pin", "Pin A");
    trackEntry(h, "renameSession", "Rename B");
    h.togglePanel();
    mountPanel();

    const labels = wrapper.findAll(".history-row-label").map((el) => el.text());
    expect(labels).toEqual(["Rename B", "Pin A"]);
  });

  it("applied, undone, and lock rows carry distinct classes", async () => {
    h = await boot();
    trackEntry(h, "pin", "Keep A");
    trackLock(h, "sendPrompt", "Send prompt");
    trackEntry(h, "pin", "Drop B");
    await h.undoSteps(1); // cursor=1; A[0] undoable, lock[1] not, B[2] undoable
    h.togglePanel();
    mountPanel();

    // Newest first: B (undone), lock, A (applied)
    const rows = wrapper.findAll(".history-row");
    expect(rows.at(0).classes()).toContain("history-row-undone");
    expect(rows.at(0).attributes("disabled")).toBeUndefined(); // redoable → clickable
    expect(rows.at(1).classes()).toContain("history-row-lock");
    expect(rows.at(1).attributes("disabled")).toBeDefined();
    expect(rows.at(2).classes()).toContain("history-row-applied");
    expect(["", undefined]).toContain(rows.at(2).attributes("disabled")); // undoable, not locked
  });

  it("'Current position' separator appears only when there is an undone segment", async () => {
    h = await boot();
    trackEntry(h, "pin", "A");
    trackEntry(h, "pin", "B");
    h.togglePanel();
    mountPanel();

    // All applied — no separator
    expect(wrapper.findAll(".history-separator")).toHaveLength(0);

    await h.undoSteps(1);
    // cursor=1: B undone, A applied → one "Current position" separator
    expect(wrapper.findAll(".history-separator")).toHaveLength(1);
    expect(wrapper.get(".history-separator-text").text()).toBe(
      i18n.global.t("history.panel.currentPosition"),
    );
  });

  it("clicking an applied undoable row calls undo and moves the cursor", async () => {
    h = await boot();
    const { undo } = trackEntry(h, "pin", "A");
    trackEntry(h, "pin", "B");
    expect(h.history.cursor).toBe(2);

    h.togglePanel();
    mountPanel();

    // B is newest applied (displayed first in the list)
    await wrapper.get(".history-row-applied").trigger("click");
    // undoRange walks newest-first: B.undo → cursor=1, stops (cursor-1=0 < toIdx=1)
    expect(h.history.cursor).toBe(1);
  });

  it("clicking an undone row redoes to it", async () => {
    h = await boot();
    const { redo } = trackEntry(h, "pin", "A");
    const b = trackEntry(h, "pin", "B");
    await h.undoSteps(2); // both undone, cursor=0
    expect(h.history.cursor).toBe(0);

    h.togglePanel();
    mountPanel();

    // B is the newest undone row (displayed first among undone rows)
    await wrapper.get(".history-row-undone").trigger("click");
    expect(h.history.cursor).toBe(2);
  });

  it("rows at or below the newest applied lock are disabled and do nothing when clicked", async () => {
    h = await boot();
    const { undo: undoA } = trackEntry(h, "pin", "A");
    // lockIndex scans applied [0..cursor-1=1], finds non-undoable lock at 1
    trackLock(h, "sendPrompt", "Send prompt");
    const { undo: undoB } = trackEntry(h, "pin", "B");
    await h.undoSteps(1); // cursor=1; A[0] applied, lock[1] applied, B[2] undone; lockIndex=1
    expect(h.lockIndex()).toBe(1);

    h.togglePanel();
    mountPanel();

    // A is at index 0, applied, and 0 <= lockIndex(1) → isLocked → disabled
    const appliedRows = wrapper.findAll(".history-row-applied");
    expect(appliedRows.at(0).attributes("disabled")).toBeDefined();
    await appliedRows.at(0).trigger("click");
    expect(undoA).not.toHaveBeenCalled();
  });

  it("rows are disabled while busy (gated-walk approach)", async () => {
    vi.useFakeTimers();
    h = await boot();
    let release!: () => void;
    const gateP = new Promise<void>((resolve) => { release = resolve; });
    trackEntry(h, "pin", "A", true, async () => { await gateP; return true; });
    expect(h.history.cursor).toBe(1);

    // Start the undo walk; entry.undo suspends at gateP, leaving busy=true.
    const walk = h.undoSteps(1);

    h.togglePanel();
    mountPanel();

    // With fake timers active, Vue's microtask-based DOM flush is blocked.
    // Switch to real timers briefly to let the reactive update propagate.
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));

    expect(wrapper.find(".history-row").attributes("disabled")).toBeDefined();
    await wrapper.get(".history-row").trigger("click"); // no-op

    // Switch back to fake timers and resolve the gate.
    vi.useFakeTimers();
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.history.cursor).toBe(0);
    await walk;
    vi.useRealTimers();
  });

  it("Esc key closes the panel", async () => {
    h = await boot();
    trackEntry(h);
    h.togglePanel();
    mountPanel();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(h.history.panelOpen).toBe(false);
  });

  it("close button closes the panel", async () => {
    h = await boot();
    trackEntry(h);
    h.togglePanel();
    mountPanel();

    await wrapper.get(".history-panel-close").trigger("click");
    expect(h.history.panelOpen).toBe(false);
  });

  it("meta line shows entry count and undo depth", async () => {
    h = await boot();
    trackEntry(h, "pin", "A");
    trackEntry(h, "pin", "B");
    trackEntry(h, "pin", "C");
    expect(h.undoDepth()).toBe(3); // all three applied and undoable

    h.togglePanel();
    mountPanel();

    const meta = wrapper.get(".history-panel-meta").text();
    expect(meta).toBe(
      i18n.global.t("history.panel.meta", { n: 3, depth: 3 }),
    );
  });
});
