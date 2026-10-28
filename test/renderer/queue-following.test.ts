import { createPinia, setActivePinia } from "pinia";
import { expect, it } from "vitest";
import { projectSession } from "../../src/shared/session";
import type { RawSessionEntry, SessionSnapshot } from "../../src/shared/types";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useSessionStore } from "../../src/renderer/stores/session";

function snapshot(next = false): SessionSnapshot {
  const entries: RawSessionEntry[] = [
    { type: "message", id: "old", parentId: null, timestamp: "0", message: { role: "user", content: "history" } },
    { type: "message", id: "u1", parentId: "old", timestamp: "1", message: { role: "user", content: "first" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2", message: { role: "assistant", content: "first answer" } },
  ];
  if (next) entries.push({ type: "message", id: "u2", parentId: "a1", timestamp: "3", message: { role: "user", content: "follow-up" } });
  return { session: { id: "s", path: "/session.jsonl" }, entries, projection: projectSession(entries, next ? "u2" : "a1"),
    runtime: { available: true, isStreaming: true },
    graph: { id: "g", epoch: "epoch", revision: next ? 2 : 1,
      runs: [{ branchId: "branch", runId: "run", nodeId: next ? "turn:u2" : "turn:u1", status: "running" }] },
  } as SessionSnapshot;
}

it.each([true, false])("follows queued turns only from the live node and retains pinned drafts (viewing live: %s)", live => {
  setActivePinia(createPinia());
  const session = useSessionStore(), layout = useLayoutStore();
  session.applySnapshot(snapshot());
  session.focusedNode = live ? "turn:u1" : "turn:old";
  layout.chatColumns = ["turn:u1"];
  const composer = { open: true, draft: { text: "unsent draft", images: [], busy: false, readingImages: false, error: "" } };
  layout.chatColumnComposers["turn:u1"] = composer;
  session.applySnapshot(snapshot(true));
  expect(session.focusedNode).toBe(live ? "turn:u2" : "turn:old");
  expect(layout.chatColumns).toEqual(["turn:u2"]);
  expect(layout.chatColumnComposers["turn:u2"]).toEqual(composer);
});

it.each(["run", "graph"])("does not follow a replaced %s", replaced => {
  setActivePinia(createPinia());
  const session = useSessionStore(), layout = useLayoutStore();
  session.applySnapshot(snapshot());
  session.focusedNode = "turn:u1";
  layout.chatColumns = ["turn:u1"];
  const next = snapshot(true);
  if (replaced === "run") next.graph!.runs[0]!.runId = "different-run";
  else next.graph!.epoch = "different-epoch";
  session.applySnapshot(next);
  expect(session.focusedNode).toBe("turn:u1");
  expect(layout.chatColumns).toEqual(["turn:u1"]);
});
