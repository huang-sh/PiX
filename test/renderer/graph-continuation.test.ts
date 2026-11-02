import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";

enableAutoUnmount(afterEach);

function snapshot(runs: NonNullable<SessionSnapshot["graph"]>["runs"]): SessionSnapshot {
  const entries = [["root", null], ["mid", "root"], ["tip", "mid"]]
    .map(([id, parentId], index) => ({ type: "message", id: id!, parentId, timestamp: String(index),
      message: { role: "user", content: id! } }));
  return {
    session: { id: "continue", path: "C:/tmp/continue.jsonl" },
    entries, projection: projectSession(entries, "tip"),
    graph: { id: "C:/tmp/continue.jsonl", revision: 1, runs },
    runtime: { available: true },
  } as unknown as SessionSnapshot;
}

describe("graph continuation arrows", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  });
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("vue-flow__node") ? 280 : 2400;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("vue-flow__node") ? 146 : 900;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("offers the horizontal arrow on the idle tip alone", async () => {
    const pinia = createPinia(); setActivePinia(pinia);
    const session = useSessionStore();
    session.current = snapshot([{ branchId: "main", runId: "r1", nodeId: "turn:tip", status: "idle" }]);
    const wrapper = mount(GraphPanel, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
    await flushPromises();
    expect(wrapper.find('[data-id="turn:tip"] [data-direction="right"]').exists()).toBe(true);
    expect(wrapper.find('[data-id="turn:mid"] [data-direction="right"]').exists()).toBe(false);
    expect(wrapper.find('[data-id="turn:root"] [data-direction="right"]').exists()).toBe(false);
    for (const id of ["turn:root", "turn:mid", "turn:tip"]) {
      expect(wrapper.find(`[data-id="${id}"] [data-direction="up"]`).exists()).toBe(true);
      expect(wrapper.find(`[data-id="${id}"] [data-direction="down"]`).exists()).toBe(true);
    }
  });

  it.each([
    ["a running branch", [{ branchId: "main", runId: "r1", nodeId: "turn:tip", status: "running" }]],
    ["a failed branch", [{ branchId: "main", runId: "r1", nodeId: "turn:tip", status: "idle", error: "boom" }]],
  ])("hides the horizontal arrow on the tip of %s", async (_name, runs) => {
    const pinia = createPinia(); setActivePinia(pinia);
    const session = useSessionStore();
    session.current = snapshot(runs);
    const wrapper = mount(GraphPanel, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
    await flushPromises();
    expect(wrapper.find('[data-direction="right"]').exists()).toBe(false);
  });

  it("keeps the horizontal arrow on every node of a plain session", async () => {
    const pinia = createPinia(); setActivePinia(pinia);
    const session = useSessionStore();
    const plain = snapshot([]);
    delete plain.graph;
    session.current = plain;
    const wrapper = mount(GraphPanel, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
    await flushPromises();
    expect(wrapper.findAll('[data-direction="right"]')).toHaveLength(3);
  });
});
