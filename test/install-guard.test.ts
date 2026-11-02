import test from "node:test";
import assert from "node:assert/strict";
import { prepareInstallation } from "../src/main/install-guard.js";
import type { HostConnectionState } from "../src/shared/host-protocol.js";
import type { InstallReservation } from "../src/host/client.js";
import { connectLocalHost, HostClient, releaseInstallReservation } from "../src/host/client.js";
import { serveLocalHost } from "../src/host/local-host.js";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const idle = (): HostConnectionState => ({ connected: false, version: "0.0.32",
  host: { id: "inspected-host", version: "0.0.32", verified: true, running: 0, clients: 3, terminals: 2, remoteConnections: 2 } });
function fixture(state = idle(), answers: number[] = []) {
  const calls: string[] = [];
  return { calls, options: {
    homes: ["profile-one"], ownerPid: 123,
    status: async () => state,
    show: async ({ confirm }: { confirm: boolean }) => { calls.push(confirm ? "confirm" : "prompt"); return answers.shift() ?? 0; },
    reserve: async (id: string | undefined, force: boolean, ownerPid: number) => {
      calls.push(`reserve:${id}:${force}`); return { home: process.env.PIX_HOME!, ownerPid, token: "reservation" };
    },
    release: (item: InstallReservation) => { calls.push(`release:${item.home}`); },
    save: (items: InstallReservation[]) => { calls.push(`save:${items.length}`); },
    stopped: async (force: boolean) => { calls.push(`windows:${force}`); },
  } };
}

test("idle windows, terminal sessions and remote connections install without extra UI or forced shutdown", async () => {
  const { calls, options } = fixture();
  const result = await prepareInstallation(options);
  assert.equal(result?.length, 1);
  assert.deepEqual(calls, ["reserve:inspected-host:false", "save:1", "windows:false"]);
});

test("only actual local or remote work triggers cancellation, recheck and explicit confirmation", async () => {
  for (const task of [{ running: 1 }, { pending: true }, { commands: 1 }, { remoteRunning: 1 }]) {
    for (const answers of [[0], [2, 0]]) {
      const state = idle(); Object.assign(state.host!, task);
      const { calls, options } = fixture(state, answers);
      assert.equal(await prepareInstallation(options), null);
      assert.ok(!calls.some(call => call.startsWith("reserve:")), "cancelling must preserve every task and window");
    }
  }
});

test("recheck uses new task state and proceeds normally when tasks finish", async () => {
  const { calls, options } = fixture(idle(), [1]);
  let checks = 0;
  options.status = async () => { const state = idle(); state.host!.running = checks++ === 0 ? 1 : 0; return state; };
  assert.ok(await prepareInstallation(options));
  assert.deepEqual(calls, ["prompt", "reserve:inspected-host:false", "save:1", "windows:false"]);
});

test("confirmed interruption is scoped to the inspected active profiles", async () => {
  const { calls, options } = fixture(idle(), [2, 1]);
  options.homes.push("profile-two");
  options.status = async () => { const state = idle(); state.host!.running = process.env.PIX_HOME === "profile-one" ? 1 : 0; return state; };
  assert.equal((await prepareInstallation(options))?.length, 2);
  assert.deepEqual(calls, ["prompt", "confirm", "reserve:inspected-host:true", "save:1", "reserve:inspected-host:false", "save:2", "windows:true"]);
});

test("task admission between inspection and atomic shutdown gets a fresh confirmation", async () => {
  const { calls, options } = fixture();
  let running = false;
  options.status = async () => { const state = idle(); state.host!.running = running ? 1 : 0; return state; };
  options.reserve = async () => { running = true; throw new Error("Stop running tasks first"); };
  assert.equal(await prepareInstallation(options), null);
  assert.deepEqual(calls, ["save:0", "prompt"]);
});

test("a replacement host cannot inherit an older host's destructive confirmation", async () => {
  const state = idle(); state.host!.running = 1;
  const { calls, options } = fixture(state, [2, 1, 0]);
  options.reserve = async () => { state.host!.id = "replacement"; throw new Error("host changed"); };
  assert.equal(await prepareInstallation(options), null);
  assert.deepEqual(calls, ["prompt", "confirm", "save:0", "prompt"]);
});

