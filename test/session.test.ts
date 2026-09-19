import test from "node:test";
import assert from "node:assert/strict";
import { deliversPendingTurn } from "../src/shared/session.js";

const messages = (rows: Array<[string, string, string]>) =>
  rows.map(([entryId, role, text]) => ({ entryId, role, text }));

test("delivers a pending turn only through an entry the send never saw", () => {
  const history = messages([["u1", "user", "hi"], ["a1", "assistant", "hello"]]);
  const known = ["u1", "a1"];

  assert.equal(deliversPendingTurn(history, "hi", known), false);
  assert.equal(deliversPendingTurn(history, "hello", known), false);
  assert.equal(
    deliversPendingTurn([...history, { entryId: "u2", role: "user", text: "hi" }], "hi", known),
    true,
  );
});

test("never matches assistant entries carrying the sent text", () => {
  const history = messages([["u1", "user", "echo"], ["a1", "assistant", "echo"]]);
  assert.equal(deliversPendingTurn(history, "echo", ["u1"]), false);
});

test("accepts the set shape the assistant store keeps alongside the array shape", () => {
  assert.equal(deliversPendingTurn(messages([["u9", "user", "go"]]), "go", new Set(["u1"])), true);
  assert.equal(deliversPendingTurn(messages([["u9", "user", "go"]]), "go", new Set(["u9"])), false);
});
