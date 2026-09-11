import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  DesktopApi,
  DesktopEvent,
  DesktopRoute,
} from "../shared/types.js";
import { unwrapInvokeReply, type InvokeReply } from "../shared/ipc.js";

const api: DesktopApi & { copy(text: string): Promise<void> } = {
  initialTheme: ipcRenderer.sendSync("pix:initial-theme"),
  async invoke<T>(route: DesktopRoute, input?: unknown) {
    const reply = await ipcRenderer.invoke("pix:invoke", route, input) as InvokeReply<T>;
    return unwrapInvokeReply(reply);
  },
  onEvent(listener: (event: DesktopEvent) => void) {
    const handle = (_event: unknown, payload: DesktopEvent) => listener(payload);
    ipcRenderer.on("pix:event", handle);
    return () => ipcRenderer.removeListener("pix:event", handle);
  },
  copy(text: string) {
    return ipcRenderer.invoke("pix:copy", text);
  },
  // Sandboxed renderers cannot read File.path; resolve it here so non-image
  // attachments can be delivered to the agent as local file paths.
  filePath(file: File) {
    return webUtils.getPathForFile(file);
  },
};

contextBridge.exposeInMainWorld("pix", api);
