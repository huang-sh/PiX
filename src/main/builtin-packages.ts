import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Pi packages PiX bundles with the app so they work without `pi install`.
 * Native-binary packages only: candidates without platform-specific builds
 * (e.g. pi-web-access) ship in the recommended list on the extensions page
 * instead, so `pi update` can move them independently of PiX releases.
 * Loaded through resourceLoaderOptions.additionalExtensionPaths, which pi
 * resolves with "temporary" scope: the packages are available without project
 * trust and pi's own package management (pi list / pi update) never touches
 * them.
 */
const BUILTIN_PACKAGE_NAMES = ["@injaneity/pi-computer-use", "@ff-labs/pi-fff"];

export interface BuiltinPackageSettings {
  getPackages(): unknown[];
  getGlobalSettings?(): { packages?: unknown[] };
  getProjectSettings?(): { packages?: unknown[] };
}

/**
 * pi loads user- and project-scoped packages as separate lists (a project
 * packages array replaces, not merges with, the user-level one in the
 * combined getPackages() view), so every scope must be checked for an
 * existing install of a bundled package.
 */
function configuredPackages(
  settingsManager: BuiltinPackageSettings,
): unknown[] {
  return [
    ...(settingsManager.getGlobalSettings?.().packages ?? []),
    ...(settingsManager.getProjectSettings?.().packages ?? []),
    ...(settingsManager.getPackages() ?? []),
  ];
}

/**
 * Pi identifies npm packages by bare name and local paths by absolute path,
 * so a user-installed copy (`pi install npm:...`) and PiX's bundled copy are
 * two different packages to pi. Both loading together would register
 * same-named tools twice with silent last-write wins and duplicated event
 * handlers, so the user's explicit install (any version, user or project
 * scope) always wins and the bundled copy stays a fallback. Re-evaluated on
 * every session creation, so `pi remove` falls back to the bundled copy on
 * the next session.
 */
function userManagesPackage(
  settingsManager: BuiltinPackageSettings,
  name: string,
): boolean {
  const npmSource = `npm:${name}`;
  for (const pkg of configuredPackages(settingsManager)) {
    const source =
      typeof pkg === "string" ? pkg : String((pkg as { source?: unknown })?.source ?? "");
    if (source === npmSource || source.startsWith(`${npmSource}@`)) return true;
  }
  return false;
}

/**
 * Locate one bundled package on disk. Candidate layouts, first match wins:
 * 1. <resources>/pi-builtin/node_modules/<name> shipped by electron-builder
 *    next to the packaged app's asar (out/main -> ../../../pi-builtin),
 * 2. <root>/node_modules/<name> for dev runs (out/main) and remote server
 *    hosts (server/dist/main), which npm-install the package as a dependency.
 */
function resolveBuiltinPackage(moduleDir: string, name: string): string | undefined {
  // Multiple Electron entries move shared runtime code into out/main/chunks.
  if (basename(moduleDir) === "chunks") moduleDir = dirname(moduleDir);
  const segments = name.split("/");
  return [
    resolve(moduleDir, "..", "..", "..", "pi-builtin", "node_modules", ...segments),
    resolve(moduleDir, "..", "..", "node_modules", ...segments),
  ].find((candidate) => existsSync(candidate));
}

/**
 * Directories of bundled pi packages that should load for the next session.
 * Empty when none are found on disk or when the user already manages one.
 */
export function resolveBuiltinPackages(
  moduleDir: string,
  settingsManager?: BuiltinPackageSettings,
): string[] {
  const packages: string[] = [];
  for (const name of BUILTIN_PACKAGE_NAMES) {
    if (settingsManager && userManagesPackage(settingsManager, name)) continue;
    const found = resolveBuiltinPackage(moduleDir, name);
    if (found) packages.push(found);
  }
  return packages;
}

/** Identify distribution separately from pi's tool/extension classification. */
export function isBundledExtension(moduleDir: string, extensionPath: string): boolean {
  for (const name of BUILTIN_PACKAGE_NAMES) {
    const root = resolveBuiltinPackage(moduleDir, name);
    if (!root) continue;
    const child = relative(root, extensionPath);
    if (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
      return true;
  }
  return false;
}
