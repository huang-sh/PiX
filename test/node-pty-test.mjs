import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawn } from "node-pty";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const win = process.platform === "win32";
const terminal = spawn(
  win ? "powershell.exe" : process.env.SHELL || "/bin/bash",
  win ? ["-NoLogo", "-NoProfile"] : [],
  {
    name: "xterm-256color",
    cwd: root,
    cols: 80,
    rows: 24,
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry) => entry[1] !== undefined),
    ),
    ...(win ? { useConpty: true } : {}),
  },
);
await new Promise((resolve, reject) => {
  let output = "";
  const timeout = setTimeout(() => {
    terminal.kill();
    reject(new Error("PTY output timed out"));
  }, 5_000);
  terminal.onData((data) => {
    output += data;
    if (!output.includes("pix-node-pty")) return;
    clearTimeout(timeout);
    terminal.kill();
    resolve();
  });
  terminal.write(
    win ? "Write-Output pix-node-pty\r" : "printf 'pix-node-pty\\n'\r",
  );
});
process.stdout.write("PTY passed\n");
process.exit(0);
