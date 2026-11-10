import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PixieRuntime, pixieWorkspace } from "../src/main/pixie-runtime.js";
import { canonicalPath, pixAgentDir, pixieSessionDirs } from "../src/main/paths.js";

const slug = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

test("pixieSessionDirs covers the workspace dir and both CLI slotted spellings", () => {
  withTempHome(() => {
    // The workspace exists once Pixie has run; realpath then resolves the
    // platform's symlinked spellings (/var vs /private/var) into two slugs.
    mkdirSync(pixieWorkspace(), { recursive: true });
    assert.deepEqual(pixieSessionDirs(), [
      join(pixieWorkspace(), "sessions"),
      join(pixAgentDir(), "sessions", slug(pixieWorkspace())),
      join(pixAgentDir(), "sessions", slug(canonicalPath(pixieWorkspace()))),
    ]);
  });
});

function withTempHome(run: (agentDir: string) => void): void {
  const previous = process.env.PIX_HOME;
  const home = mkdtempSync(join(tmpdir(), "pix-workspace-"));
  process.env.PIX_HOME = home;
  try {
    run(pixAgentDir());
  } finally {
    if (previous === undefined) delete process.env.PIX_HOME;
    else process.env.PIX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("construction migrates the legacy assistant workspace and its session dir", () => {
  withTempHome(agentDir => {
    const legacy = join(agentDir, "assistant");
    mkdirSync(join(legacy, "sessions"), { recursive: true });
    writeFileSync(join(legacy, "sessions", "a.jsonl"), "{}");
    const legacySessions = join(agentDir, "sessions", slug(legacy));
    mkdirSync(legacySessions, { recursive: true });
    writeFileSync(join(legacySessions, "old.jsonl"), "{}");

    // clearHistory wipes the current dirs before booting; constructing the
    // runtime must have moved the legacy ones out of reach first.
    new PixieRuntime(() => {}, () => ({}));

    assert.ok(existsSync(join(pixieWorkspace(), "sessions", "a.jsonl")));
    assert.ok(!existsSync(legacy));
    assert.ok(existsSync(join(agentDir, "sessions", slug(pixieWorkspace()), "old.jsonl")));
    assert.ok(!existsSync(legacySessions));
  });
});

test("an existing pixie workspace leaves the legacy dir untouched", () => {
  withTempHome(agentDir => {
    mkdirSync(join(agentDir, "assistant", "sessions"), { recursive: true });
    mkdirSync(join(pixieWorkspace(), "occupied"), { recursive: true });

    new PixieRuntime(() => {}, () => ({}));

    assert.ok(existsSync(join(agentDir, "assistant", "sessions")));
    assert.ok(existsSync(join(pixieWorkspace(), "occupied")));
  });
});

test("a symlinked profile restores and clears sessions written under the real cwd", async t => {
  const previous = process.env.PIX_HOME;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pix-workspace-link-")));
  const home = join(root, "home");
  const alias = join(root, "alias");
  mkdirSync(home);
  symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
  process.env.PIX_HOME = alias;
  const runtime = new PixieRuntime(() => {}, () => ({ restoreLastConversation: true }));
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME;
    else process.env.PIX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(pixieWorkspace(), { recursive: true });
  const sessions = join(pixAgentDir(), "sessions");
  const realDir = join(sessions, slug(realpathSync(pixieWorkspace())));
  mkdirSync(realDir, { recursive: true });
  const saved = join(realDir, "saved.jsonl");
  writeFileSync(saved, "{}");
  const requests: unknown[] = [];
  t.mock.method(runtime as any, "startMonitoring", () => {});
  t.mock.method(runtime as any, "startAgent", async () => {});
  t.mock.method(runtime as any, "snapshot", async () => ({}));
  t.mock.method(runtime["rpc"], "request", async (input: unknown) => { requests.push(input); return {}; });

  await runtime.ensure();
  assert.deepEqual(requests, [{ type: "switch_session", sessionPath: saved }]);

  const aliasDir = join(sessions, slug(pixieWorkspace()));
  const embeddedDir = join(pixieWorkspace(), "sessions");
  const unrelated = join(sessions, "other-workspace", "keep.jsonl");
  for (const dir of [aliasDir, embeddedDir, join(sessions, "other-workspace")])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(aliasDir, "old.jsonl"), "{}");
  writeFileSync(join(embeddedDir, "old.jsonl"), "{}");
  writeFileSync(unrelated, "{}");
  await runtime.clearHistory();
  assert.equal(existsSync(saved), false);
  assert.equal(existsSync(join(aliasDir, "old.jsonl")), false);
  assert.equal(existsSync(join(embeddedDir, "old.jsonl")), false);
  assert.equal(existsSync(unrelated), true);
});
