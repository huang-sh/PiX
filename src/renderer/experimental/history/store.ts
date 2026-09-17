import { reactive, readonly } from "vue";
import { i18n } from "../../i18n";

/**
 * Linear in-memory undo/redo journal for management operations.
 *
 * Entries are either undoable (carry forward and inverse closures) or lock
 * entries (irreversible — seal everything below them). The cursor separates
 * applied entries [0..cursor) from undone ones [cursor..].
 *
 * A serialised promise queue makes rapid undo presses execute in order so
 * the cursor never moves under an in-flight closure. Appends that land
 * while a walk is in flight are deferred onto the same queue so the walk's
 * cursor writes land first.
 */

export type HistoryKind =
  | "pin"
  | "archiveSession"
  | "archiveDirectory"
  | "restoreSession"
  | "restoreDirectory"
  | "renameSession"
  | "addDirectory"
  | "removeDirectory"
  | "createSession"
  | "deleteSession"
  | "sendPrompt"
  | "deleteTurn"
  | "abortRun";

export interface HistoryEntry {
  id: number;
  time: number;
  backend: string;
  kind: HistoryKind;
  label: string;
  undoable: boolean;
  /** True when the last undo/redo attempt on this entry failed. */
  failed: boolean;
  undo?: () => Promise<boolean>;
  redo?: () => Promise<boolean>;
}

interface HistoryState {
  entries: HistoryEntry[];
  /** entries[0..cursor) are applied; [cursor..] are undone and redoable. */
  cursor: number;
  toast: string | null;
  panelOpen: boolean;
  busy: boolean;
}

const MAX_ENTRIES = 200;

const state = reactive<HistoryState>({
  entries: [],
  cursor: 0,
  toast: null,
  panelOpen: false,
  busy: false,
});

export const history = readonly(state);

let nextId = 1;

/** Reset all mutable state to initial values.  For tests only. */
export function resetForTest(): void {
  state.entries.length = 0;
  state.cursor = 0;
  state.toast = null;
  state.panelOpen = false;
  state.busy = false;
  nextId = 1;
  // Drain any pending walk so subsequent operations start clean.
  queue = Promise.resolve();
  pending = 0;
}

// ── entry management ──────────────────────────────────────────────────

function truncateRedo(): void {
  if (state.cursor < state.entries.length) state.entries.splice(state.cursor);
}

/**
 * A walk is mid-flight when pending > 0. Its cursor writes can span seconds
 * of IPC; if a fresh op cuts in front and resets the cursor, the journal
 * misreads the just-performed op as undone. Appends are chained onto the
 * same queue so they land strictly after the walk finishes.
 */
function pushEntry(entry: HistoryEntry): HistoryEntry {
  if (pending > 0) {
    queue = queue.then(() => {
      appendEntry(entry);
    });
    return entry;
  }
  appendEntry(entry);
  return entry;
}

function appendEntry(entry: HistoryEntry): void {
  truncateRedo();
  state.entries.push(entry);
  if (state.entries.length > MAX_ENTRIES) {
    state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  }
  state.cursor = state.entries.length;
}

/**
 * Record an undoable operation. Any new operation truncates the redo
 * segment — standard linear-history rule, same as editors/Photoshop.
 */
export function track(spec: {
  kind: HistoryKind;
  label: string;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
}): HistoryEntry {
  truncateRedo();
  return pushEntry({
    id: nextId++,
    time: Date.now(),
    backend: "pi",
    kind: spec.kind,
    label: spec.label,
    undoable: true,
    failed: false,
    undo: spec.undo,
    redo: spec.redo,
  });
}

/** Record an irreversible operation: visible in the journal, seals everything below. */
export function trackEvent(spec: {
  kind: HistoryKind;
  label: string;
}): HistoryEntry {
  truncateRedo();
  return pushEntry({
    id: nextId++,
    time: Date.now(),
    backend: "pi",
    kind: spec.kind,
    label: spec.label,
    undoable: false,
    failed: false,
  });
}

// ── feedback ──────────────────────────────────────────────────────────

const NOTICE_MS = 4000;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function notice(text: string): void {
  state.toast = text;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    if (state.toast === text) state.toast = null;
  }, NOTICE_MS);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── undo / redo walks ─────────────────────────────────────────────────

