import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuiltinSkills } from "../src/main/builtin-skills.js";
import { parseSkillDocument } from "../src/main/skill-files.js";
import { skillBodyError, skillDescriptionError, skillNameError } from "../src/shared/skills.js";

function skillMarker(root: string, ...segments: string[]): string {
  const skillsDir = join(root, ...segments);
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: marker\ndescription: Marker skill.\n---\nBody.\n");
  return skillsDir;
}

test("finds the bundled skills in the packaged app layout", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-builtin-skills-"));
  try {
    // Mirrors electron-builder extraResources "skills" next to the app asar.
    const skillsDir = skillMarker(root, "resources", "skills");
    assert.deepEqual(
      resolveBuiltinSkills(join(root, "resources", "app.asar", "out", "main")),
      [skillsDir],
    );
    // Shared runtime code lands in out/main/chunks for multiple entries.
    assert.deepEqual(
      resolveBuiltinSkills(join(root, "resources", "app.asar", "out", "main", "chunks")),
      [skillsDir],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds the bundled skills in the dev and server layouts beside the app", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-builtin-skills-"));
  try {
    const skillsDir = skillMarker(root, "skills");
    for (const moduleDir of [
      join(root, "out", "main"), // dev Electron run
      join(root, "dist", "main"), // remote server host (server/dist/main)
    ]) {
      assert.deepEqual(resolveBuiltinSkills(moduleDir), [skillsDir]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns empty when no bundled skills tree exists on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-builtin-skills-"));
  try {
    assert.deepEqual(resolveBuiltinSkills(join(root, "out", "main")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every bundled skill directory is a spec-valid document pi can load", () => {
  const [bundledRoot] = resolveBuiltinSkills(dirname(fileURLToPath(import.meta.url)));
  assert.ok(bundledRoot, "bundled skills tree not found beside the test output");
  const entries = readdirSync(bundledRoot).filter((name) => !name.startsWith("."));
  assert.ok(entries.length > 0, "no bundled skills installed");
  for (const name of entries) {
    const skillDir = join(bundledRoot, name);
    assert.ok(statSync(skillDir).isDirectory(), `${name} is not a skill directory`);
    const document = parseSkillDocument(
      readdirSync(skillDir).some((file) => file === "SKILL.md")
        ? readFileSync(join(skillDir, "SKILL.md"), "utf8")
        : assert.fail(`${name} has no SKILL.md`),
    );
    assert.equal(document.name, name, "frontmatter name must match the directory");
    assert.equal(skillNameError(document.name), undefined);
    assert.equal(skillDescriptionError(document.description), undefined);
    assert.equal(skillBodyError(document.body), undefined);
  }
});

test("pi loads the bundled skills and a same-named user skill wins", async () => {
  const pi = await import("@earendil-works/pi-coding-agent");
  const root = mkdtempSync(join(tmpdir(), "pix-builtin-skills-agent-"));
  try {
    const agentDir = join(root, "agent");
    const userSkill = join(agentDir, "skills", "zotero-cli", "SKILL.md");
    mkdirSync(dirname(userSkill), { recursive: true });
    writeFileSync(userSkill, "---\nname: zotero-cli\ndescription: My own local copy.\n---\nLocal copy.\n");
    const settingsManager = pi.SettingsManager.create(root, agentDir);
    const services = await pi.createAgentSessionServices({
      cwd: root,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        additionalSkillPaths: resolveBuiltinSkills(dirname(fileURLToPath(import.meta.url))),
      },
    });
    const { skills, diagnostics } = services.resourceLoader.getSkills();
    assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.type === "error"), []);
    const zotero = skills.find((skill) => skill.name === "zotero-cli");
    assert.ok(zotero, "bundled skill not discovered");
    assert.equal(zotero.filePath, userSkill);
    // The bundled copy is the shadowed loser of the collision.
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.type === "collision" &&
          diagnostic.collision?.name === "zotero-cli" &&
          diagnostic.collision.winnerPath === userSkill &&
          diagnostic.collision.loserPath !== userSkill,
      ),
      `no collision diagnostic shadowing the bundled copy: ${JSON.stringify(diagnostics)}`,
    );
    const { session } = await pi.createAgentSessionFromServices({
      services,
      sessionManager: pi.SessionManager.inMemory(root),
    });
    try {
      assert.match(session.systemPrompt, /<available_skills>/);
      assert.match(session.systemPrompt, /My own local copy\./);
      // The bundled description stays out of the prompt: the user copy won.
      assert.doesNotMatch(session.systemPrompt, /Read and write a Zotero library/);
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
