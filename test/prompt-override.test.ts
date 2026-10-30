import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getSystemMessageText, type SystemMessage } from "@earendil-works/pi-ai";
import { GraphRuntime } from "../src/main/graph-runtime.js";
import { PiRuntime } from "../src/main/pi-runtime.js";
import { MainController } from "../src/main/controller.js";
import { headlessPlatform } from "../src/host/local-host.js";
import { validateRouteInput } from "../src/shared/contracts.js";
import { composeSystemPrompt, latestPromptOverride } from "../src/main/extensions/prompt-override.js";
import { projectSession } from "../src/shared/session.js";
import { PROMPT_OVERRIDE_CUSTOM_TYPE, type PromptOverrideInput, type PromptOverrideRecord, type RawSessionEntry } from "../src/shared/types.js";

const persona = "You are a laconic reviewer.";
const record = (over: Partial<PromptOverrideRecord>): PromptOverrideRecord => ({ mode: "strict", name: "reviewer", text: persona, ...over });

const options = { cwd: "/tmp/work", selectedTools: ["read"], toolSnippets: { read: "reads a file" } };

test("composeSystemPrompt composes each mode and preserves the stock sections", async () => {
  const stock = await composeSystemPrompt(options, undefined, null);
  const appended = await composeSystemPrompt(options, undefined, record({ mode: "append" }));
  assert.equal(appended.text, `${persona}\n\n${stock.text}`);
  const replaced = await composeSystemPrompt(options, undefined, record({ mode: "replace" }));
  assert.equal(replaced.preamble, persona);
  assert.deepEqual(replaced.sections, stock.sections);
  const strict = await composeSystemPrompt(options, undefined, record({ mode: "strict" }));
  assert.equal(strict.text, `${persona}\n\nCurrent working directory: /tmp/work`);
  assert.deepEqual(strict.sections, []);
  assert.deepEqual(await composeSystemPrompt(options, undefined, record({ off: true })), stock);
  assert.deepEqual(await composeSystemPrompt(options, undefined, record({ text: "  " })), stock);
  const custom = { preamble: "Custom assistant persona." };
  assert.equal((await composeSystemPrompt(options, custom, record({ mode: "replace" }))).preamble, persona);
  assert.equal((await composeSystemPrompt(options, custom, record({ mode: "append" }))).preamble,
    `${persona}\n\n${custom.preamble}`);
});

test("custom section examples remain opaque to composition and preview", async () => {
  const custom = {
    preamble: "You are <character>the Poet</character>.\n<voice>terse</voice>",
    rules: "Example:\n<docs>\nKEEP_EXAMPLE\n</docs>\n</rules>\n<rules>\nKeep this too.",
    docs: "Actual customized docs.",
  };
  const result = await composeSystemPrompt(options, custom, null);
  assert.equal(result.preamble, custom.preamble);
  assert.equal(result.sections.find(s => s.name === "rules")?.content, custom.rules);
  assert.equal(result.sections.find(s => s.name === "docs")?.content, custom.docs);
  assert.ok(result.text.includes(`<rules>\n${custom.rules}\n</rules>`));
  assert.ok(result.text.includes(`<docs>\n${custom.docs}\n</docs>`));
  const replaced = await composeSystemPrompt(options, custom, record({ mode: "replace" }));
  assert.equal(replaced.preamble, persona);
  assert.deepEqual(replaced.sections, result.sections);
});

test("customization adds sections missing from a custom base prompt", async () => {
  const result = await composeSystemPrompt({ ...options, customPrompt: "Base persona" }, { rules: "Custom rules" }, null);
  assert.equal(result.preamble, "Base persona");
  assert.deepEqual(result.sections, [
    { name: "cwd", content: "/tmp/work" }, { name: "rules", content: "Custom rules" },
  ]);
});

test("picker provenance changes neither the model prompt nor the remote runtime configuration", async () => {
  const custom = { preamble: "Same body", rules: "Keep rules" };
  for (const preamblePersona of ["second", null]) {
    assert.deepEqual(await composeSystemPrompt(options, { ...custom, preamblePersona }, null),
      await composeSystemPrompt(options, custom, null));
    assert.deepEqual(validateRouteInput("agent.control", {
      action: "setPromptCustomization", customization: { ...custom, preamblePersona },
    }), { action: "setPromptCustomization", customization: custom });
  }
});

