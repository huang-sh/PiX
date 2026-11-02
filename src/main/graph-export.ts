import { randomUUID } from "node:crypto";
import { GIT_BRANCH_CUSTOM_TYPE, PROMPT_DISPLAY_CUSTOM_TYPE, PROMPT_OVERRIDE_CUSTOM_TYPE, type RawSessionEntry } from "../shared/types.js";
import { promptDisplayTextMap } from "../shared/session.js";
import { encodeSession, parseStrict, type SessionData } from "./graph-files.js";
import { latestPromptOverride } from "./extensions/prompt-override.js";

export function descendantIds(entries: readonly { id: string; parentId: string | null }[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const entry of entries) if (entry.parentId) {
    const list = children.get(entry.parentId) ?? [];
    list.push(entry.id); children.set(entry.parentId, list);
  }
  const ids = new Set<string>(), pending = [rootId];
  while (pending.length) {
    const id = pending.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    pending.push(...children.get(id) ?? []);
  }
  return ids;
}

/** Detach a turn and every descendant, without carrying earlier conversations in summaries. */
export function exportSubtree(source: SessionData, userEntryId: string): SessionData {
  const byId = new Map(source.entries.map(entry => [entry.id, entry]));
  const root = byId.get(userEntryId);
  if (root?.type !== "message" || (root.message as { role?: string })?.role !== "user")
    throw new Error("Export root is not a user turn");
  const descendants = descendantIds(source.entries, userEntryId);
  const retained = new Set(descendants);
  // Carry only the active configuration across the cut, never ancestor messages.
  const settings = new Map<string, RawSessionEntry>();
  for (let entry = root.parentId ? byId.get(root.parentId) : undefined; entry;
    entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
    const key = entry.type === "model_change" || entry.type === "thinking_level_change" ? entry.type
      : entry.type === "custom" && entry.customType === PROMPT_OVERRIDE_CUSTOM_TYPE
        && latestPromptOverride([entry]) ? PROMPT_OVERRIDE_CUSTOM_TYPE : undefined;
    if (key && !settings.has(key)) settings.set(key, entry);
    // Pi also derives the current model from assistant replies, even when no
    // model_change record was written. Keep that setting without the reply.
    const message = entry.message as { role?: string; provider?: string; model?: string } | undefined;
    if (entry.type === "message" && message?.role === "assistant" && message.provider && message.model && !settings.has("model_change"))
      settings.set("model_change", { type: "model_change", id: randomUUID(), parentId: null, timestamp: entry.timestamp,
        provider: message.provider, modelId: message.model });
  }
  // Git identity belongs to this turn only, possibly separated by display
  // markers. Do not inherit another turn's repository state across the cut.
  let git = root.parentId ? byId.get(root.parentId) : undefined;
  while (git?.type === "custom" && git.customType === PROMPT_DISPLAY_CUSTOM_TYPE)
    git = git.parentId ? byId.get(git.parentId) : undefined;

  for (const entry of source.entries) {
    // Summaries can include history before the cut even when their reference is
    // inside the subtree. Keep the raw turns and rebuild context from those.
    if (entry.type === "compaction" || entry.type === "branch_summary") retained.delete(entry.id);
    if (entry.type === "label") {
      if (retained.has(String(entry.targetId))) retained.add(entry.id);
      else retained.delete(entry.id);
    }
    if (entry.type === "context_edit" && !retained.has(String(entry.targetId))) retained.delete(entry.id);
    if (entry.type === "custom" && entry.customType === PROMPT_DISPLAY_CUSTOM_TYPE
      && typeof (entry.data as { targetId?: unknown })?.targetId === "string"
      && !retained.has((entry.data as { targetId: string }).targetId)) retained.delete(entry.id);
    if (entry.type === "custom" && entry.customType === "pix.branch-metadata") retained.delete(entry.id);
  }
  const entries: RawSessionEntry[] = [];
  let prefix: string | null = null;
  const appendPrefix = (entry: RawSessionEntry) => {
    entries.push({ ...entry, parentId: prefix }); prefix = entry.id;
  };
  for (const entry of [...settings.values()].reverse()) appendPrefix(entry);
  if (git?.type === "custom" && git.customType === GIT_BRANCH_CUSTOM_TYPE) appendPrefix(git);
  // Resolve display text using the same ownership rules as the graph. A
  // target-linked copy also handles legacy records and non-adjacent markers.
  const displayText = promptDisplayTextMap(source.entries).get(root.id);
  if (displayText !== undefined) appendPrefix({ type: "custom", id: randomUUID(), parentId: null, timestamp: root.timestamp,
    customType: PROMPT_DISPLAY_CUSTOM_TYPE, data: { targetId: root.id, text: displayText } });
  for (const entry of source.entries) if (retained.has(entry.id)) {
    let parentId = entry.parentId;
    while (parentId && !retained.has(parentId)) parentId = byId.get(parentId)?.parentId ?? null;
    // Labels apply globally. Move off-path edits onto the retained tip, not
    // their target user entry: the latter would make that turn's new leaf
    // bypass its assistant reply when continuing from the exported node.
    if (entry.type === "label" && !descendants.has(entry.id)) parentId = entries.at(-1)?.id ?? prefix;
    else parentId ??= prefix;
    entries.push({ ...entry, parentId });
  }
  const result = { header: source.header, entries };
  parseStrict(encodeSession(result));
  return result;
}
