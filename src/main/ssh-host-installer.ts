import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RemoteConnectStage } from "../shared/types.js";
import {
  PIX_HOST_VERSION,
  PIX_REMOTE_PROTOCOL,
} from "../shared/remote-protocol.js";

export interface RemoteConnectOptions {
  signal?: AbortSignal;
  onProgress?: (stage: RemoteConnectStage) => void;
}

export function validateSshHost(host: string) {
  if (!/^[a-z0-9_.@:-]+$/iu.test(host) || host.startsWith("-"))
    throw new Error("SSH host must be a host name, SSH config alias, or user@host");
  return host;
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * What gets copied from the local server bundle to the remote staging
 * directory. Skills ship as a sibling of the server bundle (repo/skills in
 * dev runs, resources/skills in the packaged app) so remote hosts load the
 * same built-in skills via src/main/builtin-skills.ts (server/dist/main ->
 * ../../skills).
 */
const HOST_BUNDLE_ENTRIES = ["dist", "bin", "package.json", "package-lock.json", "../skills"];

export function sshProjectPath(cwd: string) {
  if (
    /[\r\n]/u.test(cwd) ||
    (cwd !== "~" && !cwd.startsWith("~/") && !cwd.startsWith("/"))
  )
    throw new Error("SSH project path must be ~, ~/path, or an absolute Linux path");
  if (cwd === "~") return '"$HOME"';
  if (cwd.startsWith("~/")) return `"$HOME"/${quote(cwd.slice(2))}`;
  return quote(cwd);
}

export function parseSshHosts(config: string) {
  const hosts = new Set<string>();
  for (const line of config.split(/\r?\n/u)) {
    const match = /^\s*Host\s+(.+?)\s*(?:#.*)?$/iu.exec(line);
    if (!match) continue;
    for (const host of match[1]!.split(/\s+/u)) {
      if (!host || /[*!?]/u.test(host)) continue;
      try {
        hosts.add(validateSshHost(host));
      } catch {}
    }
  }
  return [...hosts].sort((a, b) => a.localeCompare(b));
}

export function listSshHosts() {
  try {
    return parseSshHosts(
      readFileSync(resolve(homedir(), ".ssh", "config"), "utf8"),
    );
  } catch {
    return [];
  }
}

function run(
  command: string,
  args: string[],
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `${command} timed out while running ${String(args.at(-1)).slice(0, 100)}`,
        ),
      );
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) accept(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

const sshArgs = (host: string, command: string) => [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  host,
  command,
];

export async function ensureSshHostInstalled(hostInput: string, force = false, options: RemoteConnectOptions = {}) {
  const host = validateSshHost(hostInput);
  return ensureHostInstalled({
    exec: (command, timeoutMs) => run("ssh", sshArgs(host, command), timeoutMs, options.signal),
    upload: async (source, stage) => {
      await run("scp", ["-r", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
        ...HOST_BUNDLE_ENTRIES.map((path) => resolve(source, path)),
        `${host}:${stage}/`], 120_000, options.signal);
    },
  }, force, options);
}

export async function ensureWslHostInstalled(distro: string, force = false, options: RemoteConnectOptions = {}) {
  if (!distro || distro.startsWith("-") || /[\r\n\0]/u.test(distro)) throw new Error("Select a WSL distribution");
  const wsl = (args: string[], timeoutMs?: number) =>
    run("wsl.exe", ["-d", distro, "--exec", ...args], timeoutMs, options.signal);
  return ensureHostInstalled({
    exec: (command, timeoutMs) => wsl(["sh", "-lc", command], timeoutMs),
    upload: async (source, stage) => {
      const linuxSource = await wsl(["wslpath", "-a", "-u", source]);
      await wsl(["cp", "-R", ...HOST_BUNDLE_ENTRIES.map((path) => `${linuxSource}/${path}`), `${stage}/`]);
    },
  }, force, options);
}

async function ensureHostInstalled(transport: {
  exec(command: string, timeoutMs?: number): Promise<string>;
  upload(source: string, stage: string): Promise<void>;
}, force: boolean, options: RemoteConnectOptions) {
  const { signal, onProgress } = options;
  const { exec } = transport;
  signal?.throwIfAborted();
  onProgress?.("checking");
  if (!force) try {
    const output = await exec(
      'test -x "$HOME/.pix/server/current/bin/pix-agent-host" && "$HOME/.pix/server/current/bin/pix-agent-host" version',
      30_000,
    );
    const version = JSON.parse(output) as { version?: string; protocol?: number };
    if (
      version.version === PIX_HOST_VERSION &&
      version.protocol === PIX_REMOTE_PROTOCOL
    )
      return;
  } catch (error) {
    signal?.throwIfAborted();
    // Authentication and network failures will not be fixed by installing a host.
    if (/permission denied(?: \([^\r\n)]+\)|, please try again)|host key verification|could not resolve|connection (?:refused|timed out)|no route to host/iu.test(String(error)))
      throw error;
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const source = [
    resolve(moduleDir, "../../server"),
    resolve(moduleDir, "../../../server"),
    resolve(process.cwd(), "server"),
  ].find((candidate) => existsSync(resolve(candidate, "package.json")));
  if (!source) throw new Error("PiX server bundle could not be located");
  for (const path of [
    resolve(source, "dist"),
    resolve(source, "bin/pix-agent-host"),
    resolve(source, "bin/install-host"),
    resolve(source, "bin/check-runtime.mjs"),
    resolve(source, "package.json"),
    resolve(source, "package-lock.json"),
    resolve(source, "..", "skills"),
  ]) {
    if (!existsSync(path))
      throw new Error(`PiX server bundle is missing: ${path}`);
  }

  const home = await exec('printf %s "$HOME"', 30_000);
  if (!home.startsWith("/") || /[\r\n\0]/u.test(home)) throw new Error("Invalid remote home directory");
  const root = `${home}/.pix/server`;
  const target = `${root}/versions/${PIX_HOST_VERSION}-${Date.now()}`;
  const stage = await exec(
    `mkdir -p ${quote(root)} ${quote(`${root}/versions`)} && mktemp -d ${quote(`${root}/.install-XXXXXX`)}`,
  );
  if (!stage.startsWith(`${root}/.install-`) || /[\r\n\0]/u.test(stage) || stage.slice(root.length + 1).includes("/"))
    throw new Error("Invalid remote staging directory");

  try {
    onProgress?.("upload");
    await transport.upload(source, stage);
    onProgress?.("install");
    await exec(
      `sh ${quote(`${stage}/bin/install-host`)} ${quote(root)} ${quote(stage)} ${quote(target)}`,
      300_000,
    );
  } catch (error) {
    // A cancelled SSH command may still be winding down remotely. Leave its
    // unique staging directory alone rather than racing it with a deletion.
    // Preserve the stage on timeout too: a remote npm process may still own it.
    if (!signal?.aborted && !/timed out/iu.test(String(error)))
      await exec(`rm -rf -- ${quote(stage)}`, 5_000).catch(() => undefined);
    throw error;
  }
}
