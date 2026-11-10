import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** PiX profile root; PIX_HOME relocates the whole profile (dev, tests, CI). */
export const pixHome = () => process.env.PIX_HOME ?? homedir();
/** PiX owns ~/.pix/agent the way the pi CLI owns ~/.pi/agent. */
export const pixAgentDir = () => join(pixHome(), ".pix", "agent");
/** Pixie's own workspace: the coordinator agent runs here, never in a project. */
export const pixieWorkspace = () => join(pixAgentDir(), "pixie");
/** The pi CLI's session-directory slug for a cwd (getDefaultSessionDirPath). */
const cliSessionSlug = (cwd: string) =>
  `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
/**
 * Every directory Pixie sessions can live in: the workspace's own sessions
 * dir (pre-RPC spelling) plus the CLI's slotted dir under both path
 * spellings. Lives here so the usage scan can classify Pixie files without
 * importing the Pixie runtime (which would cycle through pi-runtime).
 */
export function pixieSessionDirs(): string[] {
  const workspace = pixieWorkspace();
  return [...new Set([
    join(workspace, "sessions"),
    join(pixAgentDir(), "sessions", cliSessionSlug(workspace)),
    join(pixAgentDir(), "sessions", cliSessionSlug(canonicalPath(workspace))),
  ])];
}
/**
 * The canonical spelling of a path. Session rows and registry entries must
 * agree even when a project is reached through a junction or symlink, so every
 * listing normalizes here; a file that is already gone keeps its resolved
 * spelling, so a stale row still compares.
 */
export const canonicalPath = (p: string) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};
