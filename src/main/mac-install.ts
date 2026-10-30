import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MessageBoxOptions } from "electron";
import { localHostStatus, withStoppedLocalHost } from "../host/client.js";
import type { HostConnectionState } from "../shared/host-protocol.js";

const exec = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function isMacInstallSource(platform: string, packaged: boolean, executable: string) {
  return platform === "darwin" && packaged
    && (executable.startsWith("/Volumes/") || executable.includes("/AppTranslocation/"));
}

interface InstalledWindows { quit(force?: boolean): Promise<void>; reopen(): Promise<void> }
interface MacInstallOptions {
  zh: boolean;
  version: string;
  show(options: MessageBoxOptions): Promise<{ response: number }>;
  move(): boolean;
  status?: typeof localHostStatus;
  windows?: () => Promise<InstalledWindows>;
  install?: typeof withStoppedLocalHost;
}

/** The source app never attaches to the host before installation finishes. */
export async function offerMacInstall(options: MacInstallOptions): Promise<"open" | "quit"> {
  const { zh } = options;
  const show = (message: string, detail: string, buttons: string[], defaultId = 0) =>
    options.show({ type: "question", title: "PiX", message, detail, buttons, defaultId, cancelId: 0, noLink: true });
  const status = options.status ?? localHostStatus;
  const install = options.install ?? withStoppedLocalHost;
  const choice = await options.show({ type: "question", title: "PiX",
    message: zh ? `安装 PiX ${options.version}？` : `Install PiX ${options.version}?`,
    detail: zh ? "将 PiX 安装到 Applications 并打开。更新前会检查任务，正常关闭已安装的 PiX 窗口和后台；不会自动终止任务。"
      : "Install PiX in Applications and open it. Before replacing the app, PiX checks tasks and closes the installed windows and background host. Tasks are never interrupted automatically.",
    buttons: zh ? ["安装并打开", "仅打开", "取消"] : ["Install and Open", "Open Only", "Cancel"],
    defaultId: 0, cancelId: 2, noLink: true });
  if (choice.response !== 0) return choice.response === 1 ? "open" : "quit";

  const busy = (state: HostConnectionState) => Boolean(state.host
    && (state.host.stopping || state.host.running || state.host.pending || state.host.remoteConnections || state.host.commands || state.host.terminals || state.host.clients));
  const chooseForce = async (state: HostConnectionState) => {
    const host = state.host!;
    const response = await show(
      zh ? (host.stopping ? "后台清理尚未完成" : "后台仍有任务或连接") : (host.stopping ? "Host cleanup has not finished" : "The background host still has tasks or connections"),
      zh ? `后台版本：${host.version}\n运行中的任务：${host.running ?? 0}\n等待中的任务：${host.pending ? "有" : "无"}\n终端命令：${host.commands ?? 0}\n终端会话：${host.terminals ?? 0}\n客户端连接：${host.clients ?? 0}\n远程连接：${host.remoteConnections ?? 0}\n\n可取消安装，等待任务完成并断开连接后重试；也可选择终止并安装。`
        : `Host version: ${host.version}\nRunning tasks: ${host.running ?? 0}\nPending work: ${host.pending ? "Yes" : "No"}\nShell commands: ${host.commands ?? 0}\nTerminals: ${host.terminals ?? 0}\nClient connections: ${host.clients ?? 0}\nRemote connections: ${host.remoteConnections ?? 0}\n\nCancel and retry after tasks finish and connections close, or choose to interrupt work and install.`,
      zh ? ["取消安装", "重新检查", "终止并安装…"] : ["Cancel Installation", "Check Again", "Interrupt and Install…"]);
    if (response.response !== 2) return response.response === 1 ? "retry" : "cancel";
    const confirmed = await show(
      zh ? "确认终止任务并安装？" : "Interrupt tasks and install?",
      zh ? "本地任务和终端命令将中断，其他客户端将断开。已保存的会话记录保留，未保存内容可能丢失。远程任务可能继续运行。\n\n会先尝试保存并正常退出；无响应时才强制终止。无法正常退出的 PiX 窗口也会被强制关闭。"
        : "Local tasks and terminal commands will be interrupted, and other clients will disconnect. Saved session history is retained; unsaved work may be lost. Remote tasks may continue running.\n\nPiX first tries to save and shut down normally, and forcibly terminates the host only if necessary. PiX windows that cannot quit normally will also be forcibly closed.",
      zh ? ["取消", "终止并安装"] : ["Cancel", "Interrupt and Install"]);
    return confirmed.response === 1 ? "force" : "cancel";
  };

  while (true) {
    let windows: InstalledWindows | undefined;
    let installed = false;
    let again = false;
    const restoreWindows = async () => {
      const previous = windows;
      windows = undefined;
      try { await previous?.reopen(); }
      catch (error) {
        return `${zh ? "无法重新打开之前的 PiX，请从 Applications 手动打开。" : "Could not reopen the previous PiX. Open it from Applications."}\n${error instanceof Error ? error.message : String(error)}`;
      }
    };
    try {
      const before = await status();
      if (before.host && !before.host.verified) throw new Error(before.error ?? (zh ? "无法验证旧后台，请稍后重试。" : "Cannot verify the previous host. Try again later."));
      let force = false;
      if (busy(before)) {
        const decision = await chooseForce(before);
        if (decision === "cancel") return "quit";
        if (decision === "retry") continue;
        force = true;
      }
      windows = await (options.windows ?? installedMacWindows)();
      if (force) {
        installed = await install(before.host?.id, true, async () => {
          await windows!.quit(true);
          return options.move();
        }, true);
      } else {
        await windows.quit();
        const current = await status();
        if ((current.host && !current.host.verified) || (current.host && current.host.id !== before.host?.id))
          throw new Error(zh ? "后台状态已改变，请重新检查后再安装。" : "The host changed. Check its current status before installing.");
        installed = await install(current.host?.id, false, async () => options.move(), true);
      }
      if (installed) return "quit";
      throw new Error(zh ? "安装未完成。若仍有 PiX 窗口正在退出，请稍后重试；取消安装会恢复旧版窗口。"
        : "Installation did not finish. If a PiX window is still closing, try again shortly. Cancelling restores the previous windows.");
    } catch (error) {
      // Restore the previous client before offering a retry or showing failure.
      const restoreError = await restoreWindows();
      const result = await show(zh ? "安装尚未完成" : "Installation has not finished",
        [error instanceof Error ? error.message : String(error), restoreError].filter(Boolean).join("\n\n"),
        zh ? ["取消安装", "重试"] : ["Cancel Installation", "Retry"]);
      again = result.response === 1;
    } finally {
      if (!installed) {
        const restoreError = await restoreWindows();
        if (restoreError) await show(zh ? "请重新打开 PiX" : "Reopen PiX", restoreError, [zh ? "好" : "OK"]);
      }
    }
    if (!again) return "quit";
  }
}

