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
});
