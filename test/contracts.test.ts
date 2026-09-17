import test from "node:test";
import assert from "node:assert/strict";
import { customModelInput, validateRouteInput } from "../src/shared/contracts.js";

test("layout save validates the persisted workbench shape", () => {
  const layout = {
    version: 1,
    navigatorPinned: true,
    branchOrders: { "D:\\p\\s.jsonl": [["turn:a", 2], ["turn:b", 1]] },
    chatPinWidth: { from: 400, to: 640 },
    widths: { navigator: 240, chat: 480, content: 800.5, settings: 360 },
    collapsed: { navigator: false, chat: false, content: true },
    minimap: true,
    utility: { open: true, collapsed: false, height: 220, activeTab: "terminal" },
  };
  assert.deepEqual(validateRouteInput("layout.save", { layout }), { layout });
  assert.throws(() =>
    validateRouteInput("layout.save", { layout: { ...layout, minimap: "yes" } }),
    /minimap/);
  assert.throws(() =>
    validateRouteInput("layout.save", {
      layout: { ...layout, widths: { ...layout.widths, chat: Number.NaN } },
    }),
    /widths\.chat/);
  assert.throws(() =>
    validateRouteInput("layout.save", {
      layout: { ...layout, utility: { ...layout.utility, activeTab: "nope" } },
    }),
    /activeTab/);
  assert.throws(() =>
    validateRouteInput("layout.save", {
      layout: { ...layout, branchOrders: { "D:\\p\\s.jsonl": [["turn:a"]] } },
    }),
    /branchOrders/);
  assert.throws(() => validateRouteInput("layout.save", { layout: {} }), /widths/);
});
test("custom model input is validated standalone for models.json writes", () => {
  const input = {
    provider: "openrouter",
    modelId: "gpt-x",
    name: " GPT X ",
    baseUrl: "https://api.example.com/v1",
    api: "openai-completions",
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
    imageInput: false,
  };
  assert.deepEqual(customModelInput(input), { ...input, name: "GPT X", apiKey: undefined });
  assert.throws(() => customModelInput({ ...input, api: "carrier-pigeon" }), /API/);
  assert.throws(() => customModelInput({ ...input, provider: "../evil" }), /provider/i);
  assert.throws(() => customModelInput({ ...input, baseUrl: "ftp://x" }), /HTTP/);
});
test("node deletion preserves its target across IPC and rejects missing identifiers", () => {
  const input = { action: "deleteNode", nodeId: "turn:b", graphId: "D:\\project\\session.jsonl" };
  assert.deepEqual(validateRouteInput("agent.control", input), input);
  for (const field of ["nodeId", "graphId"])
    for (const value of [undefined, null, "", " ", 123])
      assert.throws(() => validateRouteInput("agent.control", { ...input, [field]: value }), new RegExp(field));
});
test("validates route inputs", () =>
  assert.deepEqual(validateRouteInput("workspace.read", { path: "src/a.ts" }), {
    path: "src/a.ts",
  }));
test("rejects malformed inputs", () =>
  assert.throws(() => validateRouteInput("session.open", { path: "" })));
test("session stop targets one session file", () => {
  const targeted = { path: "/same/path.jsonl", projectId: "ssh:host:/project" };
  assert.deepEqual(validateRouteInput("session.stop", targeted), targeted);
  assert.throws(() => validateRouteInput("session.stop", { ...targeted, projectId: "" }));
  assert.deepEqual(validateRouteInput("session.stop", { path: "D:/p/.pi/sessions/s.jsonl" }),
    { path: "D:/p/.pi/sessions/s.jsonl" });
  assert.throws(() => validateRouteInput("session.stop", { path: "" }));
  assert.throws(() => validateRouteInput("session.stop", {}));
});
test("rejects unsafe external protocols", () =>
  assert.throws(() =>
    validateRouteInput("app.openExternal", { url: "file:///tmp/pix" }),
  ));
test("validates WSL connection input", () => {
  assert.deepEqual(
    validateRouteInput("wsl.connect", {
      distro: "Ubuntu-24.04",
      cwd: "/home/pix/project",
    }),
    { distro: "Ubuntu-24.04", cwd: "/home/pix/project" },
  );
  assert.throws(() =>
    validateRouteInput("wsl.connect", { distro: "", cwd: "/tmp" }),
  );
});
test("validates SSH connection input", () => {
  assert.deepEqual(
    validateRouteInput("ssh.connect", {
      host: "user@example.org",
      cwd: "/home/user/project",
    }),
    { host: "user@example.org", cwd: "/home/user/project" },
  );
  assert.throws(() =>
    validateRouteInput("ssh.connect", { host: "", cwd: "/tmp" }),
  );
});
test("validates remote directory operations", () => {
  assert.deepEqual(
    validateRouteInput("workspace.directories", { path: "/data/project" }),
    { path: "/data/project" },
  );
  assert.deepEqual(
    validateRouteInput("remote.openProject", { path: "/data/project" }),
    { path: "/data/project" },
  );
  assert.throws(() => validateRouteInput("workspace.open", { path: "" }));
});

test("validates saved project operations", () => {
  assert.deepEqual(validateRouteInput("app.openProject", { id: "local:D:/PiX" }), {
    id: "local:D:/PiX",
  });
  assert.deepEqual(validateRouteInput("app.forgetProject", { id: "ssh:host:/project" }), {
    id: "ssh:host:/project",
  });
});
test("validates interactive terminal operations", () => {
  assert.deepEqual(
    validateRouteInput("terminal.create", { cols: 80, rows: 24 }),
    { cols: 80, rows: 24 },
  );
  assert.deepEqual(
    validateRouteInput("terminal.write", { id: "terminal", data: "pwd\r" }),
    { id: "terminal", data: "pwd\r" },
  );
  assert.throws(() =>
    validateRouteInput("terminal.resize", { id: "terminal", cols: 0, rows: 24 }),
  );
});
test("validates persistent model and API key actions", () => {
  assert.deepEqual(
    validateRouteInput("settings.update", {
      scope: "global",
      patch: { modelThinkingLevels: {} },
    }),
    { scope: "global", patch: { modelThinkingLevels: {} } },
  );
  assert.deepEqual(
    validateRouteInput("agent.control", {
      action: "setModel",
      provider: "openai",
      modelId: "gpt-5.6",
      persist: true,
    }),
    { action: "setModel", provider: "openai", modelId: "gpt-5.6", persist: true },
  );
  assert.deepEqual(
    validateRouteInput("agent.control", {
      action: "loginApiKey",
      provider: "openai",
      apiKey: "secret",
    }),
    { action: "loginApiKey", provider: "openai", apiKey: "secret" },
  );
  assert.deepEqual(
    validateRouteInput("agent.control", {
      action: "loginOAuth",
      provider: "openai-codex",
      method: "device-code",
    }),
    { action: "loginOAuth", provider: "openai-codex", method: "device-code" },
  );
});

test("extension installs and removals are limited to recommended sources", () => {
  for (const action of ["installExtension", "removeExtension"] as const) {
    assert.deepEqual(
      validateRouteInput("agent.control", { action, source: "npm:pi-web-access" }),
      { action, source: "npm:pi-web-access" },
    );
    for (const source of ["", "npm:not-recommended", "git:github.com/user/repo", "./local", "npm:pi-web-access; rm -rf /"])
      assert.throws(() =>
        validateRouteInput("agent.control", { action, source }),
      );
  }
});
