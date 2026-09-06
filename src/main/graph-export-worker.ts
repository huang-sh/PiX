import { parentPort, workerData } from "node:worker_threads";
import { linkSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { GraphFiles, durableWrite, encodeSession, samePersistedValue, type BranchRecord, type SessionData } from "./graph-files.js";
import { PiRuntime } from "./pi-runtime.js";

async function run() {
  const { main, data, branches, leafId, outputPath, html } = workerData as {
    main: string; data: SessionData; branches: Array<{ record: BranchRecord; data: SessionData }>;
    leafId: string | null; outputPath: string; html: boolean;
  };
  // All inputs are cloned by worker_threads at dispatch. Never read a changing
  // live source or mutate the graph's files, locks, cursors, or runtime.
  const graph = new GraphFiles(main);
  const sources = new Map<string, SessionData>();
  for (const branch of branches) {
    graph.records.set(branch.record.id, branch.record);
    sources.set(branch.record.id, branch.data);
  }
  const result = graph.candidate(data, sources);
  const adapter = new PiRuntime(null, null, () => {}, async () => {});
  const pi = await adapter.pi();
  for (const { record, data: source } of branches) {
    const sourceLeaf = source.entries.at(-1)?.id;
    if (sourceLeaf && !samePersistedValue(pi.buildSessionContext(source.entries, sourceLeaf),
      pi.buildSessionContext(result.entries, graph.canonical(record, sourceLeaf))))
      throw new Error(`Export changed branch context: ${record.id}`);
  }
  if (!samePersistedValue(pi.buildSessionContext(data.entries, leafId), pi.buildSessionContext(result.entries, leafId)))
    throw new Error("Export changed main context");
  result.header = { ...result.header, id: randomUUID(), parentSession: main };
  const temp = mkdtempSync(join(dirname(outputPath), ".pix-export-"));
  try {
    const jsonl = join(temp, "tree.jsonl");
    durableWrite(jsonl, encodeSession(result));
    const manager = pi.SessionManager.open(jsonl);
    manager.getTree();
    if (leafId) manager.branch(leafId); else manager.resetLeaf();
    const source = html ? await adapter.exportSnapshotHtml(manager, join(temp, "tree.html")) : jsonl;
    // Exclusive installation also protects a destination created after dispatch.
    linkSync(source, outputPath);
    return { path: outputPath };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
void run().then(result => parentPort!.postMessage({ result }), error => parentPort!.postMessage({ error: String(error) }));
