import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { CANVAS_CORE_TOOLS, CANVAS_SKILLS, CANVAS_TOOLS, canvasToolName } from "../src/shared/canvas.js";
import { readPixieSkill } from "../src/main/pixie-skills.js";
import { parseSkillDocument } from "../src/main/skill-files.js";
import { skillBodyError, skillDescriptionError, skillNameError } from "../src/shared/skills.js";

const moduleDir = dirname(fileURLToPath(new URL("../src/main/pixie-extension.js", import.meta.url)));

test("Pixie skills are valid, cover each auxiliary tool once and only read bundled instructions", async () => {
  const names = CANVAS_CORE_TOOLS.map(tool => tool.name);
  for (const skill of CANVAS_SKILLS) {
    const loaded = await readPixieSkill(skill.name, moduleDir);
    const document = parseSkillDocument(loaded.content);
    assert.equal(document.name, skill.name);
    assert.equal(skillNameError(document.name), undefined);
    assert.equal(skillDescriptionError(document.description), undefined);
    assert.equal(skillBodyError(document.body), undefined);
    for (const name of loaded.tools) assert.ok(document.body.includes(name), `${name} missing from skill`);
    assert.deepEqual(loaded.tools, skill.actions.map(canvasToolName));
    names.push(...loaded.tools);
  }
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), CANVAS_TOOLS.map(tool => tool.name).sort());
  await assert.rejects(readPixieSkill("../../auth.json", moduleDir), /Unknown Pixie skill/);
});

test("Pixie skills load from packaged Electron and server layouts", async t => {
  const root = mkdtempSync(join(tmpdir(), "pixie-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../../pixie-skills", import.meta.url));
  for (const layout of [
    { resource: join(root, "resources"), module: join(root, "resources", "app.asar", "out", "main", "chunks") },
    { resource: join(root, "server"), module: join(root, "server", "dist", "main") },
  ]) {
    mkdirSync(join(layout.resource, "skills"), { recursive: true });
    cpSync(source, join(layout.resource, "pixie-skills"), { recursive: true });
    assert.equal((await readPixieSkill("canvas-queue", layout.module)).skill, "canvas-queue");
  }
});
