import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)),
  workspace = join(root, "test-workspace"),
  fixtureDir = join(workspace, ".pi", "sessions"),
  dir = mkdtempSync(join(tmpdir(), "pix-pi-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
function findPi() {
  const candidates = [
    process.env.PI_BINARY,
    join(root, "vendor", "pi", "pi"),
    join(root, "vendor", "pi", "bin", "pi"),
    join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "pi.cmd" : "pi",
    ),
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) {
        const v = walk(p);
        if (v) return v;
      } else if (n.name === "pi") return p;
    }
  };
  return walk(join(root, "vendor", "pi"));
}
const bin = findPi();
if (!bin) throw new Error("Pi v0.84.4 binary not found");
const files = readdirSync(fixtureDir).filter((n) => n.endsWith(".jsonl"));
for (const file of files) {
  const lines = readFileSync(join(fixtureDir, file), "utf8").split("\n"),
    header = JSON.parse(lines[0]);
  header.cwd = workspace;
  lines[0] = JSON.stringify(header);
  writeFileSync(join(dir, file), lines.join("\n"));
}
async function request(file) {
  const shim = process.platform === "win32" && bin.endsWith(".cmd");
  const child = spawn(
    shim ? process.execPath : bin,
    [
      ...(shim
        ? [
            join(
              root,
              "node_modules",
              "@earendil-works",
              "pi-coding-agent",
              "dist",
              "bundle",
              "cli.js",
            ),
          ]
        : []),
      "--mode",
      "rpc",
      "--offline",
      "--no-approve",
      "--session",
      join(dir, file),
      "--session-dir",
      dir,
    ],
    {
      cwd: workspace,
      env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buffer = "",
    stderr = "",
    id = 0;
  child.stderr.on("data", (x) => (stderr += String(x)));
  const pending = new Map();
  child.stdout.on("data", (x) => {
    buffer += String(x);
    for (;;) {
      const i = buffer.indexOf("\n");
      if (i < 0) break;
      const line = buffer.slice(0, i).replace(/\r$/, "");
      buffer = buffer.slice(i + 1);
      try {
        const v = JSON.parse(line);
        if (v.type === "response" && v.id && pending.has(v.id)) {
          pending.get(v.id)(v);
          pending.delete(v.id);
        }
      } catch {}
    }
  });
  const send = (type) =>
    new Promise((ok, fail) => {
      const req = `pix_${++id}`,
        timer = setTimeout(() => {
          pending.delete(req);
          fail(new Error(`Pi RPC timeout: ${type}\n${stderr}`));
        }, 15000);
      pending.set(req, (v) => {
        clearTimeout(timer);
        v.success ? ok(v.data) : fail(new Error(v.error));
      });
      child.stdin.write(JSON.stringify({ id: req, type }) + "\n");
    });
  try {
    const entries = await send("get_entries"),
      tree = await send("get_tree");
    if (!entries.entries?.length || !tree.tree?.length)
      throw new Error(`${file}: Pi returned an empty session`);
    return {
      file,
      entries: entries.entries.length,
      roots: tree.tree.length,
      leafId: entries.leafId,
    };
  } finally {
    child.kill("SIGTERM");
  }
}
const results = [];
for (const f of files) results.push(await request(f));
mkdirSync(join(root, "artifacts"), { recursive: true });
writeFileSync(
  join(root, "artifacts", "pi-session-test.json"),
  JSON.stringify({ binary: bin, version: "0.84.4", results }, null, 2) + "\n",
);
console.log(JSON.stringify(results, null, 2));
