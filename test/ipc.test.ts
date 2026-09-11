import test from "node:test";
import assert from "node:assert/strict";
import { unwrapInvokeReply } from "../src/shared/ipc.js";

test("a successful invoke reply yields the raw result", () => {
  assert.equal(unwrapInvokeReply({ ok: true, result: 42 }), 42);
  assert.deepEqual(unwrapInvokeReply({ ok: true, result: { path: "/a/SKILL.md" } }), { path: "/a/SKILL.md" });
  assert.equal(unwrapInvokeReply({ ok: true, result: undefined }), undefined);
});

test("a failed invoke reply throws exactly the message the main process wrote", () => {
  // Electron used to add "Error invoking remote method 'pix:invoke': Error: ".
  assert.throws(
    () => unwrapInvokeReply({ ok: false, message: 'A skill named "pdf-tools" already exists' }),
    (error: Error) => error.message === 'A skill named "pdf-tools" already exists',
  );
});
