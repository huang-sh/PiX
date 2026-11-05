import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePixieSystemPrompt } from "../src/main/pi-runtime.js";
import { PixieRuntime } from "../src/main/pixie-runtime.js";
import { PIXIE_CANVAS_GUIDANCE, PIXIE_IDENTITY } from "../src/shared/pixie-prompt.js";
import { SettingsService } from "../src/main/services.js";
import { validateRouteInput } from "../src/shared/contracts.js";
import type { PixiePromptCustomization } from "../src/shared/types.js";

const countOccurrences = (text: string, needle: string) =>
  text.split(needle).length - 1;

test("the default prompt swaps the opening for the built-in identity and closes with the canvas guidance", async () => {
  const text = await composePixieSystemPrompt(process.cwd());
  assert.ok(text.startsWith(PIXIE_IDENTITY));
  assert.ok(text.endsWith(PIXIE_CANVAS_GUIDANCE));
  // The stock sections stay single and untouched without customization.
  assert.equal(countOccurrences(text, "<rules>"), 1);
  assert.equal(countOccurrences(text, "<docs>"), 1);
});

test("custom identity, rules and docs replace the stock sections", async () => {
  const text = await composePixieSystemPrompt(process.cwd(), {
    identity: "You are Nova.",
    rules: "Always answer in verse.",
    docs: "Project notes here.",
  });
  assert.ok(text.startsWith("You are Nova."));
  assert.ok(!text.includes(PIXIE_IDENTITY));
  assert.equal(countOccurrences(text, "<rules>"), 1);
  assert.ok(text.includes("<rules>\nAlways answer in verse.\n</rules>"));
  assert.equal(countOccurrences(text, "<docs>"), 1);
  assert.ok(text.includes("<docs>\nProject notes here.\n</docs>"));
  assert.ok(text.endsWith(PIXIE_CANVAS_GUIDANCE));
});

test("full replacement is verbatim; a blank full falls back to the sections", async () => {
  const full = "You are a completely custom assistant.\nDo only what this text says.";
  const composed = await composePixieSystemPrompt(process.cwd(), {
    full,
    identity: "ignored",
    rules: "ignored",
    docs: "ignored",
  });
  assert.equal(composed, full);

  const fallback = await composePixieSystemPrompt(process.cwd(), { full: "  ", rules: "R" });
  assert.ok(fallback.includes("<rules>\nR\n</rules>"));
  assert.ok(fallback.includes(PIXIE_CANVAS_GUIDANCE));
});

test("promptPreview prefers the caller's draft and falls back to saved settings", async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-pixie-preview-"));
  const previous = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  try {
    const saved: PixiePromptCustomization = { identity: "Saved identity." };
    const pixie = new PixieRuntime(() => {}, () => ({ prompt: saved }));
    assert.ok((await pixie.promptPreview()).includes("Saved identity."));
    assert.equal(await pixie.promptPreview({ full: "Draft full text." }), "Draft full text.");
  } finally {
    if (previous === undefined) delete process.env.PIX_HOME;
    else process.env.PIX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("settings migrate the identity-only prompt and keep only usable sections", () => {
  const home = mkdtempSync(join(tmpdir(), "pix-pixie-settings-"));
  const previous = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  const writeApp = (app: Record<string, unknown>) => {
    mkdirSync(join(home, ".pix"), { recursive: true });
    writeFileSync(join(home, ".pix", "gui.settings.json"), JSON.stringify(app));
  };
  try {
    // The pre-customization identity string becomes prompt.identity as-is.
    writeApp({ pixie: { systemPrompt: "Old identity.", sprite: false } });
    let app = new SettingsService(home).bundle().app;
    assert.deepEqual(app.pixie, { sprite: false, prompt: { identity: "Old identity." } });

    // Blank or wrongly-typed sections drop; a surviving section keeps the object.
    writeApp({ pixie: { prompt: { identity: "  ", rules: 7, docs: ["x"], full: "Keep me." } } });
    app = new SettingsService(home).bundle().app;
    assert.deepEqual(app.pixie, { prompt: { full: "Keep me." } });

    // An empty migration and unusable prompt leave plain Pixie settings behind.
    writeApp({ pixie: { systemPrompt: "", prompt: "garbage", sprite: true } });
    app = new SettingsService(home).bundle().app;
    assert.deepEqual(app.pixie, { sprite: true });
  } finally {
    if (previous === undefined) delete process.env.PIX_HOME;
    else process.env.PIX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("pixie.previewPrompt accepts optional sections and rejects wrong types", () => {
  assert.deepEqual(validateRouteInput("pixie.previewPrompt", {}), {
    identity: undefined,
    rules: undefined,
    docs: undefined,
    full: undefined,
  });
  assert.deepEqual(
    validateRouteInput("pixie.previewPrompt", { identity: "Me.", rules: "R", docs: "D", full: "F" }),
    { identity: "Me.", rules: "R", docs: "D", full: "F" },
  );
  assert.throws(() => validateRouteInput("pixie.previewPrompt", { rules: 7 }), /rules/);
});
