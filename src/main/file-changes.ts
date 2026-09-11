import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { formatPatch, structuredPatch } from "diff";
import { durableWrite } from "./graph-files.js";
import { fileChange, type FileChange } from "../shared/file-changes.js";
import type { RawSessionEntry } from "../shared/types.js";

const MAX_BYTES = 2 * 1024 * 1024;
// A stored patch never needs to carry more text than the files it describes, so
// larger ones are reported as "large" instead of being persisted and shipped to
// the renderer as one unreadable line.
const MAX_PATCH = MAX_BYTES;
interface Version { exists: boolean; text?: string; reason?: FileChange["reason"] }
interface Snapshot { path: string; before: Version; after: Version; reason?: FileChange["reason"]; patch?: string }
interface Pending { session: string; ref: string; path: string; key: string; snapshot: Snapshot; observed: Version }
// Shared only to detect overlapping tools on the same host. Separate worktrees have distinct keys.
const writing = new Map<string, Set<Pending>>();

async function version(path: string): Promise<Version> {
  let file;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    if (!stat.isFile()) return { exists: true, reason: "unavailable" };
    if (stat.size > MAX_BYTES) return { exists: true, reason: "large" };
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) return { exists: true, reason: "large" };
    const content = bytes.subarray(0, length);
    if (content.includes(0)) return { exists: true, reason: "binary" };
    try { return { exists: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content) }; }
    catch { return { exists: true, reason: "binary" }; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, text: "" };
    return { exists: true, reason: "unavailable" };
  } finally { await file?.close(); }
}

const equal = (a: Version, b: Version) => a.text !== undefined && b.text !== undefined && a.exists === b.exists && a.text === b.text;
/** Snapshot sidecar next to the session file; removed together with it. */
export const fileChangeDir = (session: string) => `${session}.file-changes`;
const snapshotPath = (session: string, ref: string) => {
  if (!/^[a-f0-9-]{36}$/.test(ref)) throw new Error("Invalid file change reference");
  return join(fileChangeDir(session), `${ref}.json`);
};
async function load(session: string, ref: string): Promise<Snapshot> {
  return JSON.parse(await readFile(snapshotPath(session, ref), "utf8"));
}
async function save(session: string, ref: string, snapshot: Snapshot) {
  const path = snapshotPath(session, ref);
  await mkdir(dirname(path), { recursive: true });
  durableWrite(path, JSON.stringify(snapshot));
}

/** Pure: the caller decides whether the returned patch is persisted. */
export function summarizeChange(snapshot: Snapshot, ref: string): { change: FileChange; patch?: string } {
  const { before, after, path } = snapshot;
  const reason = snapshot.reason ?? before.reason ?? after.reason;
  const change: FileChange = {
    path, ref, status: equal(before, after) && !reason ? "unchanged" : !before.exists ? "added" : !after.exists ? "deleted" : "modified",
    added: null, removed: null, ...(reason ? { reason } : {}),
  };
  if (reason || before.text === undefined || after.text === undefined) return { change };
  // Bound pathological diff work without blocking the agent host indefinitely.
  const diff = structuredPatch(before.exists ? `a/${path}` : "/dev/null", after.exists ? `b/${path}` : "/dev/null",
    before.text, after.text, undefined, undefined, { context: 3, timeout: 200, maxEditLength: 20000 });
  if (!diff) return { change: { ...change, reason: "large" } };
  const patch = formatPatch(diff);
  if (patch.length > MAX_PATCH) return { change: { ...change, reason: "large" } };
  const lines = diff.hunks.flatMap(hunk => hunk.lines);
  change.added = lines.filter(line => line.startsWith("+")).length;
  change.removed = lines.filter(line => line.startsWith("-")).length;
  return { change, patch };
}

export async function readFileChange(session: string, entries: RawSessionEntry[], ref: string): Promise<string> {
  // The renderer supplies only an ID; it cannot choose a snapshot directory or arbitrary host file.
  if (!entries.some(entry => fileChange(entry)?.ref === ref)) throw new Error("Unknown file change");
  // A session imported as plain JSONL has records but no copied snapshots.
  const snapshot = await load(session, ref).catch(() => undefined);
  if (!snapshot) throw new Error("The saved diff for this change is unavailable");
  if (typeof snapshot.patch !== "string") throw new Error("Text diff is unavailable for this change");
  return snapshot.patch;
}

export class FileChangeTracker {
  private pending = new Map<string, Pending>();
  private release(item: Pending) {
    const active = writing.get(item.key);
    active?.delete(item);
    if (!active?.size) writing.delete(item.key);
  }
  async before(callId: string, path: string, cwd: string, session: string, branch: RawSessionEntry[]) {
    const display = relative(cwd, path).split(sep).join("/");
    // Match PiX's workspace access boundary, including links out of the project.
    const inside = (root: string, target: string) => {
      const rel = relative(root, target);
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    };
    if (!inside(cwd, path)) return;
    let canonical = path;
    try {
      let ancestor = path;
      while (true) {
        try { canonical = resolve(await realpath(ancestor), relative(ancestor, path)); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
          ancestor = dirname(ancestor);
        }
      }
      if (!inside(await realpath(cwd), canonical)) return;
      const observed = await version(path);
      let user = branch.length - 1;
      while (user >= 0 && !(branch[user]!.type === "message" && (branch[user]!.message as { role?: string })?.role === "user")) user--;
      if (user < 0) return;
      const samePath = (path: string) => process.platform === "win32" ? path.toLowerCase() === display.toLowerCase() : path === display;
      const previous = branch.slice(user + 1).reverse().map(fileChange).find(change => change && samePath(change.path));
      const snapshot: Snapshot = { path: display, before: observed, after: observed };
      if (previous) {
        const saved = await load(session, previous.ref);
        snapshot.path = previous.path;
        snapshot.before = saved.before;
        snapshot.reason = saved.reason ?? (equal(saved.after, observed) ? undefined : "conflict");
      }
      const item: Pending = { session, ref: randomUUID(), path, key: process.platform === "win32" ? canonical.toLowerCase() : canonical, snapshot, observed };
      const active = writing.get(item.key) ?? new Set<Pending>();
      for (const other of active) { other.snapshot.reason = "conflict"; snapshot.reason = "conflict"; }
      active.add(item); writing.set(item.key, active); this.pending.set(callId, item);
      // Persist the old content before allowing the tool to write.
      await save(item.session, item.ref, item.snapshot);
    } catch (error) {
      const item = this.pending.get(callId);
      if (item) { this.release(item); this.pending.delete(callId); }
      throw error;
    }
  }
  async after(callId: string, path: string, isError: boolean) {
    const item = this.pending.get(callId);
    if (!item) return;
    try {
      if (path !== item.path) throw new Error("Another extension changed the tool's target path");
      item.snapshot.after = await version(item.path);
      if (isError && (equal(item.observed, item.snapshot.after) || item.snapshot.after.text === undefined)) return;
      const { change, patch } = summarizeChange(item.snapshot, item.ref);
      await save(item.session, item.ref, patch === undefined ? item.snapshot : { ...item.snapshot, patch });
      return change;
    } finally { this.release(item); this.pending.delete(callId); }
  }
  clear() { for (const item of this.pending.values()) this.release(item); this.pending.clear(); }
}
