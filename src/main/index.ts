import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
} from "electron";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MainController } from "./controller.js";
import { pixHome } from "./paths.js";
import { bootstrapPixProfile } from "./services.js";
import type { DesktopRoute } from "../shared/types.js";
import { normalizeTheme, resolveTheme, themeColors, type ThemePreference } from "../shared/theme.js";
const dir = dirname(fileURLToPath(import.meta.url));
let win: any, controller: MainController;
let tray: Tray | undefined;
let isQuitting = false;
let currentTheme: ThemePreference = "light";
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
function windowColors() {
  currentTheme = normalizeTheme(controller.settings.bundle().app.theme);
  return themeColors[resolveTheme(currentTheme, nativeTheme.shouldUseDarkColors)];
}
function syncWindowTheme() {
  const colors = windowColors();
  if (!win || win.isDestroyed()) return;
  win.setBackgroundColor(colors.surface);
  if (process.platform !== "darwin")
    win.setTitleBarOverlay({ color: colors.background, symbolColor: colors.text });
}
async function create() {
  const darwin = process.platform === "darwin";
  const colors = windowColors();
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
    backgroundColor: colors.surface,
    show: false,
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
            color: colors.background,
            symbolColor: colors.text,
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
  win.once("ready-to-show", () => win.show());
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
    // A navigation to the page's own URL is the app reloading itself (vite
    // HMR full-reload in dev); it must proceed in-place, not be handed to
    // the OS browser as if it were an external link.
    if (url === win.webContents.getURL()) return;
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
  bootstrapPixProfile(pixHome());
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
    showItemInFolder(path) {
      if (!existsSync(path)) throw new Error("Session file was not found or is inaccessible");
      shell.showItemInFolder(path);
    },
    quit() {
      app.quit();
    },
  });
  controller.onEvent((e) => win?.webContents.send("pix:event", e), true);
  nativeTheme.on("updated", syncWindowTheme);
  // Preload needs the current preference before the first paint, including on reload.
  // This one synchronous handshake reads memory only; all persistence stays async over IPC.
  ipcMain.on("pix:initial-theme", (event) => { event.returnValue = currentTheme; });
  ipcMain.handle(
    "pix:invoke",
    async (_e: unknown, route: DesktopRoute, input: unknown) => {
      let result: unknown;
      try {
        result = await controller.invoke(route, input);
      } catch (error) {
        // Answering with the failure keeps Electron from re-wrapping the
        // message as "Error invoking remote method 'pix:invoke': ...". The
        // renderer turns this back into an Error; log it here for parity with
        // the rejection Electron used to report.
        console.error(`[pix:invoke] ${route}:`, error instanceof Error ? error.message : error);
        return {
          ok: false as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      // Theme sync is aftermath of a successful update, not part of the
      // invoke: a failure here must not turn the reply into a rejected one.
      if (route === "settings.update" || route === "settings.reset")
        try { syncWindowTheme(); } catch (error) { console.error("[pix:invoke] theme sync:", error); }
      return { ok: true as const, result };
    },
  );
  ipcMain.handle("pix:copy", (_e: unknown, text: string) =>
    clipboard.writeText(text),
  );
  await create();
});
let sessionsClosed = false;
let closingSessions = false;
app.on("before-quit", (event) => {
  isQuitting = true;
  if (!sessionsClosed && controller) {
    event.preventDefault();
    if (!closingSessions) {
      closingSessions = true;
      void controller.pi.close().finally(() => { sessionsClosed = true; app.quit(); }).catch(() => {});
    }
    return;
  }
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
