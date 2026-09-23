import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RawSessionEntry } from "../src/shared/types.js";
import type { WikiStatus } from "../src/shared/wiki.js";
import {
  MAX_TURNS_PER_COMPILE, parseModelSummary, prepareCompile, publishSummary, readManifest,
  refreshSessionWiki, removeSessionWiki, workspaceWikiDir,
} from "../src/main/wiki-compiler.js";
import { WikiService } from "../src/main/wiki-service.js";

const BID = "11111111-1111-4111-8111-111111111111";
const SID_A = "session-a", SID_B = "session-b";
const A_MAIN = `sessions/${SID_A}/branches/main.md`, A_BRANCH = `sessions/${SID_A}/branches/${BID}.md`;
const read = (file: string) => readFileSync(file, "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const msg = (id: string, parentId: string | null, role: string, value: string, extra: Record<string, unknown> = {}): RawSessionEntry =>
  ({ type: "message", id, parentId, timestamp: "2026-09-01T10:00:00.000Z",
    message: { role, content: [{ type: "text", text: value }], ...(role === "assistant" ? { stopReason: "stop" } : {}), ...extra } }) as RawSessionEntry;
const encode = (id: string, entries: RawSessionEntry[]) => [{ type: "session", version: 3, id, timestamp: "2026-09-01T10:00:00.000Z" } as const, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n";
const BASE = [msg("u1", null, "user", "shared question"), msg("a1", "u1", "assistant", "shared answer")];
const MAIN_TURN_2 = [msg("u2", "a1", "user", "main question"), msg("a2", "u2", "assistant", "main answer")];
const BRANCH_TURN = [msg("b1", "a1", "user", "branch question"), msg("b2", "b1", "assistant", "branch answer")];
const B_TURN = [msg("u9", null, "user", "other session question"), msg("a9", "u9", "assistant", "other session answer")];

interface Fixture {
  project: string;
  main: string;
  second: string;
  branchFile: string;
  origin: string;
  wiki: string;
  modify: (file: string, fn: (entries: Record<string, unknown>[]) => void) => void;
  appendMain: (entry: RawSessionEntry) => void;
  appendSecond: (entry: RawSessionEntry) => void;
}

function fixture(t: { after(fn: () => void): void }): Fixture {
  const project = mkdtempSync(join(tmpdir(), "pix-wiki-ws-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const sessions = join(project, ".pi", "sessions");
  mkdirSync(sessions, { recursive: true });
  const wiki = workspaceWikiDir(project);
  // Session A: a graph with one forked branch.
  const main = join(sessions, "a.jsonl");
  writeFileSync(main, encode(SID_A, [...BASE, ...MAIN_TURN_2]));
  const dir = `${main}.pix-tree`;
  mkdirSync(dir);
  const branchFile = join(dir, `${BID}.jsonl`), origin = `${branchFile}.origin.json`;
  writeFileSync(branchFile, encode(SID_A, [...BASE, ...BRANCH_TURN]));
  writeFileSync(origin, JSON.stringify({
    id: BID, parentId: "main", forkEntryId: "a1", baseline: BASE, inherited: { u1: "u1", a1: "a1" },
    status: "idle", header: { type: "session", version: 3, id: SID_A, timestamp: "2026-09-01T10:00:00.000Z" },
    request: { text: "branch request" }, requestId: "r1", runId: "run1",
  }) + "\n");
  // Session B: a plain session sharing the same workspace wiki.
  const second = join(sessions, "b.jsonl");
  writeFileSync(second, encode(SID_B, [...B_TURN]));
  mkdirSync(`${second}.pix-tree`);
  const modify = (file: string, fn: (entries: Record<string, unknown>[]) => void) => {
    const lines = read(file).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    fn(lines);
    writeFileSync(file, lines.map(e => JSON.stringify(e)).join("\n") + "\n");
  };
  const appendMain = (entry: RawSessionEntry) => { writeFileSync(main, read(main) + JSON.stringify(entry) + "\n"); };
  const appendSecond = (entry: RawSessionEntry) => { writeFileSync(second, read(second) + JSON.stringify(entry) + "\n"); };
  return { project, main, second, branchFile, origin, wiki, modify, appendMain, appendSecond };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("Timed out waiting for wiki state");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

const summaryJson = (evidence: string[], summary = "一句话总结", keywords: string[] = ["支付", "webhook"]) => JSON.stringify({
  summary, goal: "目标描述", keywords,
  conclusions: [{ text: "结论内容", evidence }],
  corrections: [], openQuestions: [{ text: "未解决事项", evidence }],
});

function service(
  t: { after(fn: () => void): void },
  f: Fixture,
  handler: (request: { userPrompt: string; provider: string; modelId: string }) => Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number; cost: number | null } }>,
  options: { settings?: Record<string, unknown>; defaultModel?: { provider: string; id: string } | null } = {},
) {
  const calls: Array<{ userPrompt: string }> = [];
  const statuses: WikiStatus[] = [];
  const settings = { enabled: true, ...(options.settings ?? {}) };
  const value = new WikiService({
    wikiRoot: () => f.wiki,
    settings: () => settings,
    defaultModel: () => options.defaultModel === undefined ? { provider: "p", id: "m" } : options.defaultModel,
    callModel: async request => {
      calls.push({ userPrompt: request.userPrompt });
      const reply = await handler(request);
      return { text: reply.text, usage: reply.usage ?? null };
    },
    emit: status => statuses.push(status),
    retryDelaysMs: [5, 5, 5],
  });
  return { value, calls, statuses, settings };
}

test("one workspace wiki aggregates sessions; per-session refresh stays idempotent", () => {
  const f = fixture(test);
  const original = [f.main, f.branchFile, f.origin, f.second].map(hash);
  const a = refreshSessionWiki(f.wiki, f.main);
  assert.equal(a.snap.nodes.length, 3);
  // Second refresh of the same session writes nothing.
  assert.equal(refreshSessionWiki(f.wiki, f.main).changed, 0);
  assert.deepEqual([f.main, f.branchFile, f.origin, f.second].map(hash), original);
  assert.ok(existsSync(join(f.wiki, "sessions", SID_A, "sources", "main.md")));
  assert.ok(existsSync(join(f.wiki, "sessions", SID_A, "tree.md")));
  // Session B joins the same workspace wiki and appears on the shared index.
  refreshSessionWiki(f.wiki, f.second);
  const manifest = readManifest(f.wiki)!;
  assert.deepEqual(Object.keys(manifest.sessions).sort(), [SID_A, SID_B]);
  const index = read(join(f.wiki, "index.md"));
  assert.match(index, /session-a/);
  assert.match(index, /session-b/);
  assert.match(index, /工作区 · 轻量 Wiki/);
  // Refreshing A again leaves the shared index stable.
  assert.equal(refreshSessionWiki(f.wiki, f.main).changed, 0);
});

test("publish advances coverage incrementally; a new turn during the call is not wasted work", () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  const plan = prepareCompile(f.wiki, f.main, "main");
  assert.ok(plan);
  assert.equal(plan!.mode, "reset");
  assert.deepEqual(plan!.includedTurns, ["turn:u1", "turn:u2"]);
  // Turn 21 lands while the model runs; publishing the read range must still succeed.
  f.appendMain(msg("u3", "a2", "user", "late question"));
  publishSummary(f.wiki, plan!, parseModelSummary(summaryJson(["turn:u2"])), { inputTokens: 10, outputTokens: 20, cost: 0.001 });
  let manifest = readManifest(f.wiki)!;
  assert.deepEqual(manifest.pages[A_MAIN]!.coveredTurns, ["turn:u1", "turn:u2"]);
  assert.equal(manifest.usage!.calls, 1);
  assert.equal(manifest.usage!.input, 10);
  refreshSessionWiki(f.wiki, f.main);
  assert.equal(readManifest(f.wiki)!.pageStatus[A_MAIN], "dirty");
  // The next compile is incremental and only summarizes the delta.
  const next = prepareCompile(f.wiki, f.main, "main");
  assert.ok(next);
  assert.equal(next!.mode, "incremental");
  assert.deepEqual(next!.includedTurns, ["turn:u3"]);
  assert.match(next!.userPrompt, /旧摘要/);
  publishSummary(f.wiki, next!, parseModelSummary(summaryJson(["turn:u3"], "更新后总结")), { inputTokens: 1, outputTokens: 2, cost: null });
  manifest = readManifest(f.wiki)!;
  assert.deepEqual(manifest.pages[A_MAIN]!.coveredTurns, ["turn:u1", "turn:u2", "turn:u3"]);
  refreshSessionWiki(f.wiki, f.main);
  assert.equal(readManifest(f.wiki)!.pageStatus[A_MAIN], "fresh");
  assert.equal(prepareCompile(f.wiki, f.main, "main"), null);
});

test("stale results cannot overwrite a user edit, an ancestor change, or a deleted session", () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  // Establish a published, fresh branch page first.
  const first = prepareCompile(f.wiki, f.main, BID)!;
  publishSummary(f.wiki, first, parseModelSummary(summaryJson([`turn:${BID}:b1`])), { inputTokens: 1, outputTokens: 1, cost: null });
  refreshSessionWiki(f.wiki, f.main);
  assert.equal(readManifest(f.wiki)!.pageStatus[A_BRANCH], "fresh");
  // 1. A pending delta compile exists; the page is edited while the model runs.
  writeFileSync(f.branchFile, read(f.branchFile) + JSON.stringify(msg("b3", "b2", "user", "follow up")) + "\n");
  const plan = prepareCompile(f.wiki, f.main, BID)!;
  assert.equal(plan.mode, "incremental");
  writeFileSync(join(f.wiki, A_BRANCH), read(join(f.wiki, A_BRANCH)) + "\n手动补充一行。\n");
  assert.throws(() => publishSummary(f.wiki, plan, parseModelSummary(summaryJson([`turn:${BID}:b3`])), { inputTokens: 1, outputTokens: 1, cost: null }), /page changed/i);
  // 2. A shared ancestor entry changed in place — context hash mismatch.
  const fresh = prepareCompile(f.wiki, f.main, BID)!;
  assert.equal(fresh.mode, "reset");
  f.modify(f.main, entries => { (entries.find(e => e.id === "a1")!.message as { content: Array<{ text: string }> }).content[0]!.text = "changed ancestor"; });
  assert.throws(() => publishSummary(f.wiki, fresh, parseModelSummary(summaryJson([`turn:${BID}:b1`])), { inputTokens: 1, outputTokens: 1, cost: null }), /context changed/i);
  // 3. The session disappeared — preparing and publishing must both refuse.
  const again = prepareCompile(f.wiki, f.main, BID)!;
  unlinkSync(f.main);
  assert.throws(() => publishSummary(f.wiki, again, parseModelSummary(summaryJson([`turn:${BID}:b1`])), { inputTokens: 1, outputTokens: 1, cost: null }), /gone|session/i);
  assert.throws(() => prepareCompile(f.wiki, f.main, BID), /gone/i);
});

test("out-of-scope references are dropped; pages without valid evidence are rejected", () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  const plan = prepareCompile(f.wiki, f.main, BID)!;
  // References outside the branch ancestry or beyond what was shown are filtered.
  const mixed = parseModelSummary(summaryJson([`turn:${BID}:b1`, "turn:u2", "turn:missing"]));
  const { receipt } = publishSummary(f.wiki, plan, mixed, { inputTokens: 1, outputTokens: 1, cost: null });
  assert.equal(receipt.coveredTurns.length, 1);
  assert.doesNotMatch(read(join(f.wiki, A_BRANCH)), /turn:u2/);
  // A reply whose only references are out of scope is rejected outright.
  const scoped = parseModelSummary(summaryJson(["turn:u2"]));
  writeFileSync(f.branchFile, read(f.branchFile) + JSON.stringify(msg("b3", "b2", "user", "follow up")) + "\n");
  const followUp = prepareCompile(f.wiki, f.main, BID)!;
  assert.equal(followUp.mode, "incremental");
  assert.throws(() => publishSummary(f.wiki, followUp, scoped, { inputTokens: 1, outputTokens: 1, cost: null }));
});

