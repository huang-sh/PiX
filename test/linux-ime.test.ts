import test from "node:test";
import assert from "node:assert/strict";
import { applyLinuxImeWorkaround, inferLinuxIm } from "../src/main/linux-ime.js";

function apply(env: NodeJS.ProcessEnv, flags: Record<string, string> = {}, platform: NodeJS.Platform = "linux") {
  const switches: string[][] = [];
  applyLinuxImeWorkaround({
    platform,
    env,
    hasSwitch: (name) => Object.hasOwn(flags, name),
    getSwitchValue: (name) => flags[name] ?? "",
    appendSwitch: (name, value) => switches.push(value === undefined ? [name] : [name, value]),
  });
  return switches;
}

test("X11 fills GTK from an explicit input method without changing Qt or XMODIFIERS", () => {
  for (const im of ["fcitx", "ibus"]) {
    const env = { XMODIFIERS: `@im=${im}` };
    assert.deepEqual(apply(env), [["gtk-version", "3"]]);
    assert.deepEqual(env, { XMODIFIERS: `@im=${im}`, GTK_IM_MODULE: im });
  }
  const env = { INPUT_METHOD: "fcitx5", QT_IM_MODULE: "ibus" };
  apply(env);
  assert.deepEqual(env, { INPUT_METHOD: "fcitx5", QT_IM_MODULE: "ibus", GTK_IM_MODULE: "fcitx" });
});

test("unconfigured and ambiguous sessions do not guess a daemon or input module", () => {
  for (const env of [{}, { QT_IM_MODULE: "fcitx" }, { XMODIFIERS: "@im=fcitx", INPUT_METHOD: "ibus" }]) {
    const before = { ...env };
    assert.deepEqual(apply(env), []);
    assert.deepEqual(env, before);
  }
});

test("explicit GTK module choices, including empty values, are preserved", () => {
  for (const module of ["", "wayland", "xim", "ibus", "fcitx"]) {
    const env = { GTK_IM_MODULE: module, XMODIFIERS: "@im=fcitx" };
    const before = { ...env };
    apply(env);
    assert.deepEqual(env, before);
    assert.equal(inferLinuxIm(env), module === "ibus" || module === "fcitx" ? module : undefined);
  }
});

test("input method names must match exactly", () => {
  assert.equal(inferLinuxIm({ XMODIFIERS: "@im=not-fcitx" }), undefined);
  assert.equal(inferLinuxIm({ INPUT_METHOD: "ibus-other" }), undefined);
  assert.equal(inferLinuxIm({ XMODIFIERS: "@im=fcitx", INPUT_METHOD: "fcitx5" }), "fcitx");
});

test("Wayland preserves unset GTK and Qt modules and uses the compositor IME", () => {
  for (const session of [{ WAYLAND_DISPLAY: "wayland-0" }, { XDG_SESSION_TYPE: "wayland" }]) {
    const env = { ...session, XMODIFIERS: "@im=fcitx" };
    const before = { ...env };
    assert.deepEqual(apply(env), [["enable-wayland-ime"]]);
    assert.deepEqual(env, before);
  }
});

test("explicit ozone backend takes precedence over desktop environment", () => {
  const env = { WAYLAND_DISPLAY: "wayland-0", XMODIFIERS: "@im=fcitx" };
  assert.deepEqual(apply(env, { "ozone-platform": "x11" }), [["gtk-version", "3"]]);
  assert.equal((env as NodeJS.ProcessEnv).GTK_IM_MODULE, "fcitx");
  const x11 = { XMODIFIERS: "@im=ibus" };
  assert.deepEqual(apply(x11, { "ozone-platform": "wayland" }), [["enable-wayland-ime"]]);
  assert.deepEqual(x11, { XMODIFIERS: "@im=ibus" });
  assert.deepEqual(apply({}, { "ozone-platform": "headless" }), []);
});

test("explicit GTK versions are not overridden", () => {
  for (const version of ["3", "4"]) {
    assert.deepEqual(apply({ GTK_IM_MODULE: "fcitx" }, { "gtk-version": version }), []);
  }
  assert.deepEqual(apply({ WAYLAND_DISPLAY: "wayland-0" }, { "gtk-version": "4" }), []);
});

test("explicit Wayland IME enable or disable switches are preserved", () => {
  for (const flag of ["enable-wayland-ime", "disable-wayland-ime"]) {
    assert.deepEqual(apply({ WAYLAND_DISPLAY: "wayland-0" }, { [flag]: "" }), []);
  }
});

test("other platforms leave switches and environment untouched", () => {
  for (const platform of ["darwin", "win32"] as const) {
    const env = { XMODIFIERS: "@im=fcitx" };
    assert.deepEqual(apply(env, {}, platform), []);
    assert.deepEqual(env, { XMODIFIERS: "@im=fcitx" });
  }
});
