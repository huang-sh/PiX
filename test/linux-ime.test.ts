import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyLinuxImeEnv,
  applyLinuxImeWorkaround,
  detectRunningLinuxIm,
  inferLinuxIm,
} from "../src/main/linux-ime.js";

test("inferLinuxIm reads fcitx/ibus from any of the desktop IME variables", () => {
  assert.equal(inferLinuxIm({ XMODIFIERS: "@im=fcitx" }), "fcitx");
  assert.equal(inferLinuxIm({ GTK_IM_MODULE: "fcitx5" }), "fcitx");
  assert.equal(inferLinuxIm({ QT_IM_MODULE: "ibus" }), "ibus");
  assert.equal(inferLinuxIm({ INPUT_METHOD: "ibus" }), "ibus");
  assert.equal(inferLinuxIm({}), undefined);
});

test("applyLinuxImeEnv fills only missing companion variables", () => {
  const env: NodeJS.ProcessEnv = { XMODIFIERS: "@im=fcitx" };
  applyLinuxImeEnv(env, "fcitx");
  assert.equal(env.XMODIFIERS, "@im=fcitx");
  assert.equal(env.GTK_IM_MODULE, "fcitx");
  assert.equal(env.QT_IM_MODULE, "fcitx");
});

test("applyLinuxImeWorkaround forces GTK3 and Wayland IME only on Linux", () => {
  const switches: string[][] = [];
  const env: NodeJS.ProcessEnv = {};
  applyLinuxImeWorkaround({
    platform: "linux",
    env,
    wayland: true,
    runningIm: "fcitx",
    appendSwitch: (name, value) => switches.push(value === undefined ? [name] : [name, value]),
  });
  assert.deepEqual(switches, [
    ["gtk-version", "3"],
    ["enable-wayland-ime"],
  ]);
  assert.equal(env.GTK_IM_MODULE, "fcitx");
  assert.equal(env.XMODIFIERS, "@im=fcitx");

  const darwin: string[][] = [];
  applyLinuxImeWorkaround({
    platform: "darwin",
    env: {},
    runningIm: "fcitx",
    appendSwitch: (name, value) => darwin.push(value === undefined ? [name] : [name, value]),
  });
  assert.deepEqual(darwin, []);
});

test("detectRunningLinuxIm prefers fcitx over ibus from /proc comm names", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-ime-"));
  try {
    writeComm(root, "100", "bash");
    writeComm(root, "101", "ibus-daemon");
    writeComm(root, "102", "fcitx5");
    mkdirSync(join(root, "self"));
    assert.equal(detectRunningLinuxIm(root), "fcitx");
    rmSync(join(root, "102"), { recursive: true });
    assert.equal(detectRunningLinuxIm(root), "ibus");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeComm(root: string, pid: string, comm: string) {
  mkdirSync(join(root, pid));
  writeFileSync(join(root, pid, "comm"), `${comm}\n`);
}
