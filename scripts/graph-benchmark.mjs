// Run after: npx tsc -p tsconfig.test.json
import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { projectSession, projectSessionBranch } from "../out-test/src/shared/session.js";
import { layoutGraph } from "../out-test/src/renderer/graph-layout.js";

function entries(turns) {
  return Array.from({ length: turns }, (_, i) => [
    { type: "message", id: `u${i}`, parentId: i ? `a${i - 1}` : null, timestamp: "2026-01-01", message: { role: "user", content: "prompt" } },
    { type: "message", id: `a${i}`, parentId: `u${i}`, timestamp: "2026-01-01", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ]).flat();
}
function median(fn) {
  fn();
  const samples = Array.from({ length: 5 }, () => { const start = performance.now(); fn(); return performance.now() - start; });
  return Number(samples.sort((a, b) => a - b)[2].toFixed(2));
}
const results = [100, 500, 1000, 2000, 10000].map(turns => {
  const data = entries(turns), leaf = `a${turns - 1}`, projection = projectSession(data, leaf);
  return { turns, projectionMs: median(() => projectSession(data, leaf)), layoutMs: median(() => layoutGraph(projection)) };
});
const sessions = Array.from({ length: 8 }, () => entries(500));
const wide = Array.from({ length: 10000 }, (_, i) => [
  { type: "message", id: `u${i}`, parentId: null, timestamp: "2026-01-01", message: { role: "user", content: "prompt" } },
  { type: "message", id: `a${i}`, parentId: `u${i}`, timestamp: "2026-01-01", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
]).flat();
const report = { selectedBranchIn10000Ms: median(() => projectSessionBranch(wide, "a9999")), node: process.version, results,
  eightSessionsMs: median(() => sessions.forEach(data => projectSession(data, "a499"))),
  note: "Synthetic chain; five-sample medians after warmup. Excludes IPC, Vue/DOM, SDK startup and export IO." };
mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
writeFileSync(new URL("../artifacts/graph-benchmark.json", import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
