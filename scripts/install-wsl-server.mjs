import { spawn } from "node:child_process";
import { resolve } from "node:path";

if (process.platform !== "win32") throw new Error("install-wsl-server requires Windows");
const index = process.argv.indexOf("--distro");
const root = resolve(import.meta.dirname, "..");
await new Promise((accept, reject) => {
  const child = spawn(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.server.json"], {
    cwd: root, windowsHide: true, stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`Server build exited ${code}`)));
});
const { WslHostClient } = await import("../server/dist/main/wsl-host-client.js");
const { ensureWslHostInstalled } = await import("../server/dist/main/ssh-host-installer.js");
const distro = index < 0 ? (await WslHostClient.names())[0] : process.argv[index + 1];
if (!distro) throw new Error("Select a WSL distribution with --distro NAME");
await ensureWslHostInstalled(distro, true, { onProgress: (stage) => console.log(`PiX: ${stage}`) });
console.log(JSON.stringify({ distro, current: `${await WslHostClient.home(distro)}/.pix/server/current/bin/pix-agent-host` }));
