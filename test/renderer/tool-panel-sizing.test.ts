import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { SplitterPanel } from "reka-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ToolPanel from "../../src/renderer/features/tools/ToolPanel.vue";
import { i18n } from "../../src/renderer/i18n";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { useWorkspaceStore } from "../../src/renderer/stores/workspace";
import * as frame from "../../src/renderer/lib/frame";

describe("file tree sizing during panel expansion", () => {
  let wrapper: VueWrapper | undefined;
  let host: HTMLElement;
  let width: number;
  let animations: Animation[];
  const observers = new Set<TestResizeObserver>();
  const originalAnimations = Object.getOwnPropertyDescriptor(document, "getAnimations");

  class TestResizeObserver {
    elements = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
    observe(element: Element) { this.elements.add(element); }
    unobserve(element: Element) { this.elements.delete(element); }
    disconnect() { this.elements.clear(); }
  }
  class TestEffect {
    constructor(readonly target: Element) {}
  }
  function deliver() {
    const element = wrapper!.get(".file-workspace").element;
    const entry = { target: element, contentRect: element.getBoundingClientRect() } as ResizeObserverEntry;
    for (const observer of observers) {
      if (observer.elements.has(element)) observer.callback([entry], observer as unknown as ResizeObserver);
    }
  }
  function transition(target: Element = host) {
    let finish!: () => void;
    let cancel!: (error: Error) => void;
    const finished = new Promise<void>((resolve, reject) => { finish = resolve; cancel = reject; });
    const animation = { effect: new TestEffect(target), finished } as unknown as Animation;
    animations.push(animation);
    return (cancelled = false) => {
      animations = animations.filter(item => item !== animation);
      if (cancelled) cancel(new DOMException("Transition cancelled", "AbortError")); else finish();
    };
  }
  async function open() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.contentTabs = ["files"];
    layout.contentSection = "files";
    wrapper = mount(ToolPanel, { attachTo: host, global: { plugins: [pinia, i18n], stubs: { PdfView: true } } });
    await flushPromises();
  }
  const tree = () => wrapper!.findAllComponents(SplitterPanel).find(panel => panel.attributes("id") === "file-tree-panel");

  beforeEach(() => {
    vi.useFakeTimers();
    width = 0;
    animations = [];
    observers.clear();
    host = document.createElement("div");
    host.id = "content-panel";
    document.body.append(host);
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("KeyframeEffect", TestEffect);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
    Object.defineProperty(document, "getAnimations", { configurable: true, value: () => animations });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      return new DOMRect(0, 0, this.classList.contains("file-workspace") ? width : 0, 400);
    });
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (originalAnimations) Object.defineProperty(document, "getAnimations", originalAnimations);
    else Reflect.deleteProperty(document, "getAnimations");
  });

  it("does not freeze a positive intermediate width, even when resize deliveries pause", async () => {
    width = 120;
    const finish = transition();
    await open();
    deliver();
    await vi.advanceTimersByTimeAsync(300);
    expect(wrapper!.find(".file-explorer").exists()).toBe(false);

    width = 600;
    deliver();
    finish();
    await flushPromises();
    expect(wrapper!.find(".file-explorer").exists()).toBe(true);
    expect(tree()!.props("defaultSize")).toBeCloseTo(200 / 600 * 100);
  });

  it("keeps waiting at zero width and freezes bounds across later resizes and rerenders", async () => {
    await open();
    deliver();
    await vi.advanceTimersByTimeAsync(300);
    expect(wrapper!.find(".file-explorer").exists()).toBe(false);
    width = 600;
    deliver();
    await vi.advanceTimersByTimeAsync(32);
    await flushPromises();
    const constraints = { min: tree()!.props("minSize"), max: tree()!.props("maxSize"), default: tree()!.props("defaultSize") };

    width = 900;
    deliver();
    useWorkspaceStore().files = [{ name: "new.md", path: "new.md", kind: "file" }];
    await flushPromises();
    await wrapper!.get('[data-action="toggle-file-tree"]').trigger("click");
    await wrapper!.get('[data-action="toggle-file-tree"]').trigger("click");
    expect({ min: tree()!.props("minSize"), max: tree()!.props("maxSize"), default: tree()!.props("defaultSize") }).toEqual(constraints);
  });

  it("measures a newly mounted Files group again after switching tools", async () => {
    width = 600;
    await open();
    deliver();
    await vi.advanceTimersByTimeAsync(32);
    await flushPromises();
    useLayoutStore().contentSection = "home";
    await flushPromises();
    width = 150;
    const finish = transition();
    useLayoutStore().contentSection = "files";
    await flushPromises();
    deliver();
    await vi.advanceTimersByTimeAsync(300);
    expect(wrapper!.find(".file-explorer").exists()).toBe(false);
    width = 800;
    deliver();
    finish();
    await flushPromises();
    expect(tree()!.props("defaultSize")).toBeCloseTo(25);
  });

  it("ignores an unfinished measurement after its group is replaced", async () => {
    width = 120;
    const finish = transition();
    await open();
    deliver();
    await vi.advanceTimersByTimeAsync(32);
    useLayoutStore().contentSection = "home";
    await flushPromises();
    width = 0;
    useLayoutStore().contentSection = "files";
    await flushPromises();
    deliver();
    finish();
    await flushPromises();
    expect(wrapper!.find(".file-explorer").exists()).toBe(false);
    width = 800;
    deliver();
    await vi.advanceTimersByTimeAsync(32);
    await flushPromises();
    expect(tree()!.props("defaultSize")).toBeCloseTo(25);
  });

  it("does not freeze an intermediate width when opening is paused past 1.5 seconds", async () => {
    width = 120;
    const finish = transition();
    await open();
    deliver();
    await vi.advanceTimersByTimeAsync(2000);
    expect(wrapper!.find(".file-explorer").exists()).toBe(false);
    width = 600;
    deliver();
    finish();
    await flushPromises();
    expect(tree()!.props("defaultSize")).toBeCloseTo(200 / 600 * 100);
  });

  it("preserves a hide clicked before the tree is measured", async () => {
    width = 120;
    const finish = transition();
    await open();
    deliver();
    await wrapper!.get('[data-action="toggle-file-tree"]').trigger("click");
    width = 600;
    deliver();
    await vi.advanceTimersByTimeAsync(32);
    finish();
    await flushPromises();
    expect(tree()!.props("defaultSize")).toBe(0);
    expect(wrapper!.find(".file-explorer").exists()).toBe(false);
    await wrapper!.get('[data-action="toggle-file-tree"]').trigger("click");
    expect(wrapper!.find(".file-explorer").exists()).toBe(true);
  });

  it("recovers when an opening is cancelled at zero width and then restarted", async () => {
    width = 120;
    const cancel = transition();
    await open();
    deliver();
    await vi.advanceTimersByTimeAsync(32);
    width = 0;
    deliver();
    cancel(true);
    await flushPromises();
    expect(wrapper!.find(".file-explorer").exists()).toBe(false);
    const finish = transition();
    width = 150;
    deliver();
    await vi.advanceTimersByTimeAsync(32);
    width = 800;
    deliver();
    finish();
    await flushPromises();
    expect(tree()!.props("defaultSize")).toBeCloseTo(25);
  });

  it("does not wait for animations outside the Files group's ancestors", async () => {
    const finish = transition(document.createElement("div"));
    width = 600;
    await open();
    deliver();
    await vi.advanceTimersByTimeAsync(32);
    await flushPromises();
    expect(wrapper!.find(".file-explorer").exists()).toBe(true);
    finish();
  });

  it("cancels the animation wait and observer when its panel unmounts", async () => {
    const wait = vi.spyOn(frame, "whenTransitionsSettle");
    width = 120;
    const finish = transition();
    await open();
    deliver();
    await vi.advanceTimersByTimeAsync(32);
    const group = wrapper!.get(".file-workspace").element;
    const signal = wait.mock.calls.at(-1)![2]!;
    const pending = wait.mock.results.at(-1)!.value as Promise<void>;
    let completed = false;
    void pending.then(() => { completed = true; });
    try {
      expect(signal.aborted).toBe(false);
      wrapper!.unmount();
      wrapper = undefined;
      await flushPromises();
      expect(signal.aborted).toBe(true);
      expect(completed).toBe(true);
      expect([...observers].some(observer => observer.elements.has(group))).toBe(false);
    } finally { finish(); await pending; }
  });
});
