import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRuntime } from "../src/main/pi-runtime.js";
import {
  assertEditableSkillPath,
  isEditableSkillPath,
  parseSkillDocument,
  serializeSkillDocument,
  skillRoots,
} from "../src/main/skill-files.js";
import { skillBodyError, skillDescriptionError, skillDisplayNameError, skillNameError, slugifySkillName } from "../src/shared/skills.js";
import { validateRouteInput } from "../src/shared/contracts.js";
import type { RuntimeSkill, RuntimeSkillDocument } from "../src/shared/types.js";

function stubServices(agentDir: string) {
  return (pi: any, cwd: string) => ({
    cwd,
    agentDir,
    settingsManager: pi.SettingsManager.inMemory({}),
    resourceLoaderOptions: { noExtensions: true, additionalExtensionPaths: [], extensionFactories: [] },
  });
}

test("skill names follow the Agent Skills slug rules", () => {
  assert.equal(slugifySkillName("PDF Processing!"), "pdf-processing");
  assert.equal(slugifySkillName("  spaced   out  "), "spaced-out");
  assert.equal(slugifySkillName("--"), "");
  assert.equal(slugifySkillName("a".repeat(80)).length, 64);
  assert.equal(skillNameError("pdf-processing"), undefined);
  assert.equal(skillNameError(""), "name-required");
  assert.equal(skillNameError("PDF"), "name-invalid");
  assert.equal(skillNameError("two--dash"), "name-invalid");
  assert.equal(skillNameError(`${"a".repeat(65)}`), "name-too-long");
  // Authors type a readable name; only the stored slug has to satisfy the spec.
  assert.equal(skillDisplayNameError("PDF Tools"), undefined);
  assert.equal(skillDisplayNameError("  "), "name-required");
  assert.equal(skillDisplayNameError("工具箱"), "name-slug-empty");
  assert.equal(skillDescriptionError("Extracts tables from PDFs."), undefined);
  assert.equal(skillDescriptionError(" "), "description-required");
  assert.equal(skillDescriptionError("x".repeat(1025)), "description-too-long");
  assert.equal(skillBodyError("# Steps\n1. do it"), undefined);
  assert.equal(skillBodyError("  "), "body-required");
  assert.equal(skillBodyError("x".repeat(128 * 1024 + 1)), "body-too-large");
});

test("skill documents round-trip without losing unmanaged frontmatter", () => {
  const original = [
    "---",
    "name: pdf-tools",
    "description: Extract text from PDFs.",
    "license: MIT",
    "allowed-tools: read bash",
    "metadata:",
    "  author: someone",
    "---",
    "",
    "# PDF tools",
    "",
    "Run the extractor.",
    "",
  ].join("\n");
  const document = parseSkillDocument(original);
  assert.equal(document.name, "pdf-tools");
  assert.equal(document.description, "Extract text from PDFs.");
  assert.equal(document.body, "# PDF tools\n\nRun the extractor.");
  assert.equal(document.disableModelInvocation, false);
  assert.equal(document.extra.license, "MIT");
  assert.deepEqual(document.extra.metadata, { author: "someone" });

  const rewritten = parseSkillDocument(serializeSkillDocument({ ...document, disableModelInvocation: true }));
  assert.equal(rewritten.disableModelInvocation, true);
  assert.equal(rewritten.extra.license, "MIT");
  assert.deepEqual(rewritten.extra.metadata, { author: "someone" });
  assert.equal(rewritten.body, document.body);
});

test("a document without frontmatter is treated as body only", () => {
  const document = parseSkillDocument("# Just a file\n");
  assert.equal(document.name, "");
  assert.equal(document.description, "");
  assert.equal(document.body, "# Just a file");
});

test("a UTF-8 BOM does not hide the frontmatter from an edit", () => {
  const bomFile = "\uFEFF---\nname: pdf-tools\ndescription: Extract text.\n---\n\n# PDF tools\nRun the extractor.";
  const document = parseSkillDocument(bomFile);
  assert.equal(document.name, "pdf-tools");
  assert.equal(document.description, "Extract text.");
  assert.equal(document.body, "# PDF tools\nRun the extractor.");
  // Editing and saving must not fold the original header into the body.
  const rewritten = serializeSkillDocument({ ...document, description: "New text." });
  const reparsed = parseSkillDocument(rewritten);
  assert.equal(reparsed.name, "pdf-tools");
  assert.equal(reparsed.description, "New text.");
  assert.equal(reparsed.body, "# PDF tools\nRun the extractor.");
  assert.equal(rewritten.startsWith("---\nname: pdf-tools"), true);
});

