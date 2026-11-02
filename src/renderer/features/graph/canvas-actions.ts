import { nextTick } from "vue";
import type { CanvasCommand } from "../../../shared/canvas";
import { GRAPH_FILTERS } from "../../../shared/graph-filter";
import type { GraphFilter, RuntimeModel } from "../../../shared/types";
import type { ComposerDraft } from "../../components/PromptComposer.vue";
import { useSessionStore } from "../../stores/session";
import { useLayoutStore } from "../../stores/layout";
import { useWorkspaceStore } from "../../stores/workspace";

export interface CanvasView {
  context(): string;
  draft(): { visible: boolean; parentId: string | null; state: ComposerDraft; model?: RuntimeModel | null; thinkingLevel: string };
  viewport(): { x: number; y: number; zoom: number } | undefined;
  positions(): Array<{ id: string; x: number; y: number }>;
  filter(): GraphFilter;
  search(): { text: string; hits: string[] };
  compose(id: string | null, direction?: "up" | "down"): Promise<void>;
  rebuild(): void;
  model(model: RuntimeModel): Promise<void>;
  thinking(level: string): void;
  cancel(): void;
  submit(): Promise<boolean>;
  retry(id: string): Promise<void>;
  select(id: string): Promise<void>;
  openPanel(id: string): void;
  delete(id: string): Promise<void>;
  export(id: string): Promise<unknown>;
  canLabel(id: string): boolean;
  setFilter(filter: GraphFilter): void;
  setSearch(text: string): Promise<void>;
  move(id: string, x: number, y: number, branch: boolean): void;
  setViewport(viewport: { x: number; y: number; zoom: number }): Promise<unknown>;
  center(id?: string): Promise<void>;
  tidy(): Promise<void>;
}

