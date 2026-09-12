import { describe, expect, it } from "vitest";
import { settingsDiff } from "../../src/renderer/lib/settings-diff";

describe("settingsDiff", () => {
  it("returns nothing when the draft matches its base", () => {
    const bundle = { language: "en", app: { nested: { on: true } }, list: ["a", "b"] };
    expect(settingsDiff(bundle, structuredClone(bundle))).toEqual({});
  });

  it("reports only changed scalars", () => {
    expect(settingsDiff({ language: "zh-CN", closeToTray: true }, { language: "en", closeToTray: true }))
      .toEqual({ language: "zh-CN" });
  });

  it("descends into objects so sibling leaves survive", () => {
    const base = { compaction: { enabled: true, threshold: 100 }, warnings: { on: true } };
    const next = structuredClone(base);
    next.compaction.enabled = false;
    expect(settingsDiff(next, base)).toEqual({ compaction: { enabled: false } });
  });

  it("replaces arrays wholesale", () => {
    expect(settingsDiff({ enabledModels: ["openai/*"] }, { enabledModels: [] }))
      .toEqual({ enabledModels: ["openai/*"] });
    expect(settingsDiff({ enabledModels: ["a"] }, { enabledModels: ["a"] })).toEqual({});
  });

  it("encodes a cleared key as null so JSON transports keep the removal", () => {
    expect(settingsDiff({ enabledModels: undefined }, { enabledModels: ["a"] }))
      .toEqual({ enabledModels: null });
    expect(settingsDiff({ modelThinkingLevels: {} }, { modelThinkingLevels: { "openai/gpt": "high" } }))
      .toEqual({ modelThinkingLevels: { "openai/gpt": null } });
  });

  it("carries a type change and a removed subtree as plain values", () => {
    expect(settingsDiff({ sessionDir: ".pi/s" }, { sessionDir: { old: true } }))
      .toEqual({ sessionDir: ".pi/s" });
    expect(settingsDiff({}, { stale: { deep: 1 } })).toEqual({ stale: null });
  });
});
