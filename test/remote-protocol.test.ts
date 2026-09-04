import test from "node:test";
import assert from "node:assert/strict";
import { isProjectRoute } from "../src/shared/remote-protocol.js";

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
