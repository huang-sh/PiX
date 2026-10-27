import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MainController, type Platform } from "../src/main/controller.js";
import type { ProjectGroup, ProjectInfo, SettingsBundle } from "../src/shared/types.js";

// Deletion and rename flows rewrite the project history in the app settings,
// so without an isolated home these tests would enroll test/workspace in the
// developer's real session panel.
const home = mkdtempSync(join(tmpdir(), "pix-security-home-"));
process.env.PIX_HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

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
  async openPath() {},
  async openWith() {},
  async openWithApps() { return []; },
  async openWithApp() {},


  showItemInFolder() {},
  quit() {},
};

test("file links resolve line suffixes without changing file-tree paths or literal filenames", async () => {
  const project = mkdtempSync(join(home, "open-links-"));
  writeFileSync(join(project, "My Report.md"), "report");
  const opened: string[] = [];
  const controller = new MainController(project, { ...denied, openPath: async path => { opened.push(path); } });
  await controller.invoke("app.openFileLink", { href: "./My%20Report.md:12" });
  assert.deepEqual(opened, [join(project, "My Report.md")]);
  await controller.invoke("app.openPath", { path: "My Report.md" });
  assert.equal(opened.at(-1), join(project, "My Report.md"));
  if (process.platform !== "win32") {
    writeFileSync(join(project, "My Report.md:12"), "literal filename");
    await controller.invoke("app.openFileLink", { href: "./My%20Report.md:12" });
    assert.equal(opened.at(-1), join(project, "My Report.md:12"));
    await controller.invoke("app.openFileLink", { href: "./My%20Report.md%3A12" });
    assert.equal(opened.at(-1), join(project, "My Report.md:12"));
  }
  await controller.invoke("app.openPath", { path: "My Report.md:12" });
  assert.equal(opened.at(-1), join(project, "My Report.md:12"), "file-tree actions never interpret line suffixes");
  const count = opened.length;
  await assert.rejects(controller.invoke("app.openFileLink", { href: "../outside.md:12" }), /escapes project/);
  assert.equal(opened.length, count);
  controller.project!.remote = { kind: "ssh", host: "server" };
  await assert.rejects(controller.invoke("app.openPath", { path: "My Report.md" }), /Remote files/);
  assert.equal(opened.length, count);
});

test("explicit file links preserve outside absolute paths while workspace actions remain confined", async () => {
  const project = mkdtempSync(join(home, "file-links-"));
  const downloads = mkdtempSync(join(home, "下载 文档-"));
  const document = join(downloads, "技术白皮书.docx");
  writeFileSync(document, "fixture");
  const shorthand = `${project.split(/[\\/]/).at(-1)}.md`;
  writeFileSync(join(project, shorthand), "project readme");
  // A same-named project path must never shadow the actual absolute document.
  if (process.platform !== "win32") {
    const shadow = join(project, document.replace(/^[/\\]+/, ""));
    mkdirSync(resolve(shadow, ".."), { recursive: true });
    writeFileSync(shadow, "different file");
    writeFileSync(`${shadow}:12`, "different literal file");
  }
  const opened: string[] = [];
  const controller = new MainController(project, { ...denied, openPath: async path => { opened.push(path); } });
  const initial = controller.project;
  await controller.invoke("app.openFileLink", { href: document });
  assert.equal(opened.at(-1), document);
  await controller.invoke("app.openFileLink", { href: `${document}:12` });
  assert.equal(opened.at(-1), document);
  await controller.invoke("app.openFileLink", { href: `${pathToFileURL(document).href}:12?view=full#section` });
  assert.equal(opened.at(-1), document);
  if (process.platform !== "win32") {
    writeFileSync(`${document}:12`, "literal filename");
    await controller.invoke("app.openFileLink", { href: `${document}:12` });
    assert.equal(opened.at(-1), `${document}:12`);
    await controller.invoke("app.openFileLink", { href: `/${shorthand}` });
    assert.equal(opened.at(-1), join(project, shorthand));
  }
  assert.equal(controller.project, initial);
  const count = opened.length;
  await assert.rejects(controller.invoke("app.openPath", { path: document }), /escapes project/);
  await assert.rejects(controller.invoke("app.openFileLink", { href: "../outside.docx" }), /escapes project/);
  await assert.rejects(controller.invoke("app.openFileLink", { href: "https://example.com/report.docx" }), /Expected a file link/);
  controller.project!.remote = { kind: "ssh", host: "server" };
  await assert.rejects(controller.invoke("app.openFileLink", { href: document }), /Remote files/);
  assert.equal(opened.length, count);
});

