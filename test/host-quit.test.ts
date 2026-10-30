import test from "node:test";
import assert from "node:assert/strict";
import { handleDesktopClose, quitWithHost } from "../src/main/host-quit.js";
import type { HostConnectionState } from "../src/shared/host-protocol.js";

const idle = (): HostConnectionState => ({ connected: true, version: "0.0.32",
  host: { id: "inspected-host", version: "0.0.32", verified: true, clients: 1, running: 0 } });
function fixture(state = idle(), answers: number[] = []) {
  const calls: string[] = [];
  return { calls, deps: {
    zh: true, status: async () => state,
    disconnect: async () => { calls.push("disconnect"); }, resume: async () => { calls.push("resume"); },
    show: async (options: { defaultId?: number; buttons?: string[] }) => {
      assert.equal(options.defaultId, 0, "destructive confirmation defaults to cancellation");
      calls.push("dialog"); return { response: answers.shift() ?? 0 };
    },
    stop: async (id: string, force = false, quitClients = false) => { calls.push(`stop:${id}:${force}:${quitClients}`); },
  } };
}

test("explicit idle quit stops the shared host after detaching its own desktop", async () => {
  const { calls, deps } = fixture();
  assert.equal(await quitWithHost(deps), true);
  assert.deepEqual(calls, ["disconnect", "stop:inspected-host:false:true"]);
});

test("cancelled quit preserves tasks, shells, terminals, remote work and other clients", async () => {
  for (const active of [{ stopping: true }, { running: 1 }, { pending: true }, { commands: 1 }, { terminals: 1 }, { remoteConnections: 1 }, { clients: 2 }]) {
    const state = idle(); Object.assign(state.host!, active);
    const { calls, deps } = fixture(state, [0]);
    assert.equal(await quitWithHost(deps), false);
    assert.deepEqual(calls, ["dialog"]);
  }
});

test("confirmed full quit stops work and tells other desktops to quit without reconnecting", async () => {
  const state = idle(); state.host!.commands = 1;
  const { calls, deps } = fixture(state, [1]);
  assert.equal(await quitWithHost(deps), true);
  assert.deepEqual(calls, ["dialog", "disconnect", "stop:inspected-host:true:true"]);
});

test("failed shutdown restores the desktop instead of leaving a disposed client", async () => {
  const { calls, deps } = fixture(idle(), [0]);
  deps.stop = async () => { calls.push("failed-stop"); throw new Error("host changed"); };
  assert.equal(await quitWithHost(deps), false);
  assert.deepEqual(calls, ["disconnect", "failed-stop", "resume", "dialog"]);
});

test("an unverified host is never terminated, and a retry checks its new identity", async () => {
  const state = idle(); state.host!.verified = false;
  const { calls, deps } = fixture(state, [1]);
  let inspections = 0;
  deps.status = async () => { inspections++; return inspections === 1 ? state : idle(); };
  assert.equal(await quitWithHost(deps), true);
  assert.deepEqual(calls, ["dialog", "disconnect", "stop:inspected-host:false:true"]);
});

test("a peer's full quit wins over another desktop's pending confirmation", async () => {
  const state = idle(); state.host!.running = 1;
  const { calls, deps } = fixture(state);
  let requested = false;
  deps.show = async () => { calls.push("dialog"); requested = true; return { response: 0 }; };
  assert.equal(await quitWithHost({ ...deps, alreadyStopping: () => requested }), true);
  assert.deepEqual(calls, ["dialog"], "the peer must neither reconnect nor start another host shutdown");
});

test("Windows/Linux closing keeps its window until the full quit decision succeeds", () => {
  for (const platform of ["win32", "linux"]) {
    const calls: string[] = [];
    handleDesktopClose({ preventDefault() { calls.push("preserve-window"); } }, {
      platform, quitting: false, closeToTray: false,
      hide() { calls.push("hide"); }, quit() { calls.push("confirm-quit"); },
    });
    assert.deepEqual(calls, ["preserve-window", "confirm-quit"]);
    calls.length = 0;
    handleDesktopClose({ preventDefault() { calls.push("preserve-window"); } }, {
      platform, quitting: false, closeToTray: true,
      hide() { calls.push("hide"); }, quit() { calls.push("confirm-quit"); },
    });
    assert.deepEqual(calls, ["preserve-window", "hide"]);
  }
});
