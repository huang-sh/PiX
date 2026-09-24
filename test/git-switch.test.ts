import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../src/main/services.js";
import { MainController, type Platform } from "../src/main/controller.js";
import { validateRouteInput } from "../src/shared/contracts.js";
import { isProjectRoute } from "../src/shared/remote-protocol.js";
import type { GitStatus } from "../src/shared/types.js";

const platform: Platform = {
  pickProject: async () => undefined, pickSession: async () => undefined,
  confirm: async () => { throw new Error("Switching branches needs no extra dialog"); },
  openExternal: async () => {}, openPath: async () => {}, openWith: async () => {}, openWithApps: async () => [], openWithApp: async () => {}, showItemInFolder() {}, quit() {},
};
const status: GitStatus = { available: true, branch: "feature", changes: [], ahead: 0, behind: 0, clean: true };

function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "pix-git-switch-"));
  const root = join(home, "project"); mkdirSync(root);
  const previous = process.env.PIX_HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PIX_HOME = home; process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  t.after(() => {
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(home, { recursive: true, force: true });
  });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { root, home, git, controller: new MainController(root, platform) };
}

test("switching local branches preserves edits, rejects unsafe targets and respects linked worktrees", async t => {
  const { root, home, git, controller } = fixture(t);
  git("init", "--initial-branch=main");
  git("config", "core.autocrlf", "false");
  assert.equal((await controller.git.status()).branch, "main");
  assert.deepEqual(await controller.invoke("git.branches"), []);
  writeFileSync(join(root, "file.txt"), "main\n"); git("add", "file.txt"); git("commit", "-m", "main");
  git("switch", "-c", "feature");
  writeFileSync(join(root, "file.txt"), "feature\n"); git("commit", "-am", "feature");
  assert.deepEqual(await controller.invoke("git.branches"), ["feature", "main"]);
  const switchTo = (branch: string) => controller.invoke("git.switch", { branch, cwd: root }) as Promise<GitStatus>;
  assert.equal((await switchTo("main")).branch, "main");
  writeFileSync(join(root, "file.txt"), "unsaved on disk\n");
  await assert.rejects(switchTo("feature"));
  assert.equal(git("branch", "--show-current"), "main");
  assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "unsaved on disk\n");
  for (const branch of ["--discard-changes", "@{-1}", "HEAD", "refs/heads/feature", "origin/feature", "feature\nmain"])
    await assert.rejects(switchTo(branch), /existing local/);
  writeFileSync(join(root, "file.txt"), "main\n");
  writeFileSync(join(root, "keep.txt"), "untracked\n");
  assert.equal((await switchTo("feature")).branch, "feature");
  assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "untracked\n");
  git("worktree", "add", join(home, "linked"), "main");
  await assert.rejects(switchTo("main"));
  assert.equal(git("branch", "--show-current"), "feature");
  await assert.rejects(controller.invoke("git.switch", { branch: "main", cwd: home }), /Project changed/);
  assert.throws(() => validateRouteInput("git.switch", { branch: "main" }), /cwd/);
  assert.throws(() => validateRouteInput("git.switch", { branch: [], cwd: root }), /branch/);
  assert.equal(isProjectRoute("git.branches"), true);
  assert.equal(isProjectRoute("git.switch"), true);
});

test("branch switching and task admission exclude each other, including background runs", async t => {
  const { root, controller } = fixture(t);
  const input = { branch: "feature", cwd: root };
  const busy = t.mock.method(controller.registry, "hasBusy", () => true);
  await assert.rejects(controller.invoke("git.switch", input), /Stop running tasks/);
  busy.mock.restore();

  let finishSwitch!: (value: GitStatus) => void;
  t.mock.method(GitService.prototype, "switchBranch", () => new Promise<GitStatus>(resolve => { finishSwitch = resolve; }));
  const switching = controller.invoke("git.switch", input);
  await assert.rejects(controller.invoke("git.switch", input), /Wait for/);
  await assert.rejects(controller.invoke("agent.control", { action: "prompt", text: "go" }), /Wait for/);
  finishSwitch(status); await switching;

  let finishPrompt!: (value: unknown) => void;
  t.mock.method(controller as any, "controlAgent", () => new Promise(resolve => { finishPrompt = resolve; }));
  const starting = controller.invoke("agent.control", { action: "prompt", text: "go" });
  await assert.rejects(controller.invoke("git.switch", input), /Stop running tasks/);
  finishPrompt({ result: null }); await starting;
  const next = controller.invoke("git.switch", input);
  finishSwitch(status); assert.deepEqual(await next, status);
});

test("Git switching is routed to the active remote workspace", async t => {
  const { controller } = fixture(t);
  const project = { name: "remote", path: "/remote", remote: { kind: "ssh" as const, host: "test" } };
  controller.project = project;
  const requests: unknown[] = [];
  controller.installSlot({ request: async (route: string, input: unknown) => { requests.push([route, input]); return status; },
    onEvent: () => () => {}, onDisconnect: () => () => {}, connected: true } as never, project, controller.settings.bundle());
  const input = { branch: "feature", cwd: "/remote" };
  assert.deepEqual(await controller.invoke("git.switch", input), status);
  assert.deepEqual(requests, [["git.switch", input]]);
});
