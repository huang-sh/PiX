import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ensureHostInstalled } from "../server/dist/main/ssh-host-installer.js";
import { WslHostClient, HostStarted } from "../server/dist/main/wsl-host-client.js";
import { PIX_HOST_VERSION, PIX_REMOTE_PROTOCOL } from "../server/dist/shared/remote-protocol.js";
import { piSdkVersion } from "../server/dist/main/pi-runtime.js";

if (process.platform !== "win32") throw new Error("This test requires Windows and WSL");
const distro = process.env.PIX_WSL_DISTRO || (await WslHostClient.names())[0];
if (!distro) throw new Error("No WSL distribution is installed");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const runWsl = (args, timeout = 300_000) => new Promise((accept, reject) => {
  const proc = spawn("wsl.exe", ["-d", distro, "--exec", ...args], { windowsHide: true });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { proc.kill(); reject(new Error(`WSL timeout: ${args[0]}`)); }, timeout);
  proc.stdout.setEncoding("utf8"); proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", chunk => stdout += chunk);
  proc.stderr.on("data", chunk => stderr += chunk);
  proc.on("error", error => { clearTimeout(timer); reject(error); });
  proc.on("exit", code => {
    clearTimeout(timer);
    if (code === 0) accept(stdout.trim());
    else reject(new Error(`WSL exited ${code}: ${stderr.trim()}\n${stdout.slice(-600)}`));
  });
});
const shell = (command, timeout) => runWsl(["sh", "-lc", command], timeout);
const home = await shell("mktemp -d /tmp/pix-upgrade-test-XXXXXX");
const root = `${home}/.pix/server`;
const workspace = `${home}/project`;
let client;
let startedHandle;
let safeToRemove = true;
try {
  // Never install over the user's $HOME/.pix/server. Only this transport's
  // subprocesses get the temporary HOME; the normal WSL host stays untouched.
  const original = await shell('if test -x "$HOME/.pix/server/current/bin/pix-agent-host"; then "$HOME/.pix/server/current/bin/pix-agent-host" version; else echo absent; fi');
  const nodePath = await shell('if test -x "$HOME/.pix/server/current/node/bin/node"; then readlink -f "$HOME/.pix/server/current/node/bin/node"; fi');
  const nodeDir = nodePath ? nodePath.slice(0, nodePath.lastIndexOf("/")) : "";
  const source = resolve("server");
  const linuxSource = await runWsl(["wslpath", "-a", "-u", source]);
  const transport = {
    exec: (command, timeout) => runWsl(["env", `HOME=${home}`, "sh", "-lc",
      `${nodeDir ? `export PATH=${quote(nodeDir)}:$PATH; ` : ""}${command}`], timeout),
    upload: async (_source, stage) => {
      const entries = ["dist", "bin", "package.json", "package-lock.json", "../skills"];
      await shell(`cp -R ${entries.map(path => quote(`${linuxSource}/${path}`)).join(" ")} ${quote(stage)}/`, 120_000);
    },
  };
  await shell(`mkdir -p ${quote(root)}/versions/legacy/bin ${quote(workspace)} && ln -s ${quote(root)}/versions/legacy ${quote(root)}/current`);
  const legacy = { version: PIX_HOST_VERSION, protocol: PIX_REMOTE_PROTOCOL, piVersion: "1.1.0" };
  const fake = `#!/bin/sh\nprintf '%s\\n' ${quote(JSON.stringify(legacy))}\n`;
  await shell(`printf %s ${quote(fake)} > ${quote(root)}/versions/legacy/bin/pix-agent-host && chmod 700 ${quote(root)}/versions/legacy/bin/pix-agent-host`);
  assert.deepEqual(JSON.parse(await transport.exec('"$HOME/.pix/server/current/bin/pix-agent-host" version')), legacy);

  const progress = [];
  await ensureHostInstalled(transport, false, { onProgress: stage => progress.push(stage) });
  assert.ok(progress.includes("upload") && progress.includes("install"), "Pi 1.1 must be replaced despite matching host/protocol versions");
  const installed = JSON.parse(await transport.exec('"$HOME/.pix/server/current/bin/pix-agent-host" version'));
  assert.deepEqual(installed, { version: PIX_HOST_VERSION, protocol: PIX_REMOTE_PROTOCOL, piVersion: await piSdkVersion() });
  let uploadedAgain = false;
  await ensureHostInstalled({ ...transport, upload: async () => { uploadedAgain = true; } }, false, {});
  assert.equal(uploadedAgain, false, "an up-to-date host must not be reinstalled");

  const previous = { home: process.env.PIX_HOME, wslEnv: process.env.WSLENV };
  try {
    // WSLENV propagates this profile into the detached host process too.
    process.env.PIX_HOME = home;
    process.env.WSLENV = [previous.wslEnv, "PIX_HOME/u"].filter(Boolean).join(":");
    try {
      client = await WslHostClient.connect({ distro, cwd: workspace,
        executable: `${root}/current/bin/pix-agent-host`, connectTimeoutMs: 60_000 });
    } catch (error) {
      if (error instanceof HostStarted) startedHandle = error.hostHandle;
      throw error;
    }
    assert.equal(client.hello.piVersion, installed.piVersion);
    assert.equal(client.hello.cwd, workspace);
    assert.deepEqual(await client.request("session.list"), []);
    const created = await client.request("agent.control", { action: "newSession" });
    assert.equal(created.session.cwd, workspace);
    console.log(JSON.stringify({ ok: true, distro, installed, workspace,
      checks: ["real WSL install", "simulated Pi 1.1 version triggers upgrade", "no redundant install", "WebSocket handshake", "new session"] }));
  } finally {
    if (previous.home === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous.home;
    if (previous.wslEnv === undefined) delete process.env.WSLENV; else process.env.WSLENV = previous.wslEnv;
  }
  const after = await shell('if test -x "$HOME/.pix/server/current/bin/pix-agent-host"; then "$HOME/.pix/server/current/bin/pix-agent-host" version; else echo absent; fi');
  assert.equal(after, original, "the normal WSL host was not changed");
} finally {
  try {
    if (client) await client.dispose();
    else if (startedHandle) await WslHostClient.killHost(startedHandle);
  } catch (error) {
    safeToRemove = false;
    console.error("Could not confirm isolated host shutdown:", error);
  }
  if (safeToRemove) await shell(`case ${quote(home)} in /tmp/pix-upgrade-test-*) rm -rf -- ${quote(home)} ;; *) exit 2 ;; esac`);
  else console.error(`Isolated test directory retained for recovery: ${home}`);
}
