import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryService } from "../src/main/library.js";

function home() {
  const dir = join(tmpdir(), `pix-library-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("pins and archives persist in one sidecar under the profile", () => {
  const dir = home();
  const library = new LibraryService(dir);
  assert.deepEqual(library.marks(), { pinned: [], archivedSessions: [], archivedProjects: [] });

  library.setSessionPinned("/p/.pi/sessions/a.jsonl", true);
  library.setSessionPinned("/p/.pi/sessions/b.jsonl", true);
  library.setProjectArchived("local:/p", true);
  assert.deepEqual(library.marks(), {
    pinned: ["/p/.pi/sessions/a.jsonl", "/p/.pi/sessions/b.jsonl"],
    archivedSessions: [],
    archivedProjects: ["local:/p"],
  });

  library.setSessionPinned("/p/.pi/sessions/a.jsonl", false);
  assert.deepEqual(library.marks().pinned, ["/p/.pi/sessions/b.jsonl"]);

  const persisted = JSON.parse(readFileSync(join(dir, ".pix", "library.json"), "utf8"));
  assert.deepEqual(persisted.pinned, ["/p/.pi/sessions/b.jsonl"]);
  rmSync(dir, { recursive: true, force: true });
});

test("archiving a session unpins it", () => {
  const library = new LibraryService(home());
  library.setSessionPinned("/p/.pi/sessions/a.jsonl", true);
  library.setSessionArchived("/p/.pi/sessions/a.jsonl", true);
  assert.deepEqual(library.marks(), { pinned: [], archivedSessions: ["/p/.pi/sessions/a.jsonl"], archivedProjects: [] });

  library.setSessionArchived("/p/.pi/sessions/a.jsonl", false);
  assert.deepEqual(library.marks().archivedSessions, []);
  assert.deepEqual(library.marks().pinned, []);
});

test("marks normalize: duplicates collapse and junk drops", () => {
  const dir = home();
  const library = new LibraryService(dir);
  mkdirSync(join(dir, ".pix"), { recursive: true });
  writeFileSync(
    join(dir, ".pix", "library.json"),
    JSON.stringify({ pinned: ["a", "a", "", 42, null, "b"], archivedSessions: "nope", archivedProjects: ["c"] }),
  );
  assert.deepEqual(library.marks(), { pinned: ["a", "b"], archivedSessions: [], archivedProjects: ["c"] });
  rmSync(dir, { recursive: true, force: true });
});

test("a corrupt sidecar reads as empty and the next write starts clean", () => {
  const dir = home();
  const library = new LibraryService(dir);
  mkdirSync(join(dir, ".pix"), { recursive: true });
  writeFileSync(join(dir, ".pix", "library.json"), "{not json");
  assert.deepEqual(library.marks(), { pinned: [], archivedSessions: [], archivedProjects: [] });
  library.setSessionPinned("/p/a.jsonl", true);
  assert.deepEqual(library.marks().pinned, ["/p/a.jsonl"]);
  rmSync(dir, { recursive: true, force: true });
});
