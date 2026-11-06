import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePixieSystemPrompt } from "../src/main/pi-runtime.js";
import { PixieRuntime } from "../src/main/pixie-runtime.js";
import { PIXIE_CANVAS_GUIDANCE, PIXIE_DOCS, PIXIE_IDENTITY, PIXIE_RULES } from "../src/shared/pixie-prompt.js";
import { CANVAS_TOOLS, PIXIE_DEFAULT_TOOLS } from "../src/shared/canvas.js";
import { SettingsService } from "../src/main/services.js";
import { validateRouteInput } from "../src/shared/contracts.js";
import type { PixiePromptCustomization } from "../src/shared/types.js";

const countOccurrences = (text: string, needle: string) =>
  text.split(needle).length - 1;

test("a prompt reload requested during a turn is applied once the turn finishes", async t => {
  const home = mkdtempSync(join(tmpdir(), "pixie-pending-reload-")), previous = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const runtime = new PixieRuntime(() => {}, () => ({}));
  t.mock.getter(runtime["rpc"], "running", () => true);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(runtime as any, "sendTurn", async () => { await gate; return {}; });
  const stop = t.mock.method(runtime["rpc"], "stop", async () => {});
  const start = t.mock.method(runtime as any, "startAgent", async () => {});
  const request = t.mock.method(runtime["rpc"], "request", async () => ({ sessionFile: "/saved/pixie.jsonl" }));
  const sending = runtime.send({ text: "ongoing work" });
  await runtime.reload();
  await runtime.reload();
  assert.equal(stop.mock.callCount(), 0, "never interrupt active work");
  finish();
  await sending;
  assert.equal(start.mock.callCount(), 1, "coalesce saved changes and reload after the turn");
  assert.ok(request.mock.calls.some(call => call.arguments[0]?.type === "switch_session"
    && call.arguments[0]?.sessionPath === "/saved/pixie.jsonl"));
  assert.equal(runtime.busy, false);
  request.mock.mockImplementation(async () => { throw new Error("state unavailable"); });
  await assert.rejects(runtime.reload(), /state unavailable/);
  assert.equal(stop.mock.callCount(), 1, "never discard a conversation whose resume path could not be read");
});

test("the default prompt uses Pi sections with coordination instructions instead of executor instructions", async () => {
  const text = await composePixieSystemPrompt(process.cwd());
  assert.ok(text.startsWith(PIXIE_IDENTITY));
  assert.ok(text.endsWith(PIXIE_CANVAS_GUIDANCE));
  assert.ok(text.includes(`<rules>\n${PIXIE_RULES}\n</rules>`));
  assert.ok(text.includes(`<docs>\n${PIXIE_DOCS}\n</docs>`));
  const tools = text.match(/<tools>\n([\s\S]*?)\n<\/tools>/)?.[1];
  for (const tool of PIXIE_DEFAULT_TOOLS) assert.ok(tools?.includes(`- ${tool.name}:`));
  for (const tool of CANVAS_TOOLS.filter(tool => !PIXIE_DEFAULT_TOOLS.includes(tool)))
    assert.ok(!text.includes(tool.name), `${tool.name} must stay in its on-demand skill`);
  assert.doesNotMatch(tools!, /- canvas:/);
  assert.doesNotMatch(tools!, /- (bash|read|edit|write):/);
  assert.doesNotMatch(text, /Use bash for file operations|Help users inspect files, run commands, and modify code/);
  // The subprocess owns the live context sections; composition must not duplicate them.
  assert.doesNotMatch(text, /<(cwd|skills|project_context)>/);
  assert.equal(countOccurrences(text, "<rules>"), 1);
  assert.equal(countOccurrences(text, "<docs>"), 1);
});

test("custom identity, rules and docs replace the coordination defaults", async () => {
  const text = await composePixieSystemPrompt(process.cwd(), {
    identity: "You are Nova.",
    rules: "Always answer in verse.",
    docs: "Project notes here.",
  });
  assert.ok(text.startsWith("You are Nova."));
  assert.ok(!text.includes(PIXIE_IDENTITY));
  assert.ok(!text.includes(PIXIE_RULES));
  assert.ok(!text.includes(PIXIE_DOCS));
  assert.equal(countOccurrences(text, "<rules>"), 1);
  assert.ok(text.includes("<rules>\nAlways answer in verse.\n</rules>"));
  assert.equal(countOccurrences(text, "<docs>"), 1);
  assert.ok(text.includes("<docs>\nProject notes here.\n</docs>"));
  assert.ok(text.endsWith(PIXIE_CANVAS_GUIDANCE));
});

test("blank sections restore defaults and XML-like customization stays opaque", async () => {
  const defaults = await composePixieSystemPrompt(process.cwd());
  assert.equal(await composePixieSystemPrompt(process.cwd(), { identity: " ", rules: " ", docs: " " }), defaults);
  const identity = "Coordinator.\n\nExample: <rules>not a section</rules>";
  const rules = "Preserve this example: </rules><docs>example</docs>";
  const text = await composePixieSystemPrompt(process.cwd(), { identity, rules });
  assert.ok(text.startsWith(identity));
  assert.ok(text.includes(`<rules>\n${rules}\n</rules>`));
  assert.ok(text.includes(`<docs>\n${PIXIE_DOCS}\n</docs>`));
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
