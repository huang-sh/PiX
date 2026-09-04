import test from "node:test";
import assert from "node:assert/strict";
import { validateRouteInput } from "../src/shared/contracts.js";
test("validates route inputs", () =>
  assert.deepEqual(validateRouteInput("workspace.read", { path: "src/a.ts" }), {
    path: "src/a.ts",
  }));
test("rejects malformed inputs", () =>
  assert.throws(() => validateRouteInput("session.open", { path: "" })));
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
      replace: true,
    }),
    { scope: "global", patch: { modelThinkingLevels: {} }, replace: true },
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
