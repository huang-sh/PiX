import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { GraphRuntime } from "../src/main/graph-runtime.js";
import { readGitBranch } from "../src/main/extensions/git-branch.js";
import { projectSession } from "../src/shared/session.js";
import { GIT_BRANCH_CUSTOM_TYPE } from "../src/shared/types.js";

test("Git branches belong to individual turns and survive forks, queues, exports and restart", { timeout: 30000 }, async t => {
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
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial");
  git("switch", "-c", "feature/One");
  const first = await prompt("switch during turn", root.id, [async () => {
    assert.equal(nodes().find(node => node.title === "switch during turn")?.gitBranch, "feature/One");
    git("switch", "main");
    await runtime.runtime.session.followUp("queued turn");
    return fauxAssistantMessage("switched");
  }, fauxAssistantMessage("queued answer")]);
  assert.equal(first.gitBranch, "feature/One");
  assert.equal(nodes().find(node => node.title === "queued turn")?.gitBranch, "main");
  git("switch", "-c", "feature/Two");
  const fork = await prompt("fork", root.id);
  assert.equal(fork.gitBranch, "feature/Two");
  assert.equal(fork.parentId, root.id);
  assert.notEqual(fork.branchId, first.branchId);
  git("checkout", "--detach", "HEAD");
  const detached = await prompt("detached", fork.id);
  assert.equal(detached.gitBranch, `HEAD (${git("rev-parse", "--short", "HEAD")})`);
  const expected = nodes().map(node => [node.id, node.gitBranch]);
  const path = runtime.snapshot().session.path;
  await runtime.close();
  git("switch", "main");
  await runtime.open(path);
  assert.deepEqual(nodes().map(node => [node.id, node.gitBranch]), expected);
  const exported = await runtime.control({ action: "exportJsonl" }) as { path: string };
  const entries = readFileSync(exported.path, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(projectSession(entries.slice(1), entries.at(-1).id).nodes.map(node => node.gitBranch), nodes().map(node => node.gitBranch));
});

test("readGitBranch reads HEAD directly, including linked worktrees and missing repositories", () => {
  const home = mkdtempSync(join(tmpdir(), "pix-git-head-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: home, encoding: "utf8", windowsHide: true }).trim();
    git("init", "--initial-branch=main");
    mkdirSync(join(home, "nested", "deeper"), { recursive: true });
    assert.equal(readGitBranch(join(home, "nested", "deeper")), "main");
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"], { cwd: home });
    execFileSync("git", ["switch", "-c", "feature"], { cwd: home });
    // A linked worktree has its own HEAD despite sharing the repository's objects.
    const worktree = join(home, "linked");
    git("worktree", "add", "--detach", worktree, "HEAD");
    assert.equal(readGitBranch(worktree), `HEAD (${git("rev-parse", "--short", "HEAD")})`);
    const plain = mkdtempSync(join(tmpdir(), "pix-git-plain-"));
    rmSync(plain, { recursive: true, force: true });
    assert.equal(readGitBranch(plain), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("branch records pair with their own turn only; malformed or legacy data is ignored", () => {
  const gitEntry = (id: string, parentId: string | null, branch: unknown) => ({
    type: "custom", customType: GIT_BRANCH_CUSTOM_TYPE, id, parentId, timestamp: "2026-01-01", data: { branch },
  });
  const userEntry = (id: string, parentId: string | null) => ({
    type: "message", id, parentId, timestamp: "2026-01-01", message: { role: "user", content: id },
  });
  // g0 pairs with u1, g1 pairs with u2, g2 is malformed (u3 gets nothing),
  // and u4 descends from an assistant record, as in a legacy session.
  const entries = [
    gitEntry("g0", null, "stale"),
    userEntry("u1", "g0"),
    gitEntry("g1", "u1", "feature/One"),
    userEntry("u2", "g1"),
    gitEntry("g2", "u2", { branch: "bad" }),
    userEntry("u3", "g2"),
    { type: "message", id: "a1", parentId: "u3", timestamp: "2026-01-01", message: { role: "assistant", content: [] } },
    userEntry("u4", "a1"),
  ];
  assert.deepEqual(projectSession(entries, "a1").nodes.map(node => node.gitBranch), ["stale", "feature/One", undefined, undefined]);
});
