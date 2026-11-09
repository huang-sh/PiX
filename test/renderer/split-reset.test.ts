import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Workbench from "../../src/renderer/features/workbench/Workbench.vue";
import { equalSplitWidth } from "../../src/renderer/lib/split";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { i18n } from "../../src/renderer/i18n";
import { desktop } from "../../src/renderer/api";
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

interface WidthProperty {
  name: "clientWidth" | "offsetWidth";
  proto: object;
  descriptor: PropertyDescriptor | undefined;
}

function widthProperty(name: "clientWidth" | "offsetWidth"): WidthProperty {
  for (const proto of [HTMLElement.prototype, Element.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor) return { name, proto, descriptor };
  }
  return { name, proto: HTMLElement.prototype, descriptor: undefined };
}
const clientWidthProperty = widthProperty("clientWidth");
const offsetWidthProperty = widthProperty("offsetWidth");

function restoreWidthProperty(property: WidthProperty) {
  if (property.descriptor) Object.defineProperty(property.proto, property.name, property.descriptor);
  else delete (property.proto as Record<string, unknown>)[property.name];
}

describe("equalSplitWidth", () => {
  it("gives the pixel panel half of the group minus the handle", () => {
    expect(equalSplitWidth(1201, 1, 310)).toBe(600);
  });

  it("rounds to whole pixels", () => {
    expect(equalSplitWidth(1000, 0, 310)).toBe(500);
    expect(equalSplitWidth(1001, 0, 310)).toBe(501);
  });

  it("clamps to the panel minimum on narrow groups", () => {
    expect(equalSplitWidth(500, 1, 310)).toBe(310);
  });
});

describe("Workbench canvas/chat splitter reset", () => {
  let wrapper: ReturnType<typeof mountWorkbench> | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(desktop, "invoke").mockResolvedValue({} as never);
    Object.defineProperty(clientWidthProperty.proto, clientWidthProperty.name, { configurable: true, get: () => 1201 });
    Object.defineProperty(offsetWidthProperty.proto, offsetWidthProperty.name, { configurable: true, get: () => 1 });
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    restoreWidthProperty(clientWidthProperty);
    restoreWidthProperty(offsetWidthProperty);
  });

  async function mountWorkbench(chatWidth: number) {
    const pinia = createPinia();
    setActivePinia(pinia);
    const layout = useLayoutStore();
    layout.hydrate(settings);
    // Boot restore never reopens chat; the tests expand it so the handle is live.
    layout.layout.collapsed.chat = false;
    layout.layout.widths.chat = chatWidth;
    // SplitterPanel stubs carry collapse/expand/resize so store-driven syncs
    // (the widths watcher) have a handle to call, like the real reka panels.
    // The group stub mirrors reka's real DOM contract: the id becomes
    // data-panel-group-id, never an id attribute.
    wrapper = mount(Workbench, {
      attachTo: document.body,
      global: {
        plugins: [pinia, i18n],
        stubs: {
          SplitterGroup: { props: ["id"], template: '<div :data-panel-group-id="id"><slot /></div>' },
          SplitterPanel: { template: "<div><slot /></div>", methods: { collapse() {}, expand() {}, resize() {} } },
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

  const savesCount = () => vi.mocked(desktop.invoke).mock.calls.filter(([route]) => route === "layout.save").length;

  it("double-clicking the canvas/chat handle equalizes the columns", async () => {
    await mountWorkbench(700);
    const layout = useLayoutStore();

    const handle = wrapper!.find('[data-panel-group-id="pix-primary"] .resize-handle');
    expect(handle.exists()).toBe(true);

    const savesBefore = savesCount();
    await handle.trigger("dblclick");
    await flushPromises();

    expect(layout.layout.widths.chat).toBe(600);
    expect(savesCount()).toBeGreaterThan(savesBefore);
  });

  it("a plain click does not reset the split", async () => {
    await mountWorkbench(700);
    const layout = useLayoutStore();

    await wrapper!.find('[data-panel-group-id="pix-primary"] .resize-handle').trigger("click");
    await flushPromises();

    expect(layout.layout.widths.chat).toBe(700);
  });

  it("micro-adjust drags that the OS folds into a dblclick do not reset", async () => {
    await mountWorkbench(700);
    const layout = useLayoutStore();
    const handle = wrapper!.find('[data-panel-group-id="pix-primary"] .resize-handle').element;

    // VTU's trigger cannot set clientX (read-only getter), so dispatch real
    // MouseEvents for the pointer gesture.
    const pointer = (type: string, x: number, y: number) =>
      handle.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));

    pointer("pointerdown", 100, 10);
    pointer("pointermove", 106, 10);
    pointer("pointerup", 106, 10);
    pointer("pointerdown", 110, 10);
    pointer("pointermove", 116, 10);
    pointer("pointerup", 116, 10);
    await handle.dispatchEvent(new Event("dblclick", { bubbles: true }));
    await flushPromises();

    expect(layout.layout.widths.chat).toBe(700);
  });

  it("a drag completed right before a double click does not block the reset", async () => {
    await mountWorkbench(700);
    const layout = useLayoutStore();
    const handle = wrapper!.find('[data-panel-group-id="pix-primary"] .resize-handle').element;

    const pointer = (type: string, x: number, y: number) =>
      handle.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));

    // Adjust the split with a real drag, then double-click without pausing:
    // only the two presses forming the dblclick count, not the finished drag.
    pointer("pointerdown", 100, 10);
    pointer("pointermove", 130, 10);
    pointer("pointerup", 130, 10);
    pointer("pointerdown", 130, 10);
    pointer("pointerup", 130, 10);
    pointer("pointerdown", 130, 10);
    pointer("pointerup", 130, 10);
    await handle.dispatchEvent(new Event("dblclick", { bubbles: true }));
    await flushPromises();

    expect(layout.layout.widths.chat).toBe(600);
  });

  it("a stationary double click still resets the split", async () => {
    await mountWorkbench(700);
    const layout = useLayoutStore();
    const handle = wrapper!.find('[data-panel-group-id="pix-primary"] .resize-handle').element;

    const pointer = (type: string, x: number, y: number) =>
      handle.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));

    pointer("pointerdown", 100, 10);
    pointer("pointerup", 100, 10);
    pointer("pointerdown", 100, 10);
    pointer("pointerup", 100, 10);
    await handle.dispatchEvent(new Event("dblclick", { bubbles: true }));
    await flushPromises();

    expect(layout.layout.widths.chat).toBe(600);
  });

  it("a double-click at an equal split saves nothing", async () => {
    await mountWorkbench(600);
    const layout = useLayoutStore();

    const savesBefore = savesCount();
    await wrapper!.find('[data-panel-group-id="pix-primary"] .resize-handle').trigger("dblclick");
    await flushPromises();

    expect(layout.layout.widths.chat).toBe(600);
    expect(savesCount()).toBe(savesBefore);
  });
});