/**
 * Undo entries from the cursor down to `toIdx` inclusive. Stops at the
 * first lock, silent refusal, or failure — partial walk keeps whatever
 * progress it made.
 */
async function undoRange(toIdx: number): Promise<boolean> {
  let last: HistoryEntry | null = null;
  let stopped: string | null = null;
  while (state.cursor - 1 >= toIdx) {
    const entry = state.entries[state.cursor - 1];
    if (!entry) break;
    if (!entry.undoable || !entry.undo) {
      stopped = i18n.global.t("history.locked", { label: entry.label });
      break;
    }
    try {
      if (!(await entry.undo())) break;
      entry.failed = false;
      state.cursor -= 1;
      last = entry;
    } catch (error) {
      entry.failed = true;
      stopped = i18n.global.t("history.undoFailed", { reason: messageOf(error) });
      break;
    }
  }
  // Why the walk stopped short outranks any earlier success notice.
  if (stopped) notice(stopped);
  else if (last) notice(i18n.global.t("history.undone", { label: last.label }));
  return last !== null;
}

/** Redo entries from the cursor up to `toIdx` inclusive. */
async function redoRange(toIdx: number): Promise<boolean> {
  let last: HistoryEntry | null = null;
  let stopped: string | null = null;
  while (state.cursor <= toIdx && state.cursor < state.entries.length) {
    const entry = state.entries[state.cursor];
    if (!entry?.redo) break;
    try {
      if (!(await entry.redo())) break;
      entry.failed = false;
      state.cursor += 1;
      last = entry;
    } catch (error) {
      entry.failed = true;
      stopped = i18n.global.t("history.redoFailed", { reason: messageOf(error) });
      break;
    }
  }
  if (stopped) notice(stopped);
  else if (last) notice(i18n.global.t("history.redone", { label: last.label }));
  return last !== null;
}

/**
 * Only one walk at a time: rapid undo presses and panel clicks queue up and
 * execute in order, so the cursor never moves under an in-flight closure.
 */
let queue: Promise<void> = Promise.resolve();
let pending = 0;

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  pending += 1;
  state.busy = true;
  const run = queue.then(fn).finally(() => {
    pending -= 1;
    if (pending === 0) state.busy = false;
  });
  // Swallow completion/rejection so subsequent queued tasks run regardless.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Undo the newest `n` applied entries; Cmd/Ctrl+Z is undoSteps(1). */
export function undoSteps(n = 1): Promise<boolean> {
  return enqueue(() => undoRange(Math.max(0, state.cursor - n)));
}

/** Redo the oldest `n` undone entries; Cmd/Ctrl+Shift+Z is redoSteps(1). */
export function redoSteps(n = 1): Promise<boolean> {
  return enqueue(() => redoRange(Math.min(state.entries.length - 1, state.cursor + n - 1)));
}

/** Undo until the named entry is undone too (panel row click). */
export function undoTo(id: number): Promise<boolean> {
  return enqueue(async () => {
    const idx = state.entries.findIndex((entry) => entry.id === id);
    if (idx < 0 || idx >= state.cursor) return false;
    return undoRange(idx);
  });
}

/** Redo until the named entry is applied again (panel row click). */
export function redoTo(id: number): Promise<boolean> {
  return enqueue(async () => {
    const idx = state.entries.findIndex((entry) => entry.id === id);
    if (idx < 0 || idx < state.cursor) return false;
    return redoRange(idx);
  });
}

// ── panel / depth helpers ─────────────────────────────────────────────

/** Consecutive undoable entries at the top of the applied stack — the badge number. */
export function undoDepth(): number {
  let depth = 0;
  for (let i = state.cursor - 1; i >= 0; i -= 1) {
    if (!state.entries[i]?.undoable) break;
    depth += 1;
  }
  return depth;
}

export function redoDepth(): number {
  return state.entries.length - state.cursor;
}

/**
 * Newest applied lock (irreversible entry): it and everything below it are
 * sealed. -1 = nothing sealed.
 */
export function lockIndex(): number {
  for (let i = state.cursor - 1; i >= 0; i -= 1) {
    if (!state.entries[i]?.undoable) return i;
  }
  return -1;
}

export function togglePanel(): void {
  state.panelOpen = !state.panelOpen;
}

export function closePanel(): void {
  state.panelOpen = false;
}