test("parseModelSummary accepts fenced JSON and rejects unusable output", () => {
  assert.equal(parseModelSummary("```json\n" + summaryJson(["turn:x"]) + "\n```").summary, "一句话总结");
  assert.throws(() => parseModelSummary("no json here"), /JSON/);
  assert.throws(() => parseModelSummary('{"goal":"no summary"}'), /summary/);
});

test("corrupt sources fail closed and leave prior wiki output untouched", () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  refreshSessionWiki(f.wiki, f.second);
  const before = hash(read(join(f.wiki, "index.md")));
  writeFileSync(f.main, read(f.main) + '{"type":');
  assert.throws(() => refreshSessionWiki(f.wiki, f.main), /Invalid session JSON/);
  assert.equal(hash(read(join(f.wiki, "index.md"))), before);
});

test("removed branches lose their export but keep visibly invalid pages", () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  writeFileSync(join(f.wiki, A_BRANCH), `# 分支\n\n## 摘要\nS. \`turn:${BID}:b1\`\n\n## 目标\nG\n\n## 关键结论\nC. \`turn:${BID}:b1\`\n\n## 修正与限制\nR\n\n## 未解决项\nU\n`);
  refreshSessionWiki(f.wiki, f.main);
  unlinkSync(f.branchFile);
  unlinkSync(f.origin);
  const result = refreshSessionWiki(f.wiki, f.main);
  assert.equal(result.manifest.pageStatus[A_BRANCH], "invalid");
  assert.ok(!existsSync(join(f.wiki, "sessions", SID_A, "sources", `${BID}.md`)));
});

