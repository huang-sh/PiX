import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PixieRuntime, pixieWorkspace } from "../src/main/pixie-runtime.js";
import { pixAgentDir } from "../src/main/paths.js";

const slug = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

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