/** NSWorkspace addresses running app instances, so quitting never launches an absent app. */
export async function installedMacWindows(targets = ["/Applications/PiX.app", join(homedir(), "Applications/PiX.app")]): Promise<InstalledWindows> {
  const { stdout } = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
    ObjC.import('AppKit');
    const targets = ${JSON.stringify(targets)};
    const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    const result = [];
    for (let i = 0; i < apps.count; i++) {
      const app = apps.objectAtIndex(i);
      if (app.bundleURL.isNil()) continue;
      const path = ObjC.unwrap(app.bundleURL.path);
      if (app.processIdentifier > 0 && app.processIdentifier !== ${process.pid} && targets.indexOf(path) !== -1)
        result.push({pid: app.processIdentifier, path});
    }
    JSON.stringify(result);
  `], { timeout: 10_000 });
  const apps = JSON.parse(stdout) as { pid: number; path: string }[];
  const requestQuit = (force: boolean) => exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
    ObjC.import('AppKit');
    ${force ? "ObjC.bindFunction('kill', ['int', ['int', 'int']]);" : ""}
    const apps = ${JSON.stringify(apps)};
    apps.forEach(item => {
      if (!Number.isInteger(item.pid) || item.pid <= 0) return;
      const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(item.pid);
      if (!app.isNil() && ObjC.unwrap(app.bundleURL.path) === item.path) ${force ? "$.kill(item.pid, 9)" : "app.terminate"};
    });
  `], { timeout: 10_000 });
  let attempted = false;
  return {
    async quit(force = false) {
      attempted = true;
      await requestQuit(false);
      let deadline = Date.now() + 10_000;
      let forced = false;
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
      while (apps.some(app => alive(app.pid))) {
        if (Date.now() >= deadline) {
          if (!force || forced) throw new Error("PiX windows are still closing. Finish any open dialogs, then retry installation.");
          // A recovery window may be waiting for this installer's startup
          // lock without a host connection through which to receive Quit.
          await requestQuit(true);
          forced = true;
          deadline = Date.now() + 5000;
        }
        await delay(100);
      }
    },
    async reopen() {
      if (!attempted) return;
      attempted = false;
      for (const path of new Set(apps.map(app => app.path)))
        await exec("/usr/bin/open", ["-a", path], { timeout: 10_000 });
    },
  };
}
