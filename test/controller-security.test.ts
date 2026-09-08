import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MainController, type Platform } from "../src/main/controller.js";
import type { ProjectGroup } from "../src/shared/types.js";

const root = resolve(process.cwd(), "test", "workspace");
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
  showItemInFolder() {},
  quit() {},
};

test("revealing a session uses its project history without opening the project", async () => {
  const shown: string[] = [];
  const controller = new MainController(root, { ...denied, showItemInFolder: path => { shown.push(path); } });
  const session = controller.files.list()[0]!;
  const record: ProjectGroup = { id: "other-project", project: { name: "other", path: root },
    sessions: [session], lastOpened: session.modified, connected: false };
  controller.projectGroups = () => [record];
  const active = controller.project;
  await controller.invoke("app.revealSession", { id: record.id, path: session.path });
  assert.deepEqual(shown, [resolve(session.path)]);
  assert.equal(controller.project, active);
  await assert.rejects(controller.invoke("app.revealSession", { id: "unknown", path: session.path }), /project history/);
  await assert.rejects(controller.invoke("app.revealSession", { id: record.id, path: "/unlisted" }), /project history/);
  await assert.rejects(controller.invoke("app.revealSession", { id: record.id }), /path/);
  record.project.remote = { kind: "ssh", host: "server" };
  await assert.rejects(controller.invoke("app.revealSession", { id: record.id, path: session.path }), /SSH/);
  assert.equal(shown.length, 1);
  if (process.platform === "win32") {
    record.project.remote = { kind: "wsl", distro: "Ubuntu" };
    session.path = "/home/user/my project/session.jsonl";
    await controller.invoke("app.revealSession", { id: record.id, path: session.path });
    assert.equal(shown.at(-1), "\\\\wsl.localhost\\Ubuntu\\home\\user\\my project\\session.jsonl");
    session.path = "/home/user/\\invalid";
    await assert.rejects(controller.invoke("app.revealSession", { id: record.id, path: session.path }), /Invalid WSL/);
  }
});

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
    { action: "getModels", broker: true },
  ]);
  assert.deepEqual(remoteCalls, [{
    route: "agent.control",
    input: { action: "setBrokerProviders", providers: [], models: [] },
  }]);
});

test("remote model refresh uses the desktop catalog and resyncs the model broker", async () => {
  const controller = new MainController(root, denied);
  const localCalls: unknown[] = [];
  const remoteCalls: Array<{ route: string; input: unknown }> = [];
  controller.pi.control = async (input) => {
    localCalls.push(input);
    return input.action === "getModels" ? [{ provider: "openai", id: "new-model" }] : { ok: true };
  };
  controller.wsl = { request: async (route: string, input: unknown) => {
    remoteCalls.push({ route, input });
    return { ok: true };
  } } as any;
  await controller.invoke("agent.control", { action: "refreshModels" });
  assert.deepEqual(localCalls, [{ action: "refreshModels" }, { action: "getModels", broker: true }]);
  assert.deepEqual(remoteCalls, [{ route: "agent.control", input: { action: "setBrokerProviders", providers: ["openai"], models: [{ provider: "openai", id: "new-model" }] } }]);
  assert.ok(controller.remoteBrokerModels.has("openai\0new-model"));
});

test("adding a remote custom model saves credentials on the desktop only", async () => {
  const controller = new MainController(root, denied);
  const localCalls: unknown[] = [];
  const remoteCalls: unknown[] = [];
  const model = { provider: "local-llm", id: "custom-model", api: "openai-completions" };
  controller.pi.control = async (input) => {
    localCalls.push(input);
    return input.action === "getModels" ? [model] : { ok: true };
  };
  controller.wsl = { request: async (_route: string, input: unknown) => {
    remoteCalls.push(input);
    return { ok: true };
  } } as any;
  const input = {
    action: "addCustomModel", provider: model.provider, modelId: model.id,
    api: model.api, baseUrl: "http://localhost:11434/v1", apiKey: "desktop-secret",
    contextWindow: 128000, maxTokens: 16384,
  };
  await controller.invoke("agent.control", input);
  assert.equal((localCalls[0] as typeof input).apiKey, input.apiKey);
  assert.deepEqual(remoteCalls, [{ action: "setBrokerProviders", providers: [model.provider], models: [model] }]);
  assert.ok(!JSON.stringify(remoteCalls).includes(input.apiKey));
  localCalls.length = 0;
  remoteCalls.length = 0;
  await controller.invoke("agent.control", { ...input, action: "updateCustomModel", imageInput: true });
  assert.equal((localCalls[0] as typeof input).action, "updateCustomModel");
  assert.deepEqual(remoteCalls, [{ action: "setBrokerProviders", providers: [model.provider], models: [model] }]);
  assert.ok(!JSON.stringify(remoteCalls).includes(input.apiKey));
  remoteCalls.length = 0;
  await controller.invoke("agent.control", { action: "getCustomModels" });
  assert.deepEqual(remoteCalls, []);
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