test("queue dedupes repeated notifications and merges turns arriving mid-run", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  const gate = deferred();
  const { value, calls, statuses } = service(test, f, async () => {
    if (calls.length === 1) await gate.promise;
    return { text: summaryJson(["turn:u1", "turn:u2"]), usage: { inputTokens: 5, outputTokens: 7, cost: 0 } };
  });
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => calls.length === 1);
  // While the model call is in flight, a new turn is saved and settles: the
  // running task must absorb it as one follow-up run, not a duplicate queue entry.
  f.appendMain(msg("u3", "a2", "user", "late question"));
  f.appendMain(msg("a3", "u3", "assistant", "late answer"));
  // Wiki activity below must not write anything further into the session files.
  const originalSources = hash(read(f.main));
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  gate.resolve();
  await until(() => calls.length === 2);
  await until(() => {
    const latest = statuses.at(-1);
    return latest?.branches.find(b => b.branchId === "main")?.status === "fresh";
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.userPrompt, /旧摘要/);
  assert.match(calls[1]!.userPrompt, /turn:u3/);
  const manifest = readManifest(f.wiki)!;
  assert.deepEqual(manifest.pages[A_MAIN]!.coveredTurns, ["turn:u1", "turn:u2", "turn:u3"]);
  assert.equal(manifest.usage!.input, 10);
  // Wiki activity never wrote to the session sources.
  assert.equal(hash(read(f.main)), originalSources);
});

