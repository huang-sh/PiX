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

test("combines the selected content-style skill with PiX's format rules", () => {
  const out = appendOutputStyle(
    ["user append"],
    [{ name: "sample-style", disableModelInvocation: false }],
    settings({}, { outputStyle: "sample-style" }),
  );
  assert.equal(out.length, 2);
  assert.equal(out[0], "user append");
  assert.match(out[1]!, /^<output_style>\n/);
  assert.match(out[1]!, /<content_style>\nUse the sample-style skill listed in available_skills\.\n<\/content_style>/);
  assert.match(out[1]!, /<format_rules>\n[\s\S]*clickable Markdown links[\s\S]*<\/format_rules>\n<\/output_style>$/);
});

test("model default keeps the format rules and omits the content style", () => {
  const skills = [{ name: "i-have-adhd", disableModelInvocation: false }];
  for (const configured of [undefined, "", "   "]) {
    const out = appendOutputStyle(
      ["base"],
      skills,
      settings({}, { outputStyle: configured }),
    );
    assert.equal(out.length, 2);
    assert.equal(out[0], "base");
    assert.doesNotMatch(out[1]!, /<content_style>/);
    assert.match(out[1]!, /<format_rules>/);
    assert.ok(out[1]!.includes("[My Report.md](</absolute/path/My Project/My Report.md>)"));
    assert.ok(out[1]!.includes("[app.py:12](/absolute/path/app.py:12)"));
  }
});

test("keeps format rules when the selected skill is not in the opted-in list", () => {
  // Hand-edited settings naming an ordinary skill: the injection list only
  // ever holds opted-in skills, so the pointer never lands.
  assert.deepEqual(
    appendOutputStyle(["base"], [], settings({}, { outputStyle: "zotero-cli" })),
    appendOutputStyle(["base"], [], settings()),
  );
});

test("omits manual-only content styles the model cannot resolve", () => {
  const manualOnly = [{ name: "sample-style", disableModelInvocation: true }];
  assert.deepEqual(
    appendOutputStyle(["base"], manualOnly, settings({}, { outputStyle: "sample-style" })),
    appendOutputStyle(["base"], [], settings()),
  );
});

test("project settings override the global value", () => {
  const styled = appendOutputStyle(
    ["base"],
    [{ name: "sample-style", disableModelInvocation: false }],
    settings({ outputStyle: "sample-style" }, { outputStyle: "i-have-adhd" }),
  );
  assert.match(styled[1]!, /Use the sample-style skill/);
  assert.doesNotMatch(styled[1]!, /i-have-adhd/);
  // A blank project value also wins: unset means unset, not a fallback to global.
  assert.deepEqual(
    appendOutputStyle(["base"], [{ name: "i-have-adhd", disableModelInvocation: false }], settings({ outputStyle: "" }, { outputStyle: "i-have-adhd" })),
    appendOutputStyle(["base"], [], settings()),
  );
});
