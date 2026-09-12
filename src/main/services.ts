import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { spawn as spawnPty, type IPty } from "node-pty";
import type {
  AppSettings,
  DirectoryListing,
  FileDocument,
  FileNode,
  GitStatus,
  LayoutState,
  PiSettings,
  ProjectHistory,
  ProjectInfo,
  SessionSummary,
  SettingsBundle,
  ShellResult,
} from "../shared/types.js";
import { projectId } from "../shared/types.js";
import { validateShortcutOverrides } from "../shared/shortcuts.js";
import { normalizeTheme } from "../shared/theme.js";
import { parseSessionJsonl, summarizeSession } from "../shared/session.js";
import { fileChangeDir } from "./file-changes.js";
import { graphDir } from "./graph-files.js";
import { pixAgentDir, pixHome } from "./paths.js";
import { piSettingsSdk } from "./pi-runtime.js";
const readJson = <T extends Record<string, unknown>>(p: string): T => {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as T)
      : ({} as T);
  } catch {
    return {} as T;
  }
};
const merge = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] =
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === "object" &&
      !Array.isArray(out[k])
        ? merge(out[k] as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
};
const atomic = (p: string, v: unknown) => {
  mkdirSync(dirname(p), { recursive: true });
  const t = `${p}.tmp`;
  writeFileSync(t, JSON.stringify(v, null, 2) + "\n");
  renameSync(t, p);
};
export const DEFAULT_LAYOUT: LayoutState = {
  version: 4,
  navigatorPinned: false,
  widths: { navigator: 248, chat: 356, content: 320 },
  collapsed: { navigator: false, chat: true, content: true },
  minimap: false,
  composer: { open: false },
  utility: {
    open: false,
    collapsed: false,
    height: 250,
    activeTab: "terminal",
  },
};
/** A settings file is readable only if it parses to a JSON object. */
function readableSettings(path: string): boolean {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}
/**
 * A missing settings file is fine (defaults apply); a corrupt one is parked
 * beside the fresh file as `<name>.corrupt-<timestamp>` so the next write
 * starts clean without silently destroying what was there.
 */
function quarantineCorruptSettings(path: string) {
  if (!existsSync(path) || readableSettings(path)) return;
  try {
    renameSync(
      path,
      `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "")}`,
    );
  } catch {}
}
/**
 * One-time bootstrap of a profile: park a corrupt GUI settings file, and on
 * first launch copy an existing pi CLI agent profile — logins, custom models,
 * skills — into the profile's own agent dir so they carry over once.
 */
export function bootstrapPixProfile(home: string) {
  quarantineCorruptSettings(join(home, ".pix", "gui.settings.json"));
  const source = join(home, ".pi", "agent");
  const target = join(home, ".pix", "agent");
  if (
    !existsSync(source) ||
    existsSync(join(target, "auth.json")) ||
    existsSync(join(target, "models.json"))
  )
    return;
  mkdirSync(target, { recursive: true });
  cpSync(source, target, {
    recursive: true,
    force: false,
    // Sessions live in each project's .pi/sessions; CLI history stays there.
    filter: (src) => basename(src) !== "sessions",
  });
}
/**
 * Value-level fault tolerance for the GUI settings: known keys with a wrong
 * type or out-of-range value are dropped so the defaults apply, while unknown
 * keys (a newer version wrote them) survive untouched. Runs on every read
 * and before every write, so neither a hand-edited file nor a bad patch can
 * push an unusable value into the app.
 */
