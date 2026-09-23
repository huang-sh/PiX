import { appendFile, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { pixHome } from "./paths.js";

// Rotate at 1 MiB so a failure loop cannot grow the file without bound; the
// previous generation stays in main.log.old until the next rotation.
export const MAX_BYTES = 1_048_576;
const MAX_DETAIL = 1_024;

// The remote host shares its machine with its owner, so the desktop owns the log
// file and the host keeps reporting on stderr instead (docs/log.md §1).
let enabled = true;

/** Turns file logging off for processes that must not leave files behind. */
export function setDebugLogEnabled(value: boolean) {
  enabled = value;
}

export const logFile = () => join(pixHome(), ".pix", "log", "main.log");

const describe = (error: unknown) => {
  if (error === undefined) return "";
  // The stack names the throwing frame as well as the message; either spelling
  // folds onto one line so a failure stays one greppable log entry.
  const text = error instanceof Error && error.stack ? error.stack : String(error);
  return text.replace(/\s+/gu, " ").slice(0, MAX_DETAIL);
};

/**
 * Appends one timestamped line to the main-process debug log and never throws,
 * so best-effort code paths can record why they bailed out without changing
 * their failure semantics. Every call measures the file instead of caching
 * state, so another process or a hand-cleaned folder cannot desync it.
 */
export function debugLog(context: string, error?: unknown) {
  if (!enabled) return;
  try {
    const file = logFile();
    mkdirSync(dirname(file), { recursive: true });
    let size = 0;
    try { size = statSync(file).size; } catch { /* the append below creates it */ }
    if (size > MAX_BYTES) {
      // A locked main.log.old skips this rotation instead of failing the write;
      // the next line re-reads the size and tries again.
      try { renameSync(file, `${file}.old`); } catch { /* keep appending */ }
    }
    const detail = describe(error);
    const line = `${new Date().toISOString()} [${context}]${detail ? ` ${detail}` : ""}\n`;
    appendFile(file, line, () => {});
  } catch {
    // Logging must never break the caller: a read-only or full disk drops the line.
  }
}
