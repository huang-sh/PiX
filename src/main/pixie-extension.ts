import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CANVAS_TOOLS, CANVAS_CORE_TOOLS, CANVAS_SKILL_TOOL, PIXIE_DEFAULT_TOOLS, canvasToolCommand, type CanvasCommand } from "../shared/canvas.js";
import { readPixieSkill } from "./pixie-skills.js";

/** The private Node IPC channel is inherited only by Pixie's own Pi subprocess. */
export function requestCanvas(command: CanvasCommand, signal?: AbortSignal): Promise<unknown> {
  if (!process.send || !process.connected) return Promise.reject(new Error("Pixie's desktop connection is unavailable"));
  if (signal?.aborted) return Promise.reject(new Error("Canvas request cancelled"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, result?: unknown) => {
      clearTimeout(timer);
      process.off("message", reply);
      process.off("disconnect", disconnected);
      signal?.removeEventListener("abort", aborted);
      error ? reject(error) : resolve(result);
    };
    const reply = (value: unknown) => {
      const message = value as { type?: string; id?: string; error?: string; result?: unknown } | null;
      if (message?.type === "pixie.canvas.reply" && message.id === id)
        finish(message.error ? new Error(message.error) : undefined, message.result);
    };
    const disconnected = () => finish(new Error("Pixie's desktop connection closed"));
    const aborted = () => finish(new Error("Canvas request cancelled; check the target canvas or task before retrying"));
    const timer = setTimeout(() => finish(new Error("Canvas request timed out; check the target canvas or task before retrying")), 300_000);
    process.on("message", reply);
    process.once("disconnect", disconnected);
    signal?.addEventListener("abort", aborted, { once: true });
    process.send!({ type: "pixie.canvas.request", id, command }, error => { if (error) finish(error); });
  });
}

export default function pixieCanvasExtension(pi: ExtensionAPI) {
  // Internal events retain their full model context without impersonating a user.
  const onTaskEvent = (value: unknown) => {
    const event = value as { type?: string; id?: string; content?: string } | null;
    if (event?.type !== "pixie.task.event" || typeof event.id !== "string") return;
    try {
      if (typeof event.content !== "string") throw new Error("Missing task event content");
      pi.sendMessage({ customType: "pixie.task-event", content: event.content, display: false }, { triggerTurn: true });
      process.send?.({ type: "pixie.task.reply", id: event.id, success: true });
    } catch (error) {
      process.send?.({ type: "pixie.task.reply", id: event.id, success: false, error: String(error) });
    }
  };
  // Session replacement reloads this extension in the same process. Its IPC
  // listener must retire before the captured ExtensionAPI becomes stale.
  pi.on("session_start", () => {
    process.off("message", onTaskEvent);
    process.on("message", onTaskEvent);
  });
  pi.on("session_shutdown", () => { process.off("message", onTaskEvent); });
  for (const tool of CANVAS_TOOLS) pi.registerTool({
    name: tool.name, label: tool.name,
    description: tool.description,
    promptSnippet: tool.description,
    defaultActive: CANVAS_CORE_TOOLS.includes(tool),
    parameters: tool.parameters as unknown as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const result = await requestCanvas(canvasToolCommand(tool.action, params), signal);
      return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }], details: {} };
    },
  });
  pi.registerTool({
    name: CANVAS_SKILL_TOOL.name, label: "Read Pixie skill",
    description: CANVAS_SKILL_TOOL.description, promptSnippet: CANVAS_SKILL_TOOL.description,
    parameters: CANVAS_SKILL_TOOL.parameters as unknown as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_id, params) {
      const skill = await readPixieSkill((params as { name: string }).name, dirname(fileURLToPath(import.meta.url)));
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...skill.tools])]);
      return { content: [{ type: "text", text: JSON.stringify(skill) }], details: {} };
    },
  });
  // Pixie coordinates through these tools; execution tools belong to graph agents.
  const resetTools = () => pi.setActiveTools(PIXIE_DEFAULT_TOOLS.map(tool => tool.name));
  pi.on("session_start", resetTools);
  pi.on("before_agent_start", resetTools);
}
