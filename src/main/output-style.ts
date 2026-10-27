import { readFileSync } from "node:fs";
import { parseSkillDocument, type SkillDocument } from "./skill-files.js";

/**
 * <output_style> combines PiX's always-on <format_rules> with an optional
 * <content_style> referencing the selected `outputStyle` skill. Only loaded,
 * model-invocable skills with `output-style: true` can supply the content style.
 * The loader resolves skills before the append-system override runs; settings
 * and skills are re-read on reload so the pointer follows the current choice.
 */

const FILE_LINK_RULES = `When referring to files in your responses, prefer clickable Markdown links so users can open them directly in PiX:
- Use absolute filesystem paths on the session host, for example [app.py](/absolute/path/app.py).
- Do not wrap Markdown links in backticks or code fences.
- If a path contains spaces, wrap the link destination in angle brackets: [My Report.md](</absolute/path/My Project/My Report.md>).
- Optionally append a one-based line number to the path: [app.py:12](/absolute/path/app.py:12) or [My Report.md:12](</absolute/path/My Project/My Report.md:12>).
- Use forward slashes in Windows paths, for example [app.py](C:/project/app.py:12).
Content style must preserve these format rules.`;

/** The loaded skills that opted in (`output-style: true`); the configured name is resolved against this list. */
export interface OutputStyleSkill {
  name: string;
  /** Manual-only skills never appear in <available_skills>; a pointer at one would dangle. */
  disableModelInvocation: boolean;
}

/** Settings reads follow the bundle merge: project values override global. */
export interface OutputStyleSettings {
  getProjectSettings(): Record<string, unknown>;
  getGlobalSettings(): Record<string, unknown>;
}

/** True when the document opts in as an output style. */
export function isOutputStyleSkill(document: SkillDocument): boolean {
  return document.extra["output-style"] === true;
}

/** Reads a skill file's opt-in; an unreadable file is never a style. */
export function isOutputStyleFile(path: string): boolean {
  try {
    return isOutputStyleSkill(parseSkillDocument(readFileSync(path, "utf-8")));
  } catch {
    return false;
  }
}

function configuredName(settings: OutputStyleSettings): string {
  const value = settings.getProjectSettings().outputStyle
    ?? settings.getGlobalSettings().outputStyle;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Appends one output-style block. Model default or an unavailable skill omits
 * only the content style; PiX's format rules remain in every session.
 */
export function appendOutputStyle(
  base: string[],
  skills: OutputStyleSkill[],
  settings: OutputStyleSettings,
): string[] {
  const name = configuredName(settings);
  const skill = skills.find((item) => item.name === name);
  const sections: string[] = [];
  if (name && skill && !skill.disableModelInvocation)
    sections.push(`<content_style>\nUse the ${skill.name} skill listed in available_skills.\n</content_style>`);
  sections.push(`<format_rules>\n${FILE_LINK_RULES}\n</format_rules>`);
  return [...base, `<output_style>\n${sections.join("\n\n")}\n</output_style>`];
}
