import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

if (process.platform !== "win32") {
  console.error("install-wsl-server requires Windows: wsl.exe drives the WSL host.");
  process.exit(1);
}

const distroIndex = process.argv.indexOf("--distro");
const distro = distroIndex < 0 ? undefined : process.argv[distroIndex + 1];
const root = resolve(import.meta.dirname, "..");
const app = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const buildId = `${app.version}-dev-${Date.now()}`;

const run = (command, args, options = {}) =>
  new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      windowsHide: true,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? accept(stdout.trim())
        : reject(
            new Error(
              `${command} exited with ${code ?? "unknown"}: ${stderr.trim()}`,
            ),
          ),
    );
  });

const wslArgs = (...args) => [
  ...(distro ? ["-d", distro] : []),
  "--exec",
  ...args,
];
const wsl = (args, capture = false) =>
  run("wsl.exe", wslArgs(...args), { capture });

await run(process.execPath, [
  resolve(root, "node_modules", "typescript", "bin", "tsc"),
  "-p",
  resolve(root, "tsconfig.server.json"),
]);
const home = await wsl(["sh", "-lc", 'printf %s "$HOME"'], true);
const source = await wsl(["wslpath", "-a", "-u", resolve(root, "server")], true);
const machine = await wsl(["uname", "-m"], true);
const arch = machine === "x86_64" ? "x64" : machine === "aarch64" ? "arm64" : "";
if (!arch) throw new Error(`Unsupported WSL architecture: ${machine}`);

const nodeVersion = process.versions.node;
const serverRoot = `${home}/.pix/server`;
const runtime = `${serverRoot}/runtime/node-v${nodeVersion}-linux-${arch}`;
const node = `${runtime}/bin/node`;
const npm = `${runtime}/lib/node_modules/npm/bin/npm-cli.js`;
const target = `${serverRoot}/versions/${buildId}`;

try {
  await wsl(["test", "-x", node]);
} catch {
  process.stdout.write(`Installing Node ${nodeVersion} for WSL ${machine}...\n`);
  const installNode = String.raw`
set -eu
runtime=$1
version=$2
arch=$3
parent=$(dirname "$runtime")
mkdir -p "$parent"
tmp=$(mktemp -d "$parent/.node-install-XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
file="node-v"$version"-linux-"$arch".tar.xz"
base="https://nodejs.org/dist/v"$version
cache=$(dirname "$parent")/cache
mkdir -p "$cache"
curl -fL --retry 3 -C - "$base/$file" -o "$cache/$file"
curl -fsSL "$base/SHASUMS256.txt" -o "$cache/SHASUMS256.txt"
(cd "$cache" && grep "  $file$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "$cache/$file" -C "$tmp"
mv "$tmp/node-v"$version"-linux-"$arch "$runtime"
`;
  await wsl(["sh", "-lc", installNode, "sh", runtime, nodeVersion, arch]);
}

const stage = await wsl(
  [
    "sh",
    "-lc",
    'mkdir -p "$1/versions"; mktemp -d "$1/.install-XXXXXX"',
    "sh",
    serverRoot,
  ],
  true,
);
await wsl(["cp", "-R", `${source}/dist`, `${stage}/dist`]);
await wsl(["cp", `${source}/package.json`, `${source}/package-lock.json`, stage]);
await wsl(["mkdir", "-p", `${stage}/bin`]);
await wsl(["cp", `${source}/bin/pix-agent-host`, `${stage}/bin/pix-agent-host`]);
await wsl(["chmod", "700", `${stage}/bin/pix-agent-host`]);
await wsl(["ln", "-s", runtime, `${stage}/node`]);
await wsl([
  "env",
  `PATH=${runtime}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  node,
  npm,
  "ci",
  "--prefix",
  stage,
  "--omit=dev",
  "--no-audit",
  "--no-fund",
]);
await wsl(["mv", stage, target]);
await wsl(["ln", "-sfn", target, `${serverRoot}/current`]);

process.stdout.write(
  `${JSON.stringify({
    distro: distro ?? "default",
    buildId,
    executable: `${target}/bin/pix-agent-host`,
    current: `${serverRoot}/current/bin/pix-agent-host`,
  })}\n`,
);
