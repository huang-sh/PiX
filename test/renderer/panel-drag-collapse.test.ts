import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Workbench from "../../src/renderer/features/workbench/Workbench.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { i18n } from "../../src/renderer/i18n";
import { desktop } from "../../src/renderer/api";
import type { PanelId } from "../../src/shared/types";
import type { SettingsBundle } from "../../src/shared/types";

const settings = {
  app: {
    language: "system",
    theme: "system",
    density: "comfortable",
    confirmDestructiveActions: true,
    browserHome: "https://pi.dev",
    openLastSessionOnStartup: false,
    enterToSend: true,
    openLinksInApp: true,
    closeToTray: true,
    canvasDotGrid: true,
    canvasDotGridSpacing: 24,
    canvasDotGridDotSize: 4,
  },
  piGlobal: {},
  piProject: {},
  effective: {},
  paths: { app: "", global: "", project: "" },
} satisfies SettingsBundle;

describe.each([
  { panel: "chat" as PanelId, elementId: "chat-panel" },
  { panel: "content" as PanelId, elementId: "content-panel" },
])("$panel drag-collapse glide", ({ panel, elementId }) => {
  let wrapper: ReturnType<typeof mountWorkbench> | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    setActivePinia(createPinia());
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.useRealTimers();
  });

  async function mountWorkbench() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    // Boot restore never reopens chat; the tests expand both pixel panels so a
    // collapse can land.
    layout.layout.collapsed.chat = false;
    layout.layout.collapsed.content = false;
    // SplitterPanel stubs declare the reka events and carry collapse/expand/
    // resize for store-driven syncs; the group stub mirrors reka's real DOM
    // contract (id becomes data-panel-group-id, never an id attribute).
    wrapper = mount(Workbench, {
      attachTo: document.body,
      global: {
        plugins: [pinia, i18n],
        stubs: {
          SplitterGroup: { props: ["id"], template: '<div :data-panel-group-id="id"><slot /></div>' },
          SplitterPanel: {
            emits: ["collapse", "expand", "resize"],
            template: "<div><slot /></div>",
            methods: { collapse() {}, expand() {}, resize() {} },
          },
          SplitterResizeHandle: { template: "<div />" },
          GraphPanel: true,
          ToolPanel: true,
          BranchContextPanel: true,
        },
      },
    });
    await flushPromises();
    return wrapper;
  }

  function panelComponent() {
    return wrapper!.findComponent(`#${elementId}`);
  }

  const panelElement = () => wrapper!.find(`#${elementId}`).element as HTMLElement;

  it("animates a collapse that lands mid-drag and clears the style afterwards", async () => {
    await mountWorkbench();
    vi.useFakeTimers();
    // Simulate an active handle drag, like reka marks it while the pointer is down.
    document.querySelector('[data-panel-group-id="pix-primary"] .resize-handle')!
      .setAttribute("data-resize-handle-active", "true");
    const layout = useLayoutStore();

    panelComponent().vm.$emit("collapse");
    await nextTick();

    expect(layout.layout.collapsed[panel]).toBe(true);
    expect(panelElement().style.flexBasis).toBe("0px");
    expect(panelElement().style.transition).toContain("260ms");

    vi.advanceTimersByTime(300);
    await nextTick();
    expect(panelElement().style.transition).toBe("");
  });

  it("does not animate a button-initiated collapse (no active handle)", async () => {
    await mountWorkbench();
    const layout = useLayoutStore();

    panelComponent().vm.$emit("collapse");
    await nextTick();

    expect(layout.layout.collapsed[panel]).toBe(true);
    expect(panelElement().style.transition).toBe("");
  });

  it("a reverse drag landing in the arm window disarms the glide immediately", async () => {
    await mountWorkbench();
    vi.useFakeTimers();
    document.querySelector('[data-panel-group-id="pix-primary"] .resize-handle')!
      .setAttribute("data-resize-handle-active", "true");
    const layout = useLayoutStore();

    panelComponent().vm.$emit("collapse");
    await nextTick();
    expect(panelElement().style.transition).toContain("260ms");

    panelComponent().vm.$emit("expand");
    await nextTick();
    expect(layout.layout.collapsed[panel]).toBe(false);
    expect(panelElement().style.transition).toBe("");
  });

  it("re-arming on repeated crossings reschedules instead of stacking timers", async () => {
    await mountWorkbench();
    vi.useFakeTimers();
    document.querySelector('[data-panel-group-id="pix-primary"] .resize-handle')!
      .setAttribute("data-resize-handle-active", "true");
    const layout = useLayoutStore();

    panelComponent().vm.$emit("collapse");
    await nextTick();
    vi.advanceTimersByTime(200);
    // A second crossing re-arms: the style must outlive the first deadline.
    panelComponent().vm.$emit("collapse");
    await nextTick();
    vi.advanceTimersByTime(100);
    expect(panelElement().style.transition).toContain("260ms");
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(panelElement().style.transition).toBe("");
    expect(layout.layout.collapsed[panel]).toBe(true);
  });
});
