import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import { FileChangeTracker } from "../file-changes.js";
import { FILE_CHANGE_CUSTOM_TYPE } from "../../shared/file-changes.js";
import type { RawSessionEntry } from "../../shared/types.js";

/**
 * PiX's internal extensions: registered through resourceLoaderOptions
 * .extensionFactories, so pi loads them with every session and they appear in
 * the extensions page as `<inline:name>` entries. They are host machinery,
 * not installable packages, and live here instead of pi-runtime.ts.
 */

/**
 * Snapshots files around the agent's edit/write tool calls and appends a
 * file-change entry per touched file, backing the UI's changes panel. The
 * session file is injected so the extension stays decoupled from PiRuntime:
 * graph workers run through the graph owner's factory, and snapshots must
 * land next to the session whose entries reference them, not next to an
 * executing worker.
 */
export function pixFileChangesExtension(getSessionFile: () => string | undefined): InlineExtension {
  return { name: "pix-file-changes", factory: fileChangesFactory(getSessionFile) };
}

function fileChangesFactory(getSessionFile: () => string | undefined): ExtensionFactory {
  return async pi => {
    const tracker = new FileChangeTracker();
    // Match the installed SDK's path rules, including Windows shell paths, ~ and @ prefixes.
    const paths = await import(new URL("./core/tools/path-utils.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "edit" && event.toolName !== "write") return;
      const input = event.input as Record<string, unknown>;
      if (typeof input.path !== "string") return;
      // Nothing here may throw past the catch: a failed snapshot must never
      // block the tool the user asked for.
      try {
        const session = getSessionFile();
        if (!session) return;
        await tracker.before(event.toolCallId, paths.resolveToCwd(input.path, ctx.cwd), ctx.cwd, session, ctx.sessionManager.getBranch() as RawSessionEntry[]);
      } catch (error) { ctx.ui.notify(`File change tracking: ${String(error)}`, "warning"); }
    });
    pi.on("tool_result", async (event, ctx) => {
      try {
        const path = typeof event.input.path === "string" ? paths.resolveToCwd(event.input.path, ctx.cwd) : "";
        const change = await tracker.after(event.toolCallId, path, event.isError);
        if (change) pi.appendEntry(FILE_CHANGE_CUSTOM_TYPE, change);
      } catch (error) { ctx.ui.notify(`File change tracking: ${String(error)}`, "warning"); }
    });
    pi.on("agent_settled", () => tracker.clear());
    pi.on("session_shutdown", () => tracker.clear());
  };
}