test("a turn landing mid-call does not waste the finished work; unseen turns are not citable", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  const gate = deferred();
  const { value, calls, statuses } = service(test, f, async () => {
    // The turn lands on disk while the first call runs; the reply also tries to
    // cite the unseen turn, which must be dropped from the published page.
    if (calls.length === 1) {
      f.appendMain(msg("u3", "a2", "user", "late"));
      f.appendMain(msg("a3", "u3", "assistant", "late answer"));
    }
    if (calls.length === 2) await gate.promise;
    return { text: summaryJson(["turn:u1", "turn:u2", "turn:u3"]) };
  });
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  // The unfinished backlog auto-continues into a second call without a new event.
  await until(() => calls.length === 2);
  const manifest = readManifest(f.wiki)!;
  // The published receipt covers exactly the read range (round 20, not 21).
  assert.deepEqual(manifest.pages[A_MAIN]!.coveredTurns, ["turn:u1", "turn:u2"]);
  assert.doesNotMatch(read(join(f.wiki, A_MAIN)), /turn:u3/);
  gate.resolve();
  await until(() => statuses.some(s => s.branches.some(b => b.branchId === "main" && b.status === "fresh")));
  assert.deepEqual(readManifest(f.wiki)!.pages[A_MAIN]!.coveredTurns, ["turn:u1", "turn:u2", "turn:u3"]);
  assert.equal(calls.length, 2);
});