/** Agent and pointer actions share the actual canvas/store operations. */
export function createCanvasActions(view: CanvasView) {
  const session = useSessionStore(), layout = useLayoutStore(), workspace = useWorkspaceStore();
  function inspect(command: CanvasCommand) {
    const current = session.current, nodes = current?.projection.nodes ?? [];
    const offset = command.offset ?? 0, limit = command.limit ?? 100;
    const draft = view.draft();
    return {
      context: view.context(), project: workspace.project, session: current?.session ?? null,
      graphId: current?.graph?.id, available: current?.runtime.available ?? false,
      selectedNodeId: session.highlightedNode || session.focusedNode,
      focusedNodeId: session.focusedNode, activeNodeId: current?.projection.activeNodeId,
      nodes: nodes.slice(offset, offset + limit).map(node => ({ ...node, preview: node.preview.slice(0, 1000), rawEntryIds: undefined })),
      totalNodes: nodes.length, offset, nextOffset: offset + limit < nodes.length ? offset + limit : null,
      runs: current?.graph?.runs.map(run => ({ branchId: run.branchId, runId: run.runId, nodeId: run.nodeId, status: run.status,
        targetNodeId: run.nodeId ?? `pending:${run.runId}`,
        pending: run.pending, error: run.error, queuedMessages: run.runtime?.queuedMessages })),
      draft: { visible: draft.visible, parentId: draft.parentId, text: draft.state.text, imageCount: draft.state.images.length,
        busy: draft.state.busy, error: draft.state.error, model: draft.model, thinkingLevel: draft.thinkingLevel, promptOverride: draft.state.promptOverride },
      models: session.models, personas: layout.settings?.app.personas ?? [],
      chatColumns: layout.chatColumns, viewport: view.viewport(), positions: view.positions().slice(offset, offset + limit),
      filter: view.filter(), filters: GRAPH_FILTERS, search: view.search(), minimap: layout.layout.minimap,
    };
  }
  function node(id: string | null | undefined) {
    const found = session.current?.projection.nodes.find(node => node.id === id);
    if (!found) throw new Error(`Canvas node not found: ${id ?? "(missing nodeId)"}. Inspect the canvas for current IDs.`);
    return found;
  }
  function target(id: string | null | undefined) {
    if (id === undefined) throw new Error("Specify nodeId; use null explicitly for a root");
    if (id !== null && node(id).forkable === false) throw new Error("This node cannot start a new branch");
    if (!session.current?.runtime.available) throw new Error("The current session is read-only or unavailable");
    if (!session.current.graph && (session.current.runtime.isStreaming || session.pendingPrompt)) throw new Error("The current session is still running");
    return id;
  }
  function checkContext(command: CanvasCommand) {
    if (command.context !== view.context()) throw new Error("The canvas session changed. Inspect it again before acting.");
  }
  function text(command: CanvasCommand) {
    if (command.text === undefined) throw new Error("text is required");
    return command.text;
  }
  function queueTarget(command: CanvasCommand) {
    if (!session.current?.graph) { node(command.nodeId); return {}; }
    const run = session.runFor(command.nodeId ?? null);
    if (!run || run.status !== "running") throw new Error("That branch is no longer running");
    return { graphId: session.current.graph.id, branchId: run.branchId, runId: run.runId };
  }
  async function editDraft(command: CanvasCommand) {
    const draft = view.draft();
    if (!draft.visible) throw new Error("Open a draft with compose first");
    if (draft.state.busy || draft.state.readingImages) throw new Error("The draft is busy");
    if (command.provider !== undefined || command.modelId !== undefined) {
      const model = session.models.find(model => model.provider === command.provider && model.id === command.modelId);
      if (!model) throw new Error("Choose provider/modelId from inspect's models list");
      await view.model(model);
      checkContext(command);
    }
    if (command.thinkingLevel !== undefined) view.thinking(command.thinkingLevel);
    if (command.promptOverride !== undefined) {
      if (command.promptOverride && !layout.settings?.app.personas?.some(persona => persona.name === command.promptOverride?.name))
        throw new Error("Choose an existing persona from inspect");
      draft.state.promptOverride = command.promptOverride;
    }
    if (command.text !== undefined) draft.state.text = command.text;
    if (command.images !== undefined) draft.state.images = command.images;
    view.rebuild();
  }
  return async (command: CanvasCommand): Promise<unknown> => {
    if (command.action === "inspect") return inspect(command);
    checkContext(command);
    let result: unknown;
    switch (command.action) {
      case "read": {
        const value = node(command.nodeId);
        return { context: view.context(), node: value, ...session.messageWindowFor(value.id, command.limit ?? 40), activity: session.activityFor(value.id) };
      }
      case "newSession":
        if (!workspace.project) throw new Error("Open a project before creating a session");
        if (session.creating) throw new Error("A new session is already being prepared");
        await session.create(); break;
      case "select": await view.select(node(command.nodeId).id); break;
      case "highlight": session.highlightedNode = node(command.nodeId).id; break;
      case "openPanel":
        if (!session.current?.graph) throw new Error("Side panels require a graph session");
        view.openPanel(node(command.nodeId).id); break;
      case "closePanel": layout.closeChatColumn(node(command.nodeId).id); break;
      case "compose": case "send":
        if (view.draft().state.busy) throw new Error("The draft is being submitted");
        if (command.action === "send" && !command.text?.trim() && !command.images?.length) throw new Error("Provide text or images to send");
        await view.compose(target(command.nodeId), command.direction);
        checkContext(command);
        await editDraft(command);
        if (command.action === "compose") break;
        // send uses the same visible draft and submission path as the human.
        if (!await view.submit()) throw new Error(view.draft().state.error || "The task could not be submitted");
        result = { submitted: true, nodeId: session.focusedNode }; break;
      case "draft": await editDraft(command); break;
      case "submit": {
        await editDraft(command);
        const draft = view.draft(); target(draft.parentId);
        if (!draft.state.text.trim() && !draft.state.images.length && !draft.state.files?.length) throw new Error("The draft is empty");
        if (!await view.submit()) throw new Error(draft.state.error || "The task could not be submitted");
        result = { submitted: true, nodeId: session.focusedNode }; break;
      }
      case "cancelDraft":
        if (view.draft().state.busy) throw new Error("The draft is being submitted");
        view.cancel(); break;
      case "retry": {
        const value = node(command.nodeId); target(value.id);
        if (!value.hasError) throw new Error("Only a failed node can be retried");
        await view.retry(value.id); break;
      }
      case "stop": {
        const scope = queueTarget(command);
        await session.control("runId" in scope ? { action: "branchAbort", branchId: scope.branchId, runId: scope.runId } : { action: "abort" }); break;
      }
      case "followUp": case "steer":
        if (!command.text?.trim() && !command.images?.length) throw new Error("Provide text or images");
        await session.control({ action: command.action, text: command.text ?? "", images: command.images, ...queueTarget(command) }); break;
      case "editQueued": case "removeQueued": case "steerQueued":
        if (!command.queueId) throw new Error("queueId is required");
        await session.control({ action: "updateQueuedMessage", id: command.queueId,
          operation: command.action === "editQueued" ? "edit" : command.action === "removeQueued" ? "remove" : "steer",
          ...(command.action === "editQueued" ? { text: text(command) } : {}), ...queueTarget(command) }); break;
      case "clearQueue": await session.control({ action: "clearQueue", ...queueTarget(command) }); break;
      case "label": {
        const value = node(command.nodeId);
        if (!view.canLabel(value.id)) throw new Error("This node cannot be labeled while its branch is running or read-only");
        await session.control({ action: "setLabel", entryId: value.userEntryId, label: text(command) }); break;
      }
      case "delete":
        if (session.deleteBlockedReason) throw new Error(session.deleteBlockedReason);
        await view.delete(node(command.nodeId).id); break;
      case "export": {
        if (!session.current?.graph) throw new Error("Export requires a graph session");
        const value = node(command.nodeId);
        if (value.running || !session.current.runtime.available) throw new Error("That node is running or read-only");
        await view.select(value.id);
        checkContext(command);
        result = await view.export(value.id); break;
      }
      case "recover":
        if (!session.current) throw new Error("No session is open");
        await session.open(session.current.session.path); break;
      case "search": await view.setSearch(text(command)); break;
      case "filter":
        if (!GRAPH_FILTERS.includes(command.filter as GraphFilter)) throw new Error("Unknown canvas filter");
        view.setFilter(command.filter as GraphFilter); break;
      case "move":
        if (command.x === undefined || command.y === undefined) throw new Error("x and y are required");
        view.move(node(command.nodeId).id, command.x, command.y, command.branch ?? false); break;
      case "viewport": {
        const viewport = view.viewport();
        if (!viewport) throw new Error("The canvas viewport is not ready");
        const zoom = command.zoom ?? viewport.zoom;
        if (zoom < 0.25 || zoom > 1.6) throw new Error("zoom must be between 0.25 and 1.6");
        await view.setViewport({ x: command.x ?? viewport.x, y: command.y ?? viewport.y, zoom }); break;
      }
      case "center": await view.center(command.nodeId ? node(command.nodeId).id : undefined); break;
      case "tidy": await view.tidy(); break;
      case "minimap":
        if (command.enabled === undefined) throw new Error("enabled is required");
        if (layout.layout.minimap !== command.enabled) await layout.toggleMinimap(); break;
    }
    await nextTick();
    return { result, ...inspect({ action: "inspect" }) };
  };
}
