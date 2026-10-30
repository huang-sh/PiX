import type { MessageBoxOptions } from "electron";
import type { HostConnectionState } from "../shared/host-protocol.js";
import { stopLocalHost, withStoppedLocalHost } from "../host/client.js";

interface HostQuitOptions {
  zh: boolean;
  status(): Promise<HostConnectionState>;
  disconnect(): Promise<void>;
  resume(): Promise<void>;
  show(options: MessageBoxOptions): Promise<{ response: number }>;
  stop?: typeof stopLocalHost;
  alreadyStopping?(): boolean;
}

export function handleDesktopClose(event: { preventDefault(): void }, options: {
  platform: string; quitting: boolean; closeToTray: boolean; hide(): void; quit(): void;
}) {
  if (options.quitting || options.platform === "darwin") return;
  // Keep the window alive until Quit's confirmation succeeds.
  event.preventDefault();
  if (options.closeToTray) options.hide();
  else options.quit();
}

/** Explicit Quit owns the host lifecycle; closing a window remains independent. */
export async function quitWithHost(options: HostQuitOptions): Promise<boolean> {
  const { zh } = options;
  let disconnected = false;
  while (true) {
    try {
      if (options.alreadyStopping?.()) return true;
      const state = await options.status();
      const host = state.host;
      if (host && !host.verified) throw new Error(state.error ?? (zh ? "无法验证后台，请稍后重试。" : "Cannot verify the host. Try again later."));
      let force = false;
      const others = Math.max(0, (host?.clients ?? 0) - (state.connected ? 1 : 0));
      if (host && (host.stopping || host.running || host.pending || host.remoteConnections || host.commands || host.terminals || others)) {
        const response = await options.show({ type: "warning", title: "PiX",
          message: zh ? "终止任务并完全退出 PiX？" : "Interrupt work and quit PiX completely?",
          detail: zh ? `${host.stopping ? "后台正在退出，清理尚未完成。\n" : ""}运行中的任务：${host.running ?? 0}\n等待中的任务：${host.pending ? "有" : "无"}\n终端命令：${host.commands ?? 0}\n终端会话：${host.terminals ?? 0}\n其他客户端：${others}\n远程连接：${host.remoteConnections ?? 0}\n\n退出会停止本机后台，中断本地任务和终端命令，并关闭其他 PiX 窗口、断开客户端。已保存的会话保留，未保存内容可能丢失。远程任务可能继续运行。\n\n如需等待任务完成，请取消，完成后再退出。`
            : `${host.stopping ? "The host is shutting down; cleanup has not finished.\n" : ""}Running tasks: ${host.running ?? 0}\nPending work: ${host.pending ? "Yes" : "No"}\nShell commands: ${host.commands ?? 0}\nTerminals: ${host.terminals ?? 0}\nOther clients: ${others}\nRemote connections: ${host.remoteConnections ?? 0}\n\nQuitting stops the local host, interrupts local tasks and terminal commands, closes other PiX windows and disconnects clients. Saved sessions are retained; unsaved work may be lost. Remote tasks may continue running.\n\nCancel to let tasks finish, then quit again.`,
          buttons: zh ? ["取消", "终止并退出"] : ["Cancel", "Interrupt and Quit"], defaultId: 0, cancelId: 0, noLink: true });
        if (options.alreadyStopping?.()) return true;
        if (response.response !== 1) return false;
        force = true;
      }
      await options.disconnect();
      disconnected = true;
      if (options.stop && host) await options.stop(host.id, force, true);
      else await withStoppedLocalHost(host?.id, force, async () => {}, true);
      return true;
    } catch (error) {
      if (options.alreadyStopping?.()) return true;
      if (disconnected) {
        disconnected = false;
        try { await options.resume(); } catch { /* The normal recovery view handles a host that remains unavailable. */ }
      }
      const response = await options.show({ type: "warning", title: "PiX",
        message: zh ? "后台尚未完全退出" : "The background host has not stopped",
        detail: error instanceof Error ? error.message : String(error),
        buttons: zh ? ["取消退出", "重试"] : ["Cancel Quit", "Retry"], defaultId: 0, cancelId: 0, noLink: true });
      if (options.alreadyStopping?.()) return true;
      if (response.response !== 1) return false;
    }
  }
}
