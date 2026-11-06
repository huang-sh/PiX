import type { NodePromptOverride, PromptImage } from "./types.js";
import { validatePromptImages } from "./images.js";

export const CANVAS_ACTIONS = {
  delegate: "Dispatch an asynchronous tracked task. Requires text, purpose and acceptance. Requires a session: call canvas_new_session with inspected context if session is null. Omit nodeId to start a root task; specify an exact node ID to continue it. With taskId, omitted nodeId continues from its result. Use inspected context for a new task, or taskId to continue in that task's original project/session. branch=true forces a conversation fork. Returns task ID immediately after admission; Pixie is notified when the run settles.",
  tasks: "List durable delegations and their latest intent, status and notification state (offset/limit pagination); taskId returns task requirements and status. Works without an open canvas.",
  updateTask: "Update a delegation's purpose/acceptance, or set taskState=cancelled to cancel automatic follow-up (use canvas_stop separately to abort execution). Requires taskId. Works without an open canvas.",
  inspect: "Read a compact visible project/session, node and run summary. Use include to request models, personas, draft, layout or queue details. Returns context for visible-canvas actions. Not needed for canvas_tasks/canvas_update_task or taskId-addressed actions; unavailable in background completion turns. Nodes are paginated with offset/limit.",
  read: "Read a node's conversation and live activity (nodeId), or a saved delegation's intent, ancestor requirements and output (taskId). limit bounds messages in either mode.",
  newSession: "Create a graph session in the visible project. Requires context from canvas_inspect even when session is null. Returns the new session and a NEW context; use that returned context for subsequent canvas actions.",
  select: "Select a node and show its conversation (nodeId).",
  highlight: "Highlight a node without changing the conversation (nodeId).",
  openPanel: "Open a node's branch in a side-by-side chat column (nodeId).",
  closePanel: "Close a side-by-side chat column (nodeId).",
  compose: "Create/open an unsent draft after nodeId; omit nodeId for a root. direction up/down chooses the branch lane. Optional text, images, provider/modelId, thinkingLevel and promptOverride fill the draft. Does not execute it.",
  draft: "Edit the open draft: text, images, provider/modelId, thinkingLevel or promptOverride. Does not submit.",
  cancelDraft: "Close the unsent canvas draft.",
  submit: "Submit the open canvas draft, optionally replacing its text/images/model/thinking/persona. Creates a real task node and starts its agent.",
  send: "Send text/images after nodeId (omit for a root), creating and submitting a draft. Sending again from a node that already has children creates another branch. Optional direction, provider/modelId, thinkingLevel, promptOverride.",
  retry: "Reopen a failed node's original message as a draft; canvas_submit separately (nodeId).",
  stop: "Stop a running delegation with taskId, or a visible run with context and nodeId. Does not cancel the delegation's automatic follow-up; canvas_update_task does that.",
  followUp: "Queue text/images after a running agent's current turn. Address with taskId, or context and nodeId. For an already settled task, use canvas_delegate instead.",
  steer: "Send text/images to redirect a running agent. Address with taskId, or context and nodeId. For an already settled task, use canvas_delegate instead.",
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
  taskId?: string;
  purpose?: string;
  acceptance?: string;
  taskState?: "cancelled";
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
  include?: Array<"models" | "personas" | "draft" | "layout" | "queue">;
  offset?: number;
  limit?: number;
}

/** Validate at both ends: a tool schema is not an IPC trust boundary. */
export function canvasCommand(value: unknown): CanvasCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a canvas command");
  const v = value as Record<string, unknown>;
  if (typeof v.action !== "string" || !Object.hasOwn(CANVAS_ACTIONS, v.action)) throw new Error("Unknown canvas action");
  const taskAction = ["tasks", "updateTask"].includes(String(v.action)) || v.taskId !== undefined;
  if (v.action !== "inspect" && !taskAction && (typeof v.context !== "string" || !v.context)) throw new Error("Inspect the canvas first and provide its context");
  for (const key of ["context", "text", "provider", "modelId", "thinkingLevel", "queueId", "filter", "taskId", "purpose", "acceptance"])
    if (v[key] !== undefined && typeof v[key] !== "string") throw new Error(`${key} must be a string`);
  for (const key of ["taskId", "purpose", "acceptance"])
    if (typeof v[key] === "string" && !v[key].trim()) throw new Error(`${key} must not be empty`);
  if (v.taskId !== undefined && !["delegate", "tasks", "updateTask", "read", "steer", "followUp", "stop"].includes(String(v.action)))
    throw new Error("This action does not support taskId");
  if (v.taskId !== undefined && (v.context !== undefined || (v.nodeId !== undefined && v.action !== "delegate")))
    throw new Error("Use taskId or context/nodeId, not both (delegate may select a continuation nodeId)");
  if (v.action === "tasks" && v.taskId !== undefined && (v.offset !== undefined || v.limit !== undefined))
    throw new Error("offset/limit apply only to task listings, not a single taskId");
  if (v.include !== undefined && (v.action !== "inspect" || !Array.isArray(v.include)
    || v.include.some(item => typeof item !== "string" || !["models", "personas", "draft", "layout", "queue"].includes(item))
    || new Set(v.include).size !== v.include.length)) throw new Error("Invalid inspect include sections");
  if (v.action === "updateTask" && !v.taskId) throw new Error("taskId is required");
  if (v.taskState !== undefined && v.taskState !== "cancelled") throw new Error("Invalid taskState");
  if (v.nodeId !== undefined && v.nodeId !== null && (typeof v.nodeId !== "string" || !v.nodeId)) throw new Error("Invalid nodeId");
  if (v.nodeId === "null") throw new Error('For a root, omit nodeId or pass JSON null without quotes, not the string "null"');
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
  return { ...v,
    ...(["delegate", "compose", "send"].includes(v.action) && v.nodeId === undefined && !v.taskId ? { nodeId: null } : {}),
    ...(v.images !== undefined ? { images: validatePromptImages(v.images) } : {}) } as unknown as CanvasCommand;
}

