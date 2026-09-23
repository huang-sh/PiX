import { join } from "node:path";
import { pixHome } from "./paths.js";
import { atomic, readJson } from "./services.js";

/**
 * The session library: pins and archives that outlive sessions themselves.
 * Marks live in one JSON sidecar under ~/.pix — session paths are absolute
 * and project-agnostic, so one list covers local and remote sessions alike,
 * and a deleted session's stale mark simply never matches anything again.
 */
export interface LibraryMarks {
  pinned: string[];
  archivedSessions: string[];
  archivedProjects: string[];
}

const EMPTY: LibraryMarks = { pinned: [], archivedSessions: [], archivedProjects: [] };

/** Keeps only non-empty strings, first occurrence first. */
function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))];
}

export class LibraryService {
  readonly path: string;
  constructor(home = pixHome()) {
    this.path = join(home, ".pix", "library.json");
  }
  marks(): LibraryMarks {
    const raw = readJson<Record<string, unknown>>(this.path);
    return {
      pinned: normalizeList(raw.pinned),
      archivedSessions: normalizeList(raw.archivedSessions),
      archivedProjects: normalizeList(raw.archivedProjects),
    };
  }
  private save(marks: LibraryMarks) {
    atomic(this.path, marks);
  }
  private toggle(list: string[], value: string, on: boolean): string[] {
    return on
      ? list.includes(value) ? list : [...list, value]
      : list.filter((item) => item !== value);
  }
  setSessionPinned(path: string, pinned: boolean) {
    const marks = this.marks();
    this.save({ ...marks, pinned: this.toggle(marks.pinned, path, pinned) });
    return this.marks();
  }
  setSessionArchived(path: string, archived: boolean) {
    // Archiving a session unpins it: a hidden session has no list to top.
    const marks = this.marks();
    const pinned = archived ? marks.pinned.filter((item) => item !== path) : marks.pinned;
    this.save({ ...marks, pinned, archivedSessions: this.toggle(marks.archivedSessions, path, archived) });
    return this.marks();
  }
  setProjectArchived(id: string, archived: boolean) {
    const marks = this.marks();
    this.save({ ...marks, archivedProjects: this.toggle(marks.archivedProjects, id, archived) });
    return this.marks();
  }
  reset() {
    this.save(EMPTY);
    return this.marks();
  }
}
