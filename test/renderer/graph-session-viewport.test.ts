// Switching sessions resumes each session's remembered arrangement and pane
// position; only a session seen for the first time centers on its active node.
import { flushPromises, mount } from "@vue/test-utils";
import { VueFlow } from "@vue-flow/core";
import { createPinia, setActivePinia } from "pinia";
import { expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";

// Gate whenVisible so a remounted pane's ready() can be released on demand.
// nextFrame keeps the real double-rAF cadence: dimensions arrive before the
// frame resolves, exactly like the app's ResizeObserver deliveries.
const { gates } = vi.hoisted(() => ({ gates: [] as Array<() => void> }));
vi.mock("../../src/renderer/lib/frame", () => ({
  nextFrame: () => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }),
  whenVisible: () => new Promise<void>(resolve => { gates.push(resolve); }),
  whenTransitionsSettle: async () => {},
}));
const releaseGates = () => { for (const release of gates.splice(0)) release(); };

function snapshot(name: string): SessionSnapshot {
  const entries = [
    { type: "message", id: `${name}-root`, parentId: null, timestamp: "00", message: { role: "user", content: `${name} root` } },
    { type: "message", id: `${name}-leaf`, parentId: `${name}-root`, timestamp: "01", message: { role: "user", content: `${name} leaf` } },
  ];
  return {
    session: { id: name, path: `${name}.jsonl`, cwd: ".", created: "", modified: "", messageCount: 2, firstMessage: `${name} root` },
    entries,
    projection: projectSession(entries, `${name}-leaf`),
    runtime: { available: true, isStreaming: false },
    graph: { id: `${name}.jsonl`, epoch: name, revision: 1, runs: [] },
  } as unknown as SessionSnapshot;
}

function mountPanel() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSessionStore();
  useLayoutStore().panelsSettled = true;
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n], config: {
    warnHandler(message) { if (!message.startsWith("Extraneous non-")) console.warn(message); },
  } } });
  return { session, wrapper };
}

function exposedFlow(wrapper: ReturnType<typeof mountPanel>["wrapper"]) {
  return (wrapper.findComponent(VueFlow).vm as unknown as { $: { exposed: Record<string, any> } }).$.exposed;
}

it("resumes the remembered viewport and manual card positions when a session is reopened", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const { session, wrapper } = mountPanel();
  try {
    session.applySnapshot(snapshot("alpha"));
    await flushPromises();
    const flow = exposedFlow(wrapper);
    const setCenter = vi.spyOn(flow, "setCenter").mockResolvedValue(true);
    const setViewport = vi.spyOn(flow, "setViewport").mockResolvedValue(true);
    flow.dimensions.value = { width: 1200, height: 600 };
    await flushPromises();
    const graph = (wrapper.vm as unknown as { $: { setupState: Record<string, any> } }).$.setupState;
    graph.rememberDrag({ node: { id: "turn:alpha-root", position: { x: 900, y: 700 } }, event: {} });
    flow.viewport.value = { x: 123, y: 45, zoom: 0.5 };
    await flushPromises();

    session.applySnapshot(snapshot("beta"));
    session.focusedNode = null;
    // A session seen for the first time still centers on its active node.
    await vi.waitFor(() => expect(setCenter).toHaveBeenCalled());
    expect(flow.findNode("turn:alpha-root")).toBeUndefined();
    expect(flow.findNode("turn:beta-root").position).toEqual({ x: 48, y: 48 });
    setCenter.mockClear();

    // Coming back restores the manual arrangement and the pane exactly.
    session.applySnapshot(snapshot("alpha"));
    session.focusedNode = null;
    await flushPromises();
    await vi.waitFor(() => expect(setViewport).toHaveBeenCalled());
    expect(setViewport).toHaveBeenCalledWith({ x: 123, y: 45, zoom: 0.5 }, { duration: 1 });
    expect(setCenter).not.toHaveBeenCalled();
    expect(flow.findNode("turn:alpha-root").position).toEqual({ x: 900, y: 700 });
  } finally {
    wrapper.unmount();
    gates.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("re-enters the remembered viewport after the pane remounts for a session", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const { session, wrapper } = mountPanel();
  try {
    session.applySnapshot(snapshot("alpha"));
    await flushPromises();
    let flow = exposedFlow(wrapper);
    flow.viewport.value = { x: 123, y: 45, zoom: 0.5 };
    await flushPromises();

    session.applySnapshot(snapshot("beta"));
    session.focusedNode = null;
    await flushPromises();
    flow.viewport.value = { x: 200, y: 10, zoom: 0.3 };
    await flushPromises();

    // Leaving the workspace clears the session, unmounting the pane.
    session.current = undefined;
    await flushPromises();
    expect(wrapper.findComponent(VueFlow).exists()).toBe(false);

    // Returning remounts the pane; ready() must re-enter the remembered
    // viewport instead of resetting to the active node.
    session.applySnapshot(snapshot("alpha"));
    session.focusedNode = null;
    await flushPromises();
    flow = exposedFlow(wrapper);
    releaseGates();
    await flushPromises();
    expect(flow.viewport.value).toEqual({ x: 123, y: 45, zoom: 0.5 });
  } finally {
    wrapper.unmount();
    gates.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
