import { randomUUID } from "node:crypto";
import type { HostClient } from "../host/client.js";
import { agentMessageContent } from "../shared/agent-stream.js";
import type { ExtensionDialog, SessionSnapshot } from "../shared/types.js";

export type Run = NonNullable<SessionSnapshot["graph"]>["runs"][number];
export interface RunOptions {
  model?: string;
  thinking?: string;
  requestId?: string;
  timeout?: string;
  json?: boolean;
  detach?: boolean;
}
export interface RunView {
  signal: AbortSignal;
  agent(event: Record<string, any>): void;
  notice(message: string): void;
  snapshot(snapshot: SessionSnapshot, run: Run): void;
  dialog(dialog: ExtensionDialog): Promise<string | undefined>;
}
const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function runTask(client: HostClient, before: SessionSnapshot, text: string, node: string | null,
  options: RunOptions, view?: RunView) {
  const path = before.session.path;
  const requestId = options.requestId ?? randomUUID();
  // A command can finish without appending a new turn. Inspect only this
  // request's messages, while retries still inspect the original saved run.
  const previousEntries = new Set(before.graph?.runs.some(run => run.requestId === requestId) ? [] : before.entries.map(entry => entry.id));
  let run: Run | undefined;
  let disconnected: Error | undefined;
  let interrupted = false;
  let wroteOutput = false;
  let partialText = "";
  const buffered: Record<string, any>[] = [];
  const emitAgent = (payload: Record<string, any>) => {
    if (payload.graphId !== path || payload.runId !== run?.runId) return;
    if (view) { view.agent(payload); return; }
    if (options.json) print({ type: "agent", session: path, event: payload });
    else if (["message_start", "message_update", "message_end"].includes(payload.type) && payload.message?.role === "assistant") {
      if (payload.type === "message_start") partialText = "";
      const output = agentMessageContent(payload.message, "text");
      if (output.startsWith(partialText) && output.length > partialText.length) {
        process.stdout.write(output.slice(partialText.length)); wroteOutput = true;
      }
      partialText = output;
      if (payload.type === "message_end" && output) process.stdout.write("\n");
    } else if (payload.type === "tool_execution_start") process.stderr.write(`[${payload.toolName}]\n`);
  };
  const unsubscribe = client.onEvent(event => {
    if (event.type === "agent") {
      const payload = event.payload as Record<string, any>;
      if (!run) buffered.push(payload); else emitAgent(payload);
    } else if (event.type === "notice") {
      if (view) view.notice((event.payload as { message?: string }).message ?? "");
      else if (options.json) print({ type: "notice", notice: event.payload });
      else process.stderr.write(`${(event.payload as { message?: string }).message ?? ""}\n`);
    }
  });
  const removeDisconnect = client.onDisconnect(error => { disconnected = error; });
  const abort = () => {
    interrupted = true;
    if (run) void client.invoke("agent.control", { action: "branchAbort", branchId: run.branchId, runId: run.runId }, path).catch(() => {});
  };
  if (!view) process.once("SIGINT", abort);
  view?.signal.addEventListener("abort", abort);
  try {
    const model = options.model;
    const slash = model?.indexOf("/") ?? -1;
    if (model && (slash < 1 || slash === model.length - 1)) throw new Error("Use --model provider/model");
    const snapshot = await client.invoke<SessionSnapshot>("agent.control", {
      action: "promptAt", requestId, nodeId: node, text,
      ...(model ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) } : {}),
      ...(options.thinking ? { thinkingLevel: options.thinking } : {}),
    }, path);
    run = snapshot.graph?.runs.find(item => item.requestId === requestId);
    if (!run) throw new Error("This request was already saved or handled without starting a run. Inspect pix tree before submitting new work.");
    const submission = { type: "submitted", session: path, requestId, branchId: run.branchId, runId: run.runId };
    if (view) view.snapshot(snapshot, run);
    else if (options.json || options.detach) print(submission);
    else process.stderr.write(`Session: ${path}\nRun: ${run.branchId}/${run.runId}\n`);
    for (const event of buffered) emitAgent(event);
    if (options.detach) return { snapshot, nodeId: run.nodeId };
    if (interrupted || view?.signal.aborted) abort();
    const deadline = options.timeout ? Date.now() + Number(options.timeout) * 1000 : Infinity;
    if (options.timeout && (!Number.isFinite(Number(options.timeout)) || Number(options.timeout) <= 0)) throw new Error("--timeout must be a positive number of seconds");
    const handledDialogs = new Set<string>();
    let current = snapshot;
    for (;;) {
      if (disconnected) throw disconnected;
      const latest = current.graph?.runs.find(item => item.runId === run!.runId);
      if (!latest) throw new Error("The run changed; inspect the session before continuing");
      view?.snapshot(current, latest);
      if (latest.status !== "running") {
        const target = current.projection.nodes.find(item => item.id === latest.nodeId);
        const own = new Set(target?.rawEntryIds ?? []);
        const messages = current.entries.filter(entry => own.has(entry.id) && !previousEntries.has(entry.id) && entry.type === "message")
          .map(entry => entry.message as Record<string, any>);
        const failed = messages.find(message => message.role === "assistant" && ["error", "aborted"].includes(message.stopReason));
        const error = latest.error ?? (failed ? failed.errorMessage || `Agent ${failed.stopReason}` : undefined);
        if (error || current.graph?.storageError || latest.status === "interrupted")
          throw new Error(error ?? current.graph?.storageError ?? "Agent execution was interrupted");
        if (!view && !wroteOutput && !options.json) {
          const output = messages.filter(message => message.role === "assistant").map(message => agentMessageContent(message, "text")).filter(Boolean).join("\n");
          if (output) process.stdout.write(output + "\n");
        }
        if (options.json) print({ type: "result", session: path, requestId, branchId: latest.branchId,
          runId: latest.runId, nodeId: latest.nodeId, status: latest.status, snapshot: current });
        if (interrupted && !view) process.exitCode = 130;
        return { snapshot: current, nodeId: latest.nodeId };
      }
      if (Date.now() >= deadline) throw new Error(`Stopped waiting; task is still running. Session: ${path}; run: ${run.runId}`);
      const dialogs = await client.invoke<ExtensionDialog[]>("ui.pending");
      const ownFile = run.branchId === "main" ? path : `${path}.pix-tree/${run.branchId}.jsonl`;
      for (const dialog of dialogs.filter(dialog => dialog.sessionPath === ownFile && !handledDialogs.has(dialog.id))) {
        if (!view?.dialog) throw new Error(`Agent needs input: ${dialog.title}. Task remains pending; use pix dialogs and pix respond ${dialog.id}, or answer in the GUI.`);
        handledDialogs.add(dialog.id);
        await client.invoke("ui.respond", { id: dialog.id, value: await view.dialog(dialog) });
      }
      await delay(200);
      current = await client.invoke<SessionSnapshot>("session.snapshot", undefined, path);
    }
  } catch (error) {
    if (interrupted && error instanceof Error) Object.assign(error, { exitCode: 130 });
    throw error;
  } finally {
    unsubscribe(); removeDisconnect();
    process.removeListener("SIGINT", abort);
    view?.signal.removeEventListener("abort", abort);
  }
}
