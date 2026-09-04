import { describe, expect, it, vi } from "vitest";

describe("renderer desktop API", () => {
  it("fails fast when the preload bridge is unavailable", async () => {
    const pix = window.pix;
    delete window.pix;
    vi.resetModules();

    try {
      await expect(import("../../src/renderer/api")).rejects.toThrow(
        "PiX preload API is unavailable",
      );
    } finally {
      window.pix = pix;
    }
  });
});
