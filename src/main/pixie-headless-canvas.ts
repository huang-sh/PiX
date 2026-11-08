import type { CanvasCommand } from "../shared/canvas.js";
import type { AgentControl, ProjectInfo, SessionSnapshot, SessionSummary } from "../shared/types.js";

/**
 * Canvas answers without a desktop view: terminal-driven Pixie turns address
 * the host's session tree directly. Branch work (inspect, new_session, read,
 * delegate, steer, follow_up, stop) mirrors the renderer's semantics; view,
 * draft and panel operations belong to a visible canvas and fail with a clear
 * reason. Delegation itself never arrives here — PixieRuntime resolves it
 * through inspect and the shared task journal.
 */
export interface HeadlessCanvasDeps {
  project(): ProjectInfo | null;
  listSessions(): Promise<SessionSummary[]>;
  openSession(path: string): Promise<SessionSnapshot>;
  createSession(): Promise<SessionSnapshot>;
  control(path: string, input: AgentControl): Promise<SessionSnapshot>;
  read(path: string, leafId: string, limit?: number): Promise<unknown>;
}

const nodeSummary = (snapshot: SessionSnapshot, id: string) => {
  const node = snapshot.projection.nodes.find(node => node.id === id);
  if (!node) throw new Error(`Canvas node not found: ${id}. Inspect the canvas for current IDs.`);
  return { id: node.id, parentId: node.parentId, title: node.title,
    label: node.label, preview: node.preview.slice(0, 240), ...(node.preview.length > 240 ? { previewTruncated: true } : {}),
    running: node.running, hasError: node.hasError,
    forkable: node.forkable, continuable: node.continuable };
};

export function headlessCanvas(deps: HeadlessCanvasDeps) {
  /** The addressed session; lazily the project's most recently modified one. */
  let currentPath: string | undefined;
  const resolvePath = async () => currentPath ??= (await deps.listSessions())
    .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))[0]?.path;
  const context = () => `h:${currentPath ?? ""}`;
  const checkContext = (command: CanvasCommand) => {
    if (command.context !== context()) throw new Error("The canvas session changed. Inspect it again before acting.");
  };
  const scope = (snapshot: SessionSnapshot) => ({ context: context(), project: deps.project(),
    session: { id: snapshot.session.id, path: snapshot.session.path }, available: snapshot.runtime.available });
  /** The running run of a node's branch, mirroring the renderer's queue target. */
  const runningRun = (snapshot: SessionSnapshot, nodeId: string) => {
    const node = snapshot.projection.nodes.find(node => node.id === nodeId);
    if (!node) throw new Error(`Canvas node not found: ${nodeId}. Inspect the canvas for current IDs.`);
    const run = snapshot.graph?.runs.find(run => run.branchId === (node.branchId ?? "main") && run.status === "running");
    if (!run) throw new Error("That branch is no longer running");
    return { graphId: snapshot.graph!.id, branchId: run.branchId, runId: run.runId };
  };

  return async (command: CanvasCommand): Promise<unknown> => {
    if (command.action === "inspect") {
      const path = await resolvePath();
      if (!path) return { context: context(), project: deps.project(), session: null, available: false,
        selectedNodeId: null, nodes: [], totalNodes: 0, offset: command.offset ?? 0, nextOffset: null, runs: [] };
      const snapshot = await deps.openSession(path);
      const offset = command.offset ?? 0, limit = command.limit ?? 40;
      const nodes = snapshot.projection.nodes;
      return { selectedNodeId: null, ...scope(snapshot),
        nodes: nodes.slice(offset, offset + limit).map(node => nodeSummary(snapshot, node.id)),
        totalNodes: nodes.length, offset, nextOffset: offset + limit < nodes.length ? offset + limit : null,
        runs: snapshot.graph?.runs.map(run => ({ nodeId: run.nodeId ?? `pending:${run.runId}`, status: run.status, error: run.error })) ?? [] };
    }
    // newSession is how an empty project gets its first session; it must not
    // be blocked by the no-session guard below.
    if (command.action === "newSession") {
      checkContext(command);
      const snapshot = await deps.createSession();
      currentPath = snapshot.session.path;
      return { ok: true, action: command.action, ...scope(snapshot) };
    }
    const path = await resolvePath();
    if (!path) throw new Error("No session exists yet; create one with canvas_new_session");
    checkContext(command);
    const snapshot = await deps.openSession(path);
    switch (command.action) {
      case "read": {
        const node = snapshot.projection.nodes.find(node => node.id === command.nodeId);
        if (!node) throw new Error(`Canvas node not found: ${command.nodeId ?? "(missing nodeId)"}. Inspect the canvas for current IDs.`);
        const history = await deps.read(path, node.leafEntryId ?? snapshot.session.id, command.limit ?? 40) as {
          messages: unknown[]; hasEarlier?: boolean };
        return { context: context(), node: nodeSummary(snapshot, node.id),
          messages: history.messages, hasEarlier: history.hasEarlier };
      }
      case "steer": case "followUp": {
        if (!command.text?.trim() && !command.images?.length) throw new Error("Provide text or images");
        await deps.control(path, snapshot.graph
          ? { action: command.action, text: command.text ?? "", images: command.images, ...runningRun(snapshot, command.nodeId!) }
          : { action: command.action, text: command.text ?? "", images: command.images });
        return { ok: true, context: context(), action: command.action, nodeId: command.nodeId };
      }
      case "stop": {
        await deps.control(path, snapshot.graph
          ? { action: "branchAbort", ...runningRun(snapshot, command.nodeId!) }
          : { action: "abort" });
        return { ok: true, context: context(), action: command.action, nodeId: command.nodeId };
      }
      default:
        throw new Error(`This headless context cannot ${command.action}; that operation needs the desktop canvas`);
    }
  };
}
