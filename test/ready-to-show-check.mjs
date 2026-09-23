// Regression check for electron/electron#54025: `ready-to-show` must fire for
// a `show: false` window with `titleBarOverlay` (PiX's exact window shape).
// Broken in electron 44.4.0–44.4.3 on Windows/Linux; fixed in 44.4.4 (#54118).
// Run against the installed electron: npx electron test/ready-to-show-check.mjs
import { app, BrowserWindow } from "electron";

const TIMEOUT = 6000;
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#000000", symbolColor: "#ffffff", height: 40 },
    webPreferences: { sandbox: true },
  });
  let readyToShow = false;
  let didFinish = false;
  win.once("ready-to-show", () => {
    readyToShow = true;
    win.show();
  });
  win.webContents.once("did-finish-load", () => {
    didFinish = true;
  });
  win.loadURL("data:text/html,<h1>ready-to-show repro</h1>");
  setTimeout(() => {
    console.log(
      `RESULT ready-to-show=${readyToShow} did-finish-load=${didFinish} ` +
        `visible=${win.isVisible()} electron=${process.versions.electron} ` +
        `chromium=${process.versions.chrome}`,
    );
    // did-finish-load firing while ready-to-show does not is exactly the
    // "alive but invisible" signature; fail on either missing piece.
    app.exit(readyToShow && didFinish && win.isVisible() ? 0 : 1);
  }, TIMEOUT);
});
