import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MainController, type Platform } from "../src/main/controller.js";

// The log folder lives under PIX_HOME, so an isolated home keeps the test from
// revealing anything in the developer's own profile.
const home = mkdtempSync(join(tmpdir(), "pix-logs-home-"));
process.env.PIX_HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, ".pix", "agent");
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const root = resolve(process.cwd(), "test", "workspace");
const revealed: string[] = [];
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


  showItemInFolder(path) {
    revealed.push(path);
  },
  quit() {},
};

test("the log folder action creates the directory and reveals the log once it exists", async () => {
  const controller = new MainController(root, platform);
  const file = join(home, ".pix", "log", "main.log");
  try {
    await controller.invoke("app.revealLogs");
    assert.deepEqual(revealed, [dirname(file)]);
    assert.ok(existsSync(dirname(file)));

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "line\n");
    await controller.invoke("app.revealLogs");
    assert.deepEqual(revealed, [dirname(file), file]);
  } finally {
    controller.dispose();
  }
});
