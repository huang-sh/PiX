import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import type { HistoryKind } from "../../src/renderer/experimental/history/store";
import { redoSteps, resetForTest, track, undoSteps } from "../../src/renderer/experimental/history/store";
import { handleHistoryKeys } from "../../src/renderer/experimental/history/keys";

// handleHistoryKeys operates on the live history singleton; reset between tests.

function makeEvent(overrides: Record<string, unknown> = {}): KeyboardEvent {
  const base = {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: "z",
    target: null,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
  };
  const ev = new KeyboardEvent("keydown", {
    bubbles: (overrides.bubbles as boolean) ?? true,
    cancelable: (overrides.cancelable as boolean) ?? true,
  });
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (k === "bubbles" || k === "cancelable") continue;
    Object.defineProperty(ev, k, { value: v, writable: true, configurable: true });
  }
  return ev;
}

describe("handleHistoryKeys", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // The module is experimental: the key handler only runs while enabled.
    useLayoutStore().settings = { app: { experimentalHistory: true } } as never;
    resetForTest();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); resetForTest(); });

  function trackEntry(undoImpl: () => Promise<boolean> = async () => true, redoImpl: () => Promise<boolean> = async () => true) {
    const undo = vi.fn(undoImpl);
    const redo = vi.fn(redoImpl);
    const entry = track({ kind: "pin" as HistoryKind, label: "Pin", undo, redo });
    return { entry, undo, redo };
  }

  it("returns false when neither metaKey nor ctrlKey is pressed", () => {
    expect(handleHistoryKeys(makeEvent({ metaKey: false, ctrlKey: false }))).toBe(false);
  });

  it("returns false when altKey is pressed", () => {
    expect(handleHistoryKeys(makeEvent({ metaKey: true, altKey: true }))).toBe(false);
  });

  it("returns false for keys other than z", () => {
    expect(handleHistoryKeys(makeEvent({ key: "y" }))).toBe(false);
  });

  it("returns false when target is INPUT", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(handleHistoryKeys(makeEvent({ target: input, metaKey: true }))).toBe(false);
    document.body.removeChild(input);
  });

  it("returns false when target is TEXTAREA", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    expect(handleHistoryKeys(makeEvent({ target: ta, metaKey: true }))).toBe(false);
    document.body.removeChild(ta);
  });

  it("returns false when target is contentEditable", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "isContentEditable", { value: true, writable: true, configurable: true });
    document.body.appendChild(el);
    expect(handleHistoryKeys(makeEvent({ target: el, metaKey: true }))).toBe(false);
    document.body.removeChild(el);
  });

  it("returns false for bare z without modifier", () => {
    expect(handleHistoryKeys(makeEvent({ key: "z" }))).toBe(false);
  });

  it("meta+Z calls undoSteps(1), prevents default, returns true", async () => {
    const { undo } = trackEntry();
    const ev = makeEvent({ metaKey: true, key: "z", cancelable: true });
    const preventSpy = vi.spyOn(ev, "preventDefault");
    const result = handleHistoryKeys(ev);
    expect(result).toBe(true);
    expect(preventSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("ctrl+Z calls undoSteps(1), prevents default, returns true", async () => {
    const { undo } = trackEntry();
    const ev = makeEvent({ ctrlKey: true, key: "z", cancelable: true });
    const preventSpy = vi.spyOn(ev, "preventDefault");
    expect(handleHistoryKeys(ev)).toBe(true);
    expect(preventSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("meta+Shift+Z calls redoSteps(1), prevents default, returns true", async () => {
    const { redo } = trackEntry();
    // First undo so there is something to redo.
    await undoSteps(1);
    const ev = makeEvent({ metaKey: true, shiftKey: true, key: "z", cancelable: true });
    const preventSpy = vi.spyOn(ev, "preventDefault");
    expect(handleHistoryKeys(ev)).toBe(true);
    expect(preventSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("ctrl+Shift+Z calls redoSteps(1)", async () => {
    const { redo } = trackEntry();
    await undoSteps(1);
    const ev = makeEvent({ ctrlKey: true, shiftKey: true, key: "z", cancelable: true });
    expect(handleHistoryKeys(ev)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("alt+meta+Z is ignored (alt guard)", () => {
    expect(handleHistoryKeys(makeEvent({ metaKey: true, altKey: true, key: "z" }))).toBe(false);
  });

  it("lowercases the key before matching", async () => {
    const { undo } = trackEntry();
    // Uppercase Z with meta — should still trigger undo
    const ev = makeEvent({ metaKey: true, key: "Z", cancelable: true });
    const preventSpy = vi.spyOn(ev, "preventDefault");
    expect(handleHistoryKeys(ev)).toBe(true);
    expect(preventSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(undo).toHaveBeenCalledTimes(1);
  });
});
