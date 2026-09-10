import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  GitService,
  SessionFiles,
  SettingsService,
  ShellService,
  WorkspaceService,
} from "../src/main/services.js";
import { projectId } from "../src/shared/types.js";
const root = resolve(process.cwd(), "test", "workspace");
test("workspace reads real files and blocks traversal", () => {
  const w = new WorkspaceService(root);
  const tree = w.tree();
  assert.deepEqual(tree.map((entry) => entry.name), readdirSync(root).sort());
  assert.equal(tree.find((entry) => entry.name === "src")?.children, undefined);
  assert.ok(w.tree("src").some((entry) => entry.name === "example.ts"));
  assert.ok(w.directories(root).entries.some((entry) => entry.name === "src"));
  assert.match(w.read("README.md").content, /PiX validation workspace/);
  assert.throws(() => w.read("../package.json"));
});
test("workspace blocks symbolic links that escape the project", () => {
  const temp = mkdtempSync(join(tmpdir(), "pix-workspace-"));
  const project = join(temp, "project"),
    outside = join(temp, "outside");
  try {
    mkdirSync(project);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(project, "escape"), "junction");
    assert.throws(() => new WorkspaceService(project).read("escape/secret.txt"));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("workspace returns browser-safe image previews", () => {
  const temp = mkdtempSync(join(tmpdir(), "pix-image-"));
  try {
    writeFileSync(
      join(temp, "pixel.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    );
    const image = new WorkspaceService(temp).read("pixel.png");
    assert.equal(image.language, "image");
    assert.equal(image.readonly, true);
    assert.match(image.dataUrl ?? "", /^data:image\/png;base64,/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("git service reports real fixture changes", async () => {
  const s = await new GitService(root).status();
  assert.equal(s.available, true);
  assert.ok(s.changes.some((x) => x.path === "src/example.ts"));
  assert.ok(s.changes.some((x) => x.path === "src/new-file.ts"));
});
test("session file service lists both sessions", () =>
  assert.equal(
    new SessionFiles(root, resolve(root, ".pi", "sessions")).list().length,
    2,
  ));
test("session file service rejects paths outside its directory", () => {
  const sessions = new SessionFiles(root, resolve(root, ".pi", "sessions"));
  assert.throws(() => sessions.managed(resolve(root, "README.md")));
});
test("session file service persists renamed sessions", () => {
  const temp = mkdtempSync(join(tmpdir(), "pix-session-"));
  try {
    const path = join(temp, "session.jsonl");
    writeFileSync(path, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "session",
      timestamp: "2026-09-03T00:00:00.000Z",
      cwd: temp,
    })}\n`);
    const sessions = new SessionFiles(temp, temp);

    sessions.rename(path, "Renamed");

    assert.equal(sessions.list()[0]?.name, "Renamed");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("session file service removes content sidecars with the session", () => {
  const temp = mkdtempSync(join(tmpdir(), "pix-session-"));
  try {
    const path = join(temp, "session.jsonl");
    writeFileSync(path, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "session",
      timestamp: "2026-09-03T00:00:00.000Z",
      cwd: temp,
    })}\n`);
    // Saved diffs and branch records keep file contents that nothing can reach
    // once the session file itself is unlinked.
    const snapshots = `${path}.file-changes`;
    const branches = `${path}.pix-tree`;
    mkdirSync(snapshots, { recursive: true });
    writeFileSync(join(snapshots, "snapshot.json"), "{}\n");
    mkdirSync(branches, { recursive: true });
    writeFileSync(join(branches, "main.jsonl"), "{}\n");
    const sessions = new SessionFiles(temp, temp);

    sessions.delete(path);

    assert.equal(existsSync(path), false);
    assert.equal(existsSync(snapshots), false);
    assert.equal(existsSync(branches), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("settings remembers local and remote project sessions", () => {
  const temp = mkdtempSync(join(tmpdir(), "pix-projects-"));
  try {
    const settings = new SettingsService(temp);
    settings.appPath = join(temp, "settings.json");
    const local = { name: "local", path: temp };
    const remote = {
      name: "remote",
      path: "/srv/remote",
      remote: { kind: "ssh" as const, host: "example" },
    };

    settings.rememberProject(local, []);
    settings.rememberProject(remote, []);

    assert.deepEqual(
      settings.projectHistory().map((record) => record.id),
      [projectId(remote), projectId(local)],
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("shell service executes in active project", async () => {
  const shell = new ShellService(root, () => {}),
    r = await shell.run(
      process.platform === "win32"
        ? "Write-Output pix-shell"
        : "printf pix-shell",
    );
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /pix-shell/);
});
test("terminal service runs an interactive PTY", async () => {
  let output = "";
  let resolveOutput: (() => void) | undefined;
  const complete = new Promise<void>((resolve) => (resolveOutput = resolve));
  const shell = new ShellService(root, (event) => {
    const payload = (event as { payload?: { data?: string } }).payload;
    output += payload?.data ?? "";
    if (output.includes("pix-terminal")) resolveOutput?.();
  });
  const terminal = shell.create(80, 24);
  try {
    shell.resizeTerminal(terminal.id, 100, 30);
    shell.writeTerminal(
      terminal.id,
      process.platform === "win32"
        ? "Write-Output pix-terminal\r"
        : "printf 'pix-terminal\\n'\r",
    );
    await Promise.race([
      complete,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Terminal output timed out")), 5_000),
      ),
    ]);
    assert.match(output, /pix-terminal/);
  } finally {
    shell.dispose();
  }
});
