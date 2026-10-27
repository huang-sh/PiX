import type { DesktopEvent, DesktopRoute } from "./types.js";

export const LOCAL_HOST_PROTOCOL = 2;
export interface HostAddress { protocol: number; version: string; pid: number; port: number; token: string }
export type LocalRequest = {
  type: "request"; id: string;
  method: "attach" | "invoke" | "status" | "shutdown";
  cwd?: string | null;
  route?: DesktopRoute;
  input?: unknown;
  sessionPath?: string;
  platform?: boolean;
  imageReferences?: boolean;
  clientId?: string;
};
export type LocalReply = { type: "reply"; id: string; result?: unknown; error?: string };
export type PlatformCall = { type: "platform"; id: string; method: string; args: unknown[] };
export type LocalMessage = LocalReply | PlatformCall | { type: "event"; sequence: number; event: DesktopEvent };
