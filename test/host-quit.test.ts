import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

for (const busy of [false, true])
test(`quit reinspects a host published during initial startup (busy=${busy})`, async t => {
  const previous = process.env.PIX_HOME;
  const home = mkdtempSync(join(tmpdir(), "pix-quit-startup-"));
  process.env.PIX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const state: HostConnectionState = { connected: false, version: "0.0.32" };
  const { calls, deps } = fixture(state);
  deps.disconnect = async () => {
    calls.push("disconnect");
    state.host = { ...idle().host!, clients: 0, commands: busy ? 1 : 0 };
  };
  assert.equal(await quitWithHost(deps), !busy);
  assert.deepEqual(calls, busy ? ["disconnect", "dialog", "resume"] : ["disconnect", "stop:inspected-host:false:true"]);
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
  assert.deepEqual(calls, ["disconnect", "failed-stop", "dialog", "resume"]);
});

test("a failed quit does not restart the host before the user chooses what to do", async () => {
  const { calls, deps } = fixture();
  let choose!: (response: { response: number }) => void, shown!: () => void;
  const displayed = new Promise<void>(resolve => { shown = resolve; });
  deps.stop = async () => { calls.push("failed-stop"); throw new Error("cleanup still pending"); };
  deps.show = async () => { calls.push("dialog"); shown(); return new Promise(resolve => { choose = resolve; }); };
  const quitting = quitWithHost(deps);
  try {
    await displayed;
    assert.equal(calls.includes("resume"), false, "waiting for a quit decision must not respawn a host");
  } finally { choose({ response: 0 }); await quitting; }
  assert.deepEqual(calls, ["disconnect", "failed-stop", "dialog", "resume"]);
});

test("retrying a failed quit never restores a desktop or starts a replacement host", async () => {
  const { calls, deps } = fixture(idle(), [1]);
  let attempts = 0;
  deps.stop = async () => { calls.push("stop"); if (++attempts === 1) throw new Error("slow cleanup"); };
  assert.equal(await quitWithHost(deps), true);
  assert.equal(attempts, 2);
  assert.equal(calls.includes("resume"), false);
});

test("cancelling a later task confirmation after retry still restores the disconnected desktop", async () => {
  const { calls, deps } = fixture(idle(), [1, 0]);
  let inspections = 0;
  deps.status = async () => {
    const state = idle();
    if (++inspections > 1) { state.connected = false; state.host!.commands = 1; }
    return state;
  };
  deps.stop = async () => { calls.push("failed-stop"); throw new Error("host changed"); };
  assert.equal(await quitWithHost(deps), false);
  assert.deepEqual(calls, ["disconnect", "failed-stop", "dialog", "dialog", "resume"]);
});

for (const synchronous of [false, true])
test(`failure to display a quit error still restores the disconnected desktop (synchronous=${synchronous})`, async () => {
  const { calls, deps } = fixture();
  deps.stop = async () => { calls.push("failed-stop"); throw new Error("cannot stop"); };
  deps.show = () => {
    calls.push("dialog");
    const error = new Error("dialog unavailable");
    if (synchronous) throw error;
    return Promise.reject(error);
  };
  await assert.rejects(quitWithHost(deps), /dialog unavailable/);
  assert.deepEqual(calls, ["disconnect", "failed-stop", "dialog", "resume"]);
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

for (const stage of ["status", "disconnect", "resume", "failure-dialog", "failure-dialog-error"] as const)
test(`a peer's full quit stops further quit work after awaiting ${stage}`, async () => {
  const state = idle();
  if (stage === "status") state.host!.running = 1;
  const { calls, deps } = fixture(state);
  let stopping = false;
  if (stage === "status") deps.status = async () => { stopping = true; return state; };
  if (stage === "disconnect") deps.disconnect = async () => { calls.push("disconnect"); stopping = true; };
  if (stage === "resume" || stage.startsWith("failure-dialog")) {
    deps.stop = async () => { calls.push("failed-stop"); throw new Error("host closing"); };
  }
  if (stage === "resume") {
    deps.resume = async () => { calls.push("resume"); stopping = true; };
  }
  if (stage.startsWith("failure-dialog")) deps.show = async () => {
    calls.push("dialog"); stopping = true;
    if (stage === "failure-dialog-error") throw new Error("dialog dismissed during peer quit");
    return { response: 0 };
  };
  assert.equal(await quitWithHost({ ...deps, alreadyStopping: () => stopping }), true);
  assert.deepEqual(calls, stage === "status" ? [] : stage === "disconnect" ? ["disconnect"]
    : stage === "resume" ? ["disconnect", "failed-stop", "dialog", "resume"] : ["disconnect", "failed-stop", "dialog"]);
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

test("an installer close request exits idle recovery windows instead of hiding to tray", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const calls: string[] = [];
    handleDesktopClose({ preventDefault() { calls.push("preserve"); } }, {
      platform, quitting: false, installing: true, closeToTray: true,
      hide() { calls.push("hide"); }, quit() { calls.push("quit"); },
    });
    assert.deepEqual(calls, ["preserve", "quit"]);
  }
});
