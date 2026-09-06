// Run after npx tsc -p tsconfig.test.json. Local synthetic data; no provider calls.
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { GraphFiles } from '../out-test/src/main/graph-files.js';
import { GraphSnapshotCache } from '../out-test/src/main/graph-snapshot.js';
import { projectSession } from '../out-test/src/shared/session.js';
import { sessionPatch } from '../out-test/src/shared/session-updates.js';

const entry = (id, parentId, role, text = id) => ({ type: 'message', id, parentId, timestamp: '2026-01-01', message: { role, content: [{ type: 'text', text }] } });
const source = entries => ({ session: { id: 's', path: 'main', messageCount: entries.length }, runtime: {}, entries,
  projection: projectSession(entries, entries.at(-1)?.id ?? null) });
const median = work => {
  work();
  const values = Array.from({ length: 7 }, () => { const start = performance.now(); work(); return performance.now() - start; });
  return +values.sort((a, b) => a - b)[3].toFixed(3);
};
const results = [];
for (const count of [1, 4, 8]) {
  const graph = new GraphFiles('benchmark-main');
  const main = source([entry('root', null, 'user'), entry('answer', 'root', 'assistant')]);
  const branches = new Map();
  for (let i = 0; i < count; i++) {
    const id = `branch${i}`, entries = [...main.entries];
    for (let turn = 0; turn < 250; turn++) entries.push(entry(`u${turn}`, turn ? `a${turn - 1}` : 'answer', 'user'),
      entry(`a${turn}`, `u${turn}`, 'assistant', 'Historical output. '.repeat(100)));
    graph.records.set(id, { id, parentId: 'main', forkEntryId: 'answer', inherited: { root: 'root', answer: 'answer' },
      baseline: main.entries, request: { text: id }, requestId: id, runId: id, status: 'idle' });
    branches.set(id, { snapshot: source(entries) });
  }
  const cache = new GraphSnapshotCache(); cache.update(graph, main, branches);
  let revision = 0;
  const view = () => ({ ...main, ...cache.view(main, new Set()), graph: { id: 'main', epoch: 'e', revision: ++revision, runs: [] } });
  const before = view();
  const worker = branches.get('branch0');
  const appended = [...worker.snapshot.entries, entry('new', 'a249', 'assistant', 'New output')];
  const fullProjectionMs = median(() => projectSession([...before.entries, { ...appended.at(-1), id: 'branch0:new', parentId: 'branch0:a249' }], main.projection.leafId));
  const changedBranchMs = median(() => { worker.snapshot = source(appended); cache.update(graph, main, branches); view(); });
  const next = view();
  const patch = sessionPatch(before, next);
  const fullBytes = Buffer.byteLength(JSON.stringify(next));
  const patchBytes = Buffer.byteLength(JSON.stringify(patch));
  results.push({ branches: count, turnsPerBranch: 250, fullProjectionMs, changedBranchMs,
    unchangedSnapshotMs: median(() => { cache.update(graph, main, branches); view(); }), fullBytes, patchBytes,
    reductionPercent: +(100 * (1 - patchBytes / fullBytes)).toFixed(2) });
}
const report = { results, note: 'Seven-sample medians after warmup. Full-projection reference excludes the old merge/decorate work; changed-branch timing includes SDK-style source projection and cached graph assembly. No IPC/Vue/DOM timing.' };
mkdirSync(new URL('../artifacts/', import.meta.url), { recursive: true });
writeFileSync(new URL('../artifacts/snapshot-benchmark.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
