import test from "node:test";
import assert from "node:assert/strict";
import {
  mergePath,
  parseLoginPath,
} from "../src/server/login-env.js";

test("mergePath puts login entries first and drops duplicates", () => {
  assert.equal(
    mergePath(
      "/usr/local/bin:/usr/bin:/bin",
      "/home/dev/.nvm/versions/node/v22/bin:/usr/local/bin:/opt/custom/bin",
    ),
    "/home/dev/.nvm/versions/node/v22/bin:/usr/local/bin:/opt/custom/bin:/usr/bin:/bin",
  );
  assert.equal(mergePath("", "/usr/bin"), "/usr/bin");
  assert.equal(mergePath("/usr/bin", ""), "/usr/bin");
});

test("parseLoginPath keeps the last path-like line and ignores shell noise", () => {
  const output = [
    "Welcome to fish 4.0",
    'bash: cannot set terminal process group',
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  ].join("\n");
  assert.equal(
    parseLoginPath(output),
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  );
  assert.equal(parseLoginPath("no paths here\nat all"), "");
  assert.equal(parseLoginPath(""), "");
});
