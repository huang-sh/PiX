export interface LinuxImeWorkaroundInput {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  hasSwitch: (name: string) => boolean;
  getSwitchValue: (name: string) => string;
  appendSwitch: (name: string, value?: string) => void;
}

export function applyLinuxImeWorkaround(input: LinuxImeWorkaroundInput): void {
  if (input.platform !== "linux") return;
  const { env, hasSwitch, getSwitchValue, appendSwitch } = input;
  const ozone = getSwitchValue("ozone-platform");
  if (ozone && ozone !== "auto" && ozone !== "x11" && ozone !== "wayland") return;
  const wayland = ozone === "wayland" || (
    ozone !== "x11" && Boolean(env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland")
  );
  if (wayland) {
    // GTK4 and the compositor protocol are alternative IME paths.
    if (getSwitchValue("gtk-version") !== "4" &&
        !hasSwitch("disable-wayland-ime") && !hasSwitch("enable-wayland-ime")) {
      appendSwitch("enable-wayland-ime");
    }
    return;
  }

  // Only use the X11 fallback for an explicitly configured input method.
  // An empty GTK_IM_MODULE is also an explicit choice; preserve it.
  const im = inferLinuxIm(env);
  if (!im) return;
  // Electron 36 started defaulting to GTK4 on GNOME. Keep the GTK3
  // compatibility fallback on X11, while honoring an explicit GTK version.
  if (!hasSwitch("gtk-version")) appendSwitch("gtk-version", "3");
  if (env.GTK_IM_MODULE === undefined) env.GTK_IM_MODULE = im;
}

export function inferLinuxIm(env: NodeJS.ProcessEnv): "fcitx" | "ibus" | undefined {
  const normalize = (value: string | undefined) => {
    if (value === "fcitx" || value === "fcitx5") return "fcitx";
    if (value === "ibus") return "ibus";
    return undefined;
  };
  if (env.GTK_IM_MODULE !== undefined) return normalize(env.GTK_IM_MODULE);
  const methods = [
    env.XMODIFIERS?.replace(/^@im=/, ""),
    env.INPUT_METHOD,
  ].filter((value): value is string => value !== undefined);
  if (!methods.length) return undefined;
  const im = normalize(methods[0]);
  return im && methods.every((value) => normalize(value) === im) ? im : undefined;
}
