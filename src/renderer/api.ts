import type { DesktopApi } from "../shared/types.js";

declare global {
  interface Window {
    pix?: DesktopApi & { copy?(text: string): Promise<void> };
  }
}

if (!window.pix) throw new Error("PiX preload API is unavailable");

export const desktop = window.pix;
