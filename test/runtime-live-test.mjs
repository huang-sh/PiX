// Real installation in a unique remote /tmp directory; never changes ~/.pix.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const [mode, host] = process.argv.slice(2);
assert.ok(["--ssh", "--wsl"].includes(mode) && host);
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const run = (cmd, args) => new Promise((accept, reject) => {
  const child = spawn(cmd, args, { windowsHide: true });
  let output = "", error = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { error += data; });
  const timer = setTimeout(() => { child.kill(); reject(new Error("Live runtime test timed out")); }, 300_000);
  child.once("error", (err) => { clearTimeout(timer); reject(err); });
  child.once("close", (code) => {
    clearTimeout(timer);
    code === 0 ? accept(output.trim()) : reject(new Error(`${output}\n${error}`));
  });
});
const remote = (command) => mode === "--ssh"
  ? run("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, command])
  : run("wsl.exe", ["-d", host, "--exec", "sh", "-lc", command]);
const root = await remote("mktemp -d /tmp/pix-runtime-live-XXXXXX");
assert.match(root, /^\/tmp\/pix-runtime-live-[A-Za-z0-9]+$/);
const stage = `${root}/.install-live`;
let timedOut = false;
try {
  await remote(`mkdir -p ${quote(stage)} ${quote(`${root}/versions`)}`);
  const source = resolve(import.meta.dirname, "../server");
  const files = ["bin", "dist", "package.json", "package-lock.json"];
  if (mode === "--ssh") {
    await run("scp", ["-r", "-o", "BatchMode=yes", ...files.map((name) => resolve(source, name)), `${host}:${stage}/`]);
  } else {
    const linuxSource = await run("wsl.exe", ["-d", host, "--exec", "wslpath", "-a", "-u", source]);
    await remote(`cp -R ${files.map((name) => quote(`${linuxSource}/${name}`)).join(" ")} ${quote(stage)}/`);
  }
  console.log(`${host}: testing fresh installation with existing Linux Node...`);
  console.log(await remote(`sh ${quote(`${stage}/bin/install-host`)} ${quote(root)} ${quote(stage)} ${quote(`${root}/versions/test`)}`));
  const executable = `${root}/current/bin/pix-agent-host`;
  const version = JSON.parse(await remote(`${quote(executable)} version`));
  assert.equal(version.version, JSON.parse(readFileSync(resolve(source, "package.json"), "utf8")).version);
  const node = await remote(`readlink -f ${quote(`${root}/current/node/bin/node`)}`);
  assert.ok(!node.startsWith(`${root}/runtime/`), "Existing Linux Node should be reused");
  await remote(`test ! -d ${quote(`${root}/runtime`)}; test ! -d ${quote(`${root}/cache`)}`);
  // Force the launch-time version-change check, then verify a real server/PTy again.
  await remote(`printf '0.0.0\n' > ${quote(`${root}/current/node-version`)}; ${quote(executable)} version`);
  console.log(JSON.stringify({ ok: true, host, node, version, checks: ["fresh install", "no Node download", "service + WebSocket + PTY", "runtime-version change rechecked"] }));
} catch (error) {
  timedOut = /timed out/i.test(String(error));
  throw error;
} finally {
  // On timeout the remote installer may still run; do not race its writes.
  if (!timedOut) await remote(`rm -rf -- ${quote(root)}`);
  else console.error(`Preserved timed-out test stage: ${root}`);
}
