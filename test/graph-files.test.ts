import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GraphFiles, durableWrite, encodeSession, parseStrict, type BranchRecord, type SessionData } from "../src/main/graph-files.js";

const header = { type: "session", version: 3, id: "test", cwd: "/test", timestamp: "2026-01-01" };
const user = (id: string, parentId: string | null) => ({ type: "message", id, parentId, timestamp: "2026-01-01", message: { role: "user", content: id, timestamp: 1 } });
const initial: SessionData = { header, entries: [user("root", null)] };
function record(id: string, parent = "main", fork = "root"): BranchRecord {
  return { id, parentId: parent, forkEntryId: fork, requestId: id, request: { text: id }, inherited: { root: "root" },
    header: { ...header, id }, baseline: initial.entries, runId: id, status: "idle" };
}

test("permanent deletion prunes branch sources, checkpoints, requests and backups without changing siblings", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-delete-files-"));
  const graph = new GraphFiles(join(dir, "main.jsonl"));
  try {
    graph.acquire(); durableWrite(graph.main, encodeSession(initial));
    const a = record("A");
    const aData = { header: a.header, entries: [...initial.entries, user("keep", "root"), user("DELETE_SECRET", "keep")] };
    graph.create(a, aData); graph.save(a);
    const b = record("B", "A", "A:DELETE_SECRET");
    b.baseline = aData.entries; b.inherited = { root: "root", keep: "A:keep", DELETE_SECRET: "A:DELETE_SECRET" };
    graph.create(b, { header: b.header, entries: [...aData.entries, user("child", "DELETE_SECRET")] });
    const sibling = record("sibling");
    graph.create(sibling, { header: sibling.header, entries: [...initial.entries, user("other", "root")] });
    const siblingBefore = readFileSync(graph.path("sibling"), "utf8");
    durableWrite(join(graph.dir, "request-removed.json"), JSON.stringify({ branchId: "A", text: "DELETE_SECRET", state: "settled" }));
    durableWrite(join(graph.dir, "request-queued.json"), JSON.stringify({ requestId: "queued", branchId: "A", nodeId: "turn:A:keep", text: "still wanted", state: "queued" }));
    durableWrite(join(graph.dir, "request-prepared.json"), JSON.stringify({ requestId: "prepared", branchId: "A", nodeId: "turn:A:keep", text: "unfinished", state: "prepared" }));
    durableWrite(join(graph.dir, "request-deleted-input.json"), JSON.stringify({ requestId: "deleted-input", branchId: "A", nodeId: "turn:A:keep", text: "DELETE_SECRET", state: "prepared" }));
    durableWrite(`${graph.path("A")}.recovered`, encodeSession(aData));
    graph.deleteNode("A:DELETE_SECRET", "root");
    graph.records.clear(); graph.load();
    assert.equal(graph.records.has("B"), false);
    assert.deepEqual(graph.candidate(initial).entries.map(e => e.id), ["root", "A:keep", "sibling:other"]);
    assert.equal(readFileSync(graph.path("sibling"), "utf8"), siblingBefore);
    for (const name of readdirSync(graph.dir)) assert.ok(!readFileSync(join(graph.dir, name), "utf8").includes("DELETE_SECRET"), name);
    assert.equal(existsSync(join(graph.dir, "delete-pending.json")), false);
    assert.deepEqual(JSON.parse(readFileSync(join(graph.dir, "request-removed.json"), "utf8")), { requestId: "removed", state: "settled" });
    assert.deepEqual(JSON.parse(readFileSync(join(graph.dir, "request-deleted-input.json"), "utf8")), { requestId: "deleted-input", state: "cancelled" });
    assert.deepEqual(graph.recoveredInputs.map(input => input.text).sort(), ["still wanted", "unfinished"].sort());
    graph.deleteNode("root", "root");
    graph.records.clear(); graph.load();
    assert.equal(graph.records.size, 0);
    assert.equal(graph.leafId, null);
    assert.deepEqual(parseStrict(readFileSync(graph.main, "utf8")).entries, []);
  } finally { graph.release(); rmSync(dir, { recursive: true, force: true }); }
});

