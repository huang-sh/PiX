import type { DesktopEvent, DesktopRoute } from "./types.js";

export const PIX_REMOTE_PROTOCOL = 9;
export const PIX_HOST_VERSION = "0.0.7";
// Session snapshots and broker contexts include base64 images from prior turns.
export const MAX_REMOTE_PAYLOAD = 128 * 1024 * 1024;

export const PROJECT_ROUTES = [
  "session.list",
  "session.snapshot",
  "session.open",
  "session.rename",
  "session.delete",
  "agent.control",
  "workspace.tree",
  "workspace.directories",
  "workspace.open",
  "workspace.read",
  "workspace.write",
  "git.status",
  "git.diff",
  "shell.run",
  "shell.abort",
  "terminal.create",
  "terminal.write",
  "terminal.resize",
  "terminal.kill",
  "settings.get",
  "settings.update",
  "settings.reset",
] as const satisfies readonly DesktopRoute[];

export type ProjectRoute = (typeof PROJECT_ROUTES)[number];

export const isProjectRoute = (value: unknown): value is ProjectRoute =>
  typeof value === "string" &&
  (PROJECT_ROUTES as readonly string[]).includes(value);

export interface HostRequest {
  type: "request";
  id: string;
  route: ProjectRoute;
  input?: unknown;
}

export type HostResponse =
  | { type: "response"; id: string; ok: true; result: unknown }
  | {
      type: "response";
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

export interface HostHello {
  type: "hello";
  protocol: number;
  hostVersion: string;
  piVersion: string;
  platform: string;
  arch: string;
  cwd: string;
}

export interface HostEvent {
  type: "event";
  sequence: number;
  event: DesktopEvent;
}

export interface HostModelRequest {
  type: "model.request";
  id: string;
  provider: string;
  modelId: string;
  context: unknown;
  options: Record<string, unknown>;
}

export interface ClientModelEvent {
  type: "model.event";
  id: string;
  event: unknown;
}

export interface ClientModelFailure {
  type: "model.failure";
  id: string;
  error: string;
}

export interface HostModelCancel {
  type: "model.cancel";
  id: string;
}

export type HostMessage =
  | HostHello
  | HostResponse
  | HostEvent
  | HostModelRequest
  | HostModelCancel;
export type ClientMessage =
  | HostRequest
  | ClientModelEvent
  | ClientModelFailure;
