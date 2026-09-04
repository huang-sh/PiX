import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MainController } from "./controller.js";
import type { DesktopRoute } from "../shared/types.js";
const dir = dirname(fileURLToPath(import.meta.url));
let win: any, controller: MainController;
let tray: Tray | undefined;
let isQuitting = false;
const zhUi = () => {
  const lang = controller.settings.bundle().app.language;
  return (
    lang === "zh-CN" ||
    (lang === "system" && app.getLocale().startsWith("zh"))
  );
};
// The tray icon only exists while it can be needed: it appears on the first
// close-to-tray hide and lives until quit (restore-from-tray keeps it, the
// way tray-native apps behave).
function ensureTray() {
  if (tray) return;
  const zh = zhUi();
  const icon = nativeImage
    .createFromPath(join(app.getAppPath(), "resources/icon.png"))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("PiX");
  const restore = () => {
    win?.show();
    win?.focus();
  };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: zh ? "显示 PiX" : "Show PiX", click: restore },
      { type: "separator" },
      { label: zh ? "退出 PiX" : "Quit PiX", click: () => void app.quit() },
    ]),
  );
  tray.on("click", restore);
  if (process.platform === "win32")
    tray.displayBalloon({
      title: "PiX",
      content: zh
        ? "PiX 已最小化到系统托盘，仍在后台运行。"
        : "PiX keeps running in the system tray.",
    });
}
async function openExternal(url: string) {
  const target = new URL(url);
  if (!["https:", "http:", "mailto:"].includes(target.protocol))
    throw new Error(`External protocol is not allowed: ${target.protocol}`);
  await shell.openExternal(target.href);
}
async function create() {
  const darwin = process.platform === "darwin";
  Menu.setApplicationMenu(
    // macOS dispatches editing shortcuts (Cmd+C/V/X/A) through the
    // application menu, so a null menu would disable them entirely.
    darwin
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
    frame: darwin,
    titleBarStyle: "hidden",
    // Windows/Linux draw overlay window controls into the page; the renderer
    // reserves their space via env(titlebar-area-*). macOS has no overlay, so
    // the native traffic lights sit over the hidden title bar — position them
    // inside the 40px custom titlebar and let the renderer pad around them
    // (env(titlebar-area-*) stays 0 there).
    ...(darwin
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : {
          titleBarOverlay: {
            color: "#eef2f1",
            symbolColor: "#17201e",
            height: 40,
          },
        }),
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
  // Belt-and-braces alongside the window-open denial: no link, drop, or
  // script may ever navigate the app window itself. The renderer intercepts
  // known link kinds; anything that still reaches a navigation attempt goes
  // through the same protocol-allowlisted external open (and is dropped for
  // non-web protocols such as file:).
  win.webContents.on("will-navigate", (event: Event, url: string) => {
    event.preventDefault();
    void openExternal(url).catch(() => {});
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
  // Close-to-tray (Windows/Linux): the X button hides the window instead of
  // destroying it, keeping the process alive. Real quits bypass this via the
  // isQuitting flag (before-quit fires before close events) or the tray
  // menu's Quit item. macOS keeps native behavior: the window closes and the
  // app stays in the dock.
  win.on("close", (e: { preventDefault(): void }) => {
    if (isQuitting || process.platform === "darwin") return;
    if (controller.settings.bundle().app.closeToTray === false) return;
    e.preventDefault();
    win.hide();
    ensureTray();
  });
  if (process.env.ELECTRON_RENDERER_URL)
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(dir, "../renderer/index.html"));
}
app.whenReady().then(async () => {
  // No implicit project: without an explicit PIX_PROJECT override the app
  // starts project-less and the welcome screen asks for one.
  const initial = process.env.PIX_PROJECT
    ? resolve(process.env.PIX_PROJECT)
    : null;
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
app.on("before-quit", () => {
  isQuitting = true;
  tray?.destroy();
  tray = undefined;
  controller?.dispose();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void create();
});