test("failed file preparation releases reservations for every previously stopped profile", async () => {
  const { calls, options } = fixture();
  options.homes.push("profile-two");
  options.stopped = async () => { throw new Error("window could not quit"); };
  await assert.rejects(prepareInstallation(options), /could not quit/);
  assert.ok(calls.includes("release:profile-one"));
  assert.ok(calls.includes("release:profile-two"));
  assert.equal(calls.at(-1), "save:0");
});

test("rollback attempts every profile and retains its receipt when one lock cannot be released", async () => {
  const { calls, options } = fixture();
  options.homes.push("profile-two");
  options.stopped = async () => { throw new Error("window could not quit"); };
  options.release = item => {
    calls.push(`release:${item.home}`);
    if (item.home === "profile-one") throw new Error("locked installer marker");
  };
  await assert.rejects(prepareInstallation(options), error => {
    assert.match(String(error), /window could not quit/);
    assert.match(String(error), /locked installer marker/);
    return true;
  });
  assert.ok(calls.includes("release:profile-two"), "one failure must not leave other profiles locked");
  assert.ok(!calls.includes("save:0"), "a failed cleanup must keep its reservations available for retry");
});

test("an unverified host is never interrupted", async () => {
  const state = idle(); state.host!.verified = false;
  const { calls, options } = fixture(state);
  await assert.rejects(prepareInstallation(options), /Cannot verify/);
  assert.deepEqual(calls, []);
});

async function execute(executable: string, args: string[]) {
  const child = spawn(executable, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += String(data); });
  child.stderr.on("data", data => { output += String(data); });
  const [status] = await once(child, "exit");
  return { status, output };
}
async function realProfile(job: (home: string, guard: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "pix-install-guard-"));
  const values = { PIX_HOME: home, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(home, "agent"),
    PIX_HOST_ENTRY: fileURLToPath(new URL("../src/host/index.js", import.meta.url)) };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    const { buildInstallGuard } = await import(new URL("../../scripts/install-guard-bundle.mjs", import.meta.url).href);
    const generated = join(home, "generated");
    buildInstallGuard(generated);
    await job(home, join(generated, "install-guard.cjs"));
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(home, { recursive: true, force: true });
  }
}

test("standalone cleanup releases other profiles after an error and can retry the retained receipt", async () => {
  await realProfile(async (home, guard) => {
    const receipt = join(home, "receipt.json");
    const reservations = ["blocked", "idle"].map(name => ({ home: join(home, name), ownerPid: process.pid, token: name }));
    const locks = reservations.map(item => join(item.home, ".pix/run/starting"));
    for (const lock of locks) {
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "pid"), String(process.pid));
    }
    mkdirSync(join(locks[0]!, "installer"));
    writeFileSync(join(locks[1]!, "installer"), reservations[1]!.token);
    writeFileSync(receipt, JSON.stringify({ ownerPid: process.pid, reservations }));
    const failed = await execute(process.execPath, [guard, "--finish", "--receipt", receipt]);
    assert.notEqual(failed.status, 0);
    assert.equal(existsSync(locks[1]!), false, "cleanup must continue after the malformed first marker");
    assert.equal(existsSync(receipt), true, "failed cleanup must retain the authenticated receipt");
    rmSync(join(locks[0]!, "installer"), { recursive: true });
    writeFileSync(join(locks[0]!, "installer"), reservations[0]!.token);
    const retried = await execute(process.execPath, [guard, "--finish", "--receipt", receipt]);
    assert.equal(retried.status, 0, retried.output);
    assert.equal(existsSync(locks[0]!), false);
    assert.equal(existsSync(receipt), false);
  });
});