test("budget exhaustion pauses model summaries but never blocks the program layer", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  const { value, calls, statuses } = service(test, f, async () => ({ text: summaryJson(["turn:u1"]) }), { settings: { budgetTokens: 1000 } });
  const manifestBefore = readManifest(f.wiki);
  writeFileSync(join(f.wiki, "manifest.json"), JSON.stringify({ ...manifestBefore, usage: { input: 900, output: 200, calls: 9, cost: null } }, null, 2) + "\n");
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => statuses.some(s => s.paused === true));
  assert.equal(calls.length, 0);
  assert.match(statuses.at(-1)!.branches.find(b => b.branchId === "main")!.error!, /预算/);
  // The deterministic layer still refreshed fine.
  assert.ok(existsSync(join(f.wiki, "index.md")));
});

test("missing model configuration surfaces a failure without calling anything", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  const { value, calls, statuses } = service(test, f, async () => ({ text: summaryJson(["turn:u1"]) }), { defaultModel: null });
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => statuses.some(s => s.branches.some(b => b.error?.includes("模型"))));
  assert.equal(calls.length, 0);
});

test("network failures retry with backoff, then stop with a visible error", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  let attempts = 0;
  const { value, calls, statuses } = service(test, f, async () => {
    attempts += 1;
    if (attempts <= 2) throw new Error("ECONNRESET");
    return { text: summaryJson(["turn:u1", "turn:u2"]) };
  });
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => statuses.some(s => s.branches.some(b => b.status === "fresh")));
  assert.equal(calls.length, 3);
  assert.equal(readManifest(f.wiki)!.pages[A_MAIN]!.usage.inputTokens, null);
});

test("validation failures do not retry and keep the previous receipt", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  const { value, calls, statuses } = service(test, f, async () => ({ text: "definitely not json" }));
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => statuses.some(s => s.branches.some(b => b.status === "failed" && b.error?.includes("JSON"))));
  assert.equal(calls.length, 1);
  assert.equal(readManifest(f.wiki)!.pages[A_MAIN], undefined);
});

test("forgetting a session stops tasks, removes only its section, and forbids resurrection", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  // Session B has a published page too.
  const planB = prepareCompile(f.wiki, f.second, "main")!;
  publishSummary(f.wiki, planB, parseModelSummary(summaryJson(["turn:u9"])), { inputTokens: 3, outputTokens: 4, cost: null });
  refreshSessionWiki(f.wiki, f.second);
  const gate = deferred();
  const { value, calls } = service(test, f, async () => {
    await gate.promise;
    return { text: summaryJson(["turn:u1", "turn:u2"]) };
  });
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => calls.length === 1);
  // Deleting session A cancels its task and removes only its wiki section.
  value.forget(f.main);
  unlinkSync(f.main);
  gate.resolve();
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!existsSync(join(f.wiki, "sessions", SID_A)));
  assert.ok(existsSync(join(f.wiki, "sessions", SID_B, "branches", "main.md")));
  const manifest = readManifest(f.wiki)!;
  assert.equal(manifest.sessions[SID_A], undefined);
  assert.ok(manifest.sessions[SID_B]);
  assert.match(read(join(f.wiki, "index.md")), /session-b/);
  assert.doesNotMatch(read(join(f.wiki, "index.md")), /session-a/);
  // A restarted service finds no session and enqueues nothing.
  const restarted = service(test, f, async () => ({ text: summaryJson(["turn:u1", "turn:u2"]) }));
  restarted.value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  restarted.value.handleGraphEvent(f.main, { kind: "opened" });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(restarted.calls.length, 0);
});