function normalizeAppSettings(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  const drop = (key: string) => delete out[key];
  const expectBoolean = (key: string) => {
    if (typeof out[key] !== "boolean") drop(key);
  };
  const expectNumber = (key: string, min: number, max: number) => {
    const value = out[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
      drop(key);
  };
  if (out.language !== "system" && out.language !== "zh-CN" && out.language !== "en")
    drop("language");
  if (out.density !== "comfortable" && out.density !== "compact") drop("density");
  out.theme = normalizeTheme(out.theme);
  if (typeof out.browserHome !== "string" || !out.browserHome) drop("browserHome");
  if (out.lastProject !== undefined && typeof out.lastProject !== "string") drop("lastProject");
  if (out.updateSkippedVersion !== undefined && typeof out.updateSkippedVersion !== "string")
    drop("updateSkippedVersion");
  for (const key of [
    "confirmDestructiveActions",
    "openLastSessionOnStartup",
    "enterToSend",
    "openLinksInApp",
    "closeToTray",
    "canvasDotGrid",
  ])
    expectBoolean(key);
  expectNumber("canvasDotGridSpacing", 8, 96);
  expectNumber("canvasDotGridDotSize", 1, 6);
  try {
    if (out.keyboardShortcuts !== undefined) validateShortcutOverrides(out.keyboardShortcuts);
  } catch {
    drop("keyboardShortcuts");
  }
  return out;
}

export class SettingsService {
  project: string | null;
  appPath = join(pixHome(), ".pix", "gui.settings.json");
  globalPath = join(pixAgentDir(), "settings.json");
  constructor(project: string | null) {
    this.project = project ? resolve(project) : null;
  }
  setProject(p: string | null) {
    this.project = p ? resolve(p) : null;
  }
  // The Windows installer records the setup-wizard language under
  // HKCU\Software\PiX. Adopt it once as the interface language; the value is
  // consumed here so later changes in Settings are never overridden.
  applyInstallerLanguage() {
    if (process.platform !== "win32") return;
    const query = spawnSync(
      "reg",
      ["query", "HKCU\\Software\\PiX", "/v", "installerLanguage"],
      { encoding: "utf8", windowsHide: true },
    );
    if (query.status !== 0) return;
    const lcid = /REG_SZ\s+(\d+)/.exec(query.stdout)?.[1];
    const language = lcid === "2052" ? "zh-CN" : lcid === "1033" ? "en" : null;
    if (!language) return;
    spawnSync(
      "reg",
      ["delete", "HKCU\\Software\\PiX", "/v", "installerLanguage", "/f"],
      { windowsHide: true },
    );
    this.update({ language });
  }
  get projectPath() {
    return this.project ? join(this.project, ".pi", "settings.json") : null;
  }
  bundle(): SettingsBundle {
    const defaults: AppSettings = {
      language: "system",
      theme: "light",
      density: "comfortable",
      confirmDestructiveActions: true,
      browserHome: "https://pi.dev",
      openLastSessionOnStartup: false,
      enterToSend: true,
      openLinksInApp: true,
      closeToTray: true,
      canvasDotGrid: true,
      canvasDotGridSpacing: 24,
      canvasDotGridDotSize: 4,
    };
    // Normalize the raw file before the defaults merge, so a dropped key is
    // filled by its default instead of surfacing as undefined.
    const app = merge(
      defaults as unknown as Record<string, unknown>,
      normalizeAppSettings(readJson(this.appPath)),
    ) as unknown as AppSettings;
    const piGlobal = readJson<PiSettings>(this.globalPath),
      piProject = this.project && this.projectPath
        ? readJson<PiSettings>(this.projectPath)
        : {};
    return {
      app,
      piGlobal,
      piProject,
      effective: merge(piGlobal, piProject) as PiSettings,
      paths: {
        app: this.appPath,
        global: this.globalPath,
        project: this.projectPath,
      },
    };
  }
  update(patch: Record<string, unknown>, replace = false) {
    const next = replace ? { ...patch } : merge(readJson(this.appPath), patch);
    if (Object.hasOwn(patch, "keyboardShortcuts")) {
      validateShortcutOverrides(patch.keyboardShortcuts);
      // This map is a complete set of overrides: merging would resurrect reset bindings.
      next.keyboardShortcuts = patch.keyboardShortcuts;
    }
    // App writes persist only values the app can read back.
    atomic(this.appPath, normalizeAppSettings(next));
    return this.bundle();
  }
  reset() {
    atomic(this.appPath, {});
    return this.bundle();
  }
  /**
   * Pi agent settings files belong to the pi SDK: reads for display stay in
   * bundle(), but writes go through the SDK's own storage so they take the
   * same file lock the CLI uses, a corrupt file freezes saves instead of
   * being overwritten, and loaded values keep the SDK's format migrations.
   */
  async updatePi(
    scope: "global" | "project",
    patch: Record<string, unknown>,
    replace = false,
  ) {
    if (scope === "project" && !this.project)
      throw new Error("Open a project first");
    const { FileSettingsStorage, SettingsManager } = await piSettingsSdk();
    const cwd = this.project ?? join(pixHome(), ".pix");
    const agentDir = pixAgentDir();
    // Freeze: a file the SDK cannot load is never overwritten. The user gets
    // the path and can fix it, remove it, or reset it from Settings.
    const probe = SettingsManager.create(cwd, agentDir);
    const loadError = probe.drainErrors().find((e) => e.scope === scope);
    if (loadError)
      throw new Error(
        `The ${scope} settings file at ${loadError.path ?? "?"} is unreadable (${loadError.error.message}); fix or remove it, or reset it in Settings`,
      );
    new FileSettingsStorage(cwd, agentDir).withLock(scope, (current) => {
      let base: Record<string, unknown> = {};
      if (current !== undefined) {
        try {
          const parsed = JSON.parse(current.replace(/^\uFEFF/, ""));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            base = parsed as Record<string, unknown>;
        } catch {
          // The probe above already rejects a corrupt file; this guards the
          // tiny window where the file changed between probe and lock.
          throw new Error(
            `The ${scope} settings file changed and is unreadable; retry after fixing it`,
          );
        }
      }
      return JSON.stringify(replace ? { ...patch } : merge(base, patch), null, 2);
    });
    return this.bundle();
  }
  /** Reset is the remedy a frozen (corrupt) file needs, so it bypasses the save freeze. */
  async resetPi(scope: "global" | "project") {
    if (scope === "project" && !this.project)
      throw new Error("Open a project first");
    const { FileSettingsStorage } = await piSettingsSdk();
    const cwd = this.project ?? join(pixHome(), ".pix");
    new FileSettingsStorage(cwd, pixAgentDir()).withLock(scope, () => "{}");
    return this.bundle();
  }
  layout() {
    return merge(
      DEFAULT_LAYOUT as unknown as Record<string, unknown>,
      (readJson(this.appPath).layout as Record<string, unknown>) ?? {},
    ) as unknown as LayoutState;
  }
  saveLayout(layout: LayoutState) {
    atomic(this.appPath, merge(readJson(this.appPath), { layout }));
  }
  lastProject(p: string) {
    this.update({ lastProject: resolve(p) });
  }
  projectHistory() {
    const value = readJson(this.appPath).recentProjects;
    return Array.isArray(value)
      ? value.filter((item): item is ProjectHistory =>
          Boolean(
            item &&
            typeof item === "object" &&
            typeof (item as ProjectHistory).id === "string" &&
            typeof (item as ProjectHistory).project?.path === "string" &&
            Array.isArray((item as ProjectHistory).sessions),
          ),
        )
      : [];
  }
  rememberProject(project: ProjectInfo, sessions: SessionSummary[]) {
    const id = projectId(project);
    const record: ProjectHistory = {
      id,
      project,
      sessions,
      lastOpened: new Date().toISOString(),
    };
    const recentProjects = [
      record,
      ...this.projectHistory().filter((item) => item.id !== id),
    ];
    this.update({ recentProjects });
    return recentProjects;
  }
  forgetProject(id: string) {
    const recentProjects = this.projectHistory().filter((item) => item.id !== id);
    this.update({ recentProjects });
    return recentProjects;
  }
}
export class WorkspaceService {
  root: string | null;
  constructor(p: string | null) {
    this.root = p ? resolve(p) : null;
  }
  setRoot(p: string | null) {
    this.root = p ? resolve(p) : null;
  }
  safe(p: string) {
    const root = this.root;
    if (!root) throw new Error("Open a project first");
    const target = resolve(root, p),
      r = relative(root, target);
    if (r === ".." || r.startsWith(`..${sep}`))
      throw new Error("Path escapes project");
    const realRoot = realpathSync(root),
      resolved = realpathSync(existsSync(target) ? target : dirname(target)),
      real = relative(realRoot, resolved);
    if (real === ".." || real.startsWith(`..${sep}`))
      throw new Error("Path escapes project through a symbolic link");
    return target;
  }
  tree(p = "") {
    const root = this.root;
    if (!root) throw new Error("Open a project first");
    const directory = this.safe(p);
    if (!statSync(directory).isDirectory()) throw new Error("Directory not found");
    return readdirSync(directory)
      .sort()
      .flatMap((name): FileNode[] => {
        const entry = join(directory, name);
        let stat;
        try {
          stat = statSync(entry);
        } catch {
          return [];
        }
        const path = relative(root, entry).split(sep).join("/");
        return stat.isDirectory()
          ? [{ name, path, kind: "directory", modified: stat.mtime.toISOString() }]
          : [{ name, path, kind: "file", size: stat.size, modified: stat.mtime.toISOString() }];
      });
  }
  directories(path: string): DirectoryListing {
    const target = realpathSync(resolve(path));
    if (!statSync(target).isDirectory()) throw new Error("Directory not found");
    const entries = readdirSync(target)
      .sort((a, b) => a.localeCompare(b))
      .flatMap((name): FileNode[] => {
        const entry = join(target, name);
        try {
          return statSync(entry).isDirectory()
            ? [{ name, path: entry.split(sep).join("/"), kind: "directory" }]
            : [];
        } catch {
          return [];
        }
      });
    return { path: target.split(sep).join("/"), entries };
  }
  read(p: string): FileDocument {
    const root = this.root;
    if (!root) throw new Error("Open a project first");
    const a = this.safe(p),
      b = readFileSync(a),
      ext = extname(a).toLowerCase(),
      mime: Record<string, string> = {
        ".avif": "image/avif",
        ".bmp": "image/bmp",
        ".gif": "image/gif",
        ".ico": "image/x-icon",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
      },
      truncated = b.length > 2 * 1024 * 1024,
      s = truncated ? b.subarray(0, 2 * 1024 * 1024) : b;
    if (mime[ext])
      return {
        path: relative(root, a).split(sep).join("/"),
        name: basename(a),
        content: "",
        dataUrl: `data:${mime[ext]};base64,${b.toString("base64")}`,
        language: "image",
        readonly: true,
        truncated: false,
      };
    if (s.includes(0)) throw new Error("Binary file");
    const language: Record<string, string> = {
      ".ts": "typescript",
      ".js": "javascript",
      ".json": "json",
      ".css": "css",
      ".html": "html",
      ".md": "markdown",
      ".py": "python",
      ".rs": "rust",
      ".go": "go",
      ".yml": "yaml",
      ".yaml": "yaml",
    };
    return {
      path: relative(root, a).split(sep).join("/"),
      name: basename(a),
      content: s.toString("utf8"),
      language: language[ext] ?? "text",
      readonly: truncated,
      truncated,
    };
  }
  write(p: string, c: string) {
    const a = this.safe(p);
    writeFileSync(a, c, "utf8");
    return this.read(p);
  }
}
const git = promisify(execFile);
export class GitService {
  root: string | null;
  constructor(p: string | null) {
    this.root = p;
  }
  setRoot(p: string | null) {
    this.root = p;
  }
  async status(): Promise<GitStatus> {
    const root = this.root;
    if (!root) throw new Error("Open a project first");
    let stdout: string;
    try {
        ({ stdout } = await git(
          "git",
          [
            "-c",
            `safe.directory=${root}`,
            "status",
            "--porcelain=v1",
            "-b",
          ],
          {
            cwd: root,
            encoding: "utf8",
            windowsHide: true,
          },
        ));
    } catch (error) {
      return {
        available: false,
        ahead: 0,
        behind: 0,
        changes: [],
        clean: true,
        error: String(
          (error as Error & { stderr?: string }).stderr ?? "Not a Git repository",
        ).trim(),
      };
    }
    const lines = stdout
        .split(/\r?\n/)
        .filter(Boolean),
      head = lines.shift() ?? "";
    const changes = lines.map((line) => ({
      path: line.slice(3).split(" -> ").at(-1) ?? line.slice(3),
      status: line.slice(0, 2).trim() || "M",
      staged: (line[0] ?? " ") !== " " && (line[0] ?? " ") !== "?",
    }));
    return {
      available: true,
      branch: head.slice(3).split("...")[0]?.split(" [")[0] || "HEAD",
      ahead: Number(head.match(/ahead (\d+)/)?.[1] ?? 0),
      behind: Number(head.match(/behind (\d+)/)?.[1] ?? 0),
      changes,
      clean: changes.length === 0,
    };
  }
  async diff(p?: string, staged = false) {
    const root = this.root;
    if (!root) throw new Error("Open a project first");
    const a = ["diff", "--no-ext-diff", "--minimal"];
    if (staged) a.push("--cached");
    if (p) a.push("--", p);
    const { stdout } = await git("git", [
      "-c",
      `safe.directory=${root}`,
      ...a,
    ], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout || "No changes.";
  }
}
export class ShellService {
  root: string | null;
  running = new Map<string, any>();
  terminals = new Map<string, IPty>();
  emit: (e: unknown) => void;
  constructor(p: string | null, emit: (e: unknown) => void) {
    this.root = p;
    this.emit = emit;
  }
  setRoot(p: string | null) {
    this.closeTerminals();
    this.root = p;
  }
  create(cols: number, rows: number): { id: string } {
    const id = randomUUID();
    const win = process.platform === "win32";
    const executable = win ? "powershell.exe" : process.env.SHELL || "/bin/bash";
    const args = win ? ["-NoProfile"] : [];
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const terminal = spawnPty(executable, args, {
      name: "xterm-256color",
      cwd: this.root ?? undefined,
      env,
      cols,
      rows,
      ...(win ? { useConpty: true } : {}),
    });
    this.terminals.set(id, terminal);
    terminal.onData((data) =>
      this.emit({ type: "terminal", payload: { id, data } }),
    );
    terminal.onExit(({ exitCode }) => {
      this.terminals.delete(id);
      this.emit({ type: "terminal", payload: { id, exitCode } });
    });
    return { id };
  }
  writeTerminal(id: string, data: string) {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error("Terminal session not found");
    terminal.write(data);
  }
  resizeTerminal(id: string, cols: number, rows: number) {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error("Terminal session not found");
    terminal.resize(cols, rows);
  }
  killTerminal(id: string) {
    const terminal = this.terminals.get(id);
    if (!terminal) return false;
    this.terminals.delete(id);
    terminal.kill();
    return true;
  }
  closeTerminals() {
    for (const id of [...this.terminals.keys()]) this.killTerminal(id);
  }
  run(command: string): Promise<ShellResult> {
    const id = randomUUID(),
      win = process.platform === "win32",
      bin = win ? "powershell.exe" : process.env.SHELL || "/bin/bash",
      args = win
        ? ["-NoLogo", "-NoProfile", "-Command", command]
        : ["-lc", command];
    return new Promise((ok, fail) => {
      const child = spawn(bin, args, {
        cwd: this.root ?? undefined,
        env: process.env,
        windowsHide: true,
      });
      this.running.set(id, child);
      let output = "",
        truncated = false;
      const add = (c: unknown) => {
        const t = String(c);
        if (output.length < 2e6) output += t.slice(0, 2e6 - output.length);
        else truncated = true;
        this.emit({ type: "shell", payload: { id, chunk: t } });
      };
      child.stdout?.on("data", add);
      child.stderr?.on("data", add);
      child.on("error", fail);
      child.on("close", (code: number | null, signal: string | null) => {
        this.running.delete(id);
        ok({
          id,
          command,
          output,
          exitCode: code,
          cancelled: signal !== null,
          truncated,
        });
      });
    });
  }
  abort(id: string) {
    const p = this.running.get(id);
    if (!p) return false;
    p.kill("SIGTERM");
    return true;
  }
  dispose() {
    this.closeTerminals();
    for (const process of this.running.values()) process.kill("SIGTERM");
    this.running.clear();
  }
}
export class SessionFiles {
  cwd: string | null;
  dir: string | null;
  constructor(cwd: string | null, dir: string | null) {
    this.cwd = cwd ? resolve(cwd) : null;
    this.dir = dir ? resolve(dir) : null;
    if (this.dir) mkdirSync(this.dir, { recursive: true });
  }
  set(cwd: string | null, dir: string | null) {
    this.cwd = cwd ? resolve(cwd) : null;
    this.dir = dir ? resolve(dir) : null;
    if (this.dir) mkdirSync(this.dir, { recursive: true });
  }
  managed(p: string) {
    if (!this.dir)
      throw new Error("Open a project first");
    const root = realpathSync(this.dir);
    const target = realpathSync(resolve(p));
    const path = relative(root, target);
    if (
      !path ||
      isAbsolute(path) ||
      path.startsWith(`..${sep}`) ||
      dirname(path) !== "." ||
      extname(path) !== ".jsonl"
    )
      throw new Error("Session path escapes the configured session directory");
    return target;
  }
  list(): SessionSummary[] {
    const dir = this.dir;
    if (!dir || !existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .flatMap((n) => {
        const p = join(dir, n);
        try {
          const s = statSync(p),
            x = parseSessionJsonl(readFileSync(p, "utf8"));
          return [
            summarizeSession(p, x.header, x.entries, s.mtime.toISOString()),
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  }
  read(p: string) {
    return parseSessionJsonl(readFileSync(this.managed(p), "utf8"));
  }
  import(source: string) {
    const dir = this.dir;
    if (!dir) throw new Error("Open a project first");
    const raw = readFileSync(resolve(source), "utf8");
    const x = parseSessionJsonl(raw);
    if (x.header?.type !== "session") throw new Error("Not a Pi session");
    let target = join(
      dir,
      basename(source).replace(/\(1\)(?=\.jsonl$)/, ""),
    );
    if (existsSync(target))
      target = join(dir, `${Date.now()}-${basename(target)}`);
    const lines = raw.split(/\r?\n/),
      i = lines.findIndex((l) => l.trim());
    const h = JSON.parse(lines[i]!);
    h.cwd = this.cwd;
    lines[i] = JSON.stringify(h);
    writeFileSync(target, lines.join("\n").trimEnd() + "\n");
    return target;
  }
  rename(p: string, name: string) {
    p = this.managed(p);
    const raw = readFileSync(p, "utf8").trimEnd(),
      entries = parseSessionJsonl(raw).entries;
    writeFileSync(
      p,
      raw +
        "\n" +
        JSON.stringify({
          type: "session_info",
          id: randomUUID().slice(0, 8),
          parentId: entries.at(-1)?.id ?? null,
          timestamp: new Date().toISOString(),
          name: name.replace(/[\r\n]+/g, " ").trim(),
        }) +
        "\n",
    );
  }
  delete(p: string) {
    const path = this.managed(p);
    unlinkSync(path);
    // The sidecars keep file contents and branch records that nothing can reach
    // once the session file is gone, so they go with it. Cleanup stays
    // best-effort: a locked snapshot must not report a finished deletion as a
    // failure after the session file itself is already unlinked.
    for (const dir of [fileChangeDir(path), graphDir(path)]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
}
export function configuredSessionDir(
  project: string,
  settings: SettingsBundle,
) {
  const v = settings.effective.sessionDir;
  if (typeof v === "string" && v.trim())
    return isAbsolute(v) ? resolve(v) : resolve(project, v);
  return join(project, ".pi", "sessions");
}
