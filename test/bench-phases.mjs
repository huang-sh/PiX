// Phase-level timing of the stored-session open path. No src edits: wraps prototypes.
// Usage: node test/bench-phases.mjs <abs-session-jsonl>
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as gf from "../out-test/src/main/graph-files.js";
import { GraphRuntime } from "../out-test/src/main/graph-runtime.js";

const file = process.argv[2];
const home = mkdtempSync(join(tmpdir(), "pix-bench-home-"));
process.env.PIX_HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");

const phases = new Map();
const wrap = (obj, name, label) => {
  const orig = obj[name];
  obj[name] = async function (...args) {
    const t = performance.now();
    try { return await orig.apply(this, args); }
    finally { phases.set(label, (phases.get(label) ?? 0) + performance.now() - t); }
  };
};
const GraphFiles = gf.GraphFiles.prototype;
wrap(GraphFiles, "load", "graph.load (origin parse+validate)");
wrap(GraphFiles, "acquire", "graph.acquire (lock)");
wrap(GraphFiles, "countMainLines", "countMainLines");
wrap(GraphFiles, "readBranch", "readBranch (hydration parse)");
const rt = GraphRuntime.prototype;
wrap(rt, "openAt", "openAt (SDK session runtime)");

let events = 0;
const runtime = new GraphRuntime(home, join(file, ".."), () => { events++; }, async () => {});
runtime["sessionServicesOptions"] = (pi, cwd) => ({
  cwd, agentDir: home, settingsManager: pi.SettingsManager.inMemory({}),
  resourceLoaderOptions: { additionalExtensionPaths: [], noExtensions: true },
});

const t0 = performance.now();
const snapshot = await runtime.open(file);
const openMs = performance.now() - t0;
const tSnap = performance.now();
runtime.snapshot();
const snapMs = performance.now() - tSnap;

let last = events, lastChange = performance.now();
while (performance.now() - lastChange < 1500 && performance.now() - t0 < 180000) {
  await new Promise(r => setTimeout(r, 200));
  if (events !== last) { last = events; lastChange = performance.now(); }
}
const tClose = performance.now();
await runtime.close();
const closeMs = performance.now() - tClose;

const sdkParse = openMs - [...phases.entries()].reduce((a, [, v]) => a + v, 0);
console.log("open(total)              ", Math.round(openMs), "ms");
for (const [k, v] of phases) console.log("  ", k.padEnd(36), Math.round(v), "ms");
console.log("   ", "(unattributed: SDK main parse + snapshot build)".padEnd(36), Math.round(sdkParse), "ms");
console.log("snapshot() after open    ", Math.round(snapMs), "ms");
console.log("hydration settle         ", Math.round(performance.now() - t0 - closeMs), "ms  (notify events:", events + ")");
console.log("close                    ", Math.round(closeMs), "ms");
process.exit(0);