test("restart recovery re-enqueues only the opened session's dirty branches", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  refreshSessionWiki(f.wiki, f.second);
  const { value: first, statuses: firstStatuses } = service(test, f, async request =>
    ({ text: request.userPrompt.includes("turn:u9") ? summaryJson(["turn:u9"]) : summaryJson(["turn:u1", "turn:u2"]) }));
  first.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => firstStatuses.some(s => s.branches.some(b => b.branchId === "main" && b.status === "fresh")));
  f.appendMain(msg("u3", "a2", "user", "new round"));
  f.appendMain(msg("a3", "u3", "assistant", "new answer"));
  // "Restart": a fresh service opens session A; B's section must stay untouched.
  const reopened = service(test, f, async request =>
    ({ text: request.userPrompt.includes("turn:u3") ? summaryJson(["turn:u3"]) : summaryJson([`turn:${BID}:b1`]) }));
  reopened.value.handleGraphEvent(f.main, { kind: "opened" });
  await until(() => {
    const status = reopened.statuses.at(-1);
    return status?.branches.length === 2 && status.branches.every(b => b.status === "fresh");
  });
  const prompts = reopened.calls.map(call => call.userPrompt);
  assert.ok(prompts.every(p => !p.includes("turn:u9")), "the other session was never re-enqueued");
  assert.ok(prompts.some(p => p.includes("turn:u3") && p.includes("旧摘要")), "main recompiled incrementally from the old summary");
  assert.ok(prompts.some(p => p.includes(`turn:${BID}:b1`) && p.includes("第一次生成摘要")), "branch compiled from scratch");
  assert.ok(!prompts.some(p => /## 轮 turn:u1/.test(p)), "already-covered turns were not re-sent");
});

test("status reports the session section key and workspace-wide usage", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  refreshSessionWiki(f.wiki, f.second);
  const { value, calls, statuses } = service(test, f, async () => ({ text: summaryJson(["turn:u9"]), usage: { inputTokens: 7, outputTokens: 8, cost: null } }));
  value.handleGraphEvent(f.second, { kind: "settled", branchId: "main" });
  await until(() => statuses.some(s => s.branches.some(b => b.status === "fresh")));
  assert.equal(calls.length, 1);
  const status = value.state(f.main);
  assert.equal(status.available, true);
  assert.equal(status.sessionKey, SID_A);
  assert.equal(status.branches.find(b => b.branchId === "main")!.status, "dirty");
  assert.equal(status.branches.find(b => b.branchId === BID)!.totalTurns, 1);
  // Session A's status reflects workspace-wide cumulative usage.
  assert.equal(status.usage.input, 7);
  assert.equal(value.state(f.second).branches.find(b => b.branchId === "main")!.status, "fresh");
});

test("removeSessionWiki is a no-op for unknown sessions", () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  removeSessionWiki(f.wiki, join(f.project, ".pi", "sessions", "missing.jsonl"));
  assert.ok(readManifest(f.wiki)!.sessions[SID_A]);
});

test("model keywords are normalized, stored as receipt anchors and rendered into the index", () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  const plan = prepareCompile(f.wiki, f.main, "main")!;
  const long = "长".repeat(40);
  const value = parseModelSummary(summaryJson(["turn:u1", "turn:u2"], "一句话总结", ["登录重构", "登录重构", "", "OAuth", long]));
  assert.deepEqual(value.keywords, ["登录重构", "OAuth", long.slice(0, 24)]);
  publishSummary(f.wiki, plan, value, { inputTokens: 1, outputTokens: 1, cost: null });
  assert.deepEqual(readManifest(f.wiki)!.pages[A_MAIN]!.keywords, ["登录重构", "OAuth", long.slice(0, 24)]);
  refreshSessionWiki(f.wiki, f.main);
  const index = read(join(f.wiki, "index.md"));
  assert.match(index, /主题锚点（检索起点）/);
  assert.match(index, /登录重构、OAuth/);
});

