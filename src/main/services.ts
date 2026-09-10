import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
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
import { homedir } from "node:os";
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
export class SettingsService {
  project: string | null;
  appPath = join(process.env.PIX_HOME ?? homedir(), ".pix", "settings.json");
  globalPath = join(
    process.env.PIX_HOME ?? homedir(),
    ".pi",
    "agent",
    "settings.json",
  );
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
    this.update("app", { language });
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
    const app = merge(
      defaults as unknown as Record<string, unknown>,
      readJson(this.appPath),
    ) as unknown as AppSettings;
    app.theme = normalizeTheme(app.theme);
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
  update(
    scope: "app" | "global" | "project",
    patch: Record<string, unknown>,
    replace = false,
  ) {
    const p =
      scope === "app"
        ? this.appPath
        : scope === "global"
          ? this.globalPath
          : this.projectPath;
    if (!p) throw new Error("Open a project first");
    const next = replace ? { ...patch } : merge(readJson(p), patch);
    if (scope === "app" && Object.hasOwn(patch, "keyboardShortcuts")) {
      validateShortcutOverrides(patch.keyboardShortcuts);
      // This map is a complete set of overrides: merging would resurrect reset bindings.
      next.keyboardShortcuts = patch.keyboardShortcuts;
    }
    atomic(p, next);
    return this.bundle();
  }
  reset(scope: "app" | "global" | "project") {
    const p =
      scope === "app"
        ? this.appPath
        : scope === "global"
          ? this.globalPath
          : this.projectPath;
    if (!p) throw new Error("Open a project first");
    atomic(p, {});
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
    this.update("app", { lastProject: resolve(p) });
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
    this.update("app", { recentProjects });
    return recentProjects;
  }
  forgetProject(id: string) {
    const recentProjects = this.projectHistory().filter((item) => item.id !== id);
    this.update("app", { recentProjects });
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
    unlinkSync(this.managed(p));
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
