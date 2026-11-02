import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionImageEncoder } from "../src/shared/session-images.js";
import { projectSession } from "../src/shared/session.js";
import { validatePromptImages } from "../src/shared/images.js";
import { validateRouteInput } from "../src/shared/contracts.js";
import { MainController } from "../src/main/controller.js";
import { headlessPlatform } from "../src/host/local-host.js";
import type { SessionSnapshot } from "../src/shared/types.js";

const image = { type: "image", mimeType: "image/png", data: "a".repeat(1_000_000) };
function snapshot(): SessionSnapshot {
  const entries = [{ type: "message", id: "user", parentId: null, timestamp: "2026-10-28", message: {
    role: "user", content: [{ type: "text", text: "inspect" }, image],
  } }];
  return { session: { id: "s", path: "/session.jsonl", cwd: "/", created: "", modified: "", messageCount: 1, firstMessage: "inspect" },
    entries, projection: projectSession(entries, "user"), runtime: { available: true } as SessionSnapshot["runtime"],
    graph: { id: "/session.jsonl", epoch: "epoch", revision: 1, runs: [] } };
}
test("desktop history replaces image bytes in both entries and projection without modifying SDK data", () => {
  const original = snapshot(), encode = sessionImageEncoder();
  const before = JSON.stringify(original), wire = encode(original);
  assert.ok(JSON.stringify(wire).length < 5000);
  assert.equal(JSON.stringify(original), before);
  const reference = { type: "image", mimeType: "image/png", reference: { session: "/session.jsonl", entryId: "user", index: 1, epoch: "epoch" } };
  assert.deepEqual(wire.projection.messages[0]!.images, [reference]);
  assert.deepEqual(projectSession(wire.entries, "user").messages[0]!.images, [reference]);
  assert.throws(() => validatePromptImages([reference]));
  assert.equal(encode({ ...original }).entries, wire.entries);
  assert.equal(encode({ ...original }).projection, wire.projection);
  // JSON transport recreates separate image objects in raw entries and projected messages.
  assert.ok(JSON.stringify(encode(JSON.parse(before))).length < 5000);
  const restarted = encode({ ...original, graph: { ...original.graph!, epoch: "new" } });
  assert.equal((restarted.projection.messages[0]!.images![0] as typeof reference).reference.epoch, "new");
  assert.deepEqual(encode({ current: original }).current, wire);
  assert.deepEqual(encode({ type: "sessions", payload: { current: original } }).payload.current, wire);
});

test("identical images retain their own message identity and MIME type", () => {
  const original = snapshot();
  original.entries.push({ type: "message", id: "second", parentId: "user", timestamp: "2026-10-28", message: {
    role: "assistant", content: [{ ...image, mimeType: "image/jpeg" }],
  } });
  original.projection = projectSession(original.entries, "second");
  const wire = sessionImageEncoder()(JSON.parse(JSON.stringify(original)));
  assert.equal(wire.projection.messages[0]!.images![0]!.mimeType, "image/png");
  assert.equal((wire.projection.messages[0]!.images![0] as { reference: { entryId: string } }).reference.entryId, "user");
  assert.equal((wire.projection.messages[1]!.images![0] as { reference: { entryId: string } }).reference.entryId, "second");
});

test("reopening changed read-only history invalidates image caches even without a graph epoch", () => {
  const encode = sessionImageEncoder();
  const first = snapshot(); delete first.graph;
  const second = snapshot(); delete second.graph;
  second.entries[0]!.message = { role: "user", content: [{ type: "text", text: "inspect" }, { ...image, data: "changed" }] };
  second.projection = projectSession(second.entries, "user");
  assert.notDeepEqual(encode(first).projection.messages[0]!.images![0], encode(second).projection.messages[0]!.images![0]);
});

