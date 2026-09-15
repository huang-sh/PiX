import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOutputStyle,
  isOutputStyleFile,
  type OutputStyleSettings,
  type OutputStyleSkill,
} from "../src/main/output-style.js";
import { DEFAULT_OUTPUT_STYLE } from "../src/shared/skills.js";

function settings(project: Record<string, unknown> = {}, global: Record<string, unknown> = {}): OutputStyleSettings {
  return {
    getProjectSettings: () => project,
    getGlobalSettings: () => global,
  };
}

function writeSkill(root: string, name: string, frontmatter: string): OutputStyleSkill & { filePath: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  writeFileSync(filePath, `---\nname: ${name}\ndescription: d\n${frontmatter}---\n\nBody.\n`);
  return { name, filePath, disableModelInvocation: false };
}

test("a marker in the frontmatter opts a skill file in", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-output-style-"));
  try {
    assert.equal(isOutputStyleFile(writeSkill(root, "marked", "output-style: true\n").filePath), true);
    assert.equal(isOutputStyleFile(writeSkill(root, "plain", "").filePath), false);
    assert.equal(isOutputStyleFile(join(root, "nowhere", "SKILL.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appends the selected skill's name as the pointer", () => {
  const out = appendOutputStyle(
    ["user append"],
    [{ name: "sample-style", disableModelInvocation: false }],
    settings({}, { outputStyle: "sample-style" }),
  );
  assert.deepEqual(out, ["user append", "<output_style>sample-style</output_style>"]);
});

test(`defaults to ${DEFAULT_OUTPUT_STYLE} when the setting is unset or blank`, () => {
  for (const configured of [undefined, "", "   "]) {
    const out = appendOutputStyle(
      ["base"],
      [{ name: DEFAULT_OUTPUT_STYLE, disableModelInvocation: false }],
      settings({}, { outputStyle: configured ?? "" }),
    );
    assert.deepEqual(out, ["base", `<output_style>${DEFAULT_OUTPUT_STYLE}</output_style>`]);
  }
});

test("leaves the base untouched when the skill is not in the opted-in list", () => {
  // Hand-edited settings naming an ordinary skill: the injection list only
  // ever holds opted-in skills, so the pointer never lands.
  assert.deepEqual(
    appendOutputStyle(["base"], [], settings({}, { outputStyle: "zotero-cli" })),
    ["base"],
  );
});

test("leaves the base untouched for a manual-only skill the prompt cannot resolve", () => {
  const manualOnly = [{ name: DEFAULT_OUTPUT_STYLE, disableModelInvocation: true }];
  assert.deepEqual(appendOutputStyle(["base"], manualOnly, settings()), ["base"]);
});

test("project settings override the global value", () => {
  const styled = appendOutputStyle(
    ["base"],
    [{ name: "sample-style", disableModelInvocation: false }],
    settings({ outputStyle: "sample-style" }, { outputStyle: DEFAULT_OUTPUT_STYLE }),
  );
  assert.deepEqual(styled, ["base", "<output_style>sample-style</output_style>"]);
  assert.deepEqual(
    appendOutputStyle(["base"], [{ name: DEFAULT_OUTPUT_STYLE, disableModelInvocation: false }], settings({ outputStyle: "" }, {})),
    ["base", `<output_style>${DEFAULT_OUTPUT_STYLE}</output_style>`],
  );
});
