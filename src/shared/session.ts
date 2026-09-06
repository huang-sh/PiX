import type {
  BranchMessage,
  GraphEdge,
  GraphNode,
  NodeFooterState,
  RawSessionEntry,
  SessionProjection,
  SessionSummary,
} from "./types.js";
import { NODE_FOOTER_CUSTOM_TYPE } from "./types.js";
import { isPromptImage } from "./images.js";

const entryIndexes = new WeakMap<RawSessionEntry[], Map<string, RawSessionEntry>>();
export function sessionEntryIndex(entries: RawSessionEntry[]) {
  let index = entryIndexes.get(entries);
  if (!index || index.size !== entries.length) {
    index = new Map(entries.map(entry => [entry.id, entry]));
    entryIndexes.set(entries, index);
  }
  return index;
}

/** Project only the selected ancestry, rather than every sibling in the graph. */
export function projectSessionBranch(entries: RawSessionEntry[], leafId: string | null) {
  const index = sessionEntryIndex(entries);
  const path: RawSessionEntry[] = [];
  const seen = new Set<string>();
  let entry = leafId ? index.get(leafId) : undefined;
  while (entry && !seen.has(entry.id)) {
    path.push(entry); seen.add(entry.id);
    entry = entry.parentId ? index.get(entry.parentId) : undefined;
  }
  return projectSession(path.reverse(), leafId);
}
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
function contentText(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v
    .map((p) => {
      const r = rec(p);
      if (!r) return "";
      if (typeof r.text === "string") return r.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
function thinkingText(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v
    .map((part) => rec(part)?.thinking)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}
export function withoutToolLabels(value: string): string {
  return value
    .split("\n")
    .filter((line) => !/^\s*Tool:\s*\S+\s*$/i.test(line))
    .join("\n")
    .trim();
}
function msg(e: RawSessionEntry) {
  return rec(e.message);
}
function images(e: RawSessionEntry) {
  const content = msg(e)?.content;
  return Array.isArray(content) ? content.filter(isPromptImage) : [];
}
function role(e: RawSessionEntry) {
  return String(msg(e)?.role ?? e.role ?? "");
}
function text(e: RawSessionEntry) {
  const m = msg(e);
  if (m) {
    const value = contentText(m.content);
    return m.role === "assistant" ? withoutToolLabels(value) : value;
  }
  if (e.type === "branch_summary" || e.type === "compaction")
    return String(e.summary ?? "");
  if (e.type === "bash_execution") return String(e.output ?? "");
  return contentText(e.content);
}
function tool(e: RawSessionEntry) {
  const n = msg(e)?.toolName ?? e.toolName;
  return typeof n === "string" ? n : undefined;
}
function toolInput(v: unknown): string {
  if (typeof v === "string") return v;
  const args = rec(v);
  for (const key of ["command", "path", "query", "pattern", "url"]) {
    if (typeof args?.[key] === "string") return args[key];
  }
  return v === undefined ? "" : JSON.stringify(v);
}
function calls(e: RawSessionEntry) {
  const c = msg(e)?.content;
  return Array.isArray(c)
    ? c.filter((x) => rec(x)?.type === "toolCall").length
    : 0;
}
function error(e: RawSessionEntry) {
  const m = msg(e);
  return m?.isError === true || e.isError === true || m?.stopReason === "error";
}
function errorMessageText(e: RawSessionEntry) {
  if (!error(e)) return undefined;
  const value = msg(e)?.errorMessage;
  return typeof value === "string" && value.trim() ? value : undefined;
}
function modelState(current: NodeFooterState["model"], provider: string, id: string) {
  return current?.provider === provider && current.id === id ? current : { provider, id };
}
// Effective settings at a position in the tree: the runtime resolves model/thinking
// from the last change entries on the root chain, so turns must inherit the same
// values before their settled footer entry is appended (and when it never lands on
// failed or aborted turns).
interface SettingsState {
  model: NodeFooterState["model"];
  thinkingLevel: string;
}
function applySettingEntry(entry: RawSessionEntry, state: SettingsState) {
  const message = msg(entry);
  if (entry.type === "model_change") {
    const provider = typeof entry.provider === "string" ? entry.provider : "";
    const id = typeof entry.modelId === "string" ? entry.modelId : "";
    if (provider && id) state.model = modelState(state.model, provider, id);
  } else if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
    state.thinkingLevel = entry.thinkingLevel;
  } else if (entry.type === "message" && message?.role === "assistant") {
    const provider = typeof message.provider === "string" ? message.provider : "";
    const id = typeof message.model === "string" ? message.model : "";
    if (provider && id) state.model = modelState(state.model, provider, id);
  }
}
function footerState(path: RawSessionEntry[], inherited?: SettingsState): NodeFooterState | undefined {
  const state: SettingsState = {
    model: inherited?.model ?? null,
    thinkingLevel: inherited?.thinkingLevel ?? "off",
  };
  let contextUsage: NodeFooterState["contextUsage"];
  let saved = false;
  for (const entry of path) {
    if (entry.type === "custom" && entry.customType === NODE_FOOTER_CUSTOM_TYPE) {
      const data = rec(entry.data);
      const usage = rec(data?.contextUsage);
      const savedModel = rec(data?.model);
      if (usage && typeof usage.contextWindow === "number") {
        contextUsage = {
          tokens: typeof usage.tokens === "number" ? usage.tokens : null,
          contextWindow: usage.contextWindow,
          percent: typeof usage.percent === "number" ? usage.percent : null,
        };
      }
      if (savedModel && typeof savedModel.provider === "string" && typeof savedModel.id === "string")
        state.model = savedModel as unknown as NonNullable<NodeFooterState["model"]>;
      if (typeof data?.thinkingLevel === "string") state.thinkingLevel = data.thinkingLevel;
      saved = true;
    } else if (!saved) {
      applySettingEntry(entry, state);
    }
  }
  return saved || state.model
    ? { contextUsage, model: state.model, thinkingLevel: state.thinkingLevel }
    : undefined;
}
const clip = (s: string, n: number) => {
  const c = s.replace(/\s+/g, " ").trim();
  return c.length > n ? `${c.slice(0, n - 1)}…` : c;
};
export const clipText = clip;
function branchEntries(byId: Map<string, RawSessionEntry>, leaf: string | null) {
  const out: RawSessionEntry[] = [];
  const seen = new Set<string>();
  let e = leaf ? byId.get(leaf) : undefined;
  while (e && !seen.has(e.id)) {
    seen.add(e.id);
    out.push(e);
    e = e.parentId ? byId.get(e.parentId) : undefined;
  }
  return out.reverse();
}
function branch(byId: Map<string, RawSessionEntry>, leaf: string | null) {
  return branchEntries(byId, leaf).map((e) => e.id);
}
export function projectSession(
  entries: RawSessionEntry[],
  leafId: string | null,
): SessionProjection {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const toolInputs = new Map<string, string>();
  for (const entry of entries) {
    const content = msg(entry)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const call = rec(part);
      if (call?.type === "toolCall" && typeof call.id === "string")
        toolInputs.set(call.id, toolInput(call.arguments));
    }
  }
  const owners = new Map<string, string>();
  const ownedEntries = new Map<string, RawSessionEntry[]>();
  const contexts = new Map<string | null, { owner: string | null; depth: number; settings: SettingsState }>();
  contexts.set(null, { owner: null, depth: -1, settings: { model: null, thinkingLevel: "off" } });
  // Resolve each ancestor once, including records supplied out of file order.
  const context = (id: string | null) => {
    const path: RawSessionEntry[] = [];
    const seen = new Set<string>();
    let cursor = id;
    while (cursor && !contexts.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const entry = byId.get(cursor);
      if (!entry) break;
      path.push(entry);
      cursor = entry.parentId;
    }
    let value = contexts.get(cursor) ?? contexts.get(null)!;
    for (const entry of path.reverse()) {
      const user = entry.type === "message" && role(entry) === "user";
      const settings = { ...value.settings };
      applySettingEntry(entry, settings);
      value = { owner: user ? entry.id : value.owner, depth: value.depth + (user ? 1 : 0), settings };
      contexts.set(entry.id, value);
    }
    return contexts.get(id) ?? contexts.get(null)!;
  };
  for (const e of entries) {
    const o = context(e.id).owner;
    if (!o) continue;
    owners.set(e.id, o);
    const group = ownedEntries.get(o) ?? [];
    group.push(e);
    ownedEntries.set(o, group);
  }
  const users = entries.filter(
    (e) => e.type === "message" && role(e) === "user",
  );
  const nodes: GraphNode[] = users.map((e) => {
    const owned = ownedEntries.get(e.id) ?? [];
    const leafEntryId = owned.at(-1)?.id ?? e.id;
    const finalAssistantReply = owned
      .filter((x) => x.type === "message" && role(x) === "assistant")
      .at(-1);
    return {
      id: `turn:${e.id}`,
      userEntryId: e.id,
      parentId: ((p) => (p ? `turn:${p}` : null))(context(e.parentId).owner),
      title: clip(text(e), 58) || (images(e).length ? `🖼 × ${images(e).length}` : "Untitled prompt"),
      ...(images(e).length ? { imageCount: images(e).length } : {}),
      preview: clip(
        owned
          .filter((x) => role(x) === "assistant")
          .map(text)
          .filter(Boolean)
          .join(" "),
        150,
      ),
      timestamp: e.timestamp,
      rawEntryIds: owned.map((x) => x.id),
      leafEntryId,
      toolCallCount: owned.reduce((n, x) => n + calls(x), 0),
      hasError: finalAssistantReply ? error(finalAssistantReply) : false,
      depth: context(e.id).depth,
      footer: footerState(owned, context(e.parentId).settings),
    };
  });
  const edges: GraphEdge[] = nodes
    .filter((n) => n.parentId)
    .map((n) => ({
      id: `${n.parentId}->${n.id}`,
      source: n.parentId!,
      target: n.id,
    }));
  const activeBranchEntryIds = branch(byId, leafId);
  const activeBranchNodeIds: string[] = [];
  for (const id of activeBranchEntryIds) {
    const o = owners.get(id);
    const t = o ? `turn:${o}` : nodes.length === 1 ? nodes[0]!.id : null;
    if (t && activeBranchNodeIds.at(-1) !== t) activeBranchNodeIds.push(t);
  }
  const messages: BranchMessage[] = [];
  for (const id of activeBranchEntryIds) {
    const e = byId.get(id);
    if (!e) continue;
    const r = role(e);
    const o = owners.get(id);
    const turnId = o ? `turn:${o}` : (nodes[0]?.id ?? `turn:${e.id}`);
    if (e.type === "message" && (r === "user" || r === "assistant"))
      messages.push({
        entryId: id,
        turnId,
        role: r as "user" | "assistant",
        text: text(e),
        ...(r === "user" && images(e).length ? { images: images(e) } : {}),
        thinking: r === "assistant" ? thinkingText(msg(e)?.content) : undefined,
        timestamp: e.timestamp,
        isError: r === "assistant" ? error(e) || undefined : undefined,
        errorMessage: r === "assistant" ? errorMessageText(e) : undefined,
      });
    else if (
      (e.type === "message" && (r === "toolResult" || r === "tool")) ||
      e.type === "bash_execution"
    )
      messages.push({
        entryId: id,
        turnId,
        role: "tool",
        text: text(e),
        timestamp: e.timestamp,
        toolName: tool(e),
        toolInput: e.type === "bash_execution"
          ? toolInput(e.command)
          : toolInputs.get(String(msg(e)?.toolCallId ?? "")),
        isError: error(e),
      });
    else if (
      ["branch_summary", "compaction", "custom_message"].includes(e.type) &&
      text(e)
    )
      messages.push({
        entryId: id,
        turnId,
        role: "system",
        text: text(e),
        timestamp: e.timestamp,
      });
  }
  return {
    nodes,
    edges,
    activeBranchNodeIds,
    activeBranchEntryIds,
    messages,
    leafId,
    activeNodeId: activeBranchNodeIds.at(-1) ?? nodes.at(-1)?.id ?? null,
  };
}
export function entryAnchorForNode(p: SessionProjection, nodeId: string) {
  const n = p.nodes.find((x) => x.id === nodeId);
  if (!n) return null;
  const ids = new Set(n.rawEntryIds);
  for (let i = p.activeBranchEntryIds.length - 1; i >= 0; i--) {
    const id = p.activeBranchEntryIds[i];
    if (id && ids.has(id)) return id;
  }
  return n.leafEntryId;
}
export function parseSessionJsonl(raw: string) {
  const all = raw
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(`Invalid JSON on line ${i + 1}`);
      }
    });
  return {
    header: all.find((x) => x.type === "session") ?? null,
    entries: all.filter((x) => x.type !== "session") as RawSessionEntry[],
  };
}
export function summarizeSession(
  path: string,
  header: Record<string, unknown> | null,
  entries: RawSessionEntry[],
  modified: string,
): SessionSummary {
  const name = [...entries]
    .reverse()
    .find((e) => e.type === "session_info")?.name;
  const first = entries.find((e) => e.type === "message" && role(e) === "user");
  return {
    id: String(header?.id ?? path),
    path,
    name: typeof name === "string" && name.trim() ? name.trim() : undefined,
    cwd: String(header?.cwd ?? ""),
    created: String(header?.timestamp ?? entries[0]?.timestamp ?? modified),
    modified,
    messageCount: entries.filter((e) => e.type === "message").length,
    firstMessage: clip(first ? text(first) : "", 120) || "(no user message)",
  };
}
