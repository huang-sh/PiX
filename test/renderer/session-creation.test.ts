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
import type { SessionSnapshot } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {},
}));
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.restoreAllMocks());
function snapshot(path: string): SessionSnapshot {
  return { session: { id: path, path }, entries: [], projection: projectSession([], null),
    runtime: { available: true } } as SessionSnapshot;
}
function setup() {
  const session = useSessionStore();
  useWorkspaceStore().hydrate({ name: "review", path: "/review" });
  session.activeProjectId = "local:/review";
  return session;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

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
    if (route === "session.open") return snapshot("existing.jsonl");
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
  if (existing) session.current = snapshot("old.jsonl");
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
