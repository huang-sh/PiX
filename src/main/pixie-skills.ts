import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CANVAS_SKILLS, canvasToolName } from "../shared/canvas.js";
import { resolveBuiltinSkills } from "./builtin-skills.js";

/** Pixie-only resources sit beside general skills, so executor agents do not discover them. */
export async function readPixieSkill(name: string, moduleDir: string) {
  const skill = CANVAS_SKILLS.find(skill => skill.name === name);
  if (!skill) throw new Error(`Unknown Pixie skill: ${name}`);
  const root = resolveBuiltinSkills(moduleDir)[0];
  if (!root) throw new Error("Bundled Pixie skills are unavailable");
  const content = await readFile(join(root, "..", "pixie-skills", skill.name, "SKILL.md"), "utf8");
  return { skill: skill.name, content, tools: skill.actions.map(canvasToolName) };
}
