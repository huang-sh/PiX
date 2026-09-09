import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RawSessionEntry } from "../src/shared/types.js";
import type { WikiStatus } from "../src/shared/wiki.js";
import {
  parseModelSummary, prepareCompile, publishSummary, readManifest, refreshWiki, wikiDir,
} from "../src/main/wiki-compiler.js";
import { WikiService } from "../src/main/wiki-service.js";

const BID = "11111111-1111-4111-8111-111111111111";
const BRANCH = `branches/${BID}.md`, MAIN = "branches/main.md";
const read = (file: string) => readFileSync(file, "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const msg = (id: string, parentId: string | null, role: string, value: string, extra: Record<string, unknown> = {}): RawSessionEntry =>
  ({ type: "message", id, parentId, timestamp: "2026-09-01T10:00:00.000Z",
    message: { role, content: [{ type: "text", text: value }], ...(role === "assistant" ? { stopReason: "stop" } : {}), ...extra } }) as RawSessionEntry;
const encode = (header: Record<string, unknown>, entries: RawSessionEntry[]) => [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n";
const HEADER = { type: "session", version: 3, id: "test", timestamp: "2026-09-01T10:00:00.000Z" };
const BASE = [msg("u1", null, "user", "shared question"), msg("a1", "u1", "assistant", "shared answer")];
const MAIN_TURN_2 = [msg("u2", "a1", "user", "main question"), msg("a2", "u2", "assistant", "main answer")];
const BRANCH_TURN = [msg("b1", "a1", "user", "branch question"), msg("b2", "b1", "assistant", "branch answer")];

interface Fixture {
  main: string;
  branchFile: string;
  origin: string;
  wiki: string;
  modify: (file: string, fn: (entries: Record<string, unknown>[]) => void) => void;
  appendMain: (entry: RawSessionEntry) => void;
}

function fixture(t: { after(fn: () => void): void }): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "pix-wiki-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const main = join(tmp, "test.jsonl"), dir = `${main}.pix-tree`, wiki = join(dir, "wiki");
  mkdirSync(join(wiki, "branches"), { recursive: true });
  mkdirSync(join(wiki, "topics"));
  writeFileSync(main, encode(HEADER, [...BASE, ...MAIN_TURN_2]));
  const branchFile = join(dir, `${BID}.jsonl`), origin = `${branchFile}.origin.json`;
  writeFileSync(branchFile, encode(HEADER, [...BASE, ...BRANCH_TURN]));
  writeFileSync(origin, JSON.stringify({
    id: BID, parentId: "main", forkEntryId: "a1", baseline: BASE, inherited: { u1: "u1", a1: "a1" },
    status: "idle", header: HEADER, request: { text: "branch request" }, requestId: "r1", runId: "run1",
  }) + "\n");
  const modify = (file: string, fn: (entries: Record<string, unknown>[]) => void) => {
    const lines = read(file).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    fn(lines);
    writeFileSync(file, lines.map(e => JSON.stringify(e)).join("\n") + "\n");
  };
  const appendMain = (entry: RawSessionEntry) => { writeFileSync(main, read(main) + JSON.stringify(entry) + "\n"); };
  return { main, branchFile, origin, wiki, modify, appendMain };
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

const summaryJson = (evidence: string[], summary = "一句话总结") => JSON.stringify({
  summary, goal: "目标描述",
  conclusions: [{ text: "结论内容", evidence }],
  corrections: [], openQuestions: [{ text: "未解决事项", evidence }],
});

function service(
  t: { after(fn: () => void): void },
  handler: (request: { userPrompt: string; provider: string; modelId: string }) => Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number; cost: number } }>,
  options: { settings?: Record<string, unknown>; defaultModel?: { provider: string; id: string } | null } = {},
) {
  const calls: Array<{ userPrompt: string }> = [];
  const statuses: WikiStatus[] = [];
  const settings = { enabled: true, ...(options.settings ?? {}) };
  const value = new WikiService({
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

test("deterministic refresh is idempotent, keeps receipts and never touches sources", () => {
  const f = fixture(test);
  const original = [f.main, f.branchFile, f.origin].map(hash);
  const first = refreshWiki(f.wiki);
  assert.equal(first.snap.nodes.length, 3);
  assert.equal(first.errors.filter(e => !e.startsWith("Missing branch summary")).length, 0);
  // Second refresh writes nothing.
  assert.equal(refreshWiki(f.wiki).changed, 0);
  assert.deepEqual([f.main, f.branchFile, f.origin].map(hash), original);
  // Sources exports are lossy: no thinking, aborted runs keep their error state.
  const exported = read(join(f.wiki, "sources/main.md"));
  assert.match(exported, /turn:u2/);
  assert.ok(existsSync(join(f.wiki, "index.md")));
  assert.ok(existsSync(join(f.wiki, "tree.md")));
});

test("publish advances coverage incrementally; a new turn during the call is not wasted work", () => {
  const f = fixture(test);
  refreshWiki(f.wiki);
  const plan = prepareCompile(f.wiki, "main");
  assert.ok(plan);
  assert.equal(plan!.mode, "reset");
  assert.deepEqual(plan!.includedTurns, ["turn:u1", "turn:u2"]);
  // Turn 21 lands while the model runs; publishing the read range must still succeed.
  f.appendMain(msg("u3", "a2", "user", "late question"));
  publishSummary(f.wiki, plan!, parseModelSummary(summaryJson(["turn:u2"])), { inputTokens: 10, outputTokens: 20, cost: 0.001 });
  let manifest = readManifest(f.wiki)!;
  assert.deepEqual(manifest.pages[MAIN]!.coveredTurns, ["turn:u1", "turn:u2"]);
  assert.equal(manifest.usage!.calls, 1);
  assert.equal(manifest.usage!.input, 10);
  refreshWiki(f.wiki);
  assert.equal(readManifest(f.wiki)!.pageStatus[MAIN], "dirty");
  // The next compile is incremental and only summarizes the delta.
  const next = prepareCompile(f.wiki, "main");
  assert.ok(next);
  assert.equal(next!.mode, "incremental");
  assert.deepEqual(next!.includedTurns, ["turn:u3"]);
  assert.match(next!.userPrompt, /旧摘要/);
  publishSummary(f.wiki, next!, parseModelSummary(summaryJson(["turn:u3"], "更新后总结")), { inputTokens: 1, outputTokens: 2, cost: null });
  manifest = readManifest(f.wiki)!;
  assert.deepEqual(manifest.pages[MAIN]!.coveredTurns, ["turn:u1", "turn:u2", "turn:u3"]);
  refreshWiki(f.wiki);
  assert.equal(readManifest(f.wiki)!.pageStatus[MAIN], "fresh");
  assert.equal(prepareCompile(f.wiki, "main"), null);
});

test("stale results cannot overwrite a user edit, an ancestor change, or a deleted session", () => {
  const f = fixture(test);
  refreshWiki(f.wiki);
  // Establish a published, fresh branch page first.
  const first = prepareCompile(f.wiki, BID)!;
  publishSummary(f.wiki, first, parseModelSummary(summaryJson([`turn:${BID}:b1`])), { inputTokens: 1, outputTokens: 1, cost: null });
  refreshWiki(f.wiki);
  assert.equal(readManifest(f.wiki)!.pageStatus[BRANCH], "fresh");
  // 1. A pending delta compile exists; the page is edited while the model runs.
  writeFileSync(f.branchFile, read(f.branchFile) + JSON.stringify(msg("b3", "b2", "user", "follow up")) + "\n");
  const plan = prepareCompile(f.wiki, BID)!;
  assert.equal(plan.mode, "incremental");
  writeFileSync(join(f.wiki, BRANCH), read(join(f.wiki, BRANCH)) + "\n手动补充一行。\n");
  assert.throws(() => publishSummary(f.wiki, plan, parseModelSummary(summaryJson([`turn:${BID}:b3`])), { inputTokens: 1, outputTokens: 1, cost: null }), /page changed/i);
  // 2. A shared ancestor entry changed in place — context hash mismatch.
  const fresh = prepareCompile(f.wiki, BID)!;
  assert.equal(fresh.mode, "reset");
  f.modify(f.main, entries => { (entries.find(e => e.id === "a1")!.message as { content: Array<{ text: string }> }).content[0]!.text = "changed ancestor"; });
  assert.throws(() => publishSummary(f.wiki, fresh, parseModelSummary(summaryJson([`turn:${BID}:b1`])), { inputTokens: 1, outputTokens: 1, cost: null }), /context changed/i);
  // 3. The session disappeared — preparing and publishing must both refuse.
  const again = prepareCompile(f.wiki, BID)!;
  unlinkSync(f.main);
  assert.throws(() => publishSummary(f.wiki, again, parseModelSummary(summaryJson([`turn:${BID}:b1`])), { inputTokens: 1, outputTokens: 1, cost: null }), /gone|session/i);
  assert.throws(() => prepareCompile(f.wiki, BID), /gone/i);
});

test("out-of-scope references are dropped; pages without valid evidence are rejected", () => {
  const f = fixture(test);
  refreshWiki(f.wiki);
  const plan = prepareCompile(f.wiki, BID)!;
  // References outside the branch ancestry or beyond what was shown are filtered.
  const mixed = parseModelSummary(summaryJson([`turn:${BID}:b1`, "turn:u2", "turn:missing"]));
  const receipt = publishSummary(f.wiki, plan, mixed, { inputTokens: 1, outputTokens: 1, cost: null });
  assert.equal(receipt.coveredTurns.length, 1);
  assert.doesNotMatch(read(join(f.wiki, BRANCH)), /turn:u2/);
  // A reply whose only references are out of scope is rejected outright.
  const scoped = parseModelSummary(summaryJson(["turn:u2"]));
  writeFileSync(f.branchFile, read(f.branchFile) + JSON.stringify(msg("b3", "b2", "user", "follow up")) + "\n");
  const followUp = prepareCompile(f.wiki, BID)!;
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
  refreshWiki(f.wiki);
  const before = hash(read(join(f.wiki, "index.md")));
  writeFileSync(f.main, read(f.main) + '{"type":');
  assert.throws(() => refreshWiki(f.wiki), /Invalid session JSON/);
  assert.equal(hash(read(join(f.wiki, "index.md"))), before);
});

test("removed branches lose their export but keep visibly invalid pages", () => {
  const f = fixture(test);
  refreshWiki(f.wiki);
  writeFileSync(join(f.wiki, BRANCH), `# Branch\n\n## 摘要\nS. \`turn:${BID}:b1\`\n\n## 目标\nG\n\n## 关键结论\nC. \`turn:${BID}:b1\`\n\n## 修正与限制\nR\n\n## 未解决项\nU\n`);
  refreshWiki(f.wiki);
  unlinkSync(f.branchFile);
  unlinkSync(f.origin);
  const result = refreshWiki(f.wiki);
  assert.equal(result.manifest.pageStatus[BRANCH], "invalid");
  assert.ok(!existsSync(join(f.wiki, `sources/${BID}.md`)));
});

test("queue dedupes repeated notifications and merges turns arriving mid-run", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshWiki(f.wiki);
  const gate = deferred();
  const { value, calls, statuses } = service(test, async () => {
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
  assert.deepEqual(manifest.pages[MAIN]!.coveredTurns, ["turn:u1", "turn:u2", "turn:u3"]);
  assert.equal(manifest.usage!.input, 10);
  // Wiki activity never wrote to the session sources.
  assert.equal(hash(read(f.main)), originalSources);
});

test("a turn landing mid-call does not waste the finished work; unseen turns are not citable", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshWiki(f.wiki);
  const { value, calls, statuses } = service(test, async () => {
    // The turn lands on disk while the first call runs; the reply also tries to
    // cite the unseen turn, which must be dropped from the published page.
    if (calls.length === 1) {
      f.appendMain(msg("u3", "a2", "user", "late"));
      f.appendMain(msg("a3", "u3", "assistant", "late answer"));
    }
    return { text: summaryJson(["turn:u1", "turn:u2", "turn:u3"]) };
  });
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => statuses.some(s => s.branches.some(b => b.branchId === "main" && b.status === "dirty")));
  assert.equal(calls.length, 1);
  const manifest = readManifest(f.wiki)!;
  // The published receipt covers exactly the read range (round 20, not 21).
  assert.deepEqual(manifest.pages[MAIN]!.coveredTurns, ["turn:u1", "turn:u2"]);
  assert.doesNotMatch(read(join(f.wiki, MAIN)), /turn:u3/);
  // The next queued run picks up the delta and reaches fresh.
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => statuses.some(s => s.branches.some(b => b.branchId === "main" && b.status === "fresh")));
  assert.deepEqual(readManifest(f.wiki)!.pages[MAIN]!.coveredTurns, ["turn:u1", "turn:u2", "turn:u3"]);
});

test("budget exhaustion pauses model summaries but never blocks the program layer", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshWiki(f.wiki);
  const { value, calls, statuses } = service(test, async () => ({ text: summaryJson(["turn:u1"]) }), { settings: { budgetTokens: 1000 } });
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
  refreshWiki(f.wiki);
  const { value, calls, statuses } = service(test, async () => ({ text: summaryJson(["turn:u1"]) }), { defaultModel: null });
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => statuses.some(s => s.branches.some(b => b.error?.includes("模型"))));
  assert.equal(calls.length, 0);
});