test("wiki self-reads never become evidence (recursion guard)", () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  // A later turn where the agent read the wiki itself.
  f.appendMain(msg("u3", "a2", "user", "查一下 wiki"));
  const selfRead = {
    type: "message", id: "t9", parentId: "u3", timestamp: "2026-09-01T10:00:00.000Z",
    message: { role: "toolResult", toolName: "read", toolCallId: "c9",
      content: [{ type: "text", text: ".pix/wiki/index.md: 支付回调验签机密内容" }] },
  } as unknown as RawSessionEntry;
  f.appendMain(selfRead);
  refreshSessionWiki(f.wiki, f.main);
  const plan = prepareCompile(f.wiki, f.main, "main")!;
  assert.match(plan.userPrompt, /wiki 读取结果，已跳过以防自引用/);
  assert.doesNotMatch(plan.userPrompt, /支付回调验签机密内容/);
  const exported = read(join(f.wiki, "sessions", SID_A, "sources", "main.md"));
  assert.match(exported, /wiki 读取结果，已跳过以防自引用/);
  assert.doesNotMatch(exported, /支付回调验签机密内容/);
});

test("wiki reads are skipped by call target even when the result text is clean", () => {
  const f = fixture(test);
  refreshSessionWiki(f.wiki, f.main);
  // The call targets the wiki; the returned text itself never mentions a wiki path.
  f.appendMain(msg("u3", "a2", "user", "读一下 wiki"));
  const entry = (id: string, parentId: string | null, message: Record<string, unknown>) =>
    ({ type: "message", id, parentId, timestamp: "2026-09-01T10:00:00.000Z", message }) as unknown as RawSessionEntry;
  f.appendMain(entry("c8", "u3", { role: "assistant", stopReason: "stop",
    content: [{ type: "toolCall", id: "c9", name: "read", arguments: { path: ".pix/wiki/sessions/session-a/branches/main.md" } }] }));
  f.appendMain(entry("t8", "c8", { role: "toolResult", toolName: "read", toolCallId: "c9",
    content: [{ type: "text", text: "纯正文结论：支付回调验签机密内容，不含任何 wiki 路径" }] }));
  refreshSessionWiki(f.wiki, f.main);
  const plan = prepareCompile(f.wiki, f.main, "main")!;
  assert.match(plan.userPrompt, /wiki 读取结果，已跳过以防自引用/);
  assert.doesNotMatch(plan.userPrompt, /支付回调验签机密内容/);
  const exported = read(join(f.wiki, "sessions", SID_A, "sources", "main.md"));
  assert.match(exported, /wiki 读取结果，已跳过以防自引用/);
  assert.doesNotMatch(exported, /支付回调验签机密内容/);
});

test("size-capped batches stay dirty, advance contiguously, and finish the backlog", () => {
  const f = fixture(test);
  // Two more turns than one batch can hold.
  for (let i = 3; i <= MAX_TURNS_PER_COMPILE + 2; i++) {
    f.appendMain(msg(`u${i}`, `a${i - 1}`, "user", `第 ${i} 个问题`));
    f.appendMain(msg(`a${i}`, `u${i}`, "assistant", `第 ${i} 个回答`));
  }
  refreshSessionWiki(f.wiki, f.main);
  // The first batch is the OLDEST contiguous run, newest turns left for later.
  const first = prepareCompile(f.wiki, f.main, "main")!;
  assert.deepEqual(first.includedTurns, Array.from({ length: MAX_TURNS_PER_COMPILE }, (_, i) => `turn:u${i + 1}`));
  publishSummary(f.wiki, first, parseModelSummary(summaryJson(["turn:u1"])), { inputTokens: 1, outputTokens: 1, cost: null });
  // Partial coverage must not pass as fresh.
  refreshSessionWiki(f.wiki, f.main);
  assert.equal(readManifest(f.wiki)!.pageStatus[A_MAIN], "dirty");
  const second = prepareCompile(f.wiki, f.main, "main")!;
  assert.ok(second);
  assert.equal(second.mode, "incremental");
  assert.deepEqual(second.includedTurns, ["turn:u25", "turn:u26"]);
  publishSummary(f.wiki, second, parseModelSummary(summaryJson(["turn:u25"])), { inputTokens: 1, outputTokens: 1, cost: null });
  refreshSessionWiki(f.wiki, f.main);
  assert.equal(readManifest(f.wiki)!.pageStatus[A_MAIN], "fresh");
  assert.equal(readManifest(f.wiki)!.pages[A_MAIN]!.coveredTurns.length, MAX_TURNS_PER_COMPILE + 2);
  assert.equal(prepareCompile(f.wiki, f.main, "main"), null);
});

