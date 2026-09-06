import test from "node:test";
import assert from "node:assert/strict";
import { validateRouteInput } from "../src/shared/contracts.js";
import { projectSession } from "../src/shared/session.js";
import { MAX_IMAGE_BYTES } from "../src/shared/images.js";
import { PiRuntime } from "../src/main/pi-runtime.js";
import type { PromptImage } from "../src/shared/types.js";

const image: PromptImage = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };

test("image-only prompts survive IPC validation and invalid attachments are rejected", () => {
  for (const action of ["prompt", "steer", "followUp"]) {
    assert.deepEqual(validateRouteInput("agent.control", { action, text: "", images: [image] }), { action, text: "", images: [image] });
    for (const images of [null, [null], [{ ...image, mimeType: "image/svg+xml" }], [{ ...image, data: "file:///secret" }], Array(9).fill(image), [{ ...image, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64") }]])
      assert.throws(() => validateRouteInput("agent.control", { action, text: "hello", images }));
  }
  assert.throws(() => validateRouteInput("agent.control", { action: "prompt", text: "", images: [] }));
});

test("projects persisted images into branch messages and labels image-only graph nodes", () => {
  const projection = projectSession([{ type: "message", id: "u1", parentId: null, timestamp: "2026-09-06", message: { role: "user", content: [image] } }], "u1");
  assert.deepEqual(projection.messages[0]!.images, [image]);
  assert.equal(projection.messages[0]!.text, "");
  assert.equal(projection.nodes[0]!.imageCount, 1);
  assert.equal(projection.nodes[0]!.title, "🖼 × 1");
});

test("runtime forwards image content to Pi prompt and queues and rejects text-only models", async () => {
  const calls: unknown[][] = [];
  const runtime = new PiRuntime("/project", null, () => {}, async () => {});
  const session = {
    model: { input: ["text", "image"] },
    sessionManager: { getEntries: () => [] },
    prompt: async (...args: unknown[]) => { calls.push(args); },
    steer: async (...args: unknown[]) => { calls.push(args); },
    followUp: async (...args: unknown[]) => { calls.push(args); },
  };
  runtime.runtime = { session };
  runtime.snapshot = (() => ({})) as typeof runtime.snapshot;
  await runtime.control({ action: "prompt", text: "", images: [image] });
  await runtime.control({ action: "steer", text: "look", images: [image] });
  await runtime.control({ action: "followUp", text: "look", images: [image] });
  assert.deepEqual(calls, [["", { source: "interactive", images: [image] }], ["look", [image]], ["look", [image]]]);
  session.model.input = ["text"];
  await assert.rejects(runtime.control({ action: "prompt", text: "look", images: [image] }), /does not support image/);
  assert.equal(calls.length, 3);
  const updated = { provider: "custom", id: "model", input: ["text", "image"] };
  let modelChanges = 0;
  const remoteSession = {
    ...session, model: { ...updated, input: ["text"] },
    modelRuntime: { getModel: () => ({ ...updated }) },
    setModel: async (model: typeof updated) => { remoteSession.model = model; modelChanges++; },
  };
  runtime.runtime = { session: remoteSession };
  runtime.brokerProviders.add("custom");
  await runtime.control({ action: "prompt", text: "updated vision", images: [image] });
  assert.deepEqual(remoteSession.model, updated);
  assert.equal(calls.length, 4);
  await runtime.control({ action: "prompt", text: "unchanged model", images: [image] });
  assert.equal(modelChanges, 1);
});