const CANVAS_FIELDS = {
  taskId: { type: "string", description: "Stable delegation ID returned by canvas_delegate. Targets the saved project/session independently of the visible canvas." },
  purpose: { type: "string", description: "Self-contained goal, why this task is needed, relevant context and constraints; persisted across unrelated conversations and compaction." },
  acceptance: { type: "string", description: "Required deliverables and checks for deciding whether the delegated work achieved its goal." },
  taskState: { const: "cancelled", description: "Cancel automatic follow-up; does not stop the executing agent." },
  context: { type: "string", description: "Copy the latest context returned by canvas_inspect or canvas_new_session exactly. Omit when addressing a delegation with taskId." },
  nodeId: { type: ["string", "null"], description: 'Exact node ID from canvas_inspect. Omit for a root when composing/sending/delegating. With taskId, omission continues its result. JSON null also means root; never use the string "null".' },
  text: { type: "string", description: "For canvas_delegate: required execution instructions (purpose and acceptance do not replace text). Also used for draft content, steering, queued messages, labels and search." },
  images: { type: "array", items: { type: "object", properties: { type: { const: "image" }, mimeType: { type: "string" }, data: { type: "string" } }, required: ["type", "mimeType", "data"] } },
  direction: { type: "string", enum: ["up", "down"] },
  provider: { type: "string" }, modelId: { type: "string" }, thinkingLevel: { type: "string" },
  promptOverride: { anyOf: [{ type: "null" }, { type: "object", properties: { name: { type: "string" }, mode: { type: "string", enum: ["append", "replace", "strict"] } }, required: ["name", "mode"] }] },
  queueId: { type: "string" }, filter: { type: "string" },
  x: { type: "number" }, y: { type: "number" }, zoom: { type: "number", minimum: 0.25, maximum: 1.6 },
  branch: { type: "boolean" }, enabled: { type: "boolean" },
  include: { type: "array", items: { type: "string", enum: ["models", "personas", "draft", "layout", "queue"] }, uniqueItems: true, description: "Optional details; omitted returns only compact nodes and runs." },
  offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 },
} as const;

type CanvasField = keyof typeof CANVAS_FIELDS;
interface CanvasToolInput {
  fields: readonly CanvasField[];
  required?: readonly CanvasField[];
  target?: "root" | "node";
}
const promptFields = ["text", "images", "provider", "modelId", "thinkingLevel", "promptOverride"] as const;
const runFields = ["context", "nodeId", "taskId"] as const;

