import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.equal(readFileSync(service.appPath, "utf8"), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("saved custom bindings survive new default collisions and unrelated settings writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "pix-shortcut-upgrade-"));
  try {
    const service = new SettingsService(null);
    service.appPath = join(directory, "settings.json");
    service.globalPath = join(directory, "pi-settings.json");
    // This was valid before editLabel introduced Mod+Shift+l as a default.
    const original = { commands: ["Mod+Shift+l"], navigator: [] };
    writeFileSync(service.appPath, JSON.stringify({ keyboardShortcuts: original, theme: "dark" }));
    const migrated = { ...original, editLabel: [] };
    assert.deepEqual(service.bundle().app.keyboardShortcuts, migrated);
    assert.deepEqual(JSON.parse(readFileSync(service.appPath, "utf8")).keyboardShortcuts, original);
    service.update({ density: "compact" });
    assert.deepEqual(JSON.parse(readFileSync(service.appPath, "utf8")).keyboardShortcuts, migrated);
    assert.deepEqual(service.bundle().app.keyboardShortcuts, migrated);
    assert.equal(service.bundle().app.theme, "dark");
    // Interactive writes still reject conflicting assignments.
    const before = readFileSync(service.appPath, "utf8");
    assert.throws(() => service.update({ keyboardShortcuts: { commands: ["Mod+Shift+l"] } }));
    assert.equal(readFileSync(service.appPath, "utf8"), before);
    service.update({ keyboardShortcuts: migrated });
    assert.deepEqual(service.bundle().app.keyboardShortcuts, migrated);
    // A claimed alias must leave the other default alias available.
    writeFileSync(service.appPath, JSON.stringify({ keyboardShortcuts: { navigator: ["Mod+Shift+p"] } }));
    assert.deepEqual(service.bundle().app.keyboardShortcuts, { navigator: ["Mod+Shift+p"], commands: ["Mod+k"] });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
