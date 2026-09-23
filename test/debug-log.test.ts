import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debugLog, MAX_BYTES, setDebugLogEnabled } from "../src/main/debug-log.js";

const withHome = (run: (home: string) => void | Promise<void>) => async () => {
  const previous = process.env.PIX_HOME;
  const root = mkdtempSync(join(tmpdir(), "pix-debug-log-"));
  process.env.PIX_HOME = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.PIX_HOME;
    else process.env.PIX_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
};

const logPath = (home: string) => join(home, ".pix", "log", "main.log");

const waitForText = async (file: string, text: string) => {
  for (let i = 0; i < 400; i++) {
    if (existsSync(file) && readFileSync(file, "utf8").includes(text)) return readFileSync(file, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`missing ${JSON.stringify(text)} in ${file}`);
};

test("writes a timestamped line carrying the error stack", withHome(async (home) => {
  debugLog("unit: context", new Error("boom"));
  const content = await waitForText(logPath(home), "boom");
  assert.match(content, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[unit: context\] Error: boom at /u);
}));

test("logs a context without an error and never throws on odd values", withHome(async (home) => {
  debugLog("unit: bare");
  debugLog("unit: string", "plain failure");
  debugLog("unit: object", { code: 42 });
  const content = await waitForText(logPath(home), "unit: object");
  assert.match(content, /\[unit: bare\]\n/u);
  assert.match(content, /\[unit: string\] plain failure\n/u);
  assert.match(content, /\[unit: object\] \[object Object\]\n/u);
}));

test("truncates a long detail to keep one line per failure", withHome(async (home) => {
  debugLog("unit: long", new Error("x".repeat(4_000)));
  const file = logPath(home);
  await waitForText(file, "unit: long");
  const line = readFileSync(file, "utf8").trimEnd();
  assert.ok(line.length < 1_100, `line kept ${line.length} chars`);
}));

test("folds a multi-line detail onto one log entry", withHome(async (home) => {
  debugLog("unit: multiline", "first failure\n  at somewhere.ts:1\nsecond line");
  const file = logPath(home);
  await waitForText(file, "unit: multiline");
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\[unit: multiline\] first failure at somewhere\.ts:1 second line$/u);
}));

test("rotates past the cap and starts a fresh file", withHome(async (home) => {
  const file = logPath(home);
  mkdirSync(join(home, ".pix", "log"), { recursive: true });
  writeFileSync(file, "x".repeat(MAX_BYTES + 1));
  debugLog("unit: rotate", new Error("after cap"));
  await waitForText(file, "unit: rotate");
  assert.equal(statSync(`${file}.old`).size, MAX_BYTES + 1);
  assert.ok(statSync(file).size < MAX_BYTES);
  assert.match(readFileSync(file, "utf8"), /\[unit: rotate\] Error: after cap/u);

  // A long-lived process rotates repeatedly: the second generation replaces
  // the first instead of failing on the existing main.log.old.
  writeFileSync(file, "y".repeat(MAX_BYTES + 1));
  debugLog("unit: rotate again", new Error("second cap"));
  await waitForText(file, "unit: rotate again");
  assert.equal(statSync(`${file}.old`).size, MAX_BYTES + 1);
  assert.equal(readFileSync(`${file}.old`, "utf8").slice(0, 1), "y");
}));

test("a rotation target that cannot be replaced still takes the line", withHome(async (home) => {
  const file = logPath(home);
  mkdirSync(join(home, ".pix", "log", "main.log.old"), { recursive: true });
  writeFileSync(file, "x".repeat(MAX_BYTES + 1));
  debugLog("unit: locked", new Error("still written"));
  const content = await waitForText(file, "unit: locked");
  assert.match(content, /\[unit: locked\] Error: still written/u);
}));

test("a new profile path measures its own file", withHome(async (home) => {
  debugLog("unit: first profile", new Error("first"));
  await waitForText(logPath(home), "unit: first profile");
  const second = mkdtempSync(join(tmpdir(), "pix-debug-log-"));
  process.env.PIX_HOME = second;
  try {
    debugLog("unit: second profile", new Error("second"));
    const content = await waitForText(logPath(second), "unit: second profile");
    assert.doesNotMatch(content, /unit: first profile/u);
  } finally {
    rmSync(second, { recursive: true, force: true });
  }
}));

test("recreates the folder when it disappears while the app runs", withHome(async (home) => {
  const file = logPath(home);
  debugLog("unit: before removal", "one");
  await waitForText(file, "unit: before removal");
  rmSync(join(home, ".pix", "log"), { recursive: true, force: true });
  debugLog("unit: after removal", "two");
  const content = await waitForText(file, "unit: after removal");
  assert.equal(content.split("\n").filter(Boolean).length, 1);
}));

test("writes nothing once the host disables file logging", withHome(async (home) => {
  setDebugLogEnabled(false);
  try {
    debugLog("unit: disabled", new Error("invisible"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!existsSync(logPath(home)), "disabled logger created a file");
  } finally {
    setDebugLogEnabled(true);
  }
  debugLog("unit: re-enabled", "visible");
  assert.match(await waitForText(logPath(home), "unit: re-enabled"), /unit: re-enabled/u);
}));
