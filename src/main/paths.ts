import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** PiX profile root; PIX_HOME relocates the whole profile (dev, tests, CI). */
export const pixHome = () => process.env.PIX_HOME ?? homedir();
/** PiX owns ~/.pix/agent the way the pi CLI owns ~/.pi/agent. */
export const pixAgentDir = () => join(pixHome(), ".pix", "agent");
/**
 * The canonical spelling of a path. Session rows and registry entries must
 * agree even when a project is reached through a junction or symlink, so every
 * listing normalizes here; a file that is already gone keeps its resolved
 * spelling, so a stale row still compares.
 */
export const canonicalPath = (p: string) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
