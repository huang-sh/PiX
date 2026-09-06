import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import type { RawSessionEntry, PromptImage } from "../shared/types.js";
import { projectSession } from "../shared/session.js";

export interface SessionData { header: Record<string, unknown>; entries: RawSessionEntry[] }
export interface BranchRecord {
  id: string;
  parentId: string;
  forkEntryId: string;
  requestId: string;
  request: { text: string; nodeId?: string | null; images?: PromptImage[]; provider?: string; modelId?: string; thinkingLevel?: string };
  inherited: Record<string, string>;
  baseline: RawSessionEntry[];
  header: Record<string, unknown>;
  status: "prepared" | "running" | "idle" | "interrupted";
  runId: string;
  error?: string;
}
export const encodeSession = (data: SessionData) => [data.header, ...data.entries].map(e => JSON.stringify(e)).join("\n") + "\n";

// Pi persists JSON, which omits optional undefined fields retained by providers
// in memory. Compare that representation without changing either source.
export function samePersistedValue(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b) || (a !== undefined && b !== undefined
    && isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))));
}

/** Validate before asking the SDK to interpret a file: its parser deliberately skips bad lines. */
export function parseStrict(raw: string): SessionData {
  const values = raw.split("\n").filter(line => line.trim()).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid session JSON at line ${i + 1}`); }
  });
  const header = values.shift();
  if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id || header.version !== 3)
    throw new Error("Expected a Pi v3 session header");
  const byId = new Map<string, RawSessionEntry>();
  const types = new Set(["message", "model_change", "thinking_level_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"]);
  for (const entry of values) {
    if (!entry || !types.has(entry.type) || typeof entry.id !== "string" || !entry.id || byId.has(entry.id)
      || (entry.parentId !== null && typeof entry.parentId !== "string") || typeof entry.timestamp !== "string")
      throw new Error("Invalid or duplicate session entry");
    // Pi's append-only format always writes a parent before its children. Multiple roots are valid.
    if (entry.parentId !== null && !byId.has(entry.parentId)) throw new Error(`Missing or cyclic parent of ${entry.id}`);
    if (entry.type === "message" && (!entry.message || typeof entry.message.role !== "string"))
      throw new Error(`Invalid message ${entry.id}`);
    byId.set(entry.id, entry);
  }
  for (const entry of values) {
    const ref = entry.type === "label" ? entry.targetId : entry.type === "compaction" ? entry.firstKeptEntryId : undefined;
    if ((entry.type === "label" || entry.type === "compaction") && (typeof ref !== "string" || !byId.has(ref))) throw new Error(`Missing reference in ${entry.id}`);
    // branch_summary.fromId may name the abandoned path outside an SDK-extracted session.
  }
  return { header, entries: values };
}
export const readStrict = (file: string) => parseStrict(readFileSync(file, "utf8"));

/** Same-directory replacement; never truncate the sole good copy. */
export function durableWrite(file: string, text: string) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx");
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
}

export class GraphFiles {
  readonly dir: string;
  readonly records = new Map<string, BranchRecord>();
  leafId: string | null = null;
  hasSavedLeaf = false;
  private locked = false;
  private deltaEntries = new WeakMap<BranchRecord, WeakMap<RawSessionEntry, RawSessionEntry>>();
  readonly recoveryMessages: string[] = [];
  readonly recoveredInputs: Array<{ requestId: string; text: string; nodeId?: string | null; images?: PromptImage[] }> = [];
  constructor(readonly main: string) {
    this.dir = `${resolve(main)}.pix-tree`;
  }
  path(id: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid branch ID");
    return join(this.dir, `${id}.jsonl`);
  }
  private origin(id: string) { return `${this.path(id)}.origin.json`; }
  checkpointPath(id: string) { return `${this.path(id)}.checkpoint`; }
  private saveJson(file: string, value: unknown) {
    if (existsSync(file)) {
      const previous = readFileSync(file, "utf8");
      try { JSON.parse(previous); durableWrite(`${file}.bak`, previous); } catch {}
    }
    durableWrite(file, JSON.stringify(value) + "\n");
  }
  private readJson(file: string) {
    try { return JSON.parse(readFileSync(file, "utf8")); }
    catch (error) {
      if (!existsSync(`${file}.bak`)) throw error;
      const backup = readFileSync(`${file}.bak`, "utf8");
      const value = JSON.parse(backup);
      if (existsSync(file)) copyFileSync(file, `${file}.damaged-${randomUUID()}`);
      durableWrite(file, backup);
      this.recoveryMessages.push(`Recovered metadata: ${basename(file)}`);
      return value;
    }
  }
  acquire() {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, "owner.json");
    if (existsSync(file)) {
      const owner = JSON.parse(readFileSync(file, "utf8"));
      if (owner.host !== hostname()) throw new Error("Session graph is owned by another host");
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== "ESRCH"; }
      if (alive) throw new Error("Session graph is already open in another PiX process");
      rmSync(file);
    }
    const fd = openSync(file, "wx");
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname() })); fsyncSync(fd); }
    finally { closeSync(fd); }
    this.locked = true;
  }
  release() {
    if (this.locked) rmSync(join(this.dir, "owner.json"), { force: true });
    this.locked = false;
  }
  load() {
    this.finishDeletion();
    const cursor = join(this.dir, "cursor.json");
    if (existsSync(cursor)) {
      try {
        const leaf = this.readJson(cursor).leafId;
        if (leaf !== null && typeof leaf !== "string") throw new Error("Invalid saved leaf");
        this.leafId = leaf; this.hasSavedLeaf = true;
      }
      catch { this.recoveryMessages.push("Saved selection unavailable; using the session's last persisted entry"); }
    }
    for (const name of readdirSync(this.dir).filter(n => n.endsWith(".jsonl.origin.json"))) {
      let record: BranchRecord;
      try {
        record = this.readJson(join(this.dir, name));
        if (basename(this.origin(record.id)) !== name || !record.inherited || typeof record.request?.text !== "string"
          || !["prepared", "running", "idle", "interrupted"].includes(record.status)) throw new Error("Invalid branch origin");
        parseStrict(encodeSession({ header: record.header, entries: record.baseline }));
      }
      catch { this.recoveryMessages.push(`Branch metadata unavailable; original session retained: ${name}`); continue; }
      if (record.status === "prepared" && !existsSync(this.path(record.id))) {
        const initial = encodeSession({ header: record.header, entries: record.baseline });
        parseStrict(initial);
        durableWrite(this.path(record.id), initial);
        durableWrite(this.checkpointPath(record.id), initial);
      }
      const interrupted = record.status === "prepared" || record.status === "running";
      if (interrupted) {
        record.status = "interrupted";
        record.error = "Execution interrupted; saved input retained. No tools were automatically replayed.";
      }
      this.records.set(record.id, record);
      if (interrupted) this.save(record);
    }
    // Durable intent is written before calling Pi. Keep interrupted input visible
    // after restart, including failures before Pi appended its first user message.
    for (const name of readdirSync(this.dir).filter(n => /^request-[a-zA-Z0-9-]+\.json$/.test(n))) {
      try {
        const input = this.readJson(join(this.dir, name));
        if ((input.state === "prepared" || input.state === "queued") && typeof input.text === "string")
          this.recoveredInputs.push({ requestId: input.requestId, text: input.text, nodeId: input.nodeId, images: input.images });
      } catch { this.recoveryMessages.push(`Saved input unavailable; original retained: ${name}`); }
    }
  }
  save(record: BranchRecord) {
    this.saveJson(this.origin(record.id), record);
    this.records.set(record.id, record);
  }
  saveLeaf(leafId: string | null) {
    this.saveJson(join(this.dir, "cursor.json"), { leafId });
    this.leafId = leafId;
    this.hasSavedLeaf = true;
  }
  /** Finish an interrupted deletion forwards; the journal contains only retained data. */
  finishDeletion() {
    const journal = join(this.dir, "delete-pending.json");
    if (!existsSync(journal)) return;
    const plan = JSON.parse(readFileSync(journal, "utf8")) as { writes: Record<string, string>; removes: string[] };
    const allowed = (name: string) => name === "cursor.json" || name === "cursor.json.bak"
      || /^[a-zA-Z0-9-]+\.jsonl(?:\.[a-zA-Z0-9.-]+)?$/.test(name)
      || /^(?:request-|main-damaged-|main-legacy-)[a-zA-Z0-9.-]+$/.test(name);
    // Validate every target before touching any file, including recovery after restart.
    if (!plan.writes || !Array.isArray(plan.removes)
      || Object.entries(plan.writes).some(([name, value]) => (name !== "main" && name !== "cursor.json"
        && !/^[a-zA-Z0-9-]+\.jsonl(?:\.origin\.json|\.checkpoint)?$/.test(name)
        && !/^request-[a-zA-Z0-9-]+\.json$/.test(name)) || typeof value !== "string")
      || plan.removes.some(name => typeof name !== "string" || !allowed(name)))
      throw new Error("Invalid node deletion journal");
    for (const [name, value] of Object.entries(plan.writes)) {
      if (plan.removes.includes(name)) throw new Error("Conflicting node deletion journal");
      if (name === "main" || name.endsWith(".jsonl") || name.endsWith(".checkpoint")) parseStrict(value);
      else {
        const data = JSON.parse(value);
        if (name === "cursor.json") {
          if (data.leafId !== null && typeof data.leafId !== "string") throw new Error("Invalid deletion cursor");
        } else if (/^request-[a-zA-Z0-9-]+\.json$/.test(name)) {
          if (`request-${data.requestId}.json` !== name || !["settled", "cancelled"].includes(data.state))
            throw new Error("Invalid deletion request receipt");
        } else {
          if (`${data.id}.jsonl.origin.json` !== name || !data.inherited || typeof data.request?.text !== "string")
            throw new Error("Invalid deletion branch metadata");
          parseStrict(encodeSession({ header: data.header, entries: data.baseline }));
        }
      }
    }
    for (const [name, value] of Object.entries(plan.writes))
      durableWrite(name === "main" ? this.main : join(this.dir, name), value);
    for (const name of plan.removes) rmSync(join(this.dir, name), { force: true });
    rmSync(journal);
  }
  /** Permanently prune a user entry and descendants from every source and saved copy. */
  deleteNode(userEntryId: string, leafId: string | null) {
    const main = readStrict(this.main);
    const sources = [...this.records.values()].map(record => ({ record, data: readStrict(this.path(record.id)) }));
    const entries = new Map(main.entries.map(entry => [entry.id, entry]));
    for (const { record, data } of sources)
      for (const entry of this.delta(record, data)) entries.set(entry.id, entry);
    const root = entries.get(userEntryId);
    if (root?.type !== "message" || (root.message as { role?: string })?.role !== "user")
      throw new Error("Node no longer exists");
    const children = new Map<string, string[]>();
    for (const entry of entries.values()) {
      if (!entry.parentId) continue;
      const siblings = children.get(entry.parentId) ?? [];
      siblings.push(entry.id); children.set(entry.parentId, siblings);
    }
    const removed = new Set<string>();
    const pending = [userEntryId];
    while (pending.length) {
      const id = pending.pop()!;
      if (removed.has(id)) continue;
      removed.add(id);
      for (const child of children.get(id) ?? []) pending.push(child);
    }
    // Metadata elsewhere can refer to an abandoned branch. Remove that metadata,
    // retaining its children and their original message ancestry.
    for (const entry of entries.values()) {
      const ref = entry.type === "label" ? entry.targetId
        : entry.type === "branch_summary" ? entry.fromId : undefined;
      if (typeof ref === "string" && removed.has(ref)) removed.add(entry.id);
      if (entry.type === "compaction" && !removed.has(entry.id) && removed.has(String(entry.firstKeptEntryId)))
        throw new Error("A retained compaction depends on this node");
    }
    const ancestor = (id: string | null) => {
      while (id && removed.has(id)) id = entries.get(id)?.parentId ?? null;
      return id;
    };
    const prune = (list: RawSessionEntry[], canonical = (id: string) => id) => {
      const local = new Map(list.map(entry => [entry.id, entry]));
      return list.filter(entry => !removed.has(canonical(entry.id))).map(entry => {
        let parentId = entry.parentId;
        while (parentId && removed.has(canonical(parentId))) parentId = local.get(parentId)?.parentId ?? null;
        return parentId === entry.parentId ? entry : { ...entry, parentId };
      });
    };
    const writes: Record<string, string> = {};
    const removes = new Set<string>();
    const names = readdirSync(this.dir);
    const mainChanged = main.entries.some(entry => removed.has(entry.id));
    if (mainChanged) {
      const next = encodeSession({ ...main, entries: prune(main.entries) });
      parseStrict(next); writes.main = next;
      for (const name of names)
        if (/^main-(?:damaged|legacy)-/.test(name)) removes.add(name);
    }
    const affected = new Set<string>();
    for (const { record, data } of sources) {
      const canonical = (id: string) => this.canonical(record, id);
      if (!removed.has(record.forkEntryId) && !data.entries.some(entry => removed.has(canonical(entry.id)))) continue;
      affected.add(record.id);
      const retained = prune(data.entries, canonical);
      const hasTurns = retained.some(entry => !Object.hasOwn(record.inherited, entry.id)
        && entry.type === "message" && (entry.message as { role?: string })?.role === "user");
      for (const name of names) if (name.startsWith(`${record.id}.jsonl`)) removes.add(name);
      if (!hasTurns) continue;
      const next = encodeSession({ ...data, entries: retained });
      parseStrict(next);
      const keptIds = new Set(retained.map(entry => entry.id));
      const updated: BranchRecord = { ...record, baseline: prune(record.baseline, canonical),
        inherited: Object.fromEntries(Object.entries(record.inherited).filter(([id]) => keptIds.has(id))),
        forkEntryId: ancestor(record.forkEntryId) ?? "", request: { text: "" }, requestId: "",
        runId: randomUUID(), status: "idle", error: undefined };
      for (const [name, value] of [
        [basename(this.path(record.id)), next], [basename(this.checkpointPath(record.id)), next],
        [basename(this.origin(record.id)), JSON.stringify(updated) + "\n"],
      ]) { writes[name!] = value!; removes.delete(name!); }
    }
    const deletedInputs = new Set<string>();
    for (const id of removed) {
      const entry = entries.get(id)!;
      if (entry.type !== "message" || (entry.message as { role?: string })?.role !== "user") continue;
      const message = projectSession([entry], entry.id).messages[0]!;
      let parent = entry.parentId ? entries.get(entry.parentId) : undefined;
      while (parent && !(parent.type === "message" && (parent.message as { role?: string })?.role === "user"))
        parent = parent.parentId ? entries.get(parent.parentId) : undefined;
      deletedInputs.add(JSON.stringify([parent ? `turn:${parent.id}` : null, message.text, message.images ?? []]));
    }
    for (const name of names.filter(name => /^request-[a-zA-Z0-9-]+\.json$/.test(name))) {
      const request = JSON.parse(readFileSync(join(this.dir, name), "utf8"));
      const targetRemoved = removed.has(String(request.nodeId ?? "").replace(/^turn:/, ""));
      const unfinished = request.state === "queued" || request.state === "prepared";
      const deletedInput = request.state === "prepared"
        && deletedInputs.has(JSON.stringify([request.nodeId ?? null, request.text, request.images ?? []]));
      // Keep independent unfinished inputs, even when their source file was pruned.
      if (targetRemoved || ((request.branchId ? affected.has(request.branchId) : mainChanged) && (!unfinished || deletedInput))) {
        // Retain only the deduplication receipt, never deleted prompt text or images.
        // Otherwise retrying an acknowledged request can execute its tools again.
        writes[name] = JSON.stringify({ requestId: name.slice(8, -5), state: unfinished ? "cancelled" : "settled" }) + "\n";
        for (const copy of names) if (copy.startsWith(`${name}.`)) removes.add(copy);
      }
    }
    writes["cursor.json"] = JSON.stringify({ leafId: ancestor(leafId) }) + "\n";
    removes.add("cursor.json.bak");
    durableWrite(join(this.dir, "delete-pending.json"), JSON.stringify({ writes, removes: [...removes] }) + "\n");
    this.finishDeletion();
    return ancestor(leafId);
  }
  readMain(migrate: (entries: unknown[]) => SessionData) {
    const original = readFileSync(this.main, "utf8");
    try { return parseStrict(original); } catch {}
    const lines = original.trimEnd().split("\n");
    let incomplete = false;
    // Only a syntactically incomplete final record is eligible for automatic
    // recovery. Broken parents, duplicate IDs and corruption in the middle fail closed.
    try { JSON.parse(lines.at(-1)!); } catch { lines.pop(); incomplete = true; }
    const values = lines.filter(line => line.trim()).map(line => JSON.parse(line));
    const version = values[0]?.version ?? 1;
    let data: SessionData;
    if (values[0]?.type === "session" && (version === 1 || version === 2))
      data = migrate(structuredClone(values));
    else data = { header: values[0], entries: values.slice(1) };
    const recovered = encodeSession(data);
    parseStrict(recovered);
    durableWrite(join(this.dir, `main-${incomplete ? "damaged" : "legacy"}-${randomUUID()}.jsonl`), original);
    if (readFileSync(this.main, "utf8") !== original) throw new Error("Main session changed during recovery");
    durableWrite(this.main, recovered);
    this.recoveryMessages.push(incomplete ? "Recovered complete main-session records; incomplete original retained" : "Upgraded session with Pi SDK; original retained");
    return data;
  }
  sealMain(memory: SessionData) {
    if (!samePersistedValue(readStrict(this.main), memory)) throw new Error("Main session persistence differs from memory");
    const fd = openSync(this.main, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  readBranch(record: BranchRecord): SessionData {
    try { return readStrict(this.path(record.id)); }
    catch (error) {
      record.error = `Source needs recovery; original retained: ${String(error)}`;
      record.status = "interrupted";
      this.recoveryMessages.push(record.error);
      if (existsSync(this.path(record.id))) {
        const raw = readFileSync(this.path(record.id), "utf8").trimEnd();
        const prefix = raw.slice(0, raw.lastIndexOf("\n") + 1);
        try {
          const data = parseStrict(prefix);
          this.delta(record, data);
          durableWrite(`${this.path(record.id)}.recovered`, encodeSession(data));
          this.save(record);
          return data;
        } catch {}
      }
      const checkpoint = readStrict(this.checkpointPath(record.id));
      this.save(record);
      return checkpoint;
    }
  }
  create(record: BranchRecord, data: SessionData) {
    const encoded = encodeSession(data);
    parseStrict(encoded);
    // Origin includes the initial snapshot, so a crash before file creation is recoverable.
    this.save(record);
    durableWrite(this.path(record.id), encoded);
    durableWrite(this.checkpointPath(record.id), encoded);
  }
  seal(record: BranchRecord, memory: SessionData) {
    const disk = readStrict(this.path(record.id));
    if (!samePersistedValue(disk, memory)) throw new Error("Session persistence differs from memory; original retained");
    const fd = openSync(this.path(record.id), "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    durableWrite(this.checkpointPath(record.id), encodeSession(disk));
    return disk;
  }
  canonical(record: BranchRecord, id: string) { return Object.hasOwn(record.inherited, id) ? record.inherited[id]! : `${record.id}:${id}`; }
  delta(record: BranchRecord, data: SessionData, reuse = false) {
    const byId = new Map(data.entries.map(e => [e.id, e]));
    for (const entry of record.baseline)
      if (!samePersistedValue(entry, byId.get(entry.id))) throw new Error(`Branch baseline changed: ${record.id}`);
    const base = new Set(record.baseline.map(e => e.id));
    let cached = reuse ? this.deltaEntries.get(record) : undefined;
    if (reuse && !cached) { cached = new WeakMap(); this.deltaEntries.set(record, cached); }
    return data.entries.filter(e => !base.has(e.id)).map(entry => {
      const previous = cached?.get(entry);
      if (previous) return previous;
      const copy = structuredClone(entry);
      copy.id = this.canonical(record, entry.id);
      copy.parentId = entry.parentId === null ? record.forkEntryId || null : this.canonical(record, entry.parentId);
      for (const key of ["targetId", "firstKeptEntryId", "fromId"])
        if (typeof copy[key] === "string" && copy[key] !== "root") copy[key] = this.canonical(record, copy[key] as string);
      // Session names and labels on copied history are session-wide SDK state.
      // Keep their provenance without overwriting the main session's metadata.
      if (copy.type === "session_info" || (copy.type === "label" && typeof entry.targetId === "string" && entry.targetId in record.inherited)) {
        const metadata = { type: "custom", id: copy.id, parentId: copy.parentId, timestamp: copy.timestamp,
          customType: "pix.branch-metadata", data: copy } as RawSessionEntry;
        cached?.set(entry, metadata);
        return metadata;
      }
      cached?.set(entry, copy);
      return copy;
    });
  }
  /** Construct a standalone export. Missing or incompatible data fails the entire export. */
  candidate(main: SessionData, checkpoints?: ReadonlyMap<string, SessionData | Error>) {
    const entries = [...main.entries];
    const known = new Map(entries.map(e => [e.id, e]));
    const pending = new Map(this.records);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, record] of pending) {
        if (checkpoints ? !checkpoints.has(id) : !existsSync(this.checkpointPath(id))) continue;
        let delta: RawSessionEntry[];
        try {
          const source = checkpoints ? checkpoints.get(id)! : readStrict(this.checkpointPath(id));
          if (source instanceof Error) throw source;
          delta = this.delta(record, source);
          if (delta.some(e => (e.type === "custom" && !["pix.node-footer", "pix.branch-metadata"].includes(String(e.customType)))
            || e.type === "custom_message")) throw new Error("Extension state needs a compatible export adapter; source retained");
        } catch (error) {
          throw new Error(`Cannot export branch ${id}: ${String(error)}`);
        }
        if (record.forkEntryId && !known.has(record.forkEntryId)) continue;
        for (const entry of delta) {
          const previous = known.get(entry.id);
          if (previous) {
            if (!samePersistedValue(previous, entry)) throw new Error(`Conflicting exported entry: ${entry.id}`);
          } else {
            if (entry.parentId && !known.has(entry.parentId)) throw new Error(`Missing export parent: ${entry.id}`);
            entries.push(entry); known.set(entry.id, entry);
          }
        }
        pending.delete(id); changed = true;
      }
    }
    if (pending.size) throw new Error(`Missing export sources or parents: ${[...pending.keys()].join(", ")}`);
    const result = { header: main.header, entries };
    parseStrict(encodeSession(result));
    return result;
  }
}