test("a missing explicit file URL never opens a project file with the same name", async () => {
  const project = mkdtempSync(join(home, "file-url-"));
  const name = `${project.split(/[\\/]/).at(-1)}.docx`;
  writeFileSync(join(project, name), "a different project document");
  const absolute = resolve(project, "/", name);
  assert.equal(existsSync(absolute), false);
  const opened: string[] = [];
  const controller = new MainController(project, { ...denied, openPath: async path => {
    if (!existsSync(path)) throw new Error(`Missing file: ${path}`);
    opened.push(path);
  } });
  await controller.invoke("app.openFileLink", { href: `/${name}` });
  assert.deepEqual(opened, [join(project, name)]);
  for (const suffix of ["", ":12", ":12#section"]) {
    await assert.rejects(controller.invoke("app.openFileLink", { href: `${pathToFileURL(absolute).href}${suffix}` }), /Missing file/);
  }
  assert.deepEqual(opened, [join(project, name)]);
});

/** Installs a mock remote workspace as the pooled, active connection. */
function attachRemote(
  controller: MainController,
  request: (route: string, input?: unknown) => Promise<unknown>,
  effective?: Partial<SettingsBundle["effective"]>,
) {
  const project: ProjectInfo = { name: "remote", path: "/remote", remote: { kind: "ssh", host: "remote" } };
  controller.project = project;
  const bundle = controller.settings.bundle();
  controller.installSlot({ request, onEvent: () => () => {}, onDisconnect: () => () => {} } as never, project,
    effective ? { ...bundle, effective: { ...bundle.effective, ...effective } } : bundle);
}

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
  controller.files.deleteAt = () => {
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
  controller.files.deleteAt = () => {
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
  const session = controller.files.list()[0]!;
  let renamed: { path: string; name: string } | undefined;
  controller.projectRuntime.rename = async (path, name) => {
    renamed = { path, name };
  };
  controller.sessions = async () => [];

  await controller.invoke("session.rename", { path: session.path, name: "Local name" });
  assert.deepEqual(renamed, { path: session.path, name: "Local name" });
});

test("remote session rename is forwarded to the remote host", async () => {
  const controller = new MainController(root, denied);
  const calls: Array<{ route: string; input: unknown }> = [];
  attachRemote(controller, async (route, input) => {
    calls.push({ route, input });
    return { sessions: [] };
  });

  await controller.invoke("session.rename", {
    path: "/project/.pi/sessions/session.jsonl",
    name: "Remote name",
  });
  assert.deepEqual(calls, [{
    route: "session.rename",
    input: { path: "/project/.pi/sessions/session.jsonl", name: "Remote name" },
  }]);
});

test("recommended extension package actions run on the active remote host", async () => {
  const controller = new MainController(root, denied);
  const localCalls: unknown[] = [];
  const remoteCalls: Array<{ route: string; input: unknown }> = [];
  controller.projectRuntime.control = async (input) => {
    localCalls.push(input);
    return { ok: true };
  };
  attachRemote(controller, async (route, input) => {
    remoteCalls.push({ route, input });
    return { ok: true };
  });

  await controller.invoke("agent.control", {
    action: "installExtension",
    source: "npm:pi-web-access",
  });
  await controller.invoke("agent.control", {
    action: "removeExtension",
    source: "npm:pi-web-access",
  });

  assert.deepEqual(localCalls, []);
  assert.deepEqual(remoteCalls, [
    { route: "agent.control", input: { action: "installExtension", source: "npm:pi-web-access" } },
    { route: "agent.control", input: { action: "removeExtension", source: "npm:pi-web-access" } },
  ]);
});

