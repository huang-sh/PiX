import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { i18n } from "../../src/renderer/i18n";
import { desktop } from "../../src/renderer/api";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot, SessionSummary } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
});
afterEach(() => vi.restoreAllMocks());
function snapshot(path: string): SessionSnapshot {
  return { session: { id: path, path, cwd: "/review", created: "", modified: "", messageCount: 0, firstMessage: "" },
    entries: [], projection: projectSession([], null),
    runtime: { available: true } } as SessionSnapshot;
}
function setup() {
  const session = useSessionStore();
  useWorkspaceStore().hydrate({ name: "review", path: "/review" });
  session.activeProjectId = "local:/review";
  session.loading = false;
  return session;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

it("reuses the current empty session on repeated create clicks without reopening it", async () => {
  const session = setup();
  session.applySnapshot(snapshot("empty.jsonl"));
  const current = session.current;
  const invoke = vi.spyOn(desktop, "invoke");

  await session.create();
  await session.create();

  expect(session.current).toBe(current);
  expect(invoke).not.toHaveBeenCalled();
  expect(session.sessions).toHaveLength(1);
});

it("opens an existing empty session in the active project even when search hides it", async () => {
  const session = setup();
  const empty = snapshot("empty.jsonl");
  session.applySnapshot(snapshot("used.jsonl"));
  session.current!.session.messageCount = 2;
  session.sessions = [session.current!.session, empty.session];
  session.query = "used";
  const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async route => {
    if (route === "session.open") return empty;
    if (route === "session.list") return session.sessions;
    return [];
  });

  await session.create();

  expect(session.current?.session.path).toBe("empty.jsonl");
  expect(invoke).toHaveBeenCalledWith("session.open", { path: "empty.jsonl" });
  expect(invoke).not.toHaveBeenCalledWith("agent.control", { action: "newSession" });
});

it.each(["used", "readonly", "running", "recovery", "branch messages"])(
  "checks the opened snapshot before reusing a cached empty session that is now %s", async kind => {
    const session = setup();
    const cached = snapshot("cached.jsonl");
    session.sessions = [cached.session];
    const opened = snapshot(cached.session.path);
    if (kind === "used") opened.session.messageCount = 1;
    if (kind === "readonly") opened.runtime.available = false;
    if (kind === "running") opened.runtime.isStreaming = true;
    if (kind === "branch messages") {
      opened.entries = [{ type: "message", id: "branch-user", parentId: null, timestamp: "",
        message: { role: "user", content: "branch prompt" } }];
      opened.projection = projectSession(opened.entries, "branch-user");
    }
    if (kind === "recovery") opened.graph = {
      id: opened.session.path, revision: 1, runs: [],
      recoveredInputs: [{ requestId: "input", text: "recover this prompt" }],
    };
    const created = snapshot("new.jsonl");
    const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
      if (route === "session.open") return opened;
      if (route === "agent.control" && (input as { action: string }).action === "newSession") return created;
      if (route === "session.list") return session.sessions;
      return [];
    });

    await session.create();

    expect(session.current?.session.path).toBe(created.session.path);
    expect(invoke).toHaveBeenCalledWith("agent.control", { action: "newSession" });
  },
);

it("keeps the empty session selected when create supersedes an unfinished navigation", async () => {
  const session = setup();
  const empty = snapshot("empty.jsonl");
  session.applySnapshot(empty);
  const pending = deferred<SessionSnapshot>();
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route === "session.open") return (input as { path: string }).path === empty.session.path ? empty : pending.promise;
    if (route === "session.list") return session.sessions;
    return [];
  });

  const opening = session.open("used.jsonl");
  await session.create();
  const used = snapshot("used.jsonl");
  used.session.messageCount = 2;
  pending.resolve(used);
  await opening;

  expect(session.current?.session.path).toBe(empty.session.path);
});

it("tries the next empty candidate when the first one opens read-only", async () => {
  const session = setup();
  const readonly = snapshot("readonly.jsonl"), empty = snapshot("empty.jsonl");
  readonly.runtime.available = false;
  session.sessions = [readonly.session, empty.session];
  const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route === "session.open") return (input as { path: string }).path === readonly.session.path ? readonly : empty;
    if (route === "session.list") return session.sessions;
    return [];
  });

  await session.create();

  expect(session.current?.session.path).toBe(empty.session.path);
  expect(invoke).not.toHaveBeenCalledWith("agent.control", { action: "newSession" });
});

it.each(["project", "session"])("does not create after reuse is superseded by a %s switch", async kind => {
  const session = setup();
  const cached = snapshot("cached.jsonl");
  session.sessions = [cached.session];
  const pending = deferred<SessionSnapshot>();
  const selected = snapshot("selected.jsonl");
  selected.session.messageCount = 1;
  const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route === "session.open") return (input as { path: string }).path === cached.session.path ? pending.promise : selected;
    if (route === "session.list") return session.sessions;
    return [];
  });

  const creating = session.create();
  if (kind === "project") session.hydrate({ name: "other", path: "/other" }, [], [], selected);
  else await session.open(selected.session.path);
  cached.runtime.available = false;
  pending.resolve(cached);
  await creating;

  expect(session.current?.session.path).toBe(selected.session.path);
  expect(invoke).not.toHaveBeenCalledWith("agent.control", { action: "newSession" });
});

