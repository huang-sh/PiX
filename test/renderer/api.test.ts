import { describe, expect, it, vi } from "vitest";

describe("renderer desktop API", () => {
  it("falls back to the web socket client when the preload bridge is absent", async () => {
    const pix = window.pix;
    delete window.pix;
    vi.resetModules();

    try {
      const mod = await import("../../src/renderer/api");
      expect(mod.desktop.invoke).toEqual(expect.any(Function));
      expect(mod.desktop.filePath(new File([], "x"))).toBe("");
    } finally {
      window.pix = pix;
    }
  });
});
