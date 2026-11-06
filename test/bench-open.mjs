// Local benchmark: time the stored-session open path for one real session.
// Usage: node test/bench-open.mjs <abs-session-jsonl>
// Run after `tsc -p tsconfig.test.json`; never touches the live .pi tree.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { GraphRuntime } from "../out-test/src/main/graph-runtime.js";

const file = process.argv[2];
if (!file) { console.error("usage: node test/bench-open.mjs <session.jsonl>"); process.exit(2); }
const sessionsDir = join(file, "..");

const home = mkdtempSync(join(tmpdir(), "pix-bench-home-"));
process.env.PIX_HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");

let events = 0;
const runtime = new GraphRuntime(home, sessionsDir, () => { events++; }, async () => {});
runtime["sessionServicesOptions"] = (pi, cwd) => ({
  cwd, agentDir: home, settingsManager: pi.SettingsManager.inMemory({}),
  resourceLoaderOptions: { additionalExtensionPaths: [], noExtensions: true },
});

const t0 = performance.now();
const snapshot = await runtime.open(file);
const wire = JSON.stringify(snapshot).length;
console.log(JSON.stringify({ phase: "open", ms: Math.round(performance.now() - t0), wireBytes: wire,
  entries: snapshot.entries.length, nodes: snapshot.projection.nodes.length, notifyEvents: events }));

// Wait for the background branch-hydration stream to go quiet (or 3 min).
let last = events, lastChange = performance.now();
while (performance.now() - lastChange < 1500 && performance.now() - t0 < 180000) {
  await new Promise(r => setTimeout(r, 200));
  if (events !== last) { last = events; lastChange = performance.now(); }
}
const snap2 = runtime.snapshot();
console.log(JSON.stringify({ phase: "settled", ms: Math.round(performance.now() - t0), notifyEvents: events,
  entries: snap2.entries.length, nodes: snap2.projection.nodes.length, wireBytes: JSON.stringify(snap2).length }));

// Warm switch: what a switch-away-and-back costs while the runtime stays alive.
const tSnap = performance.now();
const snap3 = runtime.snapshot();
console.log(JSON.stringify({ phase: "warm-switch-snapshot", ms: Math.round(performance.now() - tSnap),
  entries: snap3.entries.length, wireBytes: JSON.stringify(snap3).length }));

await runtime.close();
process.exit(0);
