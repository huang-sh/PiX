import { mkdirSync, readFileSync, renameSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { debugLog } from "./debug-log.js";
import { pixHome } from "./paths.js";
import type { UsageSessionInput, UsageProjectRef } from "../shared/usage.js";

/**
 * Persistent parse cache for the usage panel's session scans: session files
 * are the source of truth, but re-parsing a year of JSONL on every cold start
 * is wasteful when the bytes on disk never change. Entries are keyed by
 * canonical file path and invalidated by mtime + size; the map survives
 * restarts through a JSON snapshot in the profile. Estimation mutates records
 * in place, so every read hands out a clone; the project tag is scan-target
 * metadata, not file content, so it is applied per read instead of stored.
 */
const CACHE_PATH = join(pixHome(), ".pix", "usage-scan-cache.json");
/** Bump when record extraction changes shape, so stale entries are dropped. */
const SCAN_CACHE_VERSION = 1;
/** Cached sessions beyond this drop the longest-inserted entries first. */
const SCAN_CACHE_MAX = 2000;
/** Flushes wait out bursts of scan writes before hitting the disk. */
const FLUSH_DELAY_MS = 5000;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  session: Omit<UsageSessionInput, "project">;
}
interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

const stripProject = (session: UsageSessionInput): Omit<UsageSessionInput, "project"> => {
  const { project: _project, ...rest } = session;
  return rest;
};
const cloneRecords = (session: Omit<UsageSessionInput, "project">): UsageSessionInput => ({
  ...session,
  records: session.records.map((record) => ({ ...record, usage: { ...record.usage } })),
});

export class UsageScanCache {
  private entries = new Map<string, CacheEntry>();
  private loaded = false;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(private readonly path = CACHE_PATH) {}

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const file = JSON.parse(readFileSync(this.path, "utf8")) as CacheFile;
      if (file.version === SCAN_CACHE_VERSION && file.entries && typeof file.entries === "object")
        this.entries = new Map(Object.entries(file.entries));
    } catch {
      // Missing, corrupt, or foreign-version snapshots all start cold.
    }
  }

  /** The cached parse of a file, cloned and re-tagged for its scan target. */
  get(path: string, stat: Stats, project?: UsageProjectRef): UsageSessionInput | undefined {
    this.load();
    const entry = this.entries.get(path);
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size)
      return undefined;
    return { ...cloneRecords(entry.session), ...(project ? { project } : {}) };
  }

  set(path: string, stat: Stats, session: UsageSessionInput) {
    this.load();
    this.entries.set(path, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      session: stripProject(session),
    });
    // Map order is insertion order: drop the longest-unused entries first.
    for (const key of this.entries.keys()) {
      if (this.entries.size <= SCAN_CACHE_MAX) break;
      this.entries.delete(key);
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const file: CacheFile = { version: SCAN_CACHE_VERSION, entries: Object.fromEntries(this.entries) };
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(file));
      renameSync(tmp, this.path);
    } catch (e) {
      debugLog("usage scan cache: flush", e);
    }
  }
}

/** The process-wide scan cache; panel scans in any project share it. */
export const usageScanCache = new UsageScanCache();
