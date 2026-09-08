import { join } from "node:path";

// The darwin electron package ships Electron.app with no plain dist/electron
// binary (see electron's install.js executablePath switch).
export function electronBinary(root) {
  const segments =
    process.platform === "win32"
      ? ["electron.exe"]
      : process.platform === "darwin"
        ? ["Electron.app", "Contents", "MacOS", "Electron"]
        : ["electron"];
  return join(root, "node_modules", "electron", "dist", ...segments);
}
