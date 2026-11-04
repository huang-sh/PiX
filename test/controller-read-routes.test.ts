import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MainController, type Platform } from "../src/main/controller.js";
import type { RawSessionEntry, SessionSnapshot } from "../src/shared/types.js";
import { projectSession } from "../src/shared/session.js";
import { GraphFiles, durableWrite, encodeSession } from "../src/main/graph-files.js";
import { SessionFiles } from "../src/main/services.js";

// Settled sessions are remembered into PIX_HOME's settings.json, so without an
// isolated home these tests would enroll their temp workspaces in the real
// session panel.
const home = mkdtempSync(join(tmpdir(), "pix-read-routes-home-"));
process.env.PIX_HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const platform: Platform = {
  async pickProject() {
    return undefined;
  },
  async pickSession() {
    return undefined;
  },
  async confirm() {
    return false;
  },
  async openExternal() {},
  async openPath() {},
  async openWith() {},
  async openWithApps() { return []; },
  async openWithApp() {},
  showItemInFolder() {},
  quit() {},
};

/** A runtime window or a certified full read-only history. */
function viewOf(path: string, messagesHasEarlier: boolean): SessionSnapshot {
  const entries: RawSessionEntry[] = [
    { type: "message", id: "u0", parentId: null, timestamp: "1", message: { role: "user", content: [{ type: "text", text: "needle 0" }] } },
    { type: "message", id: "a0", parentId: "u0", timestamp: "1", message: { role: "assistant", content: [{ type: "text", text: "answer 0" }] } },
  ];
  return {
    session: { id: "s", path, created: "1", modified: "1", messageCount: 2, firstMessage: "" },
    entries,
    ...(!messagesHasEarlier ? { entriesComplete: true as const } : {}),
    projection: { ...projectSession(entries, null), ...(messagesHasEarlier ? { messagesHasEarlier: true } : {}) },
    runtime: {} as SessionSnapshot["runtime"],
  } as unknown as SessionSnapshot;
}

test("full-history reads refuse a windowed view whose runtime is gone instead of truncating", async () => {
  const controller = new MainController(null, platform);
  const path = resolve(join(home, "sessions", "s.jsonl"));
  controller.current = viewOf(path, true);
  await assert.rejects(controller.invoke("session.branchWindow", { session: path, limit: 40, bytes: 4194304 }), /Session is not open/);
  await assert.rejects(controller.invoke("session.search", { session: path, query: "needle" }), /Session is not open/);
  await assert.rejects(controller.invoke("session.prompts", { session: path }), /Session is not open/);
});

test("a complete view still serves full-history reads without a runtime", async () => {
  const controller = new MainController(null, platform);
  const path = resolve(join(home, "sessions", "s.jsonl"));
  controller.current = viewOf(path, false);
  const window = await controller.invoke("session.branchWindow", { session: path, limit: 40, bytes: 4194304 }) as { entries: RawSessionEntry[] };
  assert.equal(window.entries.length, 2, "the read-only view pages its whole history");
  const search = await controller.invoke("session.search", { session: path, query: "needle" }) as { nodeIds: string[] };
  assert.ok(search.nodeIds.length === 1, "search covers the complete view");
  const recall = await controller.invoke("session.prompts", { session: path }) as { prompts: string[] };
  assert.deepEqual(recall.prompts, ["needle 0"]);
});

test("a read-only fallback retains branch history for paging, search and recall", async () => {
  const dir = mkdtempSync(join(home, "readonly-"));
  const path = join(dir, "main.jsonl");
  const header = { type: "session", version: 3, id: "main", cwd: dir, timestamp: "2026-01-01" };
  const main = viewOf(path, false).entries;
  const branch: RawSessionEntry[] = [
    ...main,
    { type: "message", id: "ub", parentId: "a0", timestamp: "2", message: { role: "user", content: "branch question" } },
    { type: "message", id: "ab", parentId: "ub", timestamp: "2", message: { role: "assistant", content: "branch-only-needle" } },
  ];
  durableWrite(path, encodeSession({ header, entries: main }));
  const graph = new GraphFiles(path);
  graph.acquire();
  try {
    graph.save({ id: "b", parentId: "main", forkEntryId: "a0", inherited: { u0: "u0", a0: "a0" },
      baseline: main, header, request: { text: "branch question" }, requestId: "req", runId: "run", status: "idle" });
    durableWrite(graph.path("b"), encodeSession({ header, entries: branch }));
    const controller = new MainController(null, platform);
    const warnings: string[] = [];
    controller.current = controller.fallback(path, new SessionFiles(dir, dir), message => warnings.push(message));
    assert.deepEqual(warnings, []);
    assert.equal(controller.current.runtime.available, false);
    assert.deepEqual(controller.current.entries.map(entry => entry.id), ["u0", "a0", "b:ub", "b:ab"]);
    const node = controller.current.projection.nodes.find(node => node.branchId === "b")!;
    const page = await controller.invoke("session.branchWindow", { session: path, leafId: node.leafEntryId,
      limit: 40, bytes: 4 << 20 }) as { entries: RawSessionEntry[]; hasEarlier: boolean };
    assert.deepEqual(page.entries.map(entry => entry.id), ["u0", "a0", "b:ub", "b:ab"]);
    assert.equal(page.hasEarlier, false);
    assert.deepEqual(await controller.invoke("session.search", { session: path, query: "branch-only-needle" }),
      { nodeIds: [node.id] });
    assert.deepEqual(await controller.invoke("session.prompts", { session: path }),
      { prompts: ["branch question", "needle 0"] });

    // A short main line has no earlier messages, but its live wire snapshot
    // still omits the branch. Losing the runtime must not certify that window.
    const { entriesComplete, ...live } = controller.current;
    assert.equal(entriesComplete, true);
    controller.current = { ...live, entries: main };
    assert.equal(controller.current.projection.messagesHasEarlier, undefined);
    await assert.rejects(controller.invoke("session.branchWindow", { session: path, leafId: node.leafEntryId,
      limit: 40, bytes: 4 << 20 }), /Session is not open/);
    await assert.rejects(controller.invoke("session.search", { session: path, query: "branch-only-needle" }), /Session is not open/);
    await assert.rejects(controller.invoke("session.prompts", { session: path }), /Session is not open/);
  } finally { graph.release(); }
});

test("an uncertified short window cannot serve full history even when all message ids fit", async () => {
  const controller = new MainController(null, platform);
  const path = resolve(join(home, "sessions", "short.jsonl"));
  const { entriesComplete: _, ...window } = viewOf(path, false);
  // A wire copy can also omit tool details without losing any entry ids.
  controller.current = window;
  await assert.rejects(controller.invoke("session.branchWindow", { session: path, limit: 40, bytes: 4 << 20 }), /Session is not open/);
  await assert.rejects(controller.invoke("session.search", { session: path, query: "needle" }), /Session is not open/);
  await assert.rejects(controller.invoke("session.prompts", { session: path }), /Session is not open/);
});
