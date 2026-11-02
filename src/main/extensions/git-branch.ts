import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_BRANCH_CUSTOM_TYPE } from "../../shared/types.js";

const exec = promisify(execFile);

/** Ask Git to resolve HEAD so all reference storage formats and symbolic refs work. */
export async function readGitHead(cwd: string): Promise<{ branch: string; commit?: string } | null> {
  const options = { cwd, encoding: "utf8" as const, windowsHide: true, timeout: 3000 };
  try {
    let dir = resolve(cwd);
    for (;;) {
      try { statSync(join(dir, ".git")); break; } catch {
        if (dirname(dir) === dir) return null;
        dir = dirname(dir);
      }
    }
    // Explicit gitdir prevents Git from falling back to an outer repository
    // when the nearest .git record is broken. Git resolves gitfiles itself.
    const args = ["--git-dir", join(dir, ".git")];
    // Resolve the commit first, then request the full ref name in the same process.
    // --revs-only gives empty output for an unborn branch instead of a fatal error.
    const { stdout } = await exec("git", [...args, "rev-parse", "--revs-only", "HEAD", "--symbolic-full-name", "HEAD"], options);
    const [commit, ref] = stdout.trim().split(/\r?\n/);
    if (commit && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(commit)) {
      if (ref?.startsWith("refs/heads/")) return { branch: ref.slice(11), commit };
      return ref === "HEAD" ? { branch: `HEAD (${commit.slice(0, 7)})`, commit } : null;
    }
    const { stdout: branch } = await exec("git", [...args, "symbolic-ref", "--quiet", "--short", "HEAD"], options);
    return branch.trim() ? { branch: branch.trim() } : null;
  } catch {
    // Missing Git, invalid repositories or timed-out reads must not block prompts.
    return null;
  }
}

export const pixGitBranchExtension = {
  name: "git-branch",
  factory: pi => {
    pi.on("message_end", async (event, ctx) => {
      if (event.message.role !== "user") return;
      // Handlers run before the SDK persists the message, so the Git entry
      // becomes its parent and the projection pairs them by that link. Await
      // the read here so the record always describes the turn's starting HEAD.
      try {
        const head = await readGitHead(ctx.cwd);
        if (head) pi.appendEntry(GIT_BRANCH_CUSTOM_TYPE, head);
      } catch {
        // A missing Git record must never block the prompt.
      }
    });
  },
} satisfies InlineExtension;
