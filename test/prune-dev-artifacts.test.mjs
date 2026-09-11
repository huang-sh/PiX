import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneDevArtifacts } from "../scripts/strip-cross-platform-binaries.mjs";

test("pruneDevArtifacts removes declarations, maps, and docs but keeps runtime files", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-prune-"));
  try {
    const pkg = join(root, "pi-builtin", "node_modules", "extension");
    mkdirSync(join(pkg, "src"), { recursive: true });
    const keep = [
      join(pkg, "package.json"),
      join(pkg, "index.ts"), // pi compiles extension TS entries at load time
      join(pkg, "src", "index.mts"),
      join(pkg, "dist", "index.js"), // runtime entry for compiled packages
    ];
    const drop = [
      join(pkg, "index.d.ts"),
      join(pkg, "index.d.mts"),
      join(pkg, "dist", "index.d.cts"),
      join(pkg, "dist", "index.js.map"),
      join(pkg, "README.md"),
      join(pkg, "docs", "USAGE.MD"), // case-insensitive
    ];
    for (const file of [...keep, ...drop]) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "x");
    }
    assert.equal(pruneDevArtifacts(join(root, "pi-builtin")), drop.length);
    for (const file of keep) assert.ok(existsSync(file), `${file} must survive`);
    for (const file of drop) assert.ok(!existsSync(file), `${file} must be pruned`);
    assert.equal(pruneDevArtifacts(join(root, "pi-builtin")), 0); // idempotent
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
