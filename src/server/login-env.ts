import { spawn } from "node:child_process";

// The agent host is started by a non-interactive SSH/WSL command, so its PATH
// never picks up profile or rc initializations (nvm, conda, ~/.local/bin,
// /opt/...). Resolving the interactive login shell's PATH once at startup and
// merging it in lets every spawned child — including the agent's bash tool,
// which inherits process.env — see those binaries.
export function mergePath(current: string, login: string) {
  const merged: string[] = [];
  for (const entry of `${login}:${current}`.split(":"))
    if (entry && !merged.includes(entry)) merged.push(entry);
  return merged.join(":");
}

// Interactive shells may greet or warn on stdout; keep the last line that
// actually looks like a PATH so decorations cannot corrupt the merge.
export function parseLoginPath(output: string) {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--)
    if (/^\/[\w:./-]*$/u.test(lines[index]!)) return lines[index]!;
  return "";
}

function probeLoginPath(shell: string, timeoutMs: number): Promise<string> {
  return new Promise((accept) => {
    const child = spawn(shell, ["-ilc", "printenv PATH"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      accept("");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.once("error", () => {
      clearTimeout(timer);
      accept("");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      accept(code === 0 ? output : "");
    });
  });
}

export async function enrichLoginPath(timeoutMs = 3_000) {
  if (process.platform === "win32") return;
  const shells = [
    ...new Set([process.env.SHELL || "/bin/bash", "/bin/bash"]),
  ];
  for (const shell of shells) {
    const loginPath = parseLoginPath(await probeLoginPath(shell, timeoutMs));
    if (!loginPath) continue;
    process.env.PATH = mergePath(process.env.PATH ?? "", loginPath);
    return;
  }
}