test("standalone preflight stops idle clients without UI and holds the installer lock until postinstall", { timeout: 30000 }, async () => {
  await realProfile(async (home, guard) => {
    const host = await serveLocalHost();
    const client = await HostClient.connect(host.address, null);
    const receipt = join(home, "receipt.json");
    let replacement: HostClient | undefined;
    try {
      const result = await execute(process.execPath, [guard, "--prepare", "--target", join(home, "PiX-fixture"), "--receipt", receipt, "--owner-pid", String(process.pid), "--ui", "silent"]);
      assert.equal(result.status, 0, result.output);
      assert.equal(result.output, "", "idle installation must be silent");
      assert.equal(existsSync(join(home, ".pix/run/host.json")), false);
      assert.equal(existsSync(join(home, ".pix/run/starting")), true);
      const connecting = connectLocalHost(null);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(existsSync(join(home, ".pix/run/host.json")), false, "file replacement must exclude competing starters");
      const finished = await execute(process.execPath, [guard, "--finish", "--receipt", receipt]);
      assert.equal(finished.status, 0, finished.output);
      assert.equal(existsSync(receipt), false);
      replacement = await connecting;
      await replacement.request({ method: "shutdown" });
      for (let i = 0; i < 100 && existsSync(join(home, ".pix/run/host.json")); i++) await new Promise(resolve => setTimeout(resolve, 20));
    } finally {
      if (existsSync(receipt)) for (const item of JSON.parse(readFileSync(receipt, "utf8")).reservations) releaseInstallReservation(item);
      await replacement?.close(); await client.close(); await host.shutdown();
    }
  });
});

test("silent native installation with actual pending work aborts without interrupting it", { timeout: 20000 }, async t => {
  await realProfile(async (home, guard) => {
    const host = await serveLocalHost();
    t.mock.getter(host.owner, "hasPendingWork", () => true);
    const receipt = join(home, "receipt.json");
    try {
      const result = await execute(process.execPath, [guard, "--prepare", "--target", join(home, "PiX-fixture"), "--receipt", receipt, "--owner-pid", String(process.pid), "--ui", "silent"]);
      assert.equal(result.status, 1);
      assert.match(result.output, /tasks are unchanged/);
      assert.equal(existsSync(join(home, ".pix/run/host.json")), true);
      assert.equal(existsSync(receipt), false);
      assert.equal(existsSync(join(home, ".pix/run/starting")), false);
    } finally { await host.shutdown(); }
  });
});

test("actual interactive commands prompt for installation, cancellation preserves them, and recheck proceeds after Ctrl+C", { timeout: 30000 }, async () => {
  await realProfile(async home => {
    const host = await serveLocalHost();
    const { id } = host.owner.shell.create(80, 24);
    const wait = async (check: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw new Error("Timed out waiting for terminal state");
    };
    let reservations: InstallReservation[] = [];
    try {
      await wait(async () => (await host.owner.shell.terminalWork()).unknown === 0);
      host.owner.shell.writeTerminal(id, process.platform === "win32" ? "ping.exe -n 60 127.0.0.1\r" : "sleep 60\r");
      await wait(async () => (await host.owner.shell.terminalWork()).commands === 1);
      const options = { homes: [home], ownerPid: process.ppid, save: (saved: InstallReservation[]) => { reservations = saved; },
        stopped: async (force: boolean) => { assert.equal(force, false); }, show: async () => 0 };
      assert.equal(await prepareInstallation(options), null);
      assert.equal((await host.owner.shell.terminalWork()).commands, 1);
      assert.equal(existsSync(join(home, ".pix/run/host.json")), true);
      let prompts = 0;
      const result = await prepareInstallation({ ...options, show: async prompt => {
        assert.equal(prompt.confirm, false);
        prompts++;
        host.owner.shell.writeTerminal(id, "\x03");
        await wait(async () => (await host.owner.shell.terminalWork()).commands === 0 && (await host.owner.shell.terminalWork()).unknown === 0);
        return 1;
      } });
      assert.equal(prompts, 1);
      assert.equal(result?.length, 1);
      assert.equal(existsSync(join(home, ".pix/run/host.json")), false);
    } finally {
      for (const reservation of reservations) releaseInstallReservation(reservation);
      await host.shutdown();
    }
  });
});

