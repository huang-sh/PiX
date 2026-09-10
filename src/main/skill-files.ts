import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import type { SkillBodyError, SkillDescriptionError, SkillNameError } from "../shared/skills.js";

/**
 * Reading and writing SKILL.md documents. Pi parses frontmatter with the same
 * `yaml` package, so a document PiX writes is exactly what Pi expects, and
 * frontmatter fields PiX does not manage survive an edit untouched.
 */

export interface SkillDocument {
  name: string;
  description: string;
  body: string;
  disableModelInvocation: boolean;
  /** Frontmatter keys PiX does not manage (license, metadata, ...). */
  extra: Record<string, unknown>;
}

/**
 * Splits the document the way Pi's `parseFrontmatter` does, so a document PiX
 * reads and rewrites stays recognized by the loader.
 */
function splitFrontmatter(content: string): { yaml: string | null; body: string } {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return { yaml: null, body: normalized.trim() };
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { yaml: null, body: normalized.trim() };
  return { yaml: normalized.slice(4, end), body: normalized.slice(end + 4).trim() };
}

export function parseSkillDocument(content: string): SkillDocument {
  const { yaml, body } = splitFrontmatter(content);
  let frontmatter: Record<string, unknown> = {};
  if (yaml) {
    const parsed = parse(yaml);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      frontmatter = parsed as Record<string, unknown>;
  }
  const { name, description, "disable-model-invocation": manualOnly, ...extra } = frontmatter;
  return {
    name: typeof name === "string" ? name : "",
    description: typeof description === "string" ? description : "",
    body,
    disableModelInvocation: manualOnly === true,
    extra,
  };
}

export function serializeSkillDocument(document: SkillDocument): string {
  const frontmatter: Record<string, unknown> = {
    name: document.name.trim(),
    description: document.description.trim(),
    ...document.extra,
    ...(document.disableModelInvocation ? { "disable-model-invocation": true } : {}),
  };
  // lineWidth: 0 keeps a long description on one line instead of folding it.
  const header = stringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${header}\n---\n\n${document.body.trim()}\n`;
}

export interface SkillRoots {
  /** Root PiX writes new user skills into. */
  user: string;
  /** Root PiX writes new project skills into. */
  project: string;
  /** Roots whose files the editor may modify, including `.agents/skills`. */
  editable: string[];
}

/**
 * Pi discovers `~/.pi/agent/skills` and `<cwd>/.pi/skills` by default and
 * `.agents/skills` through the package manager; both are real user-owned skill
 * directories, so both are editable while only the Pi-native ones are targets
 * for new skills.
 */
export function skillRoots(
  agentDir: string,
  cwd: string,
  configDirName: string,
  home: string,
): SkillRoots {
  const user = join(agentDir, "skills");
  const project = join(cwd, configDirName, "skills");
  return {
    user,
    project,
    editable: [
      ...new Set([
        user,
        project,
        join(home, ".agents", "skills"),
        join(cwd, ".agents", "skills"),
      ]),
    ],
  };
}

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * A skill PiX may rewrite: inside an editable root, written as Markdown, and
 * not buried in an installed package.
 */
export function isEditableSkillPath(path: string, roots: string[]): boolean {
  const target = resolve(path);
  if (!target.toLowerCase().endsWith(".md")) return false;
  if (target.split(sep).includes("node_modules")) return false;
  return roots.some((root) => isPathInside(root, target));
}

/** Same check, for the host entry points that must fail closed. */
export function assertEditableSkillPath(path: string, roots: string[]): string {
  const target = resolve(path);
  if (!target.toLowerCase().endsWith(".md"))
    throw new Error("Only Markdown skill files can be edited");
  if (target.split(sep).includes("node_modules"))
    throw new Error("Skills installed from a package are read-only");
  if (!roots.some((root) => isPathInside(root, target)))
    throw new Error("This skill lives outside the user and project skill folders");
  return target;
}

export const SKILL_NAME_MESSAGES: Record<SkillNameError, string> = {
  "name-required": "Skill name is required",
  "name-too-long": "Skill name must be 64 characters or fewer",
  "name-invalid": "Skill name may only use lowercase letters, numbers, and single hyphens",
};
export const SKILL_DESCRIPTION_MESSAGES: Record<SkillDescriptionError, string> = {
  "description-required": "Skill description is required",
  "description-too-long": "Skill description must be 1024 characters or fewer",
};
export const SKILL_BODY_MESSAGES: Record<SkillBodyError, string> = {
  "body-required": "Skill instructions cannot be empty",
  "body-too-large": "Skill instructions exceed the 128 KB limit",
};
