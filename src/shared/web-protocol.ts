import type { DesktopEvent, DesktopRoute } from "./types.js";

export interface WebRequest {
  type: "request";
  id: string;
  route: DesktopRoute;
  input?: unknown;
}

export type WebResponse =
  | { type: "response"; id: string; ok: true; result: unknown }
  | { type: "response"; id: string; ok: false; message: string };

export interface WebEvent {
  type: "event";
  event: DesktopEvent;
}

export interface WebConfirm {
  type: "platform";
  id: string;
  method: "confirm";
  message: string;
  detail?: string;
}

export interface WebConfirmReply {
  type: "platform.reply";
  id: string;
  result: boolean;
}

export type HostMessage = WebResponse | WebEvent | WebConfirm;
export type ClientMessage = WebRequest | WebConfirmReply;
