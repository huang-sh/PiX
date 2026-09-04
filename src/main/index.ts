import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  shell,
} from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MainController } from "./controller.js";
import type { DesktopRoute } from "../shared/types.js";
const dir = dirname(fileURLToPath(import.meta.url));
let win: any, controller: MainController;
async function openExternal(url: string) {
  const target = new URL(url);
  if (!["https:", "http:", "mailto:"].includes(target.protocol))
    throw new Error(`External protocol is not allowed: ${target.protocol}`);
  await shell.openExternal(target.href);
}
async function create() {
  Menu.setApplicationMenu(
    // macOS dispatches editing shortcuts (Cmd+C/V/X/A) through the
    // application menu, so a null menu would disable them entirely.
    process.platform === "darwin"
      ? Menu.buildFromTemplate([
          { label: app.name, submenu: [{ role: "about" }, { role: "quit" }] },
          { role: "editMenu" },
        ])
      : null,
  );
  win = new BrowserWindow({
    icon: join(app.getAppPath(), "resources/icon.png"),
    width: 1600,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    title: "PiX",
    backgroundColor: "#f2f6f6",
    frame: process.platform === "darwin",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#eef2f1",
      symbolColor: "#17201e",
      height: 40,
    },
    webPreferences: {
      preload: join(dir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      // Occluded/hidden windows must keep rendering: boot-time layout restore
      // (splitters, graph centering) depends on rAF and ResizeObserver, which
      // background throttling otherwise freezes with no recovery path.
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
      void openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  win.webContents.on(
    "will-attach-webview",
    (_e: unknown, p: Record<string, unknown>) => {
      delete p.preload;
      p.nodeIntegration = false;
      p.contextIsolation = true;
      p.sandbox = true;
    },
  );
  if (process.env.ELECTRON_RENDERER_URL)
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(dir, "../renderer/index.html"));
}
app.whenReady().then(async () => {
  const initial = process.env.PIX_PROJECT
    ? resolve(process.env.PIX_PROJECT)
    : process.cwd();
  controller = new MainController(initial, {
    async pickProject() {
      const r = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
      });
      return r.canceled ? undefined : r.filePaths[0];
    },
    async pickSession() {
      const r = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        filters: [{ name: "Pi session", extensions: ["jsonl"] }],
      });
      return r.canceled ? undefined : r.filePaths[0];
    },
    async confirm(message, detail) {
      const result = await dialog.showMessageBox(win, {
        type: "warning",
        message,
        detail,
        buttons: ["Cancel", "Continue"],
        defaultId: 0,
        cancelId: 0,
      });
      return result.response === 1;
    },
    async openExternal(url) {
      await openExternal(url);
    },
    quit() {
      app.quit();
    },
  });
  controller.onEvent((e) => win?.webContents.send("pix:event", e));
  ipcMain.handle(
    "pix:invoke",
    (_e: unknown, route: DesktopRoute, input: unknown) =>
      controller.invoke(route, input),
  );
  ipcMain.handle("pix:copy", (_e: unknown, text: string) =>
    clipboard.writeText(text),
  );
  await create();
});
app.on("before-quit", () => controller?.dispose());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void create();
});