it("preserves the composer draft when reusing the current empty session", async () => {
  const session = setup();
  session.applySnapshot(snapshot("empty.jsonl"));
  const wrapper = mount(GraphPanel, { global: { plugins: [i18n], stubs: { VueFlow: true } } });
  const graph = (wrapper.vm as any).$.setupState;
  const draft = () => graph.nodes.find((node: any) => node.id === "draft:root").data.draftState;
  try {
    const original = draft();
    original.text = "unsent prompt";
    await session.create();
    await nextTick();
    expect(draft()).toBe(original);
    expect(draft().text).toBe("unsent prompt");
  } finally { wrapper.unmount(); }
});

it.each(["used", "archived", "running", "pending", "other project"])(
  "creates a session when the only candidate is %s", async kind => {
    const session = setup();
    const candidate: SessionSummary = { ...snapshot("candidate.jsonl").session,
      messageCount: kind === "used" ? 2 : 0, running: kind === "running" };
    session.sessions = kind === "other project" ? [] : [candidate];
    if (kind === "archived") session.marks.archivedSessions = [candidate.path];
    if (kind === "pending") session.pendingPrompts.pending = {
      projectId: session.activeProjectId, sessionPath: candidate.path,
      message: { entryId: "pending", turnId: "pending", role: "user", text: "hello", timestamp: "" },
      knownEntryIds: [], targetNodeId: null,
    };
    if (kind === "other project") session.projects = [{
      id: "local:/other", project: { name: "other", path: "/other" },
      sessions: [candidate], lastOpened: "", connected: true,
    }];
    const created = snapshot("new.jsonl");
    const invoke = vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
      if (route === "agent.control" && (input as { action: string }).action === "newSession") return created;
      if (route === "session.list") return [...session.sessions, created.session];
      return [];
    });

    await session.create();

    expect(invoke).toHaveBeenCalledWith("agent.control", { action: "newSession" });
    expect(session.current?.session.path).toBe(created.session.path);
  },
);

it("keeps a completed creation after a superseding project switch fails without hydrating", async () => {
  const session = setup();
  const pending = deferred<SessionSnapshot>();
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route === "agent.control" && (input as { action: string }).action === "newSession") return pending.promise;
    return [];
  });
  const creating = session.create();
  ++session.viewRequest;
  pending.resolve(snapshot("created.jsonl"));
  await creating;
  expect(session.creating).toBe(false);
  expect(session.current?.session.path).toBe("created.jsonl");
  expect(session.creation?.status).toBe("ready");
});

it("does not clear a newer creation when an older reply arrives", async () => {
  const session = setup();
  const first = deferred<SessionSnapshot>(), second = deferred<SessionSnapshot>();
  let requests = 0;
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route === "agent.control" && (input as { action: string }).action === "newSession")
      return ++requests === 1 ? first.promise : second.promise;
    if (route === "session.open") {
      const existing = snapshot("existing.jsonl");
      existing.session.messageCount = 1;
      return existing;
    }
    return [];
  });
  const old = session.create();
  await session.open("existing.jsonl");
  const current = session.create();
  first.resolve(snapshot("old-created.jsonl"));
  await old;
  expect(session.creating).toBe(true);
  second.resolve(snapshot("new-created.jsonl"));
  await current;
  expect(session.current?.session.path).toBe("new-created.jsonl");
  expect(session.creating).toBe(false);
});

it.each([false, true])("retains a failed creation's draft through retry (existing session: %s)", async existing => {
  const session = setup();
  if (existing) {
    session.current = snapshot("old.jsonl");
    session.current.session.messageCount = 1;
  }
  const first = deferred<SessionSnapshot>(), second = deferred<SessionSnapshot>();
  let requests = 0;
  vi.spyOn(desktop, "invoke").mockImplementation(async (route, input) => {
    if (route === "agent.control" && (input as { action: string }).action === "newSession")
      return ++requests === 1 ? first.promise : second.promise;
    return [];
  });
  const wrapper = mount(GraphPanel, { global: { plugins: [i18n], stubs: { VueFlow: true } } });
  const graph = (wrapper.vm as any).$.setupState;
  const draft = () => graph.nodes.find((node: any) => node.id === "draft:root").data;
  try {
    const creating = session.create().catch(() => {});
    await nextTick();
    draft().draftState.text = "keep this draft";
    first.reject(new Error("Remote transport disconnected"));
    await creating;
    await nextTick();
    expect(session.creating).toBe(false);
    expect(draft().draftState.text).toBe("keep this draft");
    expect(draft().creationError).toBe("Remote transport disconnected");
    expect(draft().runnable).toBe(false);
    expect(wrapper.find(".graph-empty").exists()).toBe(false);
    // Reconnecting refreshes this same workspace before a retry can succeed.
    session.hydrate(useWorkspaceStore().project!, [], session.projects, session.current);
    await nextTick();
    expect(draft().draftState.text).toBe("keep this draft");
    expect(draft().creationError).toBe("Remote transport disconnected");
    draft().onRetry();
    await nextTick();
    expect(session.creating).toBe(true);
    expect(draft().draftState.text).toBe("keep this draft");
    second.resolve(snapshot("retried.jsonl"));
    await vi.waitFor(() => expect(session.loading).toBe(false));
    await nextTick();
    expect(draft().draftState.text).toBe("keep this draft");
    expect(draft().runnable).toBe(true);
    expect(session.current?.session.path).toBe("retried.jsonl");
    // Opening a different session explicitly does not inherit this new draft.
    vi.mocked(desktop.invoke).mockResolvedValue(snapshot("other.jsonl"));
    await session.open("other.jsonl");
    await nextTick();
    expect(draft().draftState.text).toBe("");
  } finally { wrapper.unmount(); }
});