test("an interrupted deletion finishes on load and rejects paths outside its graph", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-delete-recovery-"));
  const graph = new GraphFiles(join(dir, "main.jsonl"));
  try {
    graph.acquire(); durableWrite(graph.main, encodeSession(initial));
    graph.create(record("A"), { header, entries: [...initial.entries, user("child", "root")] });
    const writes = { main: encodeSession({ header, entries: [] }), "cursor.json": '{"leafId":null}\n' };
    const removes = readdirSync(graph.dir).filter(name => name.startsWith("A.jsonl"));
    durableWrite(join(graph.dir, "delete-pending.json"), JSON.stringify({ writes, removes }));
    graph.records.clear(); graph.load();
    assert.deepEqual(parseStrict(readFileSync(graph.main, "utf8")).entries, []);
    assert.equal(graph.records.size, 0);
    assert.equal(graph.leafId, null);
    durableWrite(join(graph.dir, "delete-pending.json"), JSON.stringify({ writes: { "../outside": "bad" }, removes: [] }));
    assert.throws(() => graph.finishDeletion(), /Invalid node deletion journal/);
    assert.equal(existsSync(join(dir, "outside")), false);
  } finally { graph.release(); rmSync(dir, { recursive: true, force: true }); }
});

test("deleting a main-tree fork removes dangling metadata while preserving the sibling conversation", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-delete-metadata-"));
  const graph = new GraphFiles(join(dir, "main.jsonl"));
  try {
    graph.acquire();
    const data: SessionData = { header, entries: [...initial.entries, user("remove", "root"),
      { type: "label", id: "label", parentId: "root", timestamp: "now", targetId: "remove", label: "deleted label" },
      { type: "branch_summary", id: "summary", parentId: "label", timestamp: "now", fromId: "remove", summary: "deleted summary" },
      user("keep", "summary")] };
    durableWrite(graph.main, encodeSession(data));
    graph.deleteNode("remove", "keep");
    const kept = parseStrict(readFileSync(graph.main, "utf8"));
    assert.deepEqual(kept.entries.map(e => [e.id, e.parentId]), [["root", null], ["keep", "root"]]);
    const brokenReference: SessionData = { header, entries: [...initial.entries, user("remove", "root"),
      { type: "compaction", id: "compact", parentId: "root", timestamp: "now", firstKeptEntryId: "remove", summary: "context" }] };
    const original = encodeSession(brokenReference);
    durableWrite(graph.main, original);
    assert.throws(() => graph.deleteNode("remove", "compact"), /retained compaction/);
    assert.equal(readFileSync(graph.main, "utf8"), original);
  } finally { graph.release(); rmSync(dir, { recursive: true, force: true }); }
});
test("strict validation rejects malformed lines, duplicates, orphans and broken compaction refs", () => {
  for (const raw of [encodeSession(initial) + "{broken\n", encodeSession({ header, entries: [user("x", "missing")] }),
    encodeSession({ header, entries: [user("root", null), user("root", null)] }),
    encodeSession({ header, entries: [...initial.entries, { type: "compaction", id: "c", parentId: "root", timestamp: "now", firstKeptEntryId: "absent" }] })])
    assert.throws(() => parseStrict(raw));
});

