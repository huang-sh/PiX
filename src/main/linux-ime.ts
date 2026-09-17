import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LinuxIm = "fcitx" | "ibus";

export interface LinuxImeWorkaroundInput {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  wayland?: boolean;
  runningIm?: LinuxIm;
  appendSwitch: (name: string, value?: string) => void;
}

/**
 * Electron 28+ defaults to GTK4 on Linux. GTK4's IM context does not talk to
 * fcitx/ibus, so the desktop IME never attaches. GTK3 restores it.
 */
export function applyLinuxImeWorkaround(input: LinuxImeWorkaroundInput): void {
  if (input.platform !== "linux") return;
  input.appendSwitch("gtk-version", "3");
  if (input.wayland) input.appendSwitch("enable-wayland-ime");
  const im = inferLinuxIm(input.env) ?? input.runningIm;
  if (im) applyLinuxImeEnv(input.env, im);
}

export function inferLinuxIm(env: NodeJS.ProcessEnv): LinuxIm | undefined {
  const blob = [env.GTK_IM_MODULE, env.QT_IM_MODULE, env.XMODIFIERS, env.INPUT_METHOD]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (blob.includes("fcitx")) return "fcitx";
  if (blob.includes("ibus")) return "ibus";
  return undefined;
}

export function applyLinuxImeEnv(env: NodeJS.ProcessEnv, im: LinuxIm): void {
  env.GTK_IM_MODULE ||= im;
  env.QT_IM_MODULE ||= im;
  env.XMODIFIERS ||= `@im=${im}`;
}

export function detectRunningLinuxIm(procDir = "/proc"): LinuxIm | undefined {
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return undefined;
  }
  let ibus = false;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let comm: string;
    try {
      comm = readFileSync(join(procDir, name, "comm"), "utf8").trim();
    } catch {
      continue;
    }
    if (comm === "fcitx5" || comm === "fcitx") return "fcitx";
    if (comm === "ibus-daemon") ibus = true;
  }
  return ibus ? "ibus" : undefined;
}