test("network failures retry with backoff, then stop with a visible error", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshWiki(f.wiki);
  let attempts = 0;
  const { value, calls, statuses } = service(test, async () => {
    attempts += 1;
    if (attempts <= 2) throw new Error("ECONNRESET");
    return { text: summaryJson(["turn:u1", "turn:u2"]) };
  });
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => statuses.some(s => s.branches.some(b => b.status === "fresh")));
  assert.equal(calls.length, 3);
  // Validation failures never retry: the same reply stays deterministic.
  assert.equal(readManifest(f.wiki)!.pages[MAIN]!.usage.inputTokens, null);
});

test("validation failures do not retry and keep the previous receipt", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshWiki(f.wiki);
  const { value, calls, statuses } = service(test, async () => ({ text: "definitely not json" }));
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => statuses.some(s => s.branches.some(b => b.status === "failed" && b.error?.includes("JSON"))));
  assert.equal(calls.length, 1);
  assert.equal(readManifest(f.wiki)!.pages[MAIN], undefined);
});

test("cancelling a session stops tasks and forbids resurrecting its wiki", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshWiki(f.wiki);
  const gate = deferred();
  const { value, calls } = service(test, async () => {
    await gate.promise;
    return { text: summaryJson(["turn:u1", "turn:u2"]) };
  });
  value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => calls.length === 1);
  // Deleting the session cancels the task before the model result returns.
  value.cancel(f.main);
  unlinkSync(f.main);
  gate.resolve();
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!existsSync(join(f.wiki, MAIN)));
  // A restarted service finds no session and enqueues nothing.
  const restarted = service(test, async () => ({ text: summaryJson(["turn:u1", "turn:u2"]) }));
  restarted.value.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  restarted.value.handleGraphEvent(f.main, { kind: "opened" });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(restarted.calls.length, 0);
});

