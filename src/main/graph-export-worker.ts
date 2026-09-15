import { parentPort, workerData } from "node:worker_threads";
import { linkSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { GraphFiles, durableWrite, encodeSession, parseStrict, samePersistedValue, type BranchRecord, type SessionData } from "./graph-files.js";
import { PiRuntime } from "./pi-runtime.js";
import type { RawSessionEntry } from "../shared/types.js";

async function run() {
  const { main, data, branches, leafId, outputPath, html, targetLeafId } = workerData as {
    main: string; data: SessionData; branches: Array<{ record: BranchRecord; data: SessionData }>;
    leafId: string | null; outputPath: string; html: boolean; targetLeafId?: string | null;
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
  let exported = result;
  if (targetLeafId != null) {
    // Branch export keeps only the root-to-leaf path: the selected node becomes
    // the new session's tip, and every entry after it stays in the original graph.
    const byId = new Map(result.entries.map(entry => [entry.id, entry]));
    const path: RawSessionEntry[] = [];
    const seen = new Set<string>();
    for (let cursor: string | null = targetLeafId; cursor && !seen.has(cursor); ) {
      seen.add(cursor);
      const entry = byId.get(cursor);
      if (!entry) throw new Error(`Export target is missing from the graph: ${targetLeafId}`);
      path.push(entry);
      cursor = entry.parentId;
    }
    exported = { header: result.header, entries: path.reverse() };
    // A path entry can reference the past that left with its branch: a label may
    // name an entry on an abandoned sibling. Strict validation fails closed on
    // such a dangling target — no file is produced, sources stay intact. If this
    // ever blocks real sessions, prune those labels with deleteNode's reparent
    // pattern; a compaction's firstKeptEntryId must keep failing, because
    // dropping a retained compaction changes context.
    parseStrict(encodeSession(exported));
    if (!samePersistedValue(pi.buildSessionContext(result.entries, targetLeafId),
      pi.buildSessionContext(exported.entries, targetLeafId)))
      throw new Error("Export changed the branch context");
  } else {
    for (const { record, data: source } of branches) {
      const sourceLeaf = source.entries.at(-1)?.id;
      if (sourceLeaf && !samePersistedValue(pi.buildSessionContext(source.entries, sourceLeaf),
        pi.buildSessionContext(result.entries, graph.canonical(record, sourceLeaf))))
        throw new Error(`Export changed branch context: ${record.id}`);
    }
    if (!samePersistedValue(pi.buildSessionContext(data.entries, leafId), pi.buildSessionContext(result.entries, leafId)))
      throw new Error("Export changed main context");
  }
  const output: SessionData = { ...exported, header: { ...exported.header, id: randomUUID(), parentSession: main } };
  const temp = mkdtempSync(join(dirname(outputPath), ".pix-export-"));
  try {
    const jsonl = join(temp, "tree.jsonl");
    durableWrite(jsonl, encodeSession(output));
    const manager = pi.SessionManager.open(jsonl);
    manager.getTree();
    const activeLeaf = targetLeafId ?? leafId;
    if (activeLeaf) manager.branch(activeLeaf); else manager.resetLeaf();
    const source = html ? await adapter.exportSnapshotHtml(manager, join(temp, "tree.html")) : jsonl;
    // Exclusive installation also protects a destination created after dispatch.
    linkSync(source, outputPath);
    return { path: outputPath };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
void run().then(result => parentPort!.postMessage({ result }), error => parentPort!.postMessage({ error: String(error) }));