test("frontmatter that is not a mapping fails closed instead of being dropped", () => {
  assert.throws(
    () => parseSkillDocument("---\n- one\n- two\n---\n\n# Body\n"),
    /not a valid skill document/,
  );
  assert.throws(
    () => parseSkillDocument("---\n42\n---\n\n# Body\n"),
    /not a valid skill document/,
  );
});

test("only skills inside user, project, or .agents folders are writable", () => {
  const roots = skillRoots("/home/me/.pi/agent", "/work/app", ".pi", "/home/me");
  assert.deepEqual(
    roots.editable.map((root) => root.replaceAll("\\", "/")),
    ["/home/me/.pi/agent/skills", "/work/app/.pi/skills", "/home/me/.agents/skills", "/work/app/.agents/skills"],
  );
  const user = join(roots.user, "pdf-tools", "SKILL.md");
  const project = join(roots.project, "pdf-tools", "SKILL.md");
  const agents = join("/home/me", ".agents", "skills", "pdf-tools", "SKILL.md");
  const installed = join("/work/app", "node_modules", "pkg", "skills", "pdf-tools", "SKILL.md");
  assert.equal(isEditableSkillPath(user, roots.editable), true);
  assert.equal(isEditableSkillPath(project, roots.editable), true);
  assert.equal(isEditableSkillPath(agents, roots.editable), true);
  assert.equal(isEditableSkillPath(installed, roots.editable), false);
  assert.equal(isEditableSkillPath("/tmp/evil.md", roots.editable), false);
  assert.equal(isEditableSkillPath(join(roots.user, "notes.txt"), roots.editable), false);
  assert.throws(() => assertEditableSkillPath("/tmp/evil.md", roots.editable), /outside the user and project/);
});

test("skill control actions validate their payloads at the IPC boundary", () => {
  assert.deepEqual(
    validateRouteInput("agent.control", { action: "getSkill", path: "/a/SKILL.md" }),
    { action: "getSkill", path: "/a/SKILL.md" },
  );
  assert.deepEqual(
    validateRouteInput("agent.control", {
      action: "createSkill", scope: "project", name: "pdf-tools",
      description: "Extract text.", body: "# PDF", disableModelInvocation: true,
    }),
    {
      action: "createSkill", scope: "project", name: "pdf-tools",
      description: "Extract text.", body: "# PDF", disableModelInvocation: true,
    },
  );
  assert.deepEqual(
    validateRouteInput("agent.control", { action: "setSkillManualOnly", path: "/a/SKILL.md", manualOnly: true }),
    { action: "setSkillManualOnly", path: "/a/SKILL.md", manualOnly: true },
  );
  assert.throws(() => validateRouteInput("agent.control", { action: "createSkill", scope: "user", name: "x", description: "d" }), /body/);
  assert.throws(() => validateRouteInput("agent.control", {
    action: "createSkill", scope: "user", name: "x", description: "d", body: "x".repeat(128 * 1024 + 1),
  }), /size limit/);
  assert.throws(() => validateRouteInput("agent.control", { action: "updateSkill", name: "x", description: "d", body: "b" }), /path/);
});

test("create, read, toggle, edit, and delete a skill through the runtime", async () => {
  const previousHome = process.env.PIX_HOME;
  const home = mkdtempSync(join(tmpdir(), "pix-skills-"));
  process.env.PIX_HOME = home;
  const agentDir = join(home, ".pi", "agent");
  const runtime = new PiRuntime(home, join(home, "sessions"), () => {}, async () => {});
  runtime["sessionServicesOptions"] = stubServices(agentDir);
  try {
    await runtime.create();

    const created = await runtime.control({
      action: "createSkill", scope: "user", name: "pdf-tools",
      description: "Extract text from PDFs.", body: "# PDF tools\n\nExtract.", disableModelInvocation: false,
    }) as { path: string };
    assert.equal(created.path, join(agentDir, "skills", "pdf-tools", "SKILL.md"));
    assert.match(readFileSync(created.path, "utf8"), /^---\nname: pdf-tools\n/);

    let skills = await runtime.control({ action: "getSkills" }) as RuntimeSkill[];
    const listed = skills.find((skill) => skill.name === "pdf-tools");
    assert.ok(listed);
    assert.equal(listed.scope, "user");
    assert.equal(listed.editable, true);
    assert.equal(listed.disableModelInvocation, false);

    await runtime.control({ action: "setSkillManualOnly", path: created.path, manualOnly: true });
    skills = await runtime.control({ action: "getSkills" }) as RuntimeSkill[];
    assert.equal(skills.find((skill) => skill.name === "pdf-tools")?.disableModelInvocation, true);

    const document = await runtime.control({ action: "getSkill", path: created.path }) as RuntimeSkillDocument;
    assert.equal(document.name, "pdf-tools");
    assert.equal(document.disableModelInvocation, true);
    assert.equal(document.body, "# PDF tools\n\nExtract.");

    await runtime.control({
      action: "updateSkill", path: created.path, name: "pdf-tools",
      description: "Extract text and tables.", body: "# PDF tools\n\nUpdated.", disableModelInvocation: true,
    });
    const updated = await runtime.control({ action: "getSkill", path: created.path }) as RuntimeSkillDocument;
    assert.equal(updated.description, "Extract text and tables.");
    assert.equal(updated.body, "# PDF tools\n\nUpdated.");

    await assert.rejects(
      runtime.control({ action: "createSkill", scope: "user", name: "pdf-tools", description: "dup", body: "x", disableModelInvocation: false }),
      /already exists/,
    );
    await assert.rejects(
      runtime.control({ action: "getSkill", path: join(home, "outside.md") }),
      /outside the user and project/,
    );

    // A root-level .md skill has no folder of its own, so the file name names it.
    const rootFile = join(agentDir, "skills", "root-skill.md");
    writeFileSync(rootFile, "---\ndescription: Root level skill.\n---\n\n# Root\n");
    const rootDocument = await runtime.control({ action: "getSkill", path: rootFile }) as RuntimeSkillDocument;
    assert.equal(rootDocument.name, "root-skill");
    assert.equal(rootDocument.description, "Root level skill.");

    await runtime.control({ action: "deleteSkill", path: created.path });
    skills = await runtime.control({ action: "getSkills" }) as RuntimeSkill[];
    assert.equal(skills.some((skill) => skill.name === "pdf-tools"), false);
  } finally {
    runtime.dispose();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PIX_HOME;
    else process.env.PIX_HOME = previousHome;
  }
});

