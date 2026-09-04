import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MainController, type Platform } from "../src/main/controller.js";

const root = resolve(process.cwd(), "test-workspace");
const denied: Platform = {
  async pickProject() {
    return undefined;
  },
  async pickSession() {
    return undefined;
  },
  async confirm() {
    return false;
  },
  async openExternal() {},
  quit() {},
};

test("shell commands require main-process approval", async () => {
  const controller = new MainController(root, denied);
  let ran = false;
  controller.shell.run = async () => {
    ran = true;
    throw new Error("must not run");
  };
  const result = (await controller.invoke("shell.run", {
    command: "echo denied",
  })) as { cancelled: boolean };
  assert.equal(result.cancelled, true);
  assert.equal(ran, false);
});

test("interactive terminals open without a second confirmation", async () => {
  const controller = new MainController(root, denied);
  let ran = false;
  controller.shell.create = () => {
    ran = true;
    return { id: "local-terminal" };
  };
  const result = await controller.invoke("terminal.create", {
    cols: 80,
    rows: 24,
  });
  assert.deepEqual({ result, ran }, { result: { id: "local-terminal" }, ran: true });
});

test("session deletion requires main-process approval", async () => {
  const controller = new MainController(root, denied);
  const session = controller.files.list()[0]!;
  let deleted = false;
  controller.files.delete = () => {
    deleted = true;
  };
  controller.sessions = async () => [];
  const result = (await controller.invoke("session.delete", {
    path: session.path,
  })) as { cancelled: boolean };
  assert.equal(result.cancelled, true);
  assert.equal(deleted, false);
});

test("renderer-confirmed session deletion skips the native prompt", async () => {
  const controller = new MainController(root, denied);
  const session = controller.files.list()[0]!;
  let deleted = false;
  controller.files.delete = () => {
    deleted = true;
  };
  controller.sessions = async () => [];
  const result = (await controller.invoke("session.delete", {
    path: session.path,
    confirmed: true,
  })) as { cancelled?: boolean };
  assert.equal(deleted, true);
  assert.equal(result.cancelled, undefined);
});

test("local session rename reaches the local runtime", async () => {
  const controller = new MainController(root, denied);
  const home = mkdtempSync(join(tmpdir(), "pix-controller-"));
  controller.settings.appPath = join(home, "settings.json");
  const session = controller.files.list()[0]!;
  let renamed: { path: string; name: string } | undefined;
  controller.pi.rename = async (path, name) => {
    renamed = { path, name };
  };
  controller.sessions = async () => [];

  try {
    await controller.invoke("session.rename", { path: session.path, name: "Local name" });
    assert.deepEqual(renamed, { path: session.path, name: "Local name" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("remote session rename is forwarded to the remote host", async () => {
  const controller = new MainController(root, denied);
  const home = mkdtempSync(join(tmpdir(), "pix-controller-"));
  controller.settings.appPath = join(home, "settings.json");
  const calls: Array<{ route: string; input: unknown }> = [];
  controller.wsl = {
    request: async (route: string, input: unknown) => {
      calls.push({ route, input });
      return { sessions: [] };
    },
  } as any;

  try {
    await controller.invoke("session.rename", {
      path: "/project/.pi/sessions/session.jsonl",
      name: "Remote name",
    });
    assert.deepEqual(calls, [{
      route: "session.rename",
      input: { path: "/project/.pi/sessions/session.jsonl", name: "Remote name" },
    }]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("remote OAuth login runs on the desktop and only syncs models", async () => {
  const controller = new MainController(root, denied);
  const localCalls: unknown[] = [];
  const remoteCalls: Array<{ route: string; input: unknown }> = [];
  controller.pi.control = async (input) => {
    localCalls.push(input);
    if (input.action === "getModels") return [];
    return { ok: true, status: { type: "oauth" } };
  };
  controller.wsl = {
    request: async (route: string, input: unknown) => {
      remoteCalls.push({ route, input });
      return { ok: true };
    },
  } as any;

  const result = await controller.invoke("agent.control", {
    action: "loginOAuth",
    provider: "openai-codex",
    method: "device-code",
  });

  assert.deepEqual(result, { ok: true, status: { type: "oauth" } });
  assert.deepEqual(localCalls, [
    { action: "loginOAuth", provider: "openai-codex", method: "device-code" },
    { action: "getModels" },
  ]);
  assert.deepEqual(remoteCalls, [{
    route: "agent.control",
    input: { action: "setBrokerProviders", providers: [] },
  }]);
});

test("WSL shell commands keep the local main-process approval boundary", async () => {
  const controller = new MainController(root, denied);
  const calls: string[] = [];
  controller.wsl = {
    request: async (route: string) => {
      calls.push(route);
      return [];
    },
  } as any;
  controller.wslSettings = {
    ...controller.settings.bundle(),
    effective: { defaultProjectTrust: "ask" },
  };
  const result = (await controller.invoke("shell.run", {
    command: "uname -a",
  })) as { cancelled: boolean };
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls, []);
});

test("remote interactive terminals open without a second confirmation", async () => {
  const controller = new MainController(root, denied);
  const calls: string[] = [];
  controller.wsl = {
    request: async (route: string) => {
      calls.push(route);
      return { id: "remote-terminal" };
    },
  } as any;
  controller.wslSettings = {
    ...controller.settings.bundle(),
    effective: { defaultProjectTrust: "ask" },
  };
  const result = await controller.invoke("terminal.create", { cols: 80, rows: 24 });
  assert.deepEqual({ result, calls }, {
    result: { id: "remote-terminal" },
    calls: ["terminal.create"],
  });
});

test("remote terminals reject an invalid host response", async () => {
  const controller = new MainController(root, {
    ...denied,
    async confirm() {
      return true;
    },
  });
  controller.wsl = { request: async () => undefined } as any;
  controller.wslSettings = {
    ...controller.settings.bundle(),
    effective: { defaultProjectTrust: "always" },
  };

  await assert.rejects(
    controller.invoke("terminal.create", { cols: 80, rows: 24 }),
    /Disconnect and reconnect the remote workspace/,
  );
});
