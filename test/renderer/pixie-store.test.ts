import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectSession } from "../../src/shared/session";
import type { RawSessionEntry, RuntimeModel, SessionSnapshot } from "../../src/shared/types";
import { desktop } from "../../src/renderer/api";
import { usePixieStore } from "../../src/renderer/stores/pixie";

const entries = (): RawSessionEntry[] => [
  { type: "message", id: "u1", parentId: null, timestamp: "2026-09-18T10:00:00Z", message: { role: "user", content: "hello" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-18T10:00:01Z", message: { role: "assistant", content: "hi" } },
];

// The settled reply carries the sent turn under its own new entry ids.
function snapshot(leafId: string, streaming = false, withSentTurn = false): SessionSnapshot {
  const list = [...entries(), ...(withSentTurn ? [
    { type: "message", id: "u2", parentId: "a1", timestamp: "2026-09-18T10:01:00Z", message: { role: "user", content: "hello again" } },
    { type: "message", id: "a2", parentId: "u2", timestamp: "2026-09-18T10:01:01Z", message: { role: "assistant", content: "answer" } },
  ] as RawSessionEntry[] : [])];
  return {
    session: {
      id: "pixie",
      path: "pixie.jsonl",
      cwd: ".",
      created: "2026-09-18T10:00:00Z",
      modified: "2026-09-18T10:00:00Z",
      messageCount: list.length,
      firstMessage: "hello",
    },
    entries: list,
    projection: projectSession(list, leafId),
    runtime: { isStreaming: streaming } as SessionSnapshot["runtime"],
  };
}

const model: RuntimeModel = { provider: "test", id: "big", name: "Big" };

describe("pixie store", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it("initializes through pixie.ensure once and retries after a failure", async () => {
    const pixie = usePixieStore();
    const invoke = vi.spyOn(desktop, "invoke")
      .mockRejectedValueOnce(new Error("no pi today"))
      .mockImplementation(async route =>
        route === "agent.control" ? [model] : snapshot("a1"));

    await pixie.ensure();
    expect(pixie.error).toBe("no pi today");
    expect(pixie.snapshot).toBeUndefined();

    await pixie.ensure();
    expect(pixie.error).toBe("");
    expect(pixie.snapshot?.session.path).toBe("pixie.jsonl");
    expect(invoke).toHaveBeenCalledTimes(4); // failed pair, then ensure + models
  });

  it("sends with Pixie's model and thinking choices and clears the pending turn", async () => {
    const pixie = usePixieStore();
    let settleSend!: (value: SessionSnapshot) => void;
    vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
      if (route === "agent.control") return [model];
      if (route === "pixie.send") {
        expect(input).toEqual({ text: "hello again", provider: "test", modelId: "big", thinkingLevel: "high" });
        return new Promise(resolve => { settleSend = resolve; });
      }
      return snapshot("a1");
    });
    await pixie.ensure();
    pixie.model = model;
    pixie.thinking = "high";

    const delivered = pixie.send("hello again");
    await vi.waitFor(() => expect(pixie.pending?.text).toBe("hello again"));
    settleSend(snapshot("a2", false, true));
    expect(await delivered).toBe(true);
    expect(pixie.pending).toBeUndefined();
  });

  it("keeps the draft verdict false and the pending turn gone when the send fails", async () => {
    const pixie = usePixieStore();
    vi.spyOn(desktop, "invoke").mockImplementation(async route => {
      if (route === "agent.control") return [model];
      if (route === "pixie.send") throw new Error("401");
      return snapshot("a1");
    });
    await pixie.ensure();

    await expect(pixie.send("hello")).resolves.toBe(false);
    expect(pixie.pending).toBeUndefined();
    expect(pixie.error).toBe("401");
  });

  it("marks a reply unread when it settles while the card is hidden, and show clears it", () => {
    const pixie = usePixieStore();
    pixie.onEvent({ type: "agent", payload: { type: "agent_start" } });
    pixie.onEvent({
      type: "agent", payload: {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      },
    });
    expect(pixie.activity?.active).toBe(true);
    expect(pixie.unread).toBe(false);

    pixie.onEvent({ type: "agent", payload: { type: "agent_settled" } });

    expect(pixie.activity?.active).toBe(false);
    expect(pixie.unread).toBe(true);

    pixie.show();
    expect(pixie.unread).toBe(false);
  });

  it("refuses a second send while the first is still in flight", async () => {
    const pixie = usePixieStore();
    let settleSend!: (value: SessionSnapshot) => void;
    vi.spyOn(desktop, "invoke").mockImplementation(async route => {
      if (route === "agent.control") return [model];
      if (route === "pixie.send") return new Promise(resolve => { settleSend = resolve; });
      return snapshot("a1");
    });
    await pixie.ensure();

    const first = pixie.send("one");
    await vi.waitFor(() => expect(pixie.running).toBe(true));
    await expect(pixie.send("two")).resolves.toBe(false);

    settleSend(snapshot("a1"));
    expect(await first).toBe(true);
  });

  it("retires the working section whichever way the settle/reply race lands", async () => {
    const pixie = usePixieStore();
    vi.spyOn(desktop, "invoke").mockImplementation(async route =>
      route === "agent.control" ? [model] : snapshot("a1"));
    await pixie.ensure();
    // A run in flight whose snapshot (from ensure) is not streaming.
    pixie.onEvent({ type: "agent", payload: { type: "agent_start" } });
    pixie.pending = {
      text: "hello again",
      timestamp: "2026-09-18T10:01:00Z",
      knownEntryIds: new Set(["u1", "a1"]),
    };

    // Order 1: the turn's reply snapshot lands before agent_settled.
    pixie.applySnapshot(snapshot("a2", false, true));
    expect(pixie.pending).toBeUndefined();
    expect(pixie.activity?.active).toBe(true); // settle has not landed yet
    pixie.onEvent({ type: "agent", payload: { type: "agent_settled" } });
    expect(pixie.activity).toBeUndefined();
    expect(pixie.running).toBe(false);

    // Order 2: agent_settled lands while the reply is still in flight.
    pixie.onEvent({ type: "agent", payload: { type: "agent_start" } });
    pixie.pending = {
      text: "hello again",
      timestamp: "2026-09-18T10:02:00Z",
      knownEntryIds: new Set(["u1", "a1"]),
    };
    pixie.onEvent({ type: "agent", payload: { type: "agent_settled" } });
    expect(pixie.activity).toBeDefined(); // kept until the turn is in history
    pixie.applySnapshot(snapshot("a2", false, true));
    pixie.pending = undefined;
    pixie.retireSettledActivity();
    expect(pixie.activity).toBeUndefined();
    expect(pixie.running).toBe(false);
  });

  it("refuses a new conversation while a reply is still streaming", async () => {
    const pixie = usePixieStore();
    const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async route => {
      if (route === "agent.control") return [model];
      if (route === "pixie.newSession") return snapshot("a1", false);
      return snapshot("a1", true);
    });
    await pixie.ensure();
    expect(pixie.running).toBe(true);

    await pixie.newSession();

    expect(invoke.mock.calls.some(([route]) => route === "pixie.newSession")).toBe(false);
  });
});
