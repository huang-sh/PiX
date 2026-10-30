import test from "node:test";
import assert from "node:assert/strict";
import { isMacInstallSource, offerMacInstall } from "../src/main/mac-install.js";
import type { HostConnectionState } from "../src/shared/host-protocol.js";

const idle = (): HostConnectionState => ({ connected: false, version: "0.0.32",
  host: { id: "old-host", version: "0.0.31", verified: true, clients: 0, running: 0 } });
function fixture(state = idle(), answers: number[] = [0]) {
  const calls: string[] = [];
  return { calls, deps: {
    zh: true, version: "0.0.32", status: async () => { calls.push("status"); return state; },
    show: async (options: { defaultId?: number; cancelId?: number }) => {
      assert.equal(options.defaultId, 0); assert.ok(options.cancelId === 0 || options.cancelId === 2);
      calls.push("dialog"); return { response: answers.shift() ?? 0 };
    },
    windows: async () => ({ quit: async () => { calls.push("quit-windows"); }, reopen: async () => { calls.push("reopen"); } }),
    install: async <T>(id: string | undefined, force: boolean, job: () => Promise<T>, quitClients = false) => {
      calls.push(`stop:${id}:${force}:${quitClients}`); return job();
    },
    move: () => { calls.push("move"); return true; },
  } };
}

test("installation is offered only for packaged macOS disk-image or translocated apps", () => {
  assert.equal(isMacInstallSource("darwin", true, "/Volumes/PiX/PiX.app/Contents/MacOS/PiX"), true);
  assert.equal(isMacInstallSource("darwin", true, "/private/var/folders/x/AppTranslocation/id/d/PiX.app/Contents/MacOS/PiX"), true);
  for (const [platform, packaged, path] of [["darwin", true, "/Applications/PiX.app"], ["darwin", true, "/Users/pch/Projects/PiX/release/mac/PiX.app"], ["linux", true, "/Volumes/PiX"], ["darwin", false, "/Volumes/PiX"]] as const)
    assert.equal(isMacInstallSource(platform, packaged, path), false);
});

test("open-only and cancellation do not inspect, stop or replace the installed app", async () => {
  for (const [answer, expected] of [[1, "open"], [2, "quit"]] as const) {
    const { calls, deps } = fixture(idle(), [answer]);
    assert.equal(await offerMacInstall(deps), expected);
    assert.deepEqual(calls, ["dialog"]);
  }
});

test("idle installation closes windows and stops the verified host before replacement", async () => {
  const { calls, deps } = fixture();
  assert.equal(await offerMacInstall(deps), "quit");
  assert.deepEqual(calls, ["dialog", "status", "quit-windows", "status", "stop:old-host:false:true", "move"]);
});

test("busy installation never stops work when cancelled at either confirmation", async () => {
  for (const answers of [[0, 0], [0, 2, 0]]) {
    const state = idle(); state.host!.commands = 1;
    const { calls, deps } = fixture(state, answers);
    assert.equal(await offerMacInstall(deps), "quit");
    assert.ok(!calls.some(call => call.startsWith("stop:")));
    assert.ok(!calls.includes("quit-windows"));
  }
});

test("unfinished host cleanup requires explicit confirmation before installation", async () => {
  const state = idle(); state.host!.stopping = true;
  const { calls, deps } = fixture(state, [0, 0]);
  assert.equal(await offerMacInstall(deps), "quit");
  assert.deepEqual(calls, ["dialog", "status", "dialog"]);
});

test("explicit forced installation holds the lock while closing older clients and replacing the app", async () => {
  const state = idle(); state.host!.clients = 1;
  const { calls, deps } = fixture(state, [0, 2, 1]);
  assert.equal(await offerMacInstall(deps), "quit");
  assert.deepEqual(calls, ["dialog", "status", "dialog", "dialog", "stop:old-host:true:true", "quit-windows", "move"]);
});

test("confirmed force installation can close an unattached window blocked by the installer lock", async () => {
  const state = idle(); state.host!.clients = 1;
  const { calls, deps } = fixture(state, [0, 2, 1]);
  deps.windows = async () => ({
    quit: async (force?: boolean) => {
      if (!force) throw new Error("unattached desktop quit is waiting for the installer's startup lock");
      calls.push("force-close-window");
    },
    reopen: async () => { calls.push("reopen"); },
  });
  assert.equal(await offerMacInstall(deps), "quit");
  assert.ok(calls.includes("move"), "a confirmed force install must finish even if a recovery window cannot quit gracefully");
  assert.ok(calls.indexOf("force-close-window") < calls.indexOf("move"));
});

test("a failed native move restores old windows and leaves replacement to an explicit retry", async () => {
  const { calls, deps } = fixture(idle(), [0, 0]);
  deps.move = () => { calls.push("move-failed"); return false; };
  assert.equal(await offerMacInstall(deps), "quit");
  assert.deepEqual(calls, ["dialog", "status", "quit-windows", "status", "stop:old-host:false:true", "move-failed", "reopen", "dialog"]);
});

test("a new host appearing during window close cannot inherit the previous confirmation", async () => {
  const { calls, deps } = fixture(idle(), [0, 0]);
  let probes = 0;
  deps.status = async () => { probes++; return probes === 1 ? idle() : { ...idle(), host: { ...idle().host!, id: "new-host" } }; };
  assert.equal(await offerMacInstall(deps), "quit");
  assert.ok(!calls.includes("move"));
  assert.ok(!calls.some(call => call.startsWith("stop:")));
  assert.ok(calls.includes("reopen"));
});

test("failure to reopen a previous window is reported without crashing the installer", async () => {
  const { calls, deps } = fixture(idle(), [0, 0]);
  deps.move = () => false;
  deps.windows = async () => ({ quit: async () => {}, reopen: async () => { throw new Error("missing application"); } });
  deps.show = async options => { calls.push("dialog"); return { response: 0 }; };
  assert.equal(await offerMacInstall(deps), "quit");
  assert.equal(calls.filter(call => call === "dialog").length, 2);
});
