import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { GraphRuntime } from "../src/main/graph-runtime.js";
import { readGitHead } from "../src/main/extensions/git-branch.js";
import { projectSession } from "../src/shared/session.js";
import { GIT_BRANCH_CUSTOM_TYPE } from "../src/shared/types.js";

test("Git branches and commits belong to individual turns and survive forks, queues, exports and restart", { timeout: 30000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "pix-node-git-"));
  const cwd = join(home, "workspace");
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  git("init", "--initial-branch=main");
  const previous = process.env.PIX_HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PIX_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  const runtime = new GraphRuntime(cwd, join(home, "sessions"), () => {}, async () => {});
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(home, { recursive: true, force: true });
  });
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const factory = runtime.factory.bind(runtime);
  runtime.factory = pi => async args => {
    const created = await factory(pi)(args);
    created.services.modelRuntime.registerNativeProvider(faux.provider);
    return created;
  };
  await runtime.create();
  const nodes = () => runtime.snapshot().projection.nodes;
  const prompt = async (text: string, nodeId: string | null, responses: Parameters<typeof faux.setResponses>[0] = [fauxAssistantMessage("done")]) => {
    faux.setResponses(responses);
    await runtime.control({ action: "promptAt", requestId: randomUUID(), nodeId, text, provider: "faux", modelId: "test" });
    for (let i = 0; i < 500 && runtime.snapshot().graph!.runs.some(run => run.status === "running"); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(runtime.snapshot().graph!.runs.every(run => run.status === "idle"));
    return nodes().find(node => node.title === text)!;
  };
  const root = await prompt("unborn branch", null);
  assert.equal(root.gitBranch, "main");
  assert.equal(root.gitCommit, undefined);
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial");
  const initialCommit = git("rev-parse", "HEAD");
  git("switch", "-c", "feature/One");
  const first = await prompt("switch during turn", root.id, [async () => {
    assert.equal(nodes().find(node => node.title === "switch during turn")?.gitBranch, "feature/One");
    assert.equal(nodes().find(node => node.title === "switch during turn")?.gitCommit, initialCommit);
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "during turn");
    git("switch", "main");
    await runtime.runtime.session.followUp("queued turn");
    return fauxAssistantMessage("switched");
  }, fauxAssistantMessage("queued answer")]);
  assert.equal(first.gitBranch, "feature/One");
  assert.equal(first.gitCommit, initialCommit);
  assert.equal(nodes().find(node => node.title === "queued turn")?.gitBranch, "main");
  assert.equal(nodes().find(node => node.title === "queued turn")?.gitCommit, initialCommit);
  git("switch", "-c", "feature/Two", "feature/One");
  const nextCommit = git("rev-parse", "HEAD");
  assert.notEqual(nextCommit, initialCommit);
  const fork = await prompt("fork", root.id);
  assert.equal(fork.gitBranch, "feature/Two");
  assert.equal(fork.gitCommit, nextCommit);
  assert.equal(fork.parentId, root.id);
  assert.notEqual(fork.branchId, first.branchId);
  git("checkout", "--detach", "HEAD");
  const detached = await prompt("detached", fork.id);
  assert.equal(detached.gitBranch, `HEAD (${git("rev-parse", "--short", "HEAD")})`);
  assert.equal(detached.gitCommit, nextCommit);
  const expected = nodes().map(node => [node.id, node.gitBranch, node.gitCommit]);
  const path = runtime.snapshot().session.path;
  await runtime.close();
  git("switch", "main");
  await runtime.open(path);
  assert.deepEqual(nodes().map(node => [node.id, node.gitBranch, node.gitCommit]), expected);
  const exported = await runtime.control({ action: "exportJsonl" }) as { path: string };
  const entries = readFileSync(exported.path, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(projectSession(entries.slice(1), entries.at(-1).id).nodes.map(node => [node.id, node.gitBranch, node.gitCommit]), expected);
});

