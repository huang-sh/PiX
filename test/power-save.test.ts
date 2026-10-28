import test from "node:test";
import assert from "node:assert/strict";
import { createKeepAwake } from "../src/main/power-save.js";

test("power assertions switch modes without a gap and release handle zero", () => {
  const calls: unknown[][] = [];
  let nextId = 0;
  const keepAwake = createKeepAwake({
    start(type) { calls.push(["start", type]); return nextId++; },
    stop(id) { calls.push(["stop", id]); return true; },
  }, () => false);
  keepAwake(false);
  keepAwake(true);
  keepAwake(true);
  keepAwake(true, true);
  keepAwake(true, true);
  keepAwake(true, false);
  keepAwake(false);
  keepAwake(false);
  assert.deepEqual(calls, [
    ["start", "prevent-app-suspension"],
    ["start", "prevent-display-sleep"], ["stop", 0],
    ["start", "prevent-app-suspension"], ["stop", 1],
    ["stop", 2],
  ]);
});

test("a failed mode change preserves the existing assertion and can be retried", () => {
  const stopped: number[] = [];
  let nextId = 0, fail = true;
  const keepAwake = createKeepAwake({
    start(type) {
      if (type === "prevent-display-sleep" && fail) throw new Error("Unavailable");
      return nextId++;
    },
    stop(id) { stopped.push(id); return true; },
  }, () => false);
  keepAwake(true);
  assert.throws(() => keepAwake(true, true), /Unavailable/);
  assert.deepEqual(stopped, []);
  fail = false;
  keepAwake(true, true);
  keepAwake(false);
  assert.deepEqual(stopped, [0, 1]);
});

test("quitting prevents late activation but still releases the current assertion", () => {
  let quitting = false, started = 0;
  const stopped: number[] = [];
  const keepAwake = createKeepAwake({
    start() { return started++; },
    stop(id) { stopped.push(id); return true; },
  }, () => quitting);
  keepAwake(true, true);
  quitting = true;
  keepAwake(true, false);
  keepAwake(false);
  keepAwake(true, true);
  assert.equal(started, 1);
  assert.deepEqual(stopped, [0]);
});