test("remote OAuth login runs on the desktop and only syncs models", async () => {  const controller = new MainController(root, denied);
  const localCalls: unknown[] = [];
  const remoteCalls: Array<{ route: string; input: unknown }> = [];
  controller.projectRuntime.control = async (input) => {
    localCalls.push(input);
    if (input.action === "getModels") return [];
    return { ok: true, status: { type: "oauth" } };
  };
  attachRemote(controller, async (route, input) => {
    remoteCalls.push({ route, input });
    return { ok: true };
  });

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

test("remote OpenRouter refresh and login preserve personalized limits/prices and revoke old models", async () => {
  const controller = new MainController(root, denied);
  const localCalls: unknown[] = [];
  const remoteCalls: Array<{ route: string; input: unknown }> = [];
  const first = { provider: "openrouter", id: "allowed-a", api: "openai-completions", contextWindow: 75000, maxTokens: 4096,
    cost: { input: 2, output: 7, cacheRead: 1, cacheWrite: 0 } };
  const second = { ...first, id: "allowed-b", contextWindow: 80000, maxTokens: 8192 };
  let models = [first];
  controller.projectRuntime.control = async (input) => {
    localCalls.push(input);
    return input.action === "getModels" ? models : { ok: true };
  };
  attachRemote(controller, async (route, input) => {
    remoteCalls.push({ route, input });
    return { ok: true };
  });
  for (const model of [first, second]) {
    models = [model]; localCalls.length = 0; remoteCalls.length = 0;
    const input = model === first ? { action: "refreshModels" }
      : { action: "loginApiKey", provider: "openrouter", apiKey: "test-key-b" };
    await controller.invoke("agent.control", input);
    assert.deepEqual(localCalls, [input, { action: "getModels", broker: true }]);
    assert.deepEqual(remoteCalls, [{ route: "agent.control", input: { action: "setBrokerProviders", providers: ["openrouter"], models } }]);
    assert.ok(controller.remoteBrokerModels.has(`openrouter\0${model.id}`));
  }
  assert.equal(controller.remoteBrokerModels.has("openrouter\0allowed-a"), false, "the previous key's model cannot remain broker-enabled");
});

test("adding a remote custom model saves credentials on the desktop only", async () => {
  const controller = new MainController(root, denied);
  const localCalls: unknown[] = [];
  const remoteCalls: unknown[] = [];
  const model = { provider: "local-llm", id: "custom-model", api: "openai-completions" };
  controller.projectRuntime.control = async (input) => {
    localCalls.push(input);
    return input.action === "getModels" ? [model] : { ok: true };
  };
  attachRemote(controller, async (_route, input) => {
    remoteCalls.push(input);
    return { ok: true };
  });
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
  attachRemote(controller, async (route: string) => {
    calls.push(route);
    return [];
  }, { defaultProjectTrust: "ask" });
  const result = (await controller.invoke("shell.run", {
    command: "uname -a",
  })) as { cancelled: boolean };
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls, []);
});

test("remote interactive terminals open without a second confirmation", async () => {
  const controller = new MainController(root, denied);
  const calls: string[] = [];
  attachRemote(controller, async (route: string) => {
    calls.push(route);
    return { id: "remote-terminal" };
  }, { defaultProjectTrust: "ask" });
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
  attachRemote(controller, async () => undefined, { defaultProjectTrust: "always" });

  await assert.rejects(
    controller.invoke("terminal.create", { cols: 80, rows: 24 }),
    /Disconnect and reconnect the remote workspace/,
  );
});
