// electron-builder afterPack hook: prune bundled extension dev artifacts and
// verify that the app, skills, and native search dependencies are complete.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkPackagedFiles, checkPackagedFff, checkPackagedSkills } from "./check-packaged-files.mjs";

// electron-builder's context.arch is the numeric Arch enum (builder-util).
const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "universal", 3: "arm64" };

// Keep extension sources and JS runtime files. Declarations, maps, and package
// docs are not needed to load bundled tools; skills ship separately.
const DEV_ARTIFACT = /\.(?:d\.[cm]?ts|map|md)$/i;

// Delete dev artifacts under dir, covering everything staged into pi-builtin
// by the extraResources copies.
export function pruneDevArtifacts(dir) {
  let removed = 0;
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (DEV_ARTIFACT.test(entry.name)) {
        rmSync(path);
        removed++;
      }
    }
  };
  visit(dir);
  return removed;
}

export default async function afterPack(context) {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const pruned = pruneDevArtifacts(join(resources, "pi-builtin"));
  console.log(`  • pruned ${pruned} dev artifacts (declarations, maps, docs) from pi-builtin`);
  checkPackagedFiles(join(resources, "app.asar"), context.packager.info.appDir);
  checkPackagedSkills(resources);
  if (["win32", "darwin", "linux"].includes(context.electronPlatformName))
    checkPackagedFff(resources, context.electronPlatformName, ARCH_NAMES[context.arch]);
}