test("persistence checks use Pi JSON semantics but still reject changed or missing data", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-json-equality-"));
  const graph = new GraphFiles(join(dir, "main.jsonl"));
  try {
    graph.acquire();
    const memory: SessionData = { header: { ...header, parentSession: undefined }, entries: [
      { ...user("root", null), message: { role: "user", content: "root", optional: undefined } },
    ] };
    durableWrite(graph.main, encodeSession(memory));
    graph.sealMain(memory);
    const a = { ...record("A"), header: memory.header, baseline: memory.entries };
    graph.create(a, memory);
    const disk = parseStrict(readFileSync(graph.path("A"), "utf8"));
    assert.deepEqual(graph.delta(a, disk), []);
    assert.deepEqual(graph.seal(a, memory), disk);
    const changed = structuredClone(memory);
    changed.entries[0]!.message = { role: "user", content: "changed" };
    assert.throws(() => graph.delta(a, changed), /baseline changed/);
    assert.throws(() => graph.delta(a, { ...disk, entries: [] }), /baseline changed/);
    assert.throws(() => graph.sealMain(changed), /differs from memory/);
    assert.throws(() => graph.seal(a, changed), /differs from memory/);
    assert.equal(readFileSync(graph.main, "utf8"), encodeSession(memory));
    assert.equal(readFileSync(graph.path("A"), "utf8"), encodeSession(memory));
  } finally { graph.release(); rmSync(dir, { recursive: true, force: true }); }
});
test("nested branches export in dependency order without modifying any source", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-archive-"));
  const graph = new GraphFiles(join(dir, "main.jsonl"));
  try {
    durableWrite(graph.main, encodeSession(initial)); graph.acquire();
    const a = record("A");
    const aData = { header: a.header, entries: [...initial.entries, user("a", "root")] };
    const b = record("B", "A", "A:a");
    b.baseline = aData.entries; b.inherited = { root: "root", a: "A:a" };
    const bData = { header: b.header, entries: [...aData.entries, user("b", "a")] };
    graph.create(b, bData); graph.create(a, aData);
    const merged = graph.candidate(initial);
    assert.deepEqual(merged.entries.map(e => [e.id, e.parentId]), [["root", null], ["A:a", "root"], ["B:b", "A:a"]]);
    assert.deepEqual(graph.candidate(merged), merged);
    assert.equal(readFileSync(graph.main, "utf8"), encodeSession(initial));
    assert.equal(SessionManager.inMemory(dir, undefined, [merged.header as any, ...merged.entries as any]).getTree().length, 1);
    assert.equal(readFileSync(graph.path("B"), "utf8"), encodeSession(bData));
  } finally { graph.release(); rmSync(dir, { recursive: true, force: true }); }
});
test("corrupt checkpoint does not modify main or stop an independent branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-bad-branch-"));
  const graph = new GraphFiles(join(dir, "main.jsonl"));
  try {
    graph.acquire(); durableWrite(graph.main, encodeSession(initial));
    for (const id of ["bad", "good"]) graph.create(record(id), { header, entries: [...initial.entries, user("child", "root")] });
    writeFileSync(graph.checkpointPath("bad"), "broken");
    assert.throws(() => graph.candidate(initial), /Cannot export branch bad/);
    assert.equal(readFileSync(graph.main, "utf8"), encodeSession(initial));
    durableWrite(graph.checkpointPath("bad"), encodeSession({ header, entries: [...initial.entries, user("child", "root")] }));
    assert.ok(graph.candidate(initial).entries.some(e => e.id === "bad:child"));
  } finally { graph.release(); rmSync(dir, { recursive: true, force: true }); }
});

test("damaged origin metadata is restored from its backup without changing main", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-origin-recovery-"));
  const graph = new GraphFiles(join(dir, "main.jsonl"));
  try {
    graph.acquire(); durableWrite(graph.main, encodeSession(initial));
    const a = record("A"); graph.create(a, { header: a.header, entries: initial.entries });
    graph.save(a);
    writeFileSync(`${graph.path("A")}.origin.json`, "broken");
    graph.load();
    assert.equal(graph.records.get("A")?.forkEntryId, "root");
    assert.ok(graph.recoveryMessages.length);
    assert.equal(readFileSync(graph.main, "utf8"), encodeSession(initial));
  } finally { graph.release(); rmSync(dir, { recursive: true, force: true }); }
});