test("prompt admission validates persona snapshots", () => {
  const input = { action: "promptAt", requestId: "persona", nodeId: null, text: "hello", promptOverride: { mode: "strict", name: "reviewer", text: persona } };
  assert.deepEqual(validateRouteInput("agent.control", input).promptOverride, input.promptOverride);
  for (const promptOverride of [null, { mode: "strict", name: "reviewer", text: " " }, { mode: "unknown", name: "reviewer", text: persona }])
    assert.throws(() => validateRouteInput("agent.control", { ...input, promptOverride }));
  assert.deepEqual(validateRouteInput("agent.control", { ...input, promptOverride: { off: true } }).promptOverride, { off: true });
});

test("pi 1.4 system prompt structure backs each mode", async () => {
  // Guards the modes against SDK changes: customPrompt must own the prefix
  // (dropping tools/rules/docs), forceSystemPrompt must replace everything,
  // and the stock preamble must stay unwrapped at the very top for append.
  const { buildSystemPrompt, buildSystemPromptState } = await import(new URL("core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
    buildSystemPrompt: (input: Record<string, unknown>) => string;
    buildSystemPromptState: (input: Record<string, unknown>) => { content: string; sections?: Record<string, string> };
  };
  const base = { cwd: "/tmp/work", selectedTools: ["read"], toolSnippets: { read: "reads a file" } };
  const stock = buildSystemPrompt(base);
  assert.ok(stock.startsWith("You are an expert coding assistant"));
  assert.ok(stock.includes("<tools>"));

  const replaced = buildSystemPromptState({ ...base, customPrompt: persona });
  assert.equal(replaced.sections?.preamble, persona);
  assert.equal(replaced.sections?.tools, undefined, "customPrompt must drop the tools section");
  assert.equal(replaced.sections?.rules, undefined, "customPrompt must drop the rules section");
  assert.equal(replaced.sections?.docs, undefined, "customPrompt must drop the docs section");
  assert.equal(replaced.sections?.cwd, "<cwd>\n/tmp/work\n</cwd>", "cwd must survive replacement");

  const forced = buildSystemPromptState({ ...base, forceSystemPrompt: persona });
  assert.equal(forced.content, persona);
  assert.equal(forced.sections, undefined);
});

test("overrides resolve by ancestry, inherit across forks, and revert with off", () => {
  const override = (id: string, parentId: string | null, data: unknown) => ({
    type: "custom", customType: PROMPT_OVERRIDE_CUSTOM_TYPE, id, parentId, timestamp: "2026-01-01", data,
  });
  const user = (id: string, parentId: string | null): RawSessionEntry => ({
    type: "message", id, parentId, timestamp: "2026-01-01", message: { role: "user", content: id },
  });
  const assistant = (id: string, parentId: string) => ({
    type: "message", id, parentId, timestamp: "2026-01-01", message: { role: "assistant", content: "ok" },
  });
  const strict = { mode: "strict", name: "reviewer", text: persona };
  const entries = [
    user("u1", null),
    assistant("a1", "u1"),
    override("o1", "a1", strict),
    user("u2", "o1"),          // runs under reviewer
    assistant("a2", "u2"),
    user("u3", "a2"),          // inherits reviewer by ancestry
    assistant("a3", "u3"),
    override("off1", "a3", { off: true }),
    user("u4", "off1"),        // back to stock
    // fork from u2's answer: inherits reviewer at the fork point
    override("o2", "a2", { mode: "append", name: "writer", text: "be terse." }),
    user("u5", "o2"),
    assistant("a5", "u5"),
    // malformed records never activate
    override("bad", "a5", { mode: "append", name: "bad" }),
    user("u6", "bad"),
  ];
  const projection = projectSession(entries, "u6");  const overrideOf = (title: string) => projection.nodes.find(node => node.title === title)?.promptOverride;
  assert.deepEqual(overrideOf("u1"), undefined);
  assert.deepEqual(overrideOf("u2"), { mode: "strict", name: "reviewer" });
  assert.deepEqual(overrideOf("u3"), { mode: "strict", name: "reviewer" });
  assert.deepEqual(overrideOf("u4"), undefined);
  assert.deepEqual(overrideOf("u5"), { mode: "append", name: "writer" });
  // The malformed record is skipped, so u6 keeps the writer ancestry.
  assert.deepEqual(overrideOf("u6"), { mode: "append", name: "writer" });
  assert.deepEqual(projection.activePromptOverride, { mode: "append", name: "writer" });
  const empty = override("empty", "a5", { mode: "strict", name: "empty", text: " " });
  assert.equal(latestPromptOverride([...entries.slice(0, -2), empty])?.name, "writer");
  // An `off` record makes the active override explicitly null (stock).
  assert.equal(projectSession(entries, "u4").activePromptOverride, null);
  // A leaf before any record resolves to undefined (never activated).
  assert.equal(projectSession(entries, "u1").activePromptOverride, undefined);
});

test("previewSystemPrompt renders without an open session", { timeout: 60000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "pix-preview-"));
  const cwd = join(home, "workspace");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "AGENTS.md"), "Always answer briefly.");
  const previous = process.env.PIX_HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PIX_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  const runtime = new PiRuntime(cwd, join(home, "sessions"), () => {}, async () => {});
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(home, { recursive: true, force: true });
  });
  const { text } = await runtime.previewSystemPrompt();
  assert.ok(text.startsWith("You are an expert coding assistant"), "stock preamble renders without a session");
  assert.ok(text.includes("<tools>"), "tool section renders from the project services");
  assert.ok(text.includes("<cwd>"), "working directory section renders");
  assert.ok(text.includes("Always answer briefly."), "project AGENTS.md is part of the preview");
  runtime.promptCustomization = { preamble: "Custom preamble", rules: "Custom rules" };
  const custom = await runtime.previewSystemPrompt();
  assert.equal(custom.preamble, "Custom preamble");
  assert.equal(custom.sections.find(section => section.name === "rules")?.content, "Custom rules");
  // The model/skills catalog may have been loaded before a style was saved.
  // Preview must read both new settings and new skills independently of it.
  await runtime.modelRuntime();
  const skillDir = join(runtime.agentDir(), "skills", "preview-style");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: preview-style\ndescription: Preview style\noutput-style: true\n---\nAnswer briefly.\n");
  writeFileSync(join(runtime.agentDir(), "settings.json"), JSON.stringify({ outputStyle: "preview-style" }));
  const styled = await runtime.previewSystemPrompt();
  assert.match(styled.sections.find(s => s.name === "addendum")!.content, /Use the preview-style skill/);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ outputStyle: "" }));
  const defaultStyle = await runtime.previewSystemPrompt();
  assert.ok(!defaultStyle.text.includes("<content_style>"), "project model default overrides the saved global style");
  assert.ok(defaultStyle.text.includes("<format_rules>"), "resetting the content style preserves file-link rules");
  // Nothing was written to disk for the throwaway session (the directory may
  // not even exist when no session has ever been created).
  const written = existsSync(join(home, "sessions"))
    ? readdirSync(join(home, "sessions")).filter(name => name.endsWith(".jsonl"))
    : [];
  assert.deepEqual(written, []);
  await runtime.create();
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ outputStyle: "preview-style" }));
  assert.ok(!(await runtime.previewSystemPrompt()).text.includes("<content_style>"), "open sessions preview their effective state until reload");
  await runtime.control({ action: "reload" });
  assert.match((await runtime.previewSystemPrompt()).sections.find(s => s.name === "addendum")!.content, /Use the preview-style skill/);
});

