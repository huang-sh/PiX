import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  hostIsCurrent,
  parseSshHosts,
  sshProjectPath,
  validateSshHost,
  uploadSshHostBundle,
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

for (const fail of [false, true]) {
  test(`SSH bundle upload ${fail ? "cleans up after a transfer failure" : "preserves the bundle and executable modes in one transfer"}`, {
    skip: process.platform === "win32",
  }, async t => {
    const root = mkdtempSync(join(tmpdir(), "pix ssh upload-"));
    const source = join(root, "bundle's files", "server");
    const stage = join(root, "remote stage's files");
    const bin = join(root, "tools");
    const record = join(root, "transfer.json");
    for (const dir of [source, stage, bin]) mkdirSync(dir, { recursive: true });
    const files = {
      "dist/server/index.js": "server code",
      "bin/pix-agent-host": "#!/bin/sh\nexit 0\n",
      "package.json": "{}",
      "package-lock.json": "{}",
      "../skills/example/SKILL.md": "built-in skill",
      "node_modules/private.txt": "must not ship",
      "auth.json": "must not ship",
    };
    for (const [path, content] of Object.entries(files)) {
      const file = join(source, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, { mode: path.startsWith("bin/") ? 0o755 : 0o644 });
    }
    // Replace only the network tools; the real tar creates and extracts the
    // archive, including paths with spaces and quotes and executable modes.
    writeFileSync(join(bin, "scp"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const archive = args.at(-2);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({archive, args}));
${fail ? "process.stderr.write('test transfer failed'); process.exit(1);" : ""}
const target = args.at(-1);
fs.copyFileSync(archive, target.slice(target.indexOf(':') + 1));
`, { mode: 0o755 });
    writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const result = spawnSync('sh', ['-c', process.argv.at(-1)], {stdio: 'inherit'});
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    t.after(() => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    });
    const upload = uploadSshHostBundle("test-host", source, stage);
    if (fail) await assert.rejects(upload, /test transfer failed/);
    else await upload;
    const { archive, args } = JSON.parse(readFileSync(record, "utf8"));
    assert.equal(existsSync(dirname(archive)), false, "temporary local archive is removed");
    assert.equal(args.includes("-r"), false, "one archive replaces the recursive SFTP transfer");
    if (!fail) {
      for (const [path, content] of Object.entries(files)) {
        if (path === "auth.json" || path.startsWith("node_modules/")) continue;
        const remotePath = path.startsWith("../") ? path.slice(3) : path;
        assert.equal(readFileSync(join(stage, remotePath), "utf8"), content);
      }
      assert.equal(statSync(join(stage, "bin/pix-agent-host")).mode & 0o777, 0o755);
      assert.equal(existsSync(join(stage, "node_modules")), false);
      assert.equal(existsSync(join(stage, "auth.json")), false);
      assert.equal(existsSync(join(stage, "host-bundle.tar.gz")), false, "remote archive is removed after extraction");
    }
  });
}
