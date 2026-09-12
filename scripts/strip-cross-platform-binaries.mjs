// electron-builder afterPack hook: prunes dev artifacts from pi-builtin and
// deletes esbuild's cross-platform binaries. esbuild (a production dependency
// of pi's chord compiler) installs prebuilt binaries for every platform it
// supports — over 20 directories, ~230MB unpacked — under any nested
// node_modules/@esbuild scope. Only the host platform's binary is ever spawned.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkPackagedFiles, checkPackagedFff, checkPackagedSkills } from "./check-packaged-files.mjs";

// electron-builder's context.arch is the numeric Arch enum (builder-util).
const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "universal", 3: "arm64" };

// Type declarations, source maps, and package docs are dead weight at runtime:
// Node resolves .js entries, pi's chord compiler compiles the extension .ts
// sources itself (never their .d.ts), and nothing ships skills or runtime
// markdown. They make up ~28% of pi-builtin's files.
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

function hostDirectories(platformName, arch) {
  const archName = ARCH_NAMES[arch];
  if (platformName === "win32")
    return archName === "universal" ? ["win32-x64", "win32-arm64"] : [`win32-${archName}`];
  if (platformName === "darwin")
    return archName === "universal" ? ["darwin-x64", "darwin-arm64"] : [`darwin-${archName}`];
  if (platformName === "linux")
    return archName === "universal" ? ["linux-x64", "linux-arm64"] : [`linux-${archName}`];
  return [];
}

function directorySize(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? directorySize(child) : statSync(child).size;
  }
  return total;
}

// Find <@esbuild scope dir>/node_modules/@esbuild at any nesting depth under
// the unpacked tree.
function esbuildScopes(root) {
  const scopes = [];
  const visit = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith("node_modules")) continue;
      const scope = join(dir, entry.name, "@esbuild");
      if (existsSync(scope)) scopes.push(scope);
      visit(join(dir, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return scopes;
}

export default async function afterPack(context) {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const pruned = pruneDevArtifacts(join(resources, "pi-builtin"));
  console.log(`  • pruned ${pruned} dev artifacts (declarations, maps, docs) from pi-builtin`);
  checkPackagedFiles(join(resources, "app.asar"), context.packager.info.appDir);
  checkPackagedSkills(resources);
  if (["win32", "darwin"].includes(context.electronPlatformName))
    checkPackagedFff(resources, context.electronPlatformName, ARCH_NAMES[context.arch]);
  const keep = new Set(hostDirectories(context.electronPlatformName, context.arch));
  if (!keep.size) return; // unknown platform/arch: keep everything
  const unpacked = join(context.appOutDir, "resources", "app.asar.unpacked");
  let removedCount = 0;
  let removedBytes = 0;
  for (const scope of esbuildScopes(unpacked)) {
    for (const platform of readdirSync(scope, { withFileTypes: true })) {
      if (!platform.isDirectory() || keep.has(platform.name)) continue;
      const target = join(scope, platform.name);
      removedBytes += directorySize(target);
      rmSync(target, { recursive: true, force: true });
      removedCount++;
    }
  }
  if (removedCount)
    console.log(
      `  • afterPack: removed ${removedCount} cross-platform esbuild binaries (${Math.round(removedBytes / 1e6)}MB) for ${context.electronPlatformName}-${ARCH_NAMES[context.arch] ?? context.arch}`,
    );
}
