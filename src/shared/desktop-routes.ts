import type {
  DesktopRoute, ImageReference, PixiePromptCustomization, PromptImage,
  SessionHistoryWindow, SessionSnapshot, SessionSummary,
} from "./types.js";

/** Renderer-facing contracts; untrusted IPC payloads still require runtime validation. */
export interface DesktopRouteMap {
  "pixie.ensure": { input: undefined; output: SessionSnapshot };
  "pixie.send": {
    input: ({ text: string; images?: PromptImage[] } | { text?: string; images: PromptImage[] }) & {
      provider?: string; modelId?: string; thinkingLevel?: string;
      /** live drives the desktop's visible canvas; headless addresses the host's sessions directly. */
      canvas?: "headless" | "live";
    };
    output: SessionSnapshot;
  };
  "pixie.stop": { input: undefined; output: void };
  "pixie.newSession": { input: undefined; output: SessionSnapshot };
  "pixie.sessions": { input: undefined; output: { sessions: SessionSummary[] } };
  "pixie.switchSession": { input: { path: string }; output: SessionSnapshot };
  "pixie.tasks": {
    input: undefined;
    output: { tasks: Array<{ id: string; state: string; revision: number; parentTaskId?: string; nodeId?: string;
      error?: string; notification?: string; purpose: string; createdAt: string; updatedAt: string }> };
  };
  "pixie.previewPrompt": { input: PixiePromptCustomization | undefined; output: { text: string } };
  "pixie.clearHistory": { input: undefined; output: SessionSnapshot | { cancelled: true } };
  "pixie.reveal": { input: undefined; output: void };
  "pixie.reload": { input: undefined; output: void };
  "session.list": { input: undefined; output: SessionSummary[] };
  "session.image": { input: ImageReference & { thumbnail?: boolean }; output: PromptImage };
  "session.branchWindow": {
    input: { session: string; leafId?: string; limit: number; bytes: number };
    output: SessionHistoryWindow;
  };
  "session.search": { input: { session: string; query: string }; output: { nodeIds: string[] } };
  "session.prompts": { input: { session: string }; output: { prompts: string[] } };
  "session.snapshot": { input: undefined; output: SessionSnapshot | undefined };
  "session.open": { input: { path: string }; output: SessionSnapshot };
  "session.stop": { input: { path: string; projectId?: string }; output: { stopped: boolean } };
  "session.import": { input: undefined; output: { imported: string; sessions: SessionSummary[] } | null };
  "session.rename": { input: { path: string; name: string }; output: { sessions: SessionSummary[]; current?: SessionSnapshot } };
  "session.delete": {
    input: { path: string; confirmed?: boolean; pristineOnly?: boolean };
    output: { sessions: SessionSummary[]; cancelled?: true; skipped?: true };
  };
}

// Keep the route and payload correlated even when a caller holds a union of routes.
type TypedInvokeArgs = {
  [R in keyof DesktopRouteMap]: undefined extends DesktopRouteMap[R]["input"]
    ? [route: R, input?: DesktopRouteMap[R]["input"]]
    : [route: R, input: DesktopRouteMap[R]["input"]];
}[keyof DesktopRouteMap];

export interface DesktopInvoke {
  <R extends keyof DesktopRouteMap>(
    ...args: [route: R, ...input: unknown[]] & TypedInvokeArgs
  ): Promise<DesktopRouteMap[R]["output"]>;
  /** Remaining routes retain their existing API until their contracts are migrated. */
  <T = unknown>(route: Exclude<DesktopRoute, keyof DesktopRouteMap>, input?: unknown): Promise<T>;
}
