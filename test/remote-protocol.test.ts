import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isProjectRoute, PIX_HOST_VERSION } from "../src/shared/remote-protocol.js";

test("desktop, remote host and package locks share the product version", () => {
  for (const path of ["package.json", "package-lock.json", "server/package.json", "server/package-lock.json"]) {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(manifest.version, PIX_HOST_VERSION, path);
    if (manifest.packages) assert.equal(manifest.packages[""].version, PIX_HOST_VERSION, `${path} root package`);
  }
});

test("remote host only accepts project-scoped routes", () => {
  assert.equal(isProjectRoute("workspace.read"), true);
  assert.equal(isProjectRoute("workspace.directories"), true);
  assert.equal(isProjectRoute("workspace.open"), true);
  assert.equal(isProjectRoute("terminal.create"), true);
  assert.equal(isProjectRoute("terminal.write"), true);
  assert.equal(isProjectRoute("agent.control"), true);
  assert.equal(isProjectRoute("app.quit"), false);
  assert.equal(isProjectRoute("layout.save"), false);
});