test("restart restores prepared branches and unfinished inputs without replaying work", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-prepared-"));
  const graph = new GraphFiles(join(dir, "main.jsonl"));
  try {
    graph.acquire(); durableWrite(graph.main, encodeSession(initial));
    const a = { ...record("A"), status: "prepared" as const };
    graph.save(a); // Crash before creating the source file or invoking Pi.
    durableWrite(join(graph.dir, "request-A.json"), JSON.stringify({ requestId: "A", text: "saved input", state: "prepared" }));
    graph.load();
    assert.ok(existsSync(graph.path("A")));
    assert.equal(graph.records.get("A")?.status, "interrupted");
    assert.equal(graph.recoveredInputs[0]?.text, "saved input");
    assert.deepEqual(parseStrict(readFileSync(graph.path("A"), "utf8")).entries, initial.entries);
  } finally { graph.release(); rmSync(dir, { recursive: true, force: true }); }
});

test("main tail recovery and SDK legacy migration retain originals; structural damage is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-main-recovery-"));
  const graph = new GraphFiles(join(dir, "main.jsonl"));
  const migrate = (entries: unknown[]) => {
    const manager = SessionManager.inMemory(dir, undefined, entries as any);
    return { header: manager.getHeader() as any, entries: manager.getEntries() as any };
  };
  try {
    graph.acquire();
    const damaged = encodeSession(initial) + '{"type":"message"';
    durableWrite(graph.main, damaged);
    assert.deepEqual(graph.readMain(migrate), initial);
    assert.equal(readFileSync(join(graph.dir, readdirSync(graph.dir).find(n => n.startsWith("main-damaged-"))!), "utf8"), damaged);
    durableWrite(graph.main, encodeSession({ header: { ...header, version: 2 }, entries: initial.entries }));
    assert.equal(graph.readMain(migrate).header.version, 3);
    const orphan = encodeSession({ header, entries: [...initial.entries, user("bad", "absent")] });
    durableWrite(graph.main, orphan);
    assert.throws(() => graph.readMain(migrate), /Missing/);
    assert.equal(readFileSync(graph.main, "utf8"), orphan);
  } finally { graph.release(); rmSync(dir, { recursive: true, force: true }); }
});

test("recovering a damaged branch never rewrites its original", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-tail-recovery-"));
  const graph = new GraphFiles(join(dir, "main.jsonl"));
  try {
    graph.acquire(); const a = record("A"); graph.create(a, initial);
    const damaged = encodeSession(initial) + '{"type":"message"';
    durableWrite(graph.path("A"), damaged);
    assert.deepEqual(graph.readBranch(a), initial);
    assert.equal(readFileSync(graph.path("A"), "utf8"), damaged);
    assert.ok(existsSync(`${graph.path("A")}.recovered`));
  } finally { graph.release(); rmSync(dir, { recursive: true, force: true }); }
});

test("tree ownership is exclusive and released sessions can reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-directory-"));
  const graph = new GraphFiles(join(dir, "main.jsonl"));
  try {
    graph.acquire(); graph.create(record("A"), initial);
    const original = readFileSync(graph.path("A"), "utf8");
    assert.throws(() => new GraphFiles(graph.main).acquire(), /already open/);
    graph.release();
    graph.acquire(); graph.load();
    assert.ok(graph.dir.endsWith(".pix-tree"));
    assert.equal(readFileSync(graph.path("A"), "utf8"), original);
    assert.throws(() => new GraphFiles(graph.main).acquire(), /already open/);
  } finally { graph.release(); rmSync(dir, { recursive: true, force: true }); }
});

test("export rejects unresolved descendants instead of silently omitting them", () => {
  const dir = mkdtempSync(join(tmpdir(), "pix-missing-parent-"));
  const graph = new GraphFiles(join(dir, "main.jsonl"));
  try {
    graph.acquire(); graph.create(record("B", "A", "A:missing"), initial);
    assert.throws(() => graph.candidate(initial), /Missing export/);
  } finally { graph.release(); rmSync(dir, { recursive: true, force: true }); }
});
