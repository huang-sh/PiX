import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { electronBinary } from "./lib/electron-binary.mjs";

const file = fileURLToPath(import.meta.url);
const root = dirname(dirname(file));

if (!process.versions.electron) {
  const electron = electronBinary(root);
  const result = spawnSync(electron, [file], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
  });
  // status is null when the binary could not be launched at all (e.g. the
  // electron dist was never downloaded because its postinstall was skipped).
  if (result.error)
    throw new Error(`Failed to launch ${electron}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `Electron PTY test exited with code ${result.status ?? "unknown"}\n${result.stderr || result.stdout}`,
    );
  process.stdout.write(result.stdout);
} else {
  const { spawn } = await import("node-pty");
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
      reject(new Error("Electron PTY output timed out"));
    }, 5_000);
    terminal.onData((data) => {
      output += data;
      if (!output.includes("pix-electron-pty")) return;
      clearTimeout(timeout);
      terminal.kill();
      resolve();
    });
    terminal.write(
      win
        ? "Write-Output pix-electron-pty\r"
        : "printf 'pix-electron-pty\\n'\r",
    );
  });
  process.stdout.write("Electron PTY passed\n");
  // Killed PTYs can surface teardown errors after the script body finishes
  // and flip the exit code; the test has passed, so exit deterministically.
  process.exit(0);
}
