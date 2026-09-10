/**
 * Skill rules shared by the host (authoritative) and the renderer (live form
 * feedback). Nothing here touches the filesystem or the Pi SDK, so both sides
 * validate with the exact same code and only differ in how they phrase errors.
 */

/** Per the Agent Skills specification (what Pi enforces when loading). */
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
/** PiX refuses to write a skill document larger than this. */
export const MAX_SKILL_BYTES = 128 * 1024;

export type SkillScope = "user" | "project" | "temporary";
/** Scopes a skill can be created in; the rest are discovered from elsewhere. */
export type SkillWriteScope = "user" | "project";

export type SkillNameError = "name-required" | "name-too-long" | "name-invalid";
export type SkillDisplayNameError = "name-required" | "name-slug-empty";
export type SkillDescriptionError = "description-required" | "description-too-long";
export type SkillBodyError = "body-required" | "body-too-large";

/**
 * Lowercase slug for the skill directory, mirroring Pi's tolerance of a name
 * that differs from its directory while staying readable on disk.
 */
export function slugifySkillName(value: string): string {
  let slug = "";
  let lastDash = false;
  for (const char of value.trim().toLowerCase()) {
    if (char >= "a" && char <= "z") {
      slug += char;
      lastDash = false;
    } else if (char >= "0" && char <= "9") {
      slug += char;
      lastDash = false;
    } else if (slug && !lastDash) {
      slug += "-";
      lastDash = true;
    }
  }
  return slug.slice(0, MAX_SKILL_NAME_LENGTH).replace(/-+$/, "");
}

export function skillNameError(name: string): SkillNameError | undefined {
  const value = name.trim();
  if (!value) return "name-required";
  if (value.length > MAX_SKILL_NAME_LENGTH) return "name-too-long";
  if (!/^[a-z0-9-]+$/.test(value) || value.startsWith("-") || value.endsWith("-") || value.includes("--"))
    return "name-invalid";
  return undefined;
}

/**
 * Authors write a readable name; only the stored slug has to satisfy the spec.
 * "PDF Tools" is a fine thing to type — it is saved as `pdf-tools`.
 */
export function skillDisplayNameError(name: string): SkillDisplayNameError | undefined {
  if (!name.trim()) return "name-required";
  if (!slugifySkillName(name)) return "name-slug-empty";
  return undefined;
}

export function skillDescriptionError(description: string): SkillDescriptionError | undefined {
  const value = description.trim();
  if (!value) return "description-required";
  if (value.length > MAX_SKILL_DESCRIPTION_LENGTH) return "description-too-long";
  return undefined;
}

export function skillBodyError(body: string): SkillBodyError | undefined {
  if (!body.trim()) return "body-required";
  if (new TextEncoder().encode(body).length > MAX_SKILL_BYTES) return "body-too-large";
  return undefined;
}
