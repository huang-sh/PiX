import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MainController, type Platform } from "../src/main/controller.js";
import type { RawSessionEntry, SessionSnapshot } from "../src/shared/types.js";
import { projectSession } from "../src/shared/session.js";

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

/** The view of a session whose runtime is gone: what `current` holds after a
 * disposal race. `messagesHasEarlier` marks the live wire window. */
function viewOf(path: string, messagesHasEarlier: boolean): SessionSnapshot {
  const entries: RawSessionEntry[] = [
    { type: "message", id: "u0", parentId: null, timestamp: "1", message: { role: "user", content: [{ type: "text", text: "needle 0" }] } },
    { type: "message", id: "a0", parentId: "u0", timestamp: "1", message: { role: "assistant", content: [{ type: "text", text: "answer 0" }] } },
  ];
  return {
    session: { id: "s", path, created: "1", modified: "1", messageCount: 2, firstMessage: "" },
    entries,
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
