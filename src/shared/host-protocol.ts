import type { DesktopEvent, DesktopRoute } from "./types.js";

export const LOCAL_HOST_PROTOCOL = 2;
export interface HostAddress {
  protocol: number; version: string; pid: number; port: number; token: string;
  desktopViewMigration?: boolean;
}
export interface HostConnectionState {
  connected: boolean;
  version: string;
  language?: "system" | "en" | "zh-CN";
  error?: string;
  host?: {
    id: string;
    version: string;
    verified: boolean;
    clients?: number;
    running?: number;
    pending?: boolean;
    stopping?: boolean;
    remoteConnections?: number;
    commands?: number;
    terminals?: number;
  };
}
export type LocalRequest = {
  type: "request"; id: string;
  method: "attach" | "invoke" | "status" | "shutdown";
  /** Explicitly interrupt work when the user chooses to restart the host. */
  force?: boolean;
  /** An explicit full quit also closes connected desktop clients. */
  quitClients?: boolean;
  cwd?: string | null;
  route?: DesktopRoute;
  input?: unknown;
  sessionPath?: string;
  platform?: boolean;
  /** Optional desktop power capability; absent on older clients. */
  keepAwake?: boolean;
  imageReferences?: boolean;
  clientId?: string;
  /** Adopt this previous identity only when its desktop is disconnected. */
  legacyClientId?: string;
};
export type LocalReply = { type: "reply"; id: string; result?: unknown; error?: string };
export type PlatformCall = { type: "platform"; id: string; method: string; args: unknown[] };
export type LocalMessage = LocalReply | PlatformCall | { type: "event"; sequence: number; event: DesktopEvent };
