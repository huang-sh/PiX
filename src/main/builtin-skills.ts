import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

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