test("on-demand reads return exact original bytes and reject stale references or arbitrary files", async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-session-images-"));
  const previous = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  const cwd = join(home, "project"); mkdirSync(cwd);
  const controller = new MainController(cwd, headlessPlatform);
  try {
    controller.current = snapshot();
    const request = { session: "/session.jsonl", entryId: "user", index: 1, epoch: "epoch" };
    assert.deepEqual(await controller.invoke("session.image", request), image);
    await assert.rejects(controller.invoke("session.image", { ...request, session: "/etc/passwd" }), /unavailable/);
    await assert.rejects(controller.invoke("session.image", { ...request, entryId: "deleted" }), /unavailable/);
    await assert.rejects(controller.invoke("session.image", { ...request, index: 0 }), /unavailable/);
    await assert.rejects(controller.invoke("session.image", { ...request, epoch: "old" }), /changed/);
    for (const index of [-1, 1.2, "1"]) assert.throws(() => validateRouteInput("session.image", { ...request, index }));
    // Remote/owned read-only views have no local runtime or epoch. Serve the
    // opened bytes locally, and reject stale content without contacting a host.
    delete controller.current.graph;
    const readonly = sessionImageEncoder()(controller.current).projection.messages[0]!.images![0]!;
    assert.ok("reference" in readonly && readonly.reference.digest);
    if (!("reference" in readonly)) assert.fail("Expected a reference");
    Object.defineProperty(controller, "wsl", { value: { request: () => assert.fail("Images already in memory must not use remote routes") } });
    assert.deepEqual(await controller.invoke("session.image", readonly.reference), image);
    controller.current.entries[0]!.message = { role: "user", content: [{ type: "text", text: "inspect" }, { ...image, data: "different" }] };
    await assert.rejects(controller.invoke("session.image", readonly.reference), /changed/);
    assert.throws(() => validateRouteInput("session.image", { ...request, digest: "not-a-digest" }));
    controller.current.entries[0]!.message = { role: "toolResult", content: [
      ...Array.from({ length: 10001 }, () => ({ type: "text", text: "" })), image,
    ] };
    assert.deepEqual(await controller.invoke("session.image", { ...request, epoch: undefined, index: 10001 }), image);
  } finally {
    await controller.closeAll(); controller.dispose();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("image references preserve Windows, UNC and WSL paths without local filesystem translation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pix-image-paths-"));
  const previous = process.env.PIX_HOME;
  process.env.PIX_HOME = home;
  const controller = new MainController(null, headlessPlatform);
  try {
    // A current snapshot must be sufficient even if its host is disconnected.
    Object.defineProperty(controller, "entryFor", { value: () => assert.fail("Current images must not probe the local filesystem") });
    Object.defineProperty(controller, "wsl", { value: { request: () => assert.fail("Image reads must not depend on a remote route") } });
    for (const path of [String.raw`C:\Users\测试 用户\.pi\sessions\image.jsonl`,
      String.raw`\\server\共享文件\sessions\image.jsonl`, "/home/测试 用户/.pi/sessions/image.jsonl", "/mnt/c/Users/test/sessions/image.jsonl"]) {
      for (const readonly of [false, true]) {
        const original = snapshot();
        original.session.path = path;
        original.runtime.available = false;
        if (readonly) delete original.graph;
        controller.current = original;
        const encoded = JSON.parse(JSON.stringify(sessionImageEncoder()(original))) as SessionSnapshot;
        const ref = encoded.projection.messages[0]!.images![0]!;
        if (!("reference" in ref)) assert.fail("Expected a reference");
        assert.equal(ref.reference.session, path);
        assert.deepEqual(await controller.invoke("session.image", ref.reference), image);
        if (readonly) {
          // A second machine may use precisely the same session path and entry ID.
          controller.current = snapshot();
          controller.current.session.path = path;
          delete controller.current.graph;
          controller.current.entries[0]!.message = { role: "user", content: [{ type: "text", text: "inspect" }, { ...image, data: "another-host" }] };
        } else controller.current = { ...original, graph: { ...original.graph!, epoch: "restarted-host" } };
        await assert.rejects(controller.invoke("session.image", ref.reference), /changed/);
      }
    }
  } finally {
    await controller.closeAll(); controller.dispose();
    if (previous === undefined) delete process.env.PIX_HOME; else process.env.PIX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
