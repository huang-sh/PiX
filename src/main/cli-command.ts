import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pixHome } from "./paths.js";

const MARKER = "# PiX managed command";
const START = "# >>> PiX CLI >>>";
const END = "# <<< PiX CLI <<<";
const BLOCK = /\n# >>> PiX CLI >>>\n[\s\S]*?# <<< PiX CLI <<<\n/g;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
interface Installation { disabled?: boolean; launcher: string; configs: Array<{ path: string; created: boolean }>; }
export interface CommandOptions {
  home?: string;
  platform?: NodeJS.Platform;
  shell?: string;
  launcher?: string;
  executable?: string;
  entry?: string;
}
function context(options: CommandOptions) {
  const home = resolve(options.home ?? pixHome());
  const platform = options.platform ?? process.platform;
  return { home, platform, launcher: join(home, ".pix", "bin", platform === "win32" ? "pix.cmd" : "pix"), state: join(home, ".pix", "command.json") };
}
function readState(file: string): Installation | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    const home = resolve(dirname(file), "..");
    const allowed = new Set([".zprofile", ".zshrc", ".bash_profile", ".bash_login", ".bashrc", ".profile", ".config/fish/conf.d/pix-cli.fish"].map(path => join(home, path)));
    if (!Array.isArray(value?.configs) || !value.configs.every((item: any) => typeof item?.path === "string" && allowed.has(item.path) && typeof item.created === "boolean")) return;
    return value as Installation;
  } catch { return; }
}
function stripBlock(text: string) {
  return text.replace(BLOCK, (block, offset: number) => {
    const before = text.slice(0, offset), after = text.slice(offset + block.length);
    return before && after && !before.endsWith("\n") && !after.startsWith("\n") ? "\n" : "";
  });
}
function read(file: string) { return existsSync(file) ? readFileSync(file, "utf8") : ""; }
function atomic(file: string, text: string, mode?: number) {
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: mode ?? (existsSync(target) ? statSync(target).mode & 0o777 : 0o600) });
    renameSync(temp, target);
  } finally { rmSync(temp, { force: true }); }
}
function configs(home: string, platform: NodeJS.Platform, shell: string) {
  const result = new Set<string>();
  if (platform === "darwin" || /zsh$/.test(shell) || existsSync(join(home, ".zshrc"))) {
    result.add(join(home, ".zprofile")); result.add(join(home, ".zshrc"));
  }
  // Bash reads the first existing login file; never introduce a new file
  // ahead of an existing .profile and accidentally hide the user's settings.
  const login = [".bash_profile", ".bash_login", ".profile"].map(name => join(home, name));
  const existing = login.find(file => existsSync(file));
  if (/bash$/.test(shell) || existing) result.add(existing ?? join(home, ".profile"));
  if (/bash$/.test(shell) || existsSync(join(home, ".bashrc"))) result.add(join(home, ".bashrc"));
  if (/fish$/.test(shell) || existsSync(join(home, ".config", "fish"))) result.add(join(home, ".config", "fish", "conf.d", "pix-cli.fish"));
  if (!result.size) result.add(join(home, ".profile"));
  return [...result];
}
function shellBlock(fish: boolean) {
  const body = fish
    ? 'if test -x "$HOME/.pix/bin/pix"; and not contains -- "$HOME/.pix/bin" $PATH\n  set -gx PATH "$HOME/.pix/bin" $PATH\nend'
    : 'if [ -x "$HOME/.pix/bin/pix" ]; then\n  case ":$PATH:" in *":$HOME/.pix/bin:"*) ;; *) export PATH="$HOME/.pix/bin:$PATH" ;; esac\nfi';
  return `\n${START}\n${body}\n${END}\n`;
}
export function packagedLauncher(executable = process.execPath, platform = process.platform): string | undefined {
  const dir = dirname(executable);
  const path = platform === "darwin" ? resolve(dir, "../Resources/cli/pix") : join(dir, "resources", "cli", platform === "win32" ? "pix.cmd" : "pix");
  return existsSync(path) ? path : undefined;
}
function windowsPath(action: "install" | "uninstall" | "status", launcher: string) {
  const script = join(dirname(launcher), "path.ps1");
  if (!existsSync(script)) throw new Error("This command is managed by npm. Use npm's global install or uninstall commands.");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-Action", action, "-Directory", dirname(launcher), "-Scope", "User"], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim() ?? "Could not update PATH");
  if (action === "status") return JSON.parse(result.stdout);
  return { installed: action === "install", launcher, restartTerminal: true };
}
export function installCommand(options: CommandOptions = {}) {
  const c = context(options);
  const target = options.launcher ?? packagedLauncher(options.executable, c.platform);
  if (c.platform === "win32") {
    if (!target) throw new Error("Use npm install --global to register the standalone CLI");
    return windowsPath("install", target);
  }
  if (existsSync(c.launcher) || (() => { try { return lstatSync(c.launcher).isSymbolicLink(); } catch { return false; } })()) {
    if (!read(c.launcher).startsWith(`#!/bin/sh\n${MARKER}\n`)) throw new Error(`Another command already exists at ${c.launcher}; it was left unchanged`);
  }
  const command = target ? `exec ${quote(target)} "$@"` : `exec ${quote(options.executable ?? process.execPath)} ${quote(options.entry ?? resolve(process.argv[1]!))} "$@"`;
  const previous = readState(c.state);
  const files = configs(c.home, c.platform, options.shell ?? process.env.SHELL ?? "");
  const next: Installation = { launcher: c.launcher, configs: [] };
  for (const path of files) {
    const created = previous?.configs.find(item => item.path === path)?.created ?? !existsSync(path);
    const text = stripBlock(read(path));
    next.configs.push({ path, created });
    atomic(path, text + shellBlock(path.endsWith(".fish")));
  }
  // Write the executable only once its PATH entries are ready. Reinstalling
  // updates our own wrapper when the app has moved, without duplicating blocks.
  atomic(c.launcher, `#!/bin/sh\n${MARKER}\n${command}\n`, 0o755);
  atomic(c.state, JSON.stringify(next) + "\n");
  return { installed: true, launcher: c.launcher, restartTerminal: true };
}
export function uninstallCommand(options: CommandOptions = {}) {
  const c = context(options);
  const target = options.launcher ?? packagedLauncher(options.executable, c.platform);
  if (c.platform === "win32") {
    if (!target) throw new Error("Use npm uninstall --global for the standalone CLI");
    return windowsPath("uninstall", target);
  }
  const state = readState(c.state);
  for (const { path, created } of state?.configs ?? configs(c.home, c.platform, options.shell ?? process.env.SHELL ?? "").map(path => ({ path, created: false }))) {
    const before = read(path), after = stripBlock(before);
    if (before === after) continue;
    if (created && after === "" && !lstatSync(path).isSymbolicLink()) rmSync(path);
    else atomic(path, after);
  }
  const text = read(c.launcher);
  if (text.startsWith(`#!/bin/sh\n${MARKER}\n`)) rmSync(c.launcher);
  atomic(c.state, JSON.stringify({ disabled: true, launcher: c.launcher, configs: [] }) + "\n");
  return { installed: false, launcher: c.launcher, restartTerminal: true };
}
export function commandStatus(options: CommandOptions = {}) {
  const c = context(options);
  if (c.platform === "win32") {
    const target = options.launcher ?? packagedLauncher(options.executable, c.platform);
    return target ? windowsPath("status", target) : { installed: false, managedBy: "npm" };
  }
  return { installed: read(c.launcher).startsWith(`#!/bin/sh\n${MARKER}\n`), launcher: c.launcher };
}

/** Portable images have no stable installed resource directory. */
export function registerDesktopCommand(launcher: string, options: CommandOptions = {}) {
  const c = context(options);
  if (readState(c.state)?.disabled) return;
  if (c.platform === "win32") return; // NSIS owns its scope and removal metadata.
  if (process.env.APPIMAGE || process.env.PORTABLE_EXECUTABLE_FILE || (c.platform === "darwin" && launcher.startsWith("/Volumes/"))) return;
  // Native Linux packages already install a system command. Never shadow an
  // existing command from npm or another application just by opening the GUI.
  const paths = (process.env.PATH ?? "").split(":");
  for (const dir of paths) {
    const existing = join(dir, "pix");
    if (resolve(existing) === c.launcher) continue;
    if (existsSync(existing)) return;
  }
  return installCommand({ ...options, launcher });
}
