import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PixieRuntime, pixieWorkspace } from "../src/main/pixie-runtime.js";
import type { DesktopEvent } from "../src/shared/types.js";

const line = (value: unknown) => JSON.stringify(value) + "\n";
const sessionFile = (id: string, text: string) =>
  line({ type: "session", version: 3, id, cwd: "/test", timestamp: "2026-01-01T00:00:00.000Z" }) +
  line({ type: "message", id: `${id}-m1`, parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: text, timestamp: 1 } });

/** A runtime whose subprocess is mocked out: no boot, no monitor, scripted RPC. */
function fixture(t: TestContext, files: Array<{ name: string; id: string; text: string; modified: Date }>) {
  const previous = process.env.PIX_HOME;
  const home = mkdtempSync(join(tmpdir(), "pix-pixie-sessions-"));
  process.env.PIX_HOME = home;
  const dir = join(pixieWorkspace(), "sessions");
  mkdirSync(dir, { recursive: true });
  const paths = new Map<string, string>();
  for (const file of files) {
    const path = join(dir, file.name);
    writeFileSync(path, sessionFile(file.id, file.text));
    utimesSync(path, file.modified, file.modified);
    paths.set(file.id, path);
  }
  const events: DesktopEvent[] = [];
  const runtime = new PixieRuntime(event => events.push(event), () => ({}));
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete process.env.PIX_HOME;
    else process.env.PIX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  t.mock.method(runtime as any, "startMonitoring", () => {});
  t.mock.method(runtime as any, "startAgent", async () => {});
  return { runtime, events, paths, dir };
}

test("sessions lists conversations newest first and marks the live one", async t => {
  const { runtime, paths } = fixture(t, [
    { name: "older.jsonl", id: "older", text: "older prompt", modified: new Date("2026-01-01T00:00:00Z") },
    { name: "newer.jsonl", id: "newer", text: "newer prompt", modified: new Date("2026-01-02T00:00:00Z") },
  ]);
  // Without a live process there is nothing to mark active.
  assert.deepEqual((await runtime.sessions()).map(row => [row.id, row.active]), [
    ["newer", undefined],
    ["older", undefined],
  ]);
  assert.equal((await runtime.sessions())[0]!.firstMessage, "newer prompt");

  // A live process marks its own session file.
  const requests: unknown[][] = [];
  Object.defineProperty(runtime["rpc"], "running", { get: () => true });
  t.mock.method(runtime["rpc"], "request", async (input: { type: string }, timeout?: number) => {
    requests.push([input, timeout]);
    return input.type === "get_state" ? { sessionFile: paths.get("older") } : {};
  });
  const rows = await runtime.sessions();
  // The listing degrades to unmarked rows quickly when the subprocess wedges.
  assert.deepEqual(requests, [[{ type: "get_state" }, 2_000]]);
  assert.equal(rows.find(row => row.id === "older")!.active, true);
  assert.equal(rows.find(row => row.id === "newer")!.active, undefined);
});

test("switchSession repoints the runtime at a listed conversation", async t => {
  const { runtime, paths, events } = fixture(t, [
    { name: "a.jsonl", id: "aaaa1111", text: "first prompt", modified: new Date("2026-01-01T00:00:00Z") },
  ]);
  const marker = { session: { path: paths.get("aaaa1111")! }, entries: [], projection: { messages: [], nodes: [] }, runtime: {} };
  t.mock.method(runtime as any, "snapshot", async () => marker);
  const requests: unknown[] = [];
  Object.defineProperty(runtime["rpc"], "running", { get: () => true });
  t.mock.method(runtime["rpc"], "request", async (input: unknown) => {
    requests.push(input);
    return {};
  });

  assert.equal(await runtime.switchSession(paths.get("aaaa1111")!), marker);
  assert.deepEqual(requests, [{ type: "switch_session", sessionPath: paths.get("aaaa1111") }]);
  // Every attached surface follows the switch, not just the caller.
  assert.deepEqual(events, [{ type: "pixie", payload: { type: "snapshot", payload: marker } }]);
  assert.equal(runtime.busy, false);
});

test("listings follow file changes: edited summaries re-read, deleted files dropped", async t => {
  const { runtime, paths, dir } = fixture(t, [
    { name: "a.jsonl", id: "aaaa1111", text: "first prompt", modified: new Date("2026-01-01T00:00:00Z") },
  ]);
  assert.deepEqual((await runtime.sessions()).map(row => row.firstMessage), ["first prompt"]);

  // A rewrite with a newer mtime must invalidate the cached summary.
  const later = new Date("2026-01-03T00:00:00Z");
  writeFileSync(paths.get("aaaa1111")!, sessionFile("aaaa1111", "rewritten prompt"));
  utimesSync(paths.get("aaaa1111")!, later, later);
  const edited = await runtime.sessions();
  assert.equal(edited[0]!.firstMessage, "rewritten prompt");
  assert.equal(edited[0]!.modified, later.toISOString());

  // A second file appears; deleting the first leaves only the survivor.
  const newest = new Date("2026-01-04T00:00:00Z");
  const second = join(dir, "b.jsonl");
  writeFileSync(second, sessionFile("bbbb2222", "second prompt"));
  utimesSync(second, newest, newest);
  assert.deepEqual((await runtime.sessions()).map(row => row.id), ["bbbb2222", "aaaa1111"]);
  rmSync(paths.get("aaaa1111")!);
  assert.deepEqual((await runtime.sessions()).map(row => row.id), ["bbbb2222"]);
});

test("switchSession refuses files outside Pixie's session dirs and busy runtimes", async t => {
  const { runtime } = fixture(t, [
    { name: "a.jsonl", id: "aaaa1111", text: "first prompt", modified: new Date("2026-01-01T00:00:00Z") },
  ]);
  await assert.rejects(runtime.switchSession(join(tmpdir(), "elsewhere.jsonl")), /Not a saved Pixie conversation/);
  runtime["turnTiming"] = { promptAt: Date.now() };
  await assert.rejects(runtime.switchSession(join("nonexistent", "path.jsonl")), /Stop Pixie/);
});