test("Linux installation gracefully closes an unattached main process while preserving its renderers until Quit", { skip: process.platform !== "linux", timeout: 30000 }, async () => {
  await realProfile(async (home, guard) => {
    // A separate executable keeps /proc discovery scoped to this fixture.
    const runtime = join(home, "pix-desktop"); copyFileSync(process.execPath, runtime);
    const script = join(home, "desktop.cjs"), ready = join(home, "ready"), closed = join(home, "closed");
    writeFileSync(script, `
      const fs = require('node:fs'), { spawn } = require('node:child_process');
      const home = process.env.PIX_HOME, path = require('node:path');
      if (process.argv.includes('--type=renderer')) {
        process.on('SIGTERM', () => { fs.writeFileSync(path.join(home, 'renderer-signalled'), 'unexpected'); process.exit(1); });
        fs.writeFileSync(path.join(home, 'renderer-ready'), 'ready');
      } else {
        const renderer = spawn(process.execPath, [__filename, '--type=renderer'], {stdio:'ignore'});
        fs.writeFileSync(path.join(home, 'renderer-pid'), String(renderer.pid));
        process.on('SIGTERM', () => {
          process.kill(renderer.pid, 0);
          if (!fs.existsSync(path.join(home, '.pix/run/starting/installer')) || fs.existsSync(path.join(home, '.pix/run/host.json'))) process.exit(2);
          fs.writeFileSync(path.join(home, 'closed'), 'graceful');
          renderer.kill('SIGKILL'); process.exit(0);
        });
        const wait = setInterval(() => { if(fs.existsSync(path.join(home, 'renderer-ready'))) { fs.writeFileSync(path.join(home, 'ready'), 'ready'); clearInterval(wait); } }, 10);
      }
      setInterval(() => {}, 1000);
    `);
    const desktop = spawn(runtime, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "" }, stdio: "ignore" });
    const exited = once(desktop, "exit");
    const host = await serveLocalHost();
    const receipt = join(home, "receipt.json");
    try {
      for (let i = 0; !existsSync(ready) && i < 500; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(existsSync(ready));
      const prepared = await execute(process.execPath, [guard, "--prepare", "--target", runtime, "--receipt", receipt, "--owner-pid", String(process.pid), "--ui", "silent"]);
      assert.equal(prepared.status, 0, prepared.output);
      assert.equal(prepared.output, "");
      assert.deepEqual(await exited, [0, null]);
      assert.equal(readFileSync(closed, "utf8"), "graceful");
      assert.equal(existsSync(join(home, "renderer-signalled")), false);
      assert.equal((await execute(process.execPath, [guard, "--finish", "--receipt", receipt])).status, 0);
    } finally {
      if (desktop.exitCode === null) desktop.kill("SIGKILL");
      if (existsSync(join(home, "renderer-pid"))) {
        try { process.kill(Number(readFileSync(join(home, "renderer-pid"), "utf8")), "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      if (existsSync(receipt)) for (const item of JSON.parse(readFileSync(receipt, "utf8")).reservations) releaseInstallReservation(item);
      await host.shutdown();
    }
  });
});

test("generated Linux preinstall and postinstall hooks run with the embedded runtime and no system Node", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  await realProfile(async (home, guard) => {
    const { prepareLinuxCliHooks } = await import(new URL("../../scripts/linux-cli-hooks.mjs", import.meta.url).href);
    const output = join(home, "hooks"); prepareLinuxCliHooks(output);
    const runtime = join(home, "pix-desktop");
    writeFileSync(runtime, `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 99\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    const receipt = join(home, "receipt.json");
    const before = readFileSync(join(output, "before-install.sh"), "utf8").replaceAll("/opt/PiX/pix-desktop", runtime).replaceAll("/run/pix-install-guard.json", receipt);
    const script = join(home, "preinst.sh"); writeFileSync(script, before);
    const host = await serveLocalHost();
    try {
      const result = await execute("/bin/sh", [script]);
      assert.equal(result.status, 0, result.output);
      assert.equal(existsSync(receipt), true);
      assert.equal(existsSync(join(home, ".pix/run/host.json")), false);
      const after = readFileSync(join(output, "after-install.tpl"), "utf8");
      const finish = after.slice(0, after.indexOf("\nif type update-alternatives")).replaceAll("/run/pix-install-guard.json", receipt)
        .replaceAll("/opt/${sanitizedProductName}/${executable}", runtime)
        .replaceAll("/opt/${sanitizedProductName}/resources/cli/install-guard.cjs", guard);
      const installed = await execute("/bin/sh", ["-c", finish]);
      assert.equal(installed.status, 0, installed.output);
      assert.equal(existsSync(receipt), false);
      assert.equal(existsSync(join(home, ".pix/run/starting")), false);
    } finally {
      if (existsSync(receipt)) for (const item of JSON.parse(readFileSync(receipt, "utf8")).reservations) releaseInstallReservation(item);
      await host.shutdown();
    }
  });
});
