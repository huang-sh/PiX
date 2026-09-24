import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
    async openPath(path) {
      assertPath(path);
      launch(path);
    },
    async openWith(path) {
      assertPath(path);
      if (process.platform === "win32") {
        await spawnDetached(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"), [
          "shell32.dll,OpenAs_RunDLL",
          path,
        ]);
        return;
      }
      if (process.platform !== "darwin")
        throw new Error("The open-with chooser is only available on Windows and macOS");
      const script = "set picked to choose application with prompt \"Open With\" as alias\nPOSIX path of picked";
      await new Promise<void>((done, fail) => {
        execFile("osascript", ["-e", script], (error, stdout) => {
          if (!error) {
            const appPath = String(stdout).trim();
            if (appPath) launch(path, ["-a", appPath]);
            done();
          } else if (/User canceled/i.test(error.message)) done();
          else fail(error);
        });
      });
    },
    async openWithApps(path) {
      if (process.platform !== "linux") return [];
      const mime = await new Promise<string | undefined>((done) => {
        execFile("file", ["--brief", "--mime-type", path], (error, stdout) =>
          done(error || !stdout ? undefined : stdout.trim()));
      });
      if (!mime) return [];
      const apps = new Map<string, { id: string; name: string }>();
      for (const dir of [join(homedir(), ".local/share/applications"), "/usr/share/applications"]) {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith(".desktop")) continue;
          const id = name.slice(0, -".desktop".length);
          if (apps.has(id)) continue;
          let entry: string;
          try {
            entry = readFileSync(join(dir, name), "utf8");
          } catch {
            continue;
          }
          const end = entry.indexOf("\n[", entry.indexOf("[") + 1);
          const section = entry.slice(0, end < 0 ? undefined : end + 1);
          if (!/^Name\s*=.*$/m.test(section) || /^(NoDisplay|Hidden)\s*=\s*true\b/m.test(section)) continue;
          const mimes = section.match(/^MimeType\s*=\s*(.+)$/m)?.[1]?.split(";") ?? [];
          if (!mimes.includes(mime)) continue;
          apps.set(id, { id, name: section.match(/^Name\s*=\s*(.+)$/m)![1]!.trim() });
        }
      }
      return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    async openWithApp(path, appId) {
      if (process.platform !== "linux")
        throw new Error("Choosing an application applies to Linux desktop entries");
      if (!/^[\w.-]+$/.test(appId)) throw new Error("Invalid application id");
      await spawnDetached("gtk-launch", [appId, path]);
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

function assertPath(path: string) {
  if (!existsSync(path)) throw new Error("Path was not found or is inaccessible");
}

function spawnDetached(command: string, args: string[]) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
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
