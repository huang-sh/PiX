import test from "node:test";
import assert from "node:assert/strict";
import {
  hostIsCurrent,
  parseSshHosts,
  sshProjectPath,
  validateSshHost,
} from "../src/main/ssh-host-installer.js";
import { PIX_HOST_VERSION, PIX_REMOTE_PROTOCOL } from "../src/shared/remote-protocol.js";
import { piSdkVersion } from "../src/main/pi-runtime.js";

test("remote installation checks the Pi SDK version as well as host and protocol", async () => {
  const piVersion = await piSdkVersion();
  const host = { version: PIX_HOST_VERSION, protocol: PIX_REMOTE_PROTOCOL };
  assert.equal(hostIsCurrent({ ...host, piVersion }, piVersion), true);
  assert.equal(hostIsCurrent({ ...host, piVersion: "1.0.0" }, piVersion), false);
  assert.equal(hostIsCurrent({ ...host, piVersion: "1.1.0" }, piVersion), false);
  assert.equal(hostIsCurrent(host, piVersion), false, "Pi 1.0 hosts had no SDK version in `version` output");
});

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
