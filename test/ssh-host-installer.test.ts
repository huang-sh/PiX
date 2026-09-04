import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSshHosts,
  sshProjectPath,
  validateSshHost,
} from "../src/main/ssh-host-installer.js";

test("accepts SSH aliases and user-qualified hosts", () => {
  assert.equal(validateSshHost("stempdac"), "stempdac");
  assert.equal(validateSshHost("pix@server.example:22"), "pix@server.example:22");
});

test("rejects SSH options and shell syntax as hosts", () => {
  for (const host of ["-oProxyCommand=bad", "host;bad", "host name", "host\ncommand"])
    assert.throws(() => validateSshHost(host));
});

test("discovers literal aliases from OpenSSH config", () => {
  assert.deepEqual(
    parseSshHosts(`
Host *
  ServerAliveInterval 30
Host stempdac yuyun # cluster hosts
Host *.internal !bastion
Host stempdac
`),
    ["stempdac", "yuyun"],
  );
});

test("expands SSH home-relative project paths without shell injection", () => {
  assert.equal(sshProjectPath("~"), '"$HOME"');
  assert.equal(sshProjectPath("~/project data"), `"$HOME"/'project data'`);
  assert.equal(sshProjectPath("/srv/project data"), "'/srv/project data'");
  assert.throws(() => sshProjectPath("relative/project"));
  assert.throws(() => sshProjectPath("~/project\nwhoami"));
});