test("a capped backlog keeps queueing until every turn is covered", { timeout: 15000 }, async () => {
  const f = fixture(test);
  for (let i = 3; i <= MAX_TURNS_PER_COMPILE + 2; i++) {
    f.appendMain(msg(`u${i}`, `a${i - 1}`, "user", `第 ${i} 个问题`));
    f.appendMain(msg(`a${i}`, `u${i}`, "assistant", `第 ${i} 个回答`));
  }
  refreshSessionWiki(f.wiki, f.main);
  // One settled event must drain the whole backlog across batches.
  const { value, calls, statuses } = service(test, f, async () =>
    ({ text: summaryJson(calls.length === 1 ? ["turn:u1"] : ["turn:u25"]) }));
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => statuses.some(s => s.branches.some(b => b.branchId === "main" && b.status === "fresh")));
  assert.equal(calls.length, 2);
  assert.equal(readManifest(f.wiki)!.pages[A_MAIN]!.coveredTurns.length, MAX_TURNS_PER_COMPILE + 2);
});

test("queued tasks compile into their own project's wiki, not the current view", { timeout: 15000 }, async () => {
  const f = fixture(test);
  const otherRoot = workspaceWikiDir(mkdtempSync(join(tmpdir(), "pix-wiki-other-")));
  refreshSessionWiki(f.wiki, f.main);
  let current: string | null = f.wiki;
  let calls = 0;
  const gate = deferred();
  const value = new WikiService({
    wikiRoot: () => current,
    settings: () => ({ enabled: true }),
    defaultModel: () => ({ provider: "p", id: "m" }),
    callModel: async () => {
      calls += 1;
      await gate.promise;
      return { text: summaryJson(["turn:u1", "turn:u2"]), usage: null };
    },
    emit: () => {},
    retryDelaysMs: [5, 5, 5],
  });
  // Remote projects (null root) keep no wiki at all.
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" }, null);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(calls, 0);
  // The task is enqueued with project A's root bound at event time...
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" }, f.wiki);
  await until(() => calls === 1);
  // ...and the view switches to project B before the model replies.
  current = otherRoot;
  gate.resolve();
  await until(() => Boolean(readManifest(f.wiki)?.pages[A_MAIN]));
  assert.ok(readManifest(f.wiki)!.pages[A_MAIN]);
  assert.ok(!existsSync(otherRoot));
});

test("plain sessions without .pix-tree compile without fake graph storage", () => {
  const f = fixture(test);
  const plain = join(f.project, ".pi", "sessions", "c.jsonl");
  writeFileSync(plain, encode("session-c", [...B_TURN]));
  const result = refreshSessionWiki(f.wiki, plain);
  assert.equal(result.snap.ids.join(), "main");
  assert.ok(!existsSync(`${plain}.pix-tree`));
  const plan = prepareCompile(f.wiki, plain, "main")!;
  publishSummary(f.wiki, plan, parseModelSummary(summaryJson(["turn:u9"])), { inputTokens: 1, outputTokens: 1, cost: null });
  refreshSessionWiki(f.wiki, plain);
  assert.equal(readManifest(f.wiki)!.pageStatus["sessions/session-c/branches/main.md"], "fresh");
  assert.ok(existsSync(join(f.wiki, "sessions", "session-c", "tree.md")));
  assert.ok(!existsSync(`${plain}.pix-tree`));
});
