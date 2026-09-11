import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../src/main/services.js";

test("shortcut overrides persist atomically, reset independently, and reject invalid writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "pix-shortcuts-"));
  try {
    const service = new SettingsService(null);
    service.appPath = join(directory, "settings.json");
    service.globalPath = join(directory, "pi-settings.json");
    service.update({ theme: "dark", keyboardShortcuts: { navigator: [] } });
    const reopened = new SettingsService(null);
    reopened.appPath = service.appPath;
    reopened.globalPath = service.globalPath;
    assert.deepEqual(reopened.bundle().app.keyboardShortcuts, { navigator: [] });
    service.update({ keyboardShortcuts: { commands: ["Mod+m"] } });
    assert.deepEqual(reopened.bundle().app.keyboardShortcuts, { commands: ["Mod+m"] });
    service.update({ keyboardShortcuts: {} });
    assert.deepEqual(reopened.bundle().app.keyboardShortcuts, {});
    assert.equal(reopened.bundle().app.theme, "dark");
    const before = readFileSync(service.appPath, "utf8");
    assert.throws(() => service.update({ keyboardShortcuts: { commands: ["Mod+b"] } }));
    assert.throws(() => service.update({ keyboardShortcuts: { commands: ["Mod+c"] } }, true));
    assert.equal(readFileSync(service.appPath, "utf8"), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
