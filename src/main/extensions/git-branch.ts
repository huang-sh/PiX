import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GIT_BRANCH_CUSTOM_TYPE } from "../../shared/types.js";

/**
 * Reads the branch of a working directory from disk instead of spawning Git:
 * walk up to the `.git` record and read its HEAD. Linked worktrees and
 * submodules keep their HEAD in the gitdir a `.git` file points at.
 */
export function readGitBranch(cwd: string): string | null {
  for (let dir = resolve(cwd);; dir = dirname(dir)) {
    const git = join(dir, ".git");
    let directory: boolean;
    try {
      directory = statSync(git).isDirectory();
    } catch {
      if (dirname(dir) === dir) return null;
      continue;
    }
    // The record exists, so the answer is decided here — never a parent repo.
    try {
      const headFile = directory ? join(git, "HEAD") : join(resolve(dir, headRedirect(git)), "HEAD");
      const head = readFileSync(headFile, "utf8").trim();
      if (head.startsWith("ref: refs/heads/")) return head.slice(16).trim() || null;
      return /^[0-9a-f]{7,64}$/i.test(head) ? `HEAD (${head.slice(0, 7)})` : null;
    } catch {
      return null;
    }
  }
}

function headRedirect(gitFile: string): string {
  const redirect = readFileSync(gitFile, "utf8").trim().match(/^gitdir:\s*(.+)$/)?.[1];
  if (!redirect) throw new Error("Not a git worktree record");
  return redirect;
}

export const pixGitBranchExtension = {
  name: "git-branch",
  factory: pi => {
    pi.on("message_end", (event, ctx) => {
      if (event.message.role !== "user") return;
      // Handlers run before the SDK persists the message, so the branch entry
      // becomes its parent and the projection pairs them by that link. Reading
      // HEAD synchronously matters: this hook is awaited, and spawning Git
      // here would delay every turn by a process launch.
      try {
        const branch = readGitBranch(ctx.cwd);
        if (branch) pi.appendEntry(GIT_BRANCH_CUSTOM_TYPE, { branch });
      } catch {
        // A missing branch record must never block the prompt.
      }
    });
  },
} satisfies InlineExtension;