/** One operation, one model-facing tool, with only that operation's arguments. */
const CANVAS_TOOL_INPUTS = {
  inspect: { fields: ["offset", "limit", "include"] },
  newSession: { fields: ["context"], required: ["context"] },
  delegate: { fields: ["context", "nodeId", "taskId", "text", "images", "provider", "modelId", "thinkingLevel", "purpose", "acceptance", "branch"], required: ["text", "purpose", "acceptance"], target: "root" },
  tasks: { fields: ["taskId", "offset", "limit"] },
  updateTask: { fields: ["taskId", "purpose", "acceptance", "taskState"], required: ["taskId"] },
  read: { fields: [...runFields, "limit"], target: "node" },
  select: { fields: ["context", "nodeId"], required: ["context", "nodeId"] },
  highlight: { fields: ["context", "nodeId"], required: ["context", "nodeId"] },
  openPanel: { fields: ["context", "nodeId"], required: ["context", "nodeId"] },
  closePanel: { fields: ["context", "nodeId"], required: ["context", "nodeId"] },
  compose: { fields: ["context", "nodeId", "direction", ...promptFields], required: ["context"] },
  draft: { fields: ["context", ...promptFields], required: ["context"] },
  cancelDraft: { fields: ["context"], required: ["context"] },
  submit: { fields: ["context", ...promptFields], required: ["context"] },
  send: { fields: ["context", "nodeId", "direction", ...promptFields], required: ["context"] },
  retry: { fields: ["context", "nodeId"], required: ["context", "nodeId"] },
  stop: { fields: runFields, target: "node" },
  followUp: { fields: [...runFields, "text", "images"], target: "node" },
  steer: { fields: [...runFields, "text", "images"], target: "node" },
  editQueued: { fields: ["context", "nodeId", "queueId", "text"], required: ["context", "nodeId", "queueId", "text"] },
  removeQueued: { fields: ["context", "nodeId", "queueId"], required: ["context", "nodeId", "queueId"] },
  steerQueued: { fields: ["context", "nodeId", "queueId"], required: ["context", "nodeId", "queueId"] },
  clearQueue: { fields: ["context", "nodeId"], required: ["context", "nodeId"] },
  label: { fields: ["context", "nodeId", "text"], required: ["context", "nodeId", "text"] },
  delete: { fields: ["context", "nodeId"], required: ["context", "nodeId"] },
  export: { fields: ["context", "nodeId"], required: ["context", "nodeId"] },
  recover: { fields: ["context"], required: ["context"] },
  search: { fields: ["context", "text"], required: ["context", "text"] },
  filter: { fields: ["context", "filter"], required: ["context", "filter"] },
  move: { fields: ["context", "nodeId", "x", "y", "branch"], required: ["context", "nodeId", "x", "y"] },
  viewport: { fields: ["context", "x", "y", "zoom"], required: ["context"] },
  center: { fields: ["context", "nodeId"], required: ["context"] },
  tidy: { fields: ["context"], required: ["context"] },
  minimap: { fields: ["context", "enabled"], required: ["context", "enabled"] },
} as const satisfies Record<CanvasAction, CanvasToolInput>;

export const canvasToolName = (action: CanvasAction) => `canvas_${action.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`;

export const CANVAS_TOOLS = (Object.entries(CANVAS_TOOL_INPUTS) as Array<[CanvasAction, CanvasToolInput]>).map(([action, input]) => ({
  action,
  name: canvasToolName(action),
  description: CANVAS_ACTIONS[action],
  parameters: {
    type: "object",
    properties: Object.fromEntries(input.fields.map(field => [field, field === "nodeId" && !["delegate", "compose", "send"].includes(action)
      ? { type: "string", description: "Exact node ID returned by canvas_inspect." } : CANVAS_FIELDS[field]])),
    required: input.required ?? [],
    ...(input.target ? { oneOf: [{ required: ["taskId"] }, { required: input.target === "root" ? ["context"] : ["context", "nodeId"] }] } : {}),
    additionalProperties: false,
  },
}));

/** Auxiliary tools are declared only after Pixie reads the corresponding skill. */
export const CANVAS_SKILLS = [
  { name: "canvas-view", description: "Selection, panels, labels, search, filters and canvas layout.",
    actions: ["select", "highlight", "openPanel", "closePanel", "label", "search", "filter", "move", "viewport", "center", "tidy", "minimap"] },
  { name: "canvas-queue", description: "Edit, remove, promote or clear messages already queued on a running branch.",
    actions: ["editQueued", "removeQueued", "steerQueued", "clearQueue"] },
  { name: "canvas-editing", description: "Prepare or edit drafts, submit untracked work, reopen failed prompts and recover a session.",
    actions: ["compose", "draft", "cancelDraft", "submit", "send", "retry", "recover"] },
] as const satisfies ReadonlyArray<{ name: string; description: string; actions: readonly CanvasAction[] }>;

export const CANVAS_CORE_TOOLS = CANVAS_TOOLS.filter(tool =>
  !CANVAS_SKILLS.some(skill => (skill.actions as readonly CanvasAction[]).includes(tool.action)));

export const CANVAS_SKILL_TOOL = {
  name: "canvas_skill",
  description: `Read a built-in Pixie skill and enable its independent tools for the current turn. Load before using auxiliary tools, including again in later turns. ${CANVAS_SKILLS.map(skill => `${skill.name}: ${skill.description}`).join(" ")}`,
  parameters: {
    type: "object", properties: { name: { type: "string", enum: CANVAS_SKILLS.map(skill => skill.name) } },
    required: ["name"], additionalProperties: false,
  },
};

export const PIXIE_DEFAULT_TOOLS = [...CANVAS_CORE_TOOLS, CANVAS_SKILL_TOOL];

/** Bind the operation in code; model arguments cannot change which tool runs. */
export function canvasToolCommand(action: CanvasAction, value: unknown): CanvasCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected tool arguments");
  const input: CanvasToolInput = CANVAS_TOOL_INPUTS[action];
  const args = value as Record<string, unknown>;
  for (const key of Object.keys(args))
    if (!input.fields.includes(key as CanvasField)) throw new Error(`Unexpected argument for ${canvasToolName(action)}: ${key}`);
  for (const key of input.required ?? [])
    if (args[key] === undefined) throw new Error(`${key} is required`);
  if (input.target && !args.taskId && (!args.context || (input.target === "node" && !args.nodeId)))
    throw new Error(input.target === "root" ? "Provide context or taskId" : "Provide taskId, or context and nodeId");
  return canvasCommand({ ...args, action });
}
