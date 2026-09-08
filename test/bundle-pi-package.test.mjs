import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundlePiPackage } from "../scripts/bundle-pi-package.mjs";

test("bundles runtime dependencies with nested versions, excluding peers and dev packages", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-bundle-"));
  const modules = join(root, "node_modules");
  const resources = join(root, "resources");
  const add = (path, pkg) => {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify(pkg));
  };
  try {
    add(join(modules, "extension"), {
      dependencies: { shared: "1", child: "1" },
      optionalDependencies: { absent: "1" },
      peerDependencies: { sdk: "1" }, devDependencies: { test: "1" },
    });
    add(join(modules, "shared"), { version: "1" });
    add(join(modules, "child"), { dependencies: { shared: "2" } });
    add(join(modules, "child", "node_modules", "shared"), { version: "2", exports: {} });
    add(join(modules, "sdk"), {});
    add(join(modules, "extension", "node_modules", "test"), {});
    assert.equal(bundlePiPackage(root, resources, "extension"), 4);
    const output = join(resources, "pi-builtin", "node_modules");
    assert.equal(JSON.parse(readFileSync(join(output, "child/node_modules/shared/package.json"))).version, "2");
    assert.equal(existsSync(join(output, "sdk")), false);
    assert.equal(existsSync(join(output, "extension/node_modules/test")), false);
    add(join(modules, "broken"), { dependencies: { missing: "1" } });
    assert.throws(() => bundlePiPackage(root, resources, "broken"), /Missing bundled dependency missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