test("controller defaults reach background projects, future sessions and shared host views", { timeout: 60000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "pix-prompt-settings-"));
  const cwd = join(home, "workspace"), other = join(home, "other");
  mkdirSync(cwd); mkdirSync(other);
  const previous = process.env.PIX_HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PIX_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  const controller = new MainController(cwd, { ...headlessPlatform });
  const view = new MainController(cwd, { ...headlessPlatform }, controller);
  t.after(async () => {
    await controller.closeAll(); view.detach(); controller.detach();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(home, { recursive: true, force: true });
  });
  await controller.invoke("settings.update", { scope: "app", patch: { promptCustomization: { preamble: "Old preamble", rules: "Old rules" } } });
  assert.equal((await controller.projectRuntime.previewSystemPrompt()).preamble, "Old preamble");
  await controller.invoke("agent.control", { action: "newSession" });
  const background = controller.registry.liveEntries()[0]!.runtime!;
  controller.configure(other);
  await controller.invoke("agent.control", { action: "newSession" });
  await controller.invoke("settings.update", { scope: "app", patch: { promptCustomization: { rules: "New rules" } } });
  assert.deepEqual(controller.settings.bundle().app.promptCustomization, { rules: "New rules" }, "omitted preamble resets instead of merging back");
  const updated = await background.previewSystemPrompt();
  assert.ok(updated.preamble.startsWith("You are an expert coding assistant"));
  assert.equal(updated.sections.find(s => s.name === "rules")?.content, "New rules");
  controller.configure(cwd);
  assert.equal((await background.previewSystemPrompt()).text, updated.text, "restoring a project needs no renderer sync");

  // A remote client's configuration arrives before it opens any session. All
  // views share the registry's runtime factory and must share this default too.
  await view.invoke("agent.control", { action: "setPromptCustomization", customization: { preamble: "Synced host default" } });
  assert.equal((await background.previewSystemPrompt()).preamble, "Synced host default");
  await view.invoke("agent.control", { action: "newSession" });
  for (const entry of controller.registry.liveEntries())
    assert.equal((await entry.runtime!.previewSystemPrompt()).preamble, "Synced host default");
  await view.invoke("agent.control", { action: "setPromptCustomization", customization: {} });
  assert.ok((await background.previewSystemPrompt()).preamble.startsWith("You are an expert coding assistant"));
});