test("restart recovery re-enqueues dirty branches from the manifest watermark", { timeout: 15000 }, async () => {
  const f = fixture(test);
  refreshWiki(f.wiki);
  const { value: first, statuses: firstStatuses } = service(test, async () => ({ text: summaryJson(["turn:u1", "turn:u2"]) }));
  first.handleGraphEvent(f.main, { kind: "settled", branchId: "main" });
  await until(() => firstStatuses.some(s => s.branches.some(b => b.branchId === "main" && b.status === "fresh")));
  f.appendMain(msg("u3", "a2", "user", "new round"));
  f.appendMain(msg("a3", "u3", "assistant", "new answer"));
  // "Restart": a fresh service opens the session and recovers from the manifest.
  const reopened = service(test, async request =>
    ({ text: request.userPrompt.includes("turn:u3") ? summaryJson(["turn:u3"]) : summaryJson([`turn:${BID}:b1`]) }));
  reopened.value.handleGraphEvent(f.main, { kind: "opened" });
  await until(() => {
    const status = reopened.statuses.at(-1);
    return status?.branches.length === 2 && status.branches.every(b => b.status === "fresh");
  });
  // Main needed only its delta; the never-summarized branch got its first compile.
  const prompts = reopened.calls.map(call => call.userPrompt);
  assert.ok(prompts.some(p => p.includes("turn:u3") && p.includes("旧摘要")), "main recompiled incrementally from the old summary");
  assert.ok(prompts.some(p => p.includes(`turn:${BID}:b1`) && p.includes("第一次生成摘要")), "branch compiled from scratch");
  assert.ok(!prompts.some(p => /## 轮 turn:u1/.test(p)), "already-covered turns were not re-sent");
});

test("status reflects live task state and persists after service restarts", () => {
  const f = fixture(test);
  refreshWiki(f.wiki);
  const { value } = service(test, async () => ({ text: summaryJson(["turn:u1"]) }));
  const status = value.state(f.main);
  assert.equal(status.available, true);
  assert.equal(status.model!.provider, "p");
  assert.equal(status.branches.find(b => b.branchId === "main")!.status, "dirty");
  assert.equal(status.branches.find(b => b.branchId === BID)!.totalTurns, 1);
});
