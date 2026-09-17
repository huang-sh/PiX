import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Platform } from "../main/controller.js";

export function openUrl(url: string) {
  const target = new URL(url);
  if (!["https:", "http:", "mailto:"].includes(target.protocol))
    throw new Error(`External protocol is not allowed: ${target.protocol}`);
  launch(target.href);
}

export function createWebPlatform(
  confirm: (message: string, detail?: string) => Promise<boolean>,
): Platform {
  return {
    async pickProject() {
      return undefined;
    },
    async pickSession() {
      return undefined;
    },
    confirm,
    async openExternal(url) {
      openUrl(url);
    },
    showItemInFolder(path) {
      if (!existsSync(path))
        throw new Error("Session file was not found or is inaccessible");
      if (process.platform === "darwin") launch(path, ["-R"]);
      else if (process.platform === "win32")
        spawn("explorer", ["/select,", path], {
          detached: true,
          stdio: "ignore",
        }).unref();
      else launch(dirname(path));
    },
    quit() {},
  };
}

function launch(target: string, extra: string[] = []) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? ["/c", "start", "", target]
      : [...extra, target];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