test("runtime persona pick rewrites the next turn and forks inherit it", { timeout: 60000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "pix-persona-"));
  const cwd = join(home, "workspace");
  const promptCwd = cwd.replace(/\\/g, "/");
  mkdirSync(cwd);
  const previous = process.env.PIX_HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PIX_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  const runtime = new GraphRuntime(cwd, join(home, "sessions"), () => {}, async () => {});
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(home, { recursive: true, force: true });
  });
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const factory = runtime.factory.bind(runtime);
  runtime.factory = pi => async args => {
    const created = await factory(pi)(args);
    created.services.modelRuntime.registerNativeProvider(faux.provider);
    return created;
  };
  await runtime.create();
  // Capture the context after the SDK's request projection, at the provider
  // boundary. Forced prompts must replace earlier system messages entirely.
  let sentSystemPrompt = "";
  let sentSystemMessageCount = 0;
  const prompt = async (text: string, nodeId: string | null, promptOverride?: PromptOverrideInput) => {
    faux.setResponses([context => {
      const systems = context.messages.filter((message: { role: string }) => message.role === "system");
      sentSystemMessageCount = systems.length;
      sentSystemPrompt = getSystemMessageText(systems.at(-1) as SystemMessage);
      return fauxAssistantMessage("done");
    }]);
    await runtime.control({ action: "promptAt", requestId: randomUUID(), nodeId, text, provider: "faux", modelId: "test", promptOverride });
    for (let i = 0; i < 500 && runtime.snapshot().graph!.runs.some(run => run.status === "running"); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    return runtime.snapshot().projection.nodes.find(node => node.title === text)!;
  };

  const root = await prompt("stock turn", null);
  assert.equal(root.promptOverride, undefined);
  assert.ok(sentSystemPrompt.startsWith("You are an expert coding assistant"));

  // Persona definitions live in desktop settings; the action carries the text.
  await runtime.control({ action: "setPromptOverride", mode: "replace", name: "reviewer", text: persona });
  const preview = await runtime.previewSystemPrompt();
  assert.ok(preview.text.startsWith(persona), "idle preview composes the pending persona");
  const under = await prompt("persona turn", root.id);
  assert.equal(sentSystemPrompt, preview.text, "preview matches the provider request");
  assert.equal(sentSystemMessageCount, 1, "the provider must not receive the old system prompt alongside the replacement");
  assert.deepEqual(under.promptOverride, { mode: "replace", name: "reviewer" });
  assert.ok(sentSystemPrompt.startsWith(persona), "the run must compose the persona");
  assert.ok(!sentSystemPrompt.includes("You are an expert coding assistant"), "replace swaps the preamble only");
  assert.ok(sentSystemPrompt.includes("<tools>"), "replace keeps every other section");

  // A fork from before the override stays stock; from after it inherits.
  const sibling = await prompt("sibling turn", root.id);
  assert.equal(sibling.promptOverride, undefined);
  const child = await prompt("child turn", under.id);
  assert.deepEqual(child.promptOverride, { mode: "replace", name: "reviewer" });

  await runtime.control({ action: "setPromptOverride", off: true });
  const off = await prompt("off turn", child.id);
  assert.equal(off.promptOverride, undefined);
  assert.ok(sentSystemPrompt.startsWith("You are an expert coding assistant"));

  // Desktop-level customization outlives persona switches: the rules section
  // swaps while the preamble stays stock.
  await runtime.control({ action: "setPromptCustomization", customization: { rules: "- Always answer in rhyme" } });
  const tuned = await prompt("tuned turn", off.id);
  assert.ok(sentSystemPrompt.startsWith("You are an expert coding assistant"));
  assert.ok(sentSystemPrompt.includes("<rules>\n- Always answer in rhyme\n</rules>"));
  assert.ok(!sentSystemPrompt.includes("Be concise"));
  assert.equal(tuned.promptOverride, undefined);
  assert.ok((await runtime.previewSystemPrompt()).text.includes("Always answer in rhyme"));

  const customization = { preamble: "CUSTOM_PERSONA_SENT_TO_PROVIDER", rules: "CUSTOM_RULES_SENT_TO_PROVIDER", docs: "CUSTOM_DOCS_SENT_TO_PROVIDER" };
  await runtime.control({ action: "setPromptCustomization", customization });
  const customizedPreview = await runtime.previewSystemPrompt();
  const customized = await prompt("all customized sections", tuned.id);
  assert.equal(sentSystemMessageCount, 1);
  assert.equal(sentSystemPrompt, customizedPreview.text, "all settings sections reach the actual provider context");
  assert.ok(sentSystemPrompt.startsWith(customization.preamble));
  assert.ok(sentSystemPrompt.includes(`<rules>\n${customization.rules}\n</rules>`));
  assert.ok(sentSystemPrompt.includes(`<docs>\n${customization.docs}\n</docs>`));
  assert.ok(!sentSystemPrompt.includes("You are an expert coding assistant"));
  assert.ok(!sentSystemPrompt.includes("Pi documentation (read only when"));
  assert.ok(!sentSystemPrompt.includes("Always answer in rhyme"));
  assert.ok(sentSystemPrompt.includes("<tools>"), "section edits preserve the dynamic tool instructions");
  assert.ok(sentSystemPrompt.includes(`<cwd>\n${promptCwd}\n</cwd>`));
  await runtime.control({ action: "setPromptCustomization", customization: {} });
  await prompt("restore all default sections", customized.id);
  assert.ok(sentSystemPrompt.startsWith("You are an expert coding assistant"));
  assert.ok(sentSystemPrompt.includes("Pi documentation (read only when"));
  for (const marker of Object.values(customization)) assert.ok(!sentSystemPrompt.includes(marker));

  // A draft attached to history applies its persona only after the branch is
  // chosen, while the main branch and other parallel drafts retain theirs.
  const fork = await prompt("explicit fork persona", root.id, { mode: "strict", name: "fork", text: "Fork persona" });
  assert.equal(sentSystemPrompt, `Fork persona\n\nCurrent working directory: ${promptCwd}`);
  assert.equal(sentSystemMessageCount, 1);
  assert.deepEqual(fork.promptOverride, { mode: "strict", name: "fork" });
  assert.equal(runtime.snapshot().projection.activePromptOverride, null);
  const continuation = await prompt("fork continuation", fork.id);
  assert.deepEqual(continuation.promptOverride, fork.promptOverride);
  assert.ok(sentSystemPrompt.startsWith("Fork persona"));
  const disabled = await prompt("fork persona off", continuation.id, { off: true });
  assert.equal(disabled.promptOverride, undefined);
  assert.ok(sentSystemPrompt.startsWith("You are an expert coding assistant"));
  const main = await prompt("main persona after first turn", tuned.id, { mode: "append", name: "main", text: "Main persona" });
  assert.deepEqual(main.promptOverride, { mode: "append", name: "main" });
  assert.ok(sentSystemPrompt.startsWith("Main persona"));
});
