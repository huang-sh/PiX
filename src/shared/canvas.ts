import type { NodePromptOverride, PromptImage } from "./types.js";
import { validatePromptImages } from "./images.js";

export const CANVAS_ACTIONS = {
  inspect: "Read the current project/session, selected nodes, draft, models, personas, run/queue state and viewport. Nodes are paginated with offset/limit. Returns the context required by every other action.",
  read: "Read a node's conversation and live activity (nodeId, optional limit).",
  newSession: "Create a new graph session, like the canvas New session button.",
  select: "Select a node and show its conversation (nodeId).",
  highlight: "Highlight a node without changing the conversation (nodeId).",
  openPanel: "Open a node's branch in a side-by-side chat column (nodeId).",
  closePanel: "Close a side-by-side chat column (nodeId).",
  compose: "Create/open an unsent draft after nodeId; null starts a root. direction up/down chooses the branch lane. Optional text, images, provider/modelId, thinkingLevel and promptOverride fill the draft. Does not execute it.",
  draft: "Edit the open draft: text, images, provider/modelId, thinkingLevel or promptOverride. Does not submit.",
  cancelDraft: "Close the unsent canvas draft.",
  submit: "Submit the open canvas draft, optionally replacing its text/images/model/thinking/persona. Creates a real task node and starts its agent.",
  send: "Send text/images after explicit nodeId (null for a root), creating and submitting a draft. Sending again from a node that already has children creates another branch. Optional direction, provider/modelId, thinkingLevel, promptOverride.",
  retry: "Reopen a failed node's original message as a draft; submit separately (nodeId).",
  stop: "Stop the run belonging to nodeId, leaving other branches running.",
  followUp: "Queue text/images for the running branch at nodeId.",
  steer: "Send steering text/images to the running branch at nodeId.",
  editQueued: "Edit queued message queueId on nodeId's running branch (text).",
  removeQueued: "Remove queued message queueId on nodeId's running branch.",
  steerQueued: "Promote queued message queueId to steering on nodeId's running branch.",
  clearQueue: "Clear queued messages on nodeId's running branch.",
  label: "Set/clear a node's label (nodeId, text).",
  delete: "Permanently delete a node using the same running-task protections as the canvas (nodeId).",
  export: "Export the branch through nodeId into a separate session.",
  recover: "Reopen the current session after a storage error.",
  search: "Search node contents and show matching IDs (text; empty text closes search).",
  filter: "Set the canvas filter (filter).",
  move: "Move a node to canvas x/y; branch=true moves its descendants too (nodeId).",
  viewport: "Pan/zoom the canvas using x/y/zoom (zoom 0.25–1.6).",
  center: "Center a node at a readable zoom (nodeId optional).",
  tidy: "Restore automatic branch layout and center the selected node.",
  minimap: "Show/hide the graph minimap (enabled).",
} as const;

export type CanvasAction = keyof typeof CANVAS_ACTIONS;
export interface CanvasCommand {
  action: CanvasAction;
  context?: string;
  nodeId?: string | null;
  text?: string;
  images?: PromptImage[];
  direction?: "up" | "down";
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  promptOverride?: NodePromptOverride | null;
  queueId?: string;
  filter?: string;
  x?: number;
  y?: number;
  zoom?: number;
  branch?: boolean;
  enabled?: boolean;
  offset?: number;
  limit?: number;
}

/** Validate at both ends: a tool schema is not an IPC trust boundary. */
export function canvasCommand(value: unknown): CanvasCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a canvas command");
  const v = value as Record<string, unknown>;
  if (typeof v.action !== "string" || !Object.hasOwn(CANVAS_ACTIONS, v.action)) throw new Error("Unknown canvas action");
  if (v.action !== "inspect" && (typeof v.context !== "string" || !v.context)) throw new Error("Inspect the canvas first and provide its context");
  for (const key of ["context", "text", "provider", "modelId", "thinkingLevel", "queueId", "filter"])
    if (v[key] !== undefined && typeof v[key] !== "string") throw new Error(`${key} must be a string`);
  if (v.nodeId !== undefined && v.nodeId !== null && (typeof v.nodeId !== "string" || !v.nodeId)) throw new Error("Invalid nodeId");
  for (const key of ["x", "y", "zoom", "offset", "limit"])
    if (v[key] !== undefined && (typeof v[key] !== "number" || !Number.isFinite(v[key]))) throw new Error(`${key} must be finite`);
  for (const key of ["branch", "enabled"])
    if (v[key] !== undefined && typeof v[key] !== "boolean") throw new Error(`${key} must be boolean`);
  if (v.direction !== undefined && v.direction !== "up" && v.direction !== "down") throw new Error("Invalid branch direction");
  if (v.offset !== undefined && (!Number.isSafeInteger(v.offset) || (v.offset as number) < 0)) throw new Error("Invalid offset");
  if (v.limit !== undefined && (!Number.isSafeInteger(v.limit) || (v.limit as number) < 1 || (v.limit as number) > 200)) throw new Error("limit must be 1–200");
  if (v.promptOverride !== undefined && v.promptOverride !== null) {
    const p = v.promptOverride as NodePromptOverride;
    if (typeof p.name !== "string" || !["append", "replace", "strict"].includes(p.mode)) throw new Error("Invalid persona override");
  }
  return { ...v, ...(v.images !== undefined ? { images: validatePromptImages(v.images) } : {}) } as unknown as CanvasCommand;
}

export const CANVAS_TOOL_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: Object.keys(CANVAS_ACTIONS) },
    context: { type: "string", description: "Exact context returned by inspect. Refresh it after changing session." },
    nodeId: { type: ["string", "null"], description: "Exact node ID from inspect; null means a root draft." },
    text: { type: "string" },
    images: { type: "array", items: { type: "object", properties: { type: { const: "image" }, mimeType: { type: "string" }, data: { type: "string" } }, required: ["type", "mimeType", "data"] } },
    direction: { type: "string", enum: ["up", "down"] },
    provider: { type: "string" }, modelId: { type: "string" }, thinkingLevel: { type: "string" },
    promptOverride: { anyOf: [{ type: "null" }, { type: "object", properties: { name: { type: "string" }, mode: { type: "string", enum: ["append", "replace", "strict"] } }, required: ["name", "mode"] }] },
    queueId: { type: "string" }, filter: { type: "string" },
    x: { type: "number" }, y: { type: "number" }, zoom: { type: "number", minimum: 0.25, maximum: 1.6 },
    branch: { type: "boolean" }, enabled: { type: "boolean" },
    offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 },
  },
  required: ["action"], additionalProperties: false,
};
