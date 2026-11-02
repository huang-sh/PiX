import test from "node:test";
import assert from "node:assert/strict";
import { isMacInstallSource, offerMacInstall } from "../src/main/mac-install.js";
import type { HostConnectionState } from "../src/shared/host-protocol.js";

const idle = (): HostConnectionState => ({ connected: false, version: "0.0.32",
  host: { id: "old-host", version: "0.0.31", verified: true, clients: 0, running: 0 } });
function fixture(state = idle(), answers: number[] = [0]) {
  const calls: string[] = [];
  return { calls, deps: {
    zh: true, status: async () => { calls.push("status"); return state; },
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

test("idle installation has no extra UI and stops the host before closing windows and replacing the app", async () => {
  const { calls, deps } = fixture();
  assert.equal(await offerMacInstall(deps), "quit");
  assert.deepEqual(calls, ["status", "stop:old-host:false:true", "quit-windows", "move"]);
});

test("busy installation never stops work when cancelled at either confirmation", async () => {
  for (const answers of [[0], [2, 0]]) {
    const state = idle(); state.host!.commands = 1;
    const { calls, deps } = fixture(state, answers);
    assert.equal(await offerMacInstall(deps), "quit");
    assert.ok(!calls.some(call => call.startsWith("stop:")));
    assert.ok(!calls.includes("quit-windows"));
  }
});

test("idle windows, terminals, remote connections and cleanup do not trigger task confirmation", async () => {
  const state = idle(); state.host!.stopping = true;
  Object.assign(state.host!, { clients: 3, terminals: 2, remoteConnections: 2 });
  const { calls, deps } = fixture(state);
  assert.equal(await offerMacInstall(deps), "quit");
  assert.deepEqual(calls, ["status", "stop:old-host:false:true", "quit-windows", "move"]);
});

test("explicit forced installation holds the lock while closing older clients and replacing the app", async () => {
  const state = idle(); state.host!.commands = 1;
  const { calls, deps } = fixture(state, [2, 1]);
  assert.equal(await offerMacInstall(deps), "quit");
  assert.deepEqual(calls, ["status", "dialog", "dialog", "stop:old-host:true:true", "quit-windows", "move"]);
});

test("confirmed force installation can close an unattached window blocked by the installer lock", async () => {
  const state = idle(); state.host!.commands = 1;
  const { calls, deps } = fixture(state, [2, 1]);
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
  const { calls, deps } = fixture(idle(), [0]);
  deps.move = () => { calls.push("move-failed"); return false; };
  assert.equal(await offerMacInstall(deps), "quit");
  assert.deepEqual(calls, ["status", "stop:old-host:false:true", "quit-windows", "move-failed", "reopen", "status", "dialog"]);
});

test("a host identity change detected by the guard aborts before native replacement", async () => {
  const { calls, deps } = fixture(idle(), [0, 0]);
  deps.install = async () => { throw new Error("The host changed"); };
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
  assert.equal(calls.filter(call => call === "dialog").length, 1);
});
