import type { RawSessionEntry } from "./types.js";

export const FILE_CHANGE_CUSTOM_TYPE = "pix.file-change";
export interface FileChange {
  path: string;
  ref: string;
  status: "added" | "modified" | "deleted" | "unchanged";
  added: number | null;
  removed: number | null;
  reason?: "binary" | "large" | "unavailable" | "conflict";
}

// Session files can be imported. Validate metadata before using it in the UI or IPC.
export function fileChange(entry: RawSessionEntry): FileChange | undefined {
  if (entry.type !== "custom" || entry.customType !== FILE_CHANGE_CUSTOM_TYPE) return;
  const data = entry.data as FileChange | undefined;
  if (!data || typeof data.path !== "string" || !data.path ||
      typeof data.ref !== "string" || !/^[a-f0-9-]{36}$/.test(data.ref) ||
      !["added", "modified", "deleted", "unchanged"].includes(data.status) ||
      ![data.added, data.removed].every(n => n === null || (Number.isSafeInteger(n) && n! >= 0)) ||
      (data.reason !== undefined && !["binary", "large", "unavailable", "conflict"].includes(data.reason))) return;
  return data;
}

export function turnFileChanges(entries: RawSessionEntry[]): FileChange[] {
  const files = new Map<string, FileChange>();
  for (const entry of entries) {
    const change = fileChange(entry);
    if (change) files.set(change.path, change);
  }
  return [...files.values()].filter(change => change.status !== "unchanged").sort((a, b) => a.path.localeCompare(b.path));
}
