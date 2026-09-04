import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopApi,
  DesktopEvent,
  DesktopRoute,
} from "../shared/types.js";

const api: DesktopApi & { copy(text: string): Promise<void> } = {
  invoke<T>(route: DesktopRoute, input?: unknown) {
    return ipcRenderer.invoke("pix:invoke", route, input);
  },
  onEvent(listener: (event: DesktopEvent) => void) {
    const handle = (_event: unknown, payload: DesktopEvent) => listener(payload);
    ipcRenderer.on("pix:event", handle);
    return () => ipcRenderer.removeListener("pix:event", handle);
  },
  copy(text: string) {
    return ipcRenderer.invoke("pix:copy", text);
  },
};

contextBridge.exposeInMainWorld("pix", api);
