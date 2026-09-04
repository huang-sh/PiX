import { statSync } from "node:fs";
import { delimiter, dirname, join, normalize } from "node:path";

function existingFile(path: string): string | undefined {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Expand a bare executable name with PATHEXT and scan PATH in order, matching
 * `where <name>` without spawning a process so it also works in packaged
 * Electron environments with a minimal PATH.
 */
export function findExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const pathValue = env.PATH ?? env.Path;
  if (!pathValue) return undefined;
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  const names = name.includes(".")
    ? [name]
    : [name, ...extensions.map((ext) => name + ext.toLowerCase())];
  for (const entry of pathValue.split(delimiter)) {
    const dir = entry.replace(/^"+|"+$/g, "");
    if (!dir) continue;
    for (const candidate of names) {
      const hit = existingFile(join(dir, candidate));
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Git for Windows keeps bash.exe in Git\bin while git.exe only ever ships in
 * Git\cmd or Git\usr\bin, so bash follows from git's location no matter which
 * drive or folder Git was installed to.
 */
export function deriveBashPathsFromGit(gitExecutable: string): string[] {
  const dir = dirname(gitExecutable);
  return [
    normalize(join(dir, "..", "bin", "bash.exe")),
    normalize(join(dir, "..", "..", "bin", "bash.exe")),
  ];
}

export interface BashDetectionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Locate a bash.exe for Pi's bash tool on Windows. Resolution order:
 * 1. Git Bash under the Program Files locations Pi checks itself,
 * 2. the bash.exe next to any git.exe found on PATH (covers custom install
 *    roots such as D:\software\Git, where Git\cmd is on PATH but Git\bin
 *    is not),
 * 3. a bash.exe placed directly on PATH (Cygwin, MSYS2, WSL).
 * Returns undefined when nothing matched so Pi keeps its own diagnostics.
 */
export function detectWindowsBash(
  options: BashDetectionOptions = {},
): string | undefined {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const env = options.env ?? process.env;
  const candidates: string[] = [];
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (root) candidates.push(join(root, "Git", "bin", "bash.exe"));
  }
  const git = findExecutableOnPath("git", env);
  if (git) candidates.push(...deriveBashPathsFromGit(git));
  const bash = findExecutableOnPath("bash", env);
  if (bash) candidates.push(bash);
  return candidates.find((candidate) => Boolean(existingFile(candidate)));
}

/**
 * Run a detector at most once per process and reuse its result, including
 * undefined. Probing happens lazily on the first call, so app startup pays
 * nothing until a Pi session actually needs a shell.
 */
export function memoizeOnce<T>(detector: () => T): () => T {
  let probed = false;
  let value: T;
  return () => {
    if (!probed) {
      probed = true;
      value = detector();
    }
    return value;
  };
}

/**
 * Fall back to the detected bash whenever Pi has no explicit shellPath
 * configured; an explicit user setting always wins. The prototype chain keeps
 * every other SettingsManager behavior (reads and saves) on the real manager.
 */
export function withDetectedBashShell<
  T extends { getShellPath(): string | undefined },
>(settingsManager: T, detected: string | undefined): T {
  if (!detected) return settingsManager;
  const fallback: T = Object.create(settingsManager);
  fallback.getShellPath = () => settingsManager.getShellPath() ?? detected;
  return fallback;
}