test("importing keeps a valid document and rejects one Pi cannot load", async () => {
  const previousHome = process.env.PIX_HOME;
  const home = mkdtempSync(join(tmpdir(), "pix-skill-import-"));
  process.env.PIX_HOME = home;
  const agentDir = join(home, ".pi", "agent");
  const runtime = new PiRuntime(home, join(home, "sessions"), () => {}, async () => {});
  runtime["sessionServicesOptions"] = stubServices(agentDir);
  try {
    await runtime.create();
    const source = join(home, "downloaded.md");
    writeFileSync(source, [
      "---",
      "name: research-helper",
      "description: Find sources.",
      "license: MIT",
      "---",
      "",
      "# Research",
      "",
      "Search first.",
      "",
    ].join("\n"));
    const imported = await runtime.control({
      action: "importSkill", scope: "user", name: "research-helper", content: readFileSync(source, "utf8"),
    }) as { path: string };
    const document = await runtime.control({ action: "getSkill", path: imported.path }) as RuntimeSkillDocument;
    assert.equal(document.name, "research-helper");
    assert.equal(document.description, "Find sources.");
    assert.equal(document.body, "# Research\n\nSearch first.");
    assert.match(readFileSync(imported.path, "utf8"), /license: MIT/);

    await assert.rejects(
      runtime.control({ action: "importSkill", scope: "user", name: "broken", content: "# No frontmatter\n" }),
      /description is required/i,
    );

    // A name Pi tolerates but the spec rejects is normalized on import instead
    // of refusing a document the loader would happily read.
    const messy = await runtime.control({
      action: "importSkill", scope: "user", name: "Messy Name",
      content: "---\ndescription: Works anyway.\n---\n\n# Messy\n",
    }) as { path: string };
    assert.equal(messy.path, join(agentDir, "skills", "messy-name", "SKILL.md"));
  } finally {
    runtime.dispose();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PIX_HOME;
    else process.env.PIX_HOME = previousHome;
  }
});

test("project skills land in .pi/skills and are listable", async () => {
  const previousHome = process.env.PIX_HOME;
  const home = mkdtempSync(join(tmpdir(), "pix-skill-project-"));
  const project = mkdtempSync(join(tmpdir(), "pix-skill-project-cwd-"));
  process.env.PIX_HOME = home;
  const agentDir = join(home, ".pi", "agent");
  const runtime = new PiRuntime(project, join(home, "sessions"), () => {}, async () => {});
  runtime["sessionServicesOptions"] = stubServices(agentDir);
  try {
    await runtime.create();
    const created = await runtime.control({
      action: "createSkill", scope: "project", name: "repo-map",
      description: "Explain the repository layout.", body: "# Repo map", disableModelInvocation: false,
    }) as { path: string };
    assert.equal(created.path, join(project, ".pi", "skills", "repo-map", "SKILL.md"));
    const skills = await runtime.control({ action: "getSkills" }) as RuntimeSkill[];
    assert.equal(skills.find((skill) => skill.name === "repo-map")?.scope, "project");
  } finally {
    runtime.dispose();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PIX_HOME;
    else process.env.PIX_HOME = previousHome;
  }
});
