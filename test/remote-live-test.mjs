// Real Linux host regression test. Build the app/test output first. Only the
// processes launched for its unique /tmp workspace are stopped or signalled.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MainController } from "../out-test/src/main/controller.js";
import { projectId } from "../out-test/src/shared/types.js";

const [mode, target] = process.argv.slice(2);
assert.ok(["--ssh", "--wsl"].includes(mode) && target, "Use --ssh HOST or --wsl DISTRO");
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const checks = [];
function passed(name, details = {}) {
  checks.push({ name, ...details });
  console.log(JSON.stringify({ passed: name, ...details }));
}
function remote(command) {
  const executable = mode === "--ssh" ? "ssh" : "wsl.exe";
  const args = mode === "--ssh"
    ? ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", target, command]
    : ["-d", target, "--exec", "sh", "-lc", command];
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Remote test helper timed out")); }, 25_000);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? accept(stdout.trim()) : reject(new Error(stderr || `Remote helper exited ${code}`));
    });
  });
}
async function until(condition, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition()) return;
    await delay(100);
  }
  throw new Error("Timed out waiting for test condition");
}

const localHome = mkdtempSync(join(tmpdir(), "pix-live-local-"));
process.env.PIX_HOME = localHome;
process.env.PI_CODING_AGENT_DIR = join(localHome, ".pix", "agent");
process.env.PI_OFFLINE = "1";
const controller = new MainController(localHome, {
  async pickProject() {}, async pickSession() {},
  async confirm() { return true; }, async openExternal() {}, quit() {},
});
let modelResponse;
let modelRequests = 0;
let modelAborted = false;
const modelServer = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Drain the test prompt. */ }
  modelRequests++;
  modelResponse = response;
  response.once("close", () => { modelAborted = true; });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write('data: {"id":"live-test","choices":[{"index":0,"delta":{"role":"assistant","content":"Test stream started"},"finish_reason":null}]}\n\n');
});
modelServer.listen(0, "127.0.0.1");
await once(modelServer, "listening");
let cwd;
let stoppedPid;
let failure;
const startedAt = new Date().toISOString();
const connect = (path, browse = false) => controller.invoke(mode === "--ssh" ? "ssh.connect" : "wsl.connect", {
  ...(mode === "--ssh" ? { host: target } : { distro: target }), cwd: path, browse,
});
const events = [];
controller.onEvent((event) => {
  if (event.type === "remote.progress" || event.type === "remote.connection") {
    events.push(event);
    console.log(JSON.stringify(event));
  }
});
async function signalOwnedProcess(pid, signal) {
  assert.match(String(pid), /^[1-9][0-9]*$/);
  assert.match(cwd, /^\/tmp\/pix-live-test-[A-Za-z0-9]+$/);
  // The PID must still belong to this exact test workspace, guarding PID reuse.
  await remote(String.raw`if test -r /proc/${pid}/cmdline; then args=$(tr '\000' ' ' < /proc/${pid}/cmdline); case "$args" in *"--cwd ${cwd} "*) kill -${signal} ${pid} ;; *) printf 'Test PID no longer owns workspace' >&2; exit 2 ;; esac; fi`);
}
try {
  cwd = await remote("mktemp -d /tmp/pix-live-test-XXXXXX");
  assert.match(cwd, /^\/tmp\/pix-live-test-[A-Za-z0-9]+$/);
  console.log(JSON.stringify({ target, mode, cwd, startedAt }));
  await controller.invoke("agent.control", {
    action: "addCustomModel", provider: "pix-live-test", modelId: "held-stream",
    api: "openai-completions", apiKey: "temporary-test-key",
    baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
    contextWindow: 64000, maxTokens: 1024, reasoning: false, imageInput: false,
  });
  const connected = await connect(cwd);
  assert.equal(connected.project.path, cwd);
  assert.equal(controller.wsl.hello.platform, "linux");
  passed("real host connection", { hello: controller.wsl.hello });
  await controller.invoke("workspace.write", { path: "roundtrip.txt", content: "PiX real remote roundtrip\n" });
  assert.equal((await controller.invoke("workspace.read", { path: "roundtrip.txt" })).content, "PiX real remote roundtrip\n");
  assert.ok((await controller.invoke("workspace.tree", { path: "" })).some((node) => node.path === "roundtrip.txt"));
  passed("file write/read and directory tree");

  const terminal = await controller.invoke("terminal.create", { cols: 80, rows: 24 });
  let output = "";
  const stopTerminalEvents = controller.onEvent((event) => {
    if (event.type === "terminal" && event.payload.id === terminal.id) output += event.payload.data ?? "";
  });
  await controller.invoke("terminal.write", { id: terminal.id, data: "printf 'pix-live-%s\\n' terminal-ok\r" });
  await until(() => output.includes("pix-live-terminal-ok"));
  await controller.invoke("terminal.resize", { id: terminal.id, cols: 100, rows: 30 });
  passed("real interactive terminal and resize");

  const old = controller.wsl;
  const beforeFailedSwitch = events.length;
  await assert.rejects(connect(`${cwd}/does-not-exist`), /Project directory not found/);
  assert.ok(!events.slice(beforeFailedSwitch).some((event) => ["runtime", "upload", "install"].includes(event.payload?.stage)),
    "A missing workspace must not trigger host reinstallation");
  assert.equal(controller.wsl, old);
  assert.equal(old.connected, true);
  await connect(cwd, true);
  assert.equal(controller.wsl, old);
  assert.equal((await controller.invoke("remote.directories", { path: cwd })).path, cwd);
  await controller.invoke("remote.cancel");
  assert.equal(controller.wsl, old);
  assert.equal((await controller.invoke("workspace.read", { path: "roundtrip.txt" })).content, "PiX real remote roundtrip\n");
  passed("failed switch and cancelled candidate preserve the live workspace");

  let cancellation;
  const stopProgress = controller.onEvent((event) => {
    const stage = event.payload?.stage;
    if (event.type === "remote.progress" && stage === (mode === "--ssh" ? "checking" : "starting"))
      cancellation = controller.invoke("remote.cancel");
  });
  try {
    await assert.rejects(connect(cwd, true), /abort|cancel/i);
    await cancellation;
    assert.equal(controller.wsl, old);
    assert.equal(old.connected, true);
  } finally { stopProgress(); }
  passed("cancellation during actual connection preparation");

  console.log("Running a real 31-second shell job across two heartbeat intervals...");
  const longJob = await controller.invoke("shell.run", { command: "sleep 31; printf pix-long-job-ok" });
  assert.match(longJob.output, /pix-long-job-ok/);
  passed("31-second shell job survives RPC deadline with healthy heartbeat");
  await controller.invoke("terminal.kill", { id: terminal.id });
  stopTerminalEvents();

  const snapshot = await controller.invoke("agent.control", { action: "newSession" });
  await controller.invoke("agent.control", { action: "setModel", provider: "pix-live-test", modelId: "held-stream" });
  const prompt = controller.invoke("agent.control", { action: "prompt", text: "Connection test; do not use tools." }).then(
    () => ({ completed: true }), (error) => ({ error: error.message }),
  );
  await until(() => modelRequests > 0);
  const pidResult = await controller.invoke("shell.run", { command: "printf '%s' \"$PPID\"" });
  stoppedPid = Number(pidResult.output.trim());
  console.log(JSON.stringify({ fault: "SIGSTOP only this test's host process", pid: stoppedPid }));
  await signalOwnedProcess(stoppedPid, "STOP");
  const lostAt = Date.now();
  await until(() => !old.connected, 40_000);
  await until(() => modelAborted);
  const promptResult = await prompt;
  assert.ok(promptResult.error, "In-flight prompt should fail on connection loss");
  assert.equal(controller.projectGroups().find((group) => group.id === projectId(controller.project)).connected, false);
  assert.ok(events.some((event) => event.type === "remote.connection" && event.payload.connected === false));
  passed("unresponsive real host detected, UI event emitted, model HTTP stream aborted", { disconnectMs: Date.now() - lostAt, promptError: promptResult.error });
  await signalOwnedProcess(stoppedPid, "CONT");
  // Let the resumed host observe socket closure and finish its own shutdown.
  // Sending TERM immediately here would turn a disconnect test into a kill race.
  await until(async () => (await remote(`if test -d /proc/${stoppedPid}; then printf alive; else printf gone; fi`)) === "gone", 10_000);
  stoppedPid = undefined;
  await connect(cwd);
  const sessions = await controller.invoke("session.list");
  assert.ok(sessions.some((session) => session.path === snapshot.session.path),
    `Session not restored: expected ${snapshot.session.path}, found ${JSON.stringify(sessions.map((session) => session.path))}`);
  await controller.invoke("session.open", { path: snapshot.session.path });
  assert.equal((await controller.invoke("workspace.read", { path: "roundtrip.txt" })).content, "PiX real remote roundtrip\n");
  passed("reconnect restores persisted session and files");

  const liveClient = controller.wsl;
  const interrupted = controller.invoke("shell.run", { command: "sleep 15; printf should-not-complete" }).catch((error) => error);
  await delay(500);
  const breakAt = Date.now();
  if (mode === "--ssh") liveClient.child.kill();
  else liveClient.socket.terminate();
  assert.ok(await interrupted instanceof Error);
  await until(() => !liveClient.connected);
  passed("abrupt real transport disconnect rejects pending work", { disconnectMs: Date.now() - breakAt });
  await connect(cwd);
  await controller.invoke("remote.disconnect");
  assert.equal(controller.project.path, localHome);
  passed("explicit disconnect returns to local workspace");
} catch (error) {
  failure = error;
  console.error(error.stack ?? error);
} finally {
  if (stoppedPid) {
    await signalOwnedProcess(stoppedPid, "CONT").catch((error) => console.error(error.message));
    await signalOwnedProcess(stoppedPid, "TERM").catch((error) => console.error(error.message));
  }
  await controller.closeWsl();
  controller.dispose();
  modelResponse?.destroy();
  modelServer.closeAllConnections();
  await new Promise((accept) => modelServer.close(accept));
  if (cwd && /^\/tmp\/pix-live-test-[A-Za-z0-9]+$/.test(cwd)) {
    await remote(`test "$(readlink -f ${quote(cwd)})" = ${quote(cwd)} && rm -rf -- ${quote(cwd)}`).catch((error) => console.error(`Cleanup: ${error.message}`));
  }
  const artifacts = resolve("artifacts");
  mkdirSync(artifacts, { recursive: true });
  const report = join(artifacts, `remote-live-${mode.slice(2)}.json`);
  writeFileSync(report, JSON.stringify({ ok: !failure, target, startedAt, endedAt: new Date().toISOString(), checks, error: failure?.message }, null, 2) + "\n");
  console.log(`Report: ${report}`);
  rmSync(localHome, { recursive: true, force: true });
  process.exitCode = failure ? 1 : 0;
}
