import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";

enableAutoUnmount(afterEach);

function snapshot(graph: boolean): SessionSnapshot {
  const entries = [["root", null], ["mid", "root"], ["tip", "mid"]]
    .map(([id, parentId], index) => ({ type: "message", id: id!, parentId, timestamp: String(index),
      message: { role: "user", content: id! } }));
  const value = {
    session: { id: "continue", path: "C:/tmp/continue.jsonl" },
    entries, projection: projectSession(entries, "tip"),
    runtime: { available: true },
  } as unknown as SessionSnapshot;
  if (graph) {
    value.graph = { id: "C:/tmp/continue.jsonl", revision: 1, runs: [] };
    // What GraphRuntime delivers: only the branch tip continues in place.
    for (const node of value.projection.nodes) if (node.id !== "turn:tip") node.continuable = false;
  }
  return value;
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

  it("offers the horizontal arrow on the tip alone of a graph session", async () => {
    const pinia = createPinia(); setActivePinia(pinia);
    const session = useSessionStore();
    session.current = snapshot(true);
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

  it("keeps the horizontal arrow on every node of a plain session", async () => {
    const pinia = createPinia(); setActivePinia(pinia);
    const session = useSessionStore();
    session.current = snapshot(false);
    const wrapper = mount(GraphPanel, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
    await flushPromises();
    expect(wrapper.findAll('[data-direction="right"]')).toHaveLength(3);
  });
});
