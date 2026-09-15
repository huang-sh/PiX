import { readFileSync } from "node:fs";
import { parseSkillDocument, type SkillDocument } from "./skill-files.js";
import { DEFAULT_OUTPUT_STYLE } from "../shared/skills.js";

/**
 * Output style is one pi setting, `outputStyle`, that names a skill whose
 * frontmatter opts in with `output-style: true`. The chosen name joins the
 * append-system prompt sections as a bare pointer
 * (`<output_style>name</output_style>`); the model resolves it against
 * <available_skills> exactly like any other skill, so manual-only skills are
 * excluded — they never appear there, and a pointer at one would dangle. The
 * setting lives in pi's settings.json on whatever host runs the session, so
 * it reaches remote sessions through the settings sync PiX already performs.
 * The loader resolves skills (user copies shadow built-ins) before the
 * append-system override runs in the same pass, so checking the final list is
 * all the wiring the runtime needs.
 */

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
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || DEFAULT_OUTPUT_STYLE;
}

/**
 * Appends the selected skill's name to the append-system prompt sections. Any
 * miss — no such loaded skill, skill without the opt-in, manual-only skill —
 * leaves the base untouched; a broken setting must never break the session
 * prompt.
 */
export function appendOutputStyle(
  base: string[],
  skills: OutputStyleSkill[],
  settings: OutputStyleSettings,
): string[] {
  const name = configuredName(settings);
  const skill = skills.find((item) => item.name === name);
  if (!skill || skill.disableModelInvocation) return base;
  return [...base, `<output_style>${name}</output_style>`];
}
