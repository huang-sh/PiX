import type { DesktopEvent, DesktopRoute } from "./types.js";

// Both sides of this merge moved the wire on their own: usage.overview is a
// new project route, and lingering hosts, reattachment, and credential
// deployment added shutdown messages and the hello authorization flag. Each
// change alone claimed 15, so the merged protocol is 16 to force hosts from
// either lineage to reinstall. Installers compare both protocol and version.
export const PIX_REMOTE_PROTOCOL = 16;
export const PIX_HOST_VERSION = "0.0.24";
// Session snapshots and broker contexts include base64 images from prior turns.
export const MAX_REMOTE_PAYLOAD = 128 * 1024 * 1024;

export const PROJECT_ROUTES = [
  "session.list",
  "session.snapshot",
  "session.open",
  "session.stop",
  "session.rename",
  "session.delete",
  "usage.overview",
  "agent.control",
  "workspace.tree",
  "workspace.directories",
  "workspace.open",
  "workspace.read",
  "workspace.write",
  "git.status",
  "git.branches",
  "git.switch",
  "git.diff",
  "changes.read",
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
  /** Absolute real directory path, with the same spelling as workspace.directories. */
  cwd: string;
  /** Whether the desktop may deploy its model credentials to this host. */
  allowCredentialDeploy?: boolean;
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

/** Tells a lingering host the desktop is done with it; it shuts down now. */
export interface ClientShutdown {
  type: "shutdown";
}

/** Identifies a lingering host across desktop sessions, for reattachment. */
export interface HostHandle {
  kind: "ssh" | "wsl";
  /** SSH host alias or WSL distribution naming the machine. */
  target: string;
  /** Loopback port and auth token of the running host, plus its pid. */
  port: number;
  token: string;
  pid: number;
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
  | ClientModelFailure
  | ClientShutdown;