test("readGitHead resolves loose and packed refs, linked worktrees and missing repositories", async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-git-head-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: home, encoding: "utf8", windowsHide: true }).trim();
    git("init", "--initial-branch=main");
    mkdirSync(join(home, "nested", "deeper"), { recursive: true });
    assert.deepEqual(await readGitHead(join(home, "nested", "deeper")), { branch: "main" });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], { cwd: home });
    const initial = git("rev-parse", "HEAD");
    assert.deepEqual(await readGitHead(home), { branch: "main", commit: initial });
    execFileSync("git", ["switch", "-c", "feature"], { cwd: home });
    git("pack-refs", "--all", "--prune");
    assert.deepEqual(await readGitHead(home), { branch: "feature", commit: initial });
    // A linked worktree has its own HEAD despite sharing the repository's objects.
    const worktree = join(home, "linked");
    git("worktree", "add", worktree, "main");
    assert.deepEqual(await readGitHead(worktree), { branch: "main", commit: initial });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "loose ref"], { cwd: worktree });
    const updated = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
    assert.notEqual(updated, initial);
    assert.deepEqual(await readGitHead(worktree), { branch: "main", commit: updated });
    assert.deepEqual(await readGitHead(home), { branch: "feature", commit: initial });
    git("pack-refs", "--all", "--prune");
    assert.deepEqual(await readGitHead(worktree), { branch: "main", commit: updated });
    execFileSync("git", ["checkout", "--detach", "HEAD"], { cwd: worktree });
    assert.deepEqual(await readGitHead(worktree), { branch: `HEAD (${updated.slice(0, 7)})`, commit: updated });
    mkdirSync(join(worktree, "broken", ".git"), { recursive: true });
    assert.equal(await readGitHead(join(worktree, "broken")), null);
    assert.equal(await readGitHead(join(tmpdir(), "pix-git-missing", "workspace")), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readGitHead follows relative gitdir files and supports SHA-256 commits", async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-git-sha256-"));
  try {
    const cwd = join(home, "workspace");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: home, encoding: "utf8", windowsHide: true }).trim();
    git("init", "--object-format=sha256", "--initial-branch=main", "--separate-git-dir", join(home, "gitdir"), cwd);
    writeFileSync(join(cwd, ".git"), "gitdir: ../gitdir\n");
    assert.deepEqual(await readGitHead(cwd), { branch: "main" });
    git("-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial");
    const commit = git("-C", cwd, "rev-parse", "HEAD");
    assert.equal(commit.length, 64);
    assert.deepEqual(await readGitHead(cwd), { branch: "main", commit });
    git("-C", cwd, "pack-refs", "--all", "--prune");
    assert.deepEqual(await readGitHead(cwd), { branch: "main", commit });
    git("-C", cwd, "checkout", "--detach", "HEAD");
    assert.deepEqual(await readGitHead(cwd), { branch: `HEAD (${commit.slice(0, 7)})`, commit });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readGitHead resolves symbolic branch references", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pix-git-symbolic-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  try {
    git("init", "--initial-branch=main");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial");
    git("symbolic-ref", "refs/heads/alias", "refs/heads/main");
    git("symbolic-ref", "HEAD", "refs/heads/alias");
    assert.deepEqual(await readGitHead(cwd), { branch: "main", commit: git("rev-parse", "HEAD") });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readGitHead supports reftable branches, detached HEAD and linked worktrees", async t => {
  const home = mkdtempSync(join(tmpdir(), "pix-git-reftable-"));
  const cwd = join(home, "workspace");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: home, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    try {
      git("init", "--ref-format=reftable", "--initial-branch=main", cwd);
    } catch (error) {
      if (/unknown option.*ref-format|unknown ref storage format/i.test(String(error))) {
        t.skip("Git does not support reftable");
        return;
      }
      throw error;
    }
    assert.deepEqual(await readGitHead(cwd), { branch: "main" });
    git("-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial");
    const commit = git("-C", cwd, "rev-parse", "HEAD");
    assert.deepEqual(await readGitHead(cwd), { branch: "main", commit });
    const worktree = join(home, "linked");
    git("-C", cwd, "worktree", "add", "-b", "feature", worktree, "HEAD");
    assert.deepEqual(await readGitHead(worktree), { branch: "feature", commit });
    git("-C", cwd, "checkout", "--detach", "HEAD");
    assert.deepEqual(await readGitHead(cwd), { branch: `HEAD (${commit.slice(0, 7)})`, commit });
    assert.deepEqual(await readGitHead(worktree), { branch: "feature", commit });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("branch records pair with their own turn only; malformed or legacy data is ignored", () => {
  const commit = "a".repeat(40);
  const gitEntry = (id: string, parentId: string | null, branch: unknown, commit?: unknown) => ({
    type: "custom", customType: GIT_BRANCH_CUSTOM_TYPE, id, parentId, timestamp: "2026-01-01", data: { branch, commit },
  });
  const userEntry = (id: string, parentId: string | null) => ({
    type: "message", id, parentId, timestamp: "2026-01-01", message: { role: "user", content: id },
  });
  // g0 pairs with u1, g1 pairs with u2, g2 is malformed (u3 gets nothing),
  // and u4 descends from an assistant record, as in a legacy session.
  const entries = [
    gitEntry("g0", null, "stale"),
    userEntry("u1", "g0"),
    gitEntry("g1", "u1", "feature/One", commit),
    userEntry("u2", "g1"),
    gitEntry("g2", "u2", { branch: "bad" }),
    userEntry("u3", "g2"),
    { type: "message", id: "a1", parentId: "u3", timestamp: "2026-01-01", message: { role: "assistant", content: [] } },
    userEntry("u4", "a1"),
    gitEntry("g3", "u4", "main", "invalid"),
    userEntry("u5", "g3"),
    gitEntry("g4", "u5", "main", 123),
    userEntry("u6", "g4"),
  ];
  const nodes = projectSession(entries, "u6").nodes;
  assert.deepEqual(nodes.map(node => node.gitBranch), ["stale", "feature/One", undefined, undefined, "main", "main"]);
  assert.deepEqual(nodes.map(node => node.gitCommit), [undefined, commit, undefined, undefined, undefined, undefined]);
});
