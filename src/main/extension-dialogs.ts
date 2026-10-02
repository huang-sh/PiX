import { randomUUID } from "node:crypto";
import type { DesktopEvent, ExtensionDialog } from "../shared/types.js";
import { debugLog } from "./debug-log.js";

/** Replies bypass the running command that is waiting for user input. */
export class ExtensionDialogs {
  private pending = new Map<string, { owner: object; request: ExtensionDialog; finish: (value?: string) => void }>();
  constructor(private emit: (event: DesktopEvent) => void) {}
  private publish(event: DesktopEvent) {
    try { this.emit(event); } catch (error) { debugLog("extension-dialogs: publish", error); }
  }
  list() { return [...this.pending.values()].map(item => item.request); }
  request(owner: object, input: Omit<ExtensionDialog, "id">, options?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined> {
    if (options?.signal?.aborted) return Promise.resolve(undefined);
    const request = { ...input, id: randomUUID() };
    return new Promise(resolve => {
      let timer: NodeJS.Timeout | undefined;
      const cancel = () => finish();
      const finish = (value?: string) => {
        if (!this.pending.delete(request.id)) return;
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", cancel);
        this.publish({ type: "ui.dismiss", payload: { id: request.id } });
        resolve(value);
      };
      this.pending.set(request.id, { owner, request, finish });
      options?.signal?.addEventListener("abort", cancel, { once: true });
      if (options?.timeout !== undefined) timer = setTimeout(cancel, options.timeout);
      this.publish({ type: "ui.request", payload: request });
    });
  }
  respond(id: string, value?: string) {
    const item = this.pending.get(id);
    if (!item) return false;
    if (value !== undefined && item.request.options && !item.request.options.includes(value))
      throw new Error("Invalid dialog selection");
    item.finish(value);
    return true;
  }
  cancel(owner?: object) {
    for (const item of this.pending.values()) if (!owner || item.owner === owner) item.finish();
  }
}
