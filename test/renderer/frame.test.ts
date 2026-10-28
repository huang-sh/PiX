import { describe, expect, it, vi } from "vitest";
import {
  nextFrame,
  whenMeasured,
  whenPanelsSettle,
  whenTransitionsSettle,
  whenVisible,
} from "../../src/renderer/lib/frame";

describe("frame signals", () => {
  it("resolves nextFrame even without requestAnimationFrame", async () => {
    const raf = globalThis.requestAnimationFrame;
    // jsdom may or may not provide rAF; simulate the missing case explicitly.
    vi.stubGlobal("requestAnimationFrame", undefined);
    await expect(nextFrame(50)).resolves.toBeUndefined();
    vi.stubGlobal("requestAnimationFrame", raf);
  });

  it("resolves whenVisible immediately for a visible document", async () => {
    expect(document.hidden).toBe(false);
    await expect(whenVisible()).resolves.toBeUndefined();
  });

  it("falls back to the timeout when ResizeObserver never fires", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    const element = document.createElement("div");
    document.body.append(element);
    try {
      await expect(whenMeasured(element, 40)).resolves.toBeUndefined();
      await expect(whenPanelsSettle([{ element, collapsed: false, width: 320 }], 40)).resolves.toBeUndefined();
    } finally {
      element.remove();
      vi.unstubAllGlobals();
    }
  });

  it("settles panels that already match the target without waiting", async () => {
    const element = document.createElement("div");
    element.setAttribute("data-state", "collapsed");
    Object.defineProperty(element, "getBoundingClientRect", {
      value: () => ({ width: 0, height: 0 }),
    });
    document.body.append(element);
    try {
      const start = Date.now();
      await whenPanelsSettle([{ element, collapsed: true, width: 248 }]);
      expect(Date.now() - start).toBeLessThan(50);
    } finally {
      element.remove();
    }
  });

  it("returns from whenTransitionsSettle when no animations exist", async () => {
    await expect(whenTransitionsSettle(() => true, 100)).resolves.toBeUndefined();
  });

  it.each([
    { name: "bounded", timeout: 40, cancel: false },
    { name: "unbounded", timeout: Infinity, cancel: false },
    { name: "cancelled", timeout: Infinity, cancel: true },
  ])("honors $name transition waits", async ({ timeout, cancel }) => {
    vi.useFakeTimers();
    const originalAnimations = Object.getOwnPropertyDescriptor(document, "getAnimations");
    const element = document.createElement("div");
    class Effect { target = element; }
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    let running = true;
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let pending = Promise.resolve();
    Object.defineProperty(document, "getAnimations", { configurable: true,
      value: () => running ? [{ effect: new Effect(), finished }] : [] });
    vi.stubGlobal("KeyframeEffect", Effect);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
    try {
      let settled = false;
      pending = whenTransitionsSettle(target => target === element, timeout, cancel ? controller.signal : undefined).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).toBe(Number.isFinite(timeout));
      if (cancel) {
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(true);
      }
      running = false;
      finish();
      await pending;
      expect(settled).toBe(true);
      if (cancel) expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      running = false;
      finish();
      await pending;
      removeListener.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
      if (originalAnimations) Object.defineProperty(document, "getAnimations", originalAnimations);
      else Reflect.deleteProperty(document, "getAnimations");
    }
  });

  it("returns immediately for an already cancelled owner", async () => {
    const controller = new AbortController();
    controller.abort();
    const frame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", frame);
    try {
      await whenTransitionsSettle(() => true, Infinity, controller.signal);
      expect(frame).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("ignores finished animations retained by fill mode instead of polling them forever", async () => {
    const originalAnimations = Object.getOwnPropertyDescriptor(document, "getAnimations");
    const element = document.createElement("div");
    class Effect { target = element; }
    const getAnimations = vi.fn(() => {
      if (getAnimations.mock.calls.length > 1) throw new Error("Finished animation was polled again");
      return [{ effect: new Effect(), playState: "finished", pending: false, finished: Promise.resolve() }];
    });
    Object.defineProperty(document, "getAnimations", { configurable: true, value: getAnimations });
    vi.stubGlobal("KeyframeEffect", Effect);
    try {
      await expect(whenTransitionsSettle(target => target === element, Infinity)).resolves.toBeUndefined();
      expect(getAnimations).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      if (originalAnimations) Object.defineProperty(document, "getAnimations", originalAnimations);
      else Reflect.deleteProperty(document, "getAnimations");
    }
  });
});
