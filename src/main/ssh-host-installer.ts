import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PIX_HOST_VERSION,
  PIX_REMOTE_PROTOCOL,
} from "../shared/remote-protocol.js";

export function validateSshHost(host: string) {
  if (!/^[a-z0-9_.@:-]+$/iu.test(host) || host.startsWith("-"))
    throw new Error("SSH host must be a host name, SSH config alias, or user@host");
  return host;
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

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
): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
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
    child.once("exit", (code) => {
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

const ssh = (host: string, command: string, timeoutMs?: number) =>
  run("ssh", sshArgs(host, command), timeoutMs);

export async function ensureSshHostInstalled(hostInput: string, force = false) {
  const host = validateSshHost(hostInput);
  if (!force) try {
    const output = await ssh(
      host,
      'test -x "$HOME/.pix/server/current/bin/pix-agent-host" && "$HOME/.pix/server/current/bin/pix-agent-host" version',
      30_000,
    );
    const version = JSON.parse(output) as { version?: string; protocol?: number };
    if (
      version.version === PIX_HOST_VERSION &&
      version.protocol === PIX_REMOTE_PROTOCOL
    )
      return;
  } catch {}

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
    resolve(source, "package.json"),
    resolve(source, "package-lock.json"),
  ]) {
    if (!existsSync(path))
      throw new Error(`PiX server bundle is missing: ${path}`);
  }

  const system = (
    await ssh(host, 'printf "%s\\n" "$HOME"; uname -m', 30_000)
  ).split(/\r?\n/u);
  const home = system[0] ?? "";
  const machine = system[1] ?? "";
  const arch = machine === "x86_64" ? "x64" : machine === "aarch64" ? "arm64" : "";
  if (!arch) throw new Error(`Unsupported SSH host architecture: ${machine}`);

  const nodeVersion = process.versions.node;
  const root = `${home}/.pix/server`;
  const runtime = `${root}/runtime/node-v${nodeVersion}-linux-${arch}`;
  const node = `${runtime}/bin/node`;
  const npm = `${runtime}/lib/node_modules/npm/bin/npm-cli.js`;
  const target = `${root}/versions/${PIX_HOST_VERSION}-${Date.now()}`;
  const stage = await ssh(
    host,
    `mkdir -p ${quote(root)} ${quote(`${root}/versions`)} && mktemp -d ${quote(`${root}/.install-XXXXXX`)}`,
  );

  try {
    const hasNode =
      (await ssh(
        host,
        `if test -x ${quote(node)}; then printf yes; else printf no; fi`,
        30_000,
      )) === "yes";
    if (!hasNode) {
      const installNode = `
set -eu
runtime=$1
version=$2
arch=$3
parent=$(dirname "$runtime")
mkdir -p "$parent"
tmp=$(mktemp -d "$parent/.node-install-XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
file="node-v$version-linux-$arch.tar.xz"
base="https://nodejs.org/dist/v$version"
cache=$(dirname "$parent")/cache
mkdir -p "$cache"
curl -fsSL "$base/SHASUMS256.txt" -o "$cache/SHASUMS256.txt"
if ! (cd "$cache" && grep "  $file$" SHASUMS256.txt | sha256sum -c - >/dev/null 2>&1); then
  rm -f "$cache/$file"
  curl -fL --retry 3 "$base/$file" -o "$cache/$file"
fi
(cd "$cache" && grep "  $file$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "$cache/$file" -C "$tmp"
mv "$tmp/node-v$version-linux-$arch" "$runtime"
`;
      await ssh(
        host,
        `sh -lc ${quote(installNode)} sh ${quote(runtime)} ${quote(nodeVersion)} ${quote(arch)}`,
        300_000,
      );
    }
    await run("scp", ["-r", resolve(source, "dist"), `${host}:${stage}/dist`]);
    await run("scp", [
      resolve(source, "package.json"),
      resolve(source, "package-lock.json"),
      `${host}:${stage}/`,
    ]);
    await ssh(host, `mkdir -p ${quote(`${stage}/bin`)}`);
    await run("scp", [
      resolve(source, "bin/pix-agent-host"),
      `${host}:${stage}/bin/pix-agent-host`,
    ]);
    await ssh(
      host,
      [
        "set -eu",
        `chmod 700 ${quote(`${stage}/bin/pix-agent-host`)}`,
        `ln -s ${quote(runtime)} ${quote(`${stage}/node`)}`,
        `PATH=${quote(`${runtime}/bin`)}:"$PATH" ${quote(node)} ${quote(npm)} ci --prefix ${quote(stage)} --omit=dev --no-audit --no-fund`,
        `mv ${quote(stage)} ${quote(target)}`,
        `ln -sfn ${quote(target)} ${quote(`${root}/current`)}`,
      ].join("; "),
      300_000,
    );
  } catch (error) {
    await ssh(host, `rm -rf -- ${quote(stage)}`).catch(() => undefined);
    throw error;
  }
}
