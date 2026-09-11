import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isPathInside } from "./skill-files.js";

/**
 * Built-in skills PiX bundles with the app so they work without user setup.
 * Loaded through resourceLoaderOptions.additionalSkillPaths, which pi ranks
 * below every user-discovered skill: a same-named skill the user writes to
 * ~/.pi/agent/skills or a project root always wins, and pi's package
 * management never touches the bundled files.
 *
 * Directories are plain markdown, unlike bundled packages: no npm install is
 * needed on remote hosts, so the same tree ships everywhere unchanged.
 */
export function resolveBuiltinSkills(moduleDir: string): string[] {
  // Multiple Electron entries move shared runtime code into out/main/chunks.
  if (basename(moduleDir) === "chunks") moduleDir = dirname(moduleDir);
  return [
    // <resources>/skills shipped by electron-builder next to the packaged
    // app's asar (out/main -> ../../../skills),
    resolve(moduleDir, "..", "..", "..", "skills"),
    // <root>/skills for dev runs (out/main) and remote server hosts
    // (server/dist/main), where the skills tree sits beside the app.
    resolve(moduleDir, "..", "..", "skills"),
  ].filter((candidate) => existsSync(candidate));
}

/** True for a markdown file inside the bundled skills roots. */
export function isBundledSkillPath(moduleDir: string, path: string): boolean {
  const target = resolve(path);
  if (!target.toLowerCase().endsWith(".md")) return false;
  return resolveBuiltinSkills(moduleDir).some((root) => isPathInside(root, target));
}

/**
 * The bundled files are read-only (install dirs are replaced on upgrade and
 * may not be writable at all), so a user's manual-only preference for a
 * bundled skill is recorded here instead of in its SKILL.md. Lives beside
 * settings.json under the PiX home, per machine: the remote host keeps its
 * own, exactly where its sessions are created.
 */
const overridePath = () =>
  join(process.env.PIX_HOME ?? homedir(), ".pix", "skill-overrides.json");

/** Map of skill name -> disable-model-invocation. */
function readBuiltinSkillOverrides(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(readFileSync(overridePath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const overrides: Record<string, boolean> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") overrides[name] = value;
    }
    return overrides;
  } catch {
    return {};
  }
}

export function setBuiltinSkillManualOnly(name: string, manualOnly: boolean) {
  const overrides = readBuiltinSkillOverrides();
  overrides[name] = manualOnly;
  const path = overridePath();
  mkdirSync(dirname(path), { recursive: true });
  const staged = `${path}.tmp`;
  writeFileSync(staged, `${JSON.stringify(overrides, null, 2)}\n`);
  renameSync(staged, path);
}

/**
 * Applies the override table to a loaded skill list: a skill whose file is
 * inside the bundled roots and whose name has an entry gets that entry's
 * disable-model-invocation. Path-scoped so a user's same-named skill is never
 * mistaken for the bundled one. Generic so the loader's own skill and
 * diagnostic types pass through untouched.
 */
export function applyBuiltinSkillOverrides<
  Skill extends { name: string; filePath: string; disableModelInvocation: boolean },
  Diagnostic,
>(moduleDir: string, base: { skills: Skill[]; diagnostics: Diagnostic[] }): {
  skills: Skill[];
  diagnostics: Diagnostic[];
} {
  const overrides = readBuiltinSkillOverrides();
  if (Object.keys(overrides).length === 0) return base;
  const roots = resolveBuiltinSkills(moduleDir);
  if (roots.length === 0) return base;
  return {
    ...base,
    skills: base.skills.map((skill) =>
      Object.hasOwn(overrides, skill.name) &&
      roots.some((root) => isPathInside(root, String(skill.filePath)))
        ? { ...skill, disableModelInvocation: overrides[skill.name]! }
        : skill,
    ),
  };
}
