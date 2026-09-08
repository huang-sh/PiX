import { mount, shallowMount, type VueWrapper } from "@vue/test-utils";
import { DropdownMenuRoot } from "reka-ui";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppTitlebar from "../../src/renderer/features/workbench/AppTitlebar.vue";
import Workbench from "../../src/renderer/features/workbench/Workbench.vue";
import SessionNavigator from "../../src/renderer/features/navigator/SessionNavigator.vue";
import NavigatorMenu from "../../src/renderer/features/navigator/NavigatorMenu.vue";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { i18n } from "../../src/renderer/i18n";

vi.mock("../../src/renderer/features/graph/GraphPanel.vue", () => ({ default: { template: '<div class="graph-test" tabindex="0" />' } }));
vi.mock("../../src/renderer/features/branch-context/BranchContextPanel.vue", () => ({ default: { template: '<div />' } }));
vi.mock("../../src/renderer/features/tools/ToolPanel.vue", () => ({ default: { template: '<div />' } }));

describe("session panel controls", () => {
  let wrapper: VueWrapper;
  let layout: ReturnType<typeof useLayoutStore>;
  const button = () => wrapper.get('[data-action="navigator-panel"]');
  const panel = () => wrapper.get("#navigator-panel");
  const pin = () => wrapper.get('[data-action="navigator-pin"]');
  const clickEvent = async (detail: number, type = "click") => {
    button().element.dispatchEvent(new MouseEvent(type, { bubbles: true, detail }));
    await nextTick();
  };
  const singleClick = () => clickEvent(1);

  beforeEach(() => {
    vi.useFakeTimers();
    const pinia = createPinia();
    setActivePinia(pinia);
    layout = useLayoutStore();
    wrapper = mount({ components: { AppTitlebar, Workbench }, template: "<AppTitlebar /><Workbench />" }, {
      attachTo: document.body,
      global: {
        plugins: [pinia, i18n],
        stubs: {
          SplitterGroup: { template: '<div><slot /></div>' },
          SplitterPanel: { template: '<div><slot /></div>' },
          SplitterResizeHandle: true,
          GraphPanel: { template: '<div class="graph-test" tabindex="0" />' },
          BranchContextPanel: true,
          ToolPanel: true,
        },
      },
    });
  });
  afterEach(() => {
    wrapper.unmount();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("toggles immediately and changes pinning only through the header pin button", async () => {
    await singleClick();
    expect(layout.layout.collapsed.navigator).toBe(false);
    expect(panel().classes()).toContain("floating");
    expect(layout.layout.navigatorPinned).toBe(false);

    const save = vi.spyOn(layout, "save");
    await pin().trigger("click");
    expect(save).toHaveBeenCalledTimes(1);
    expect(layout.layout.navigatorPinned).toBe(true);
    expect(layout.layout.collapsed.navigator).toBe(false);
    expect(pin().attributes("aria-pressed")).toBe("true");
    expect(panel().classes()).not.toContain("floating");

    await singleClick();
    expect(layout.layout.collapsed.navigator).toBe(true);
    expect(layout.layout.navigatorPinned).toBe(true);
    await singleClick();
    await wrapper.get(".graph-test").trigger("pointerdown");
    await vi.advanceTimersByTimeAsync(5000);
    expect(layout.layout.collapsed.navigator).toBe(false);
    expect(layout.layout.navigatorPinned).toBe(true);

    await pin().trigger("click");
    expect(layout.layout.navigatorPinned).toBe(false);
    expect(layout.layout.collapsed.navigator).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(layout.layout.collapsed.navigator).toBe(true);
  });

  it.each([false, true])("double clicks only toggle visibility when pinned=%s", async (pinned) => {
    layout.layout.navigatorPinned = pinned;
    const save = vi.spyOn(layout, "save");
    await clickEvent(1);
    expect(layout.layout.collapsed.navigator).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await clickEvent(2);
    await clickEvent(2, "dblclick");
    expect(layout.layout.collapsed.navigator).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(layout.layout.collapsed.navigator).toBe(true);
    expect(layout.layout.navigatorPinned).toBe(pinned);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("resumes auto-hide when an open menu is unmounted by a list update", async () => {
    await singleClick();
    const navigator = wrapper.getComponent(SessionNavigator);
    const menu = shallowMount(NavigatorMenu, {
      props: { onOpenChange: (open: boolean) => navigator.vm.$emit("menuOpenChange", open) },
    });
    menu.getComponent(DropdownMenuRoot).vm.$emit("update:open", true);
    await nextTick();
    await vi.advanceTimersByTimeAsync(3000);
    expect(layout.layout.collapsed.navigator).toBe(false);
    menu.unmount();
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(layout.layout.collapsed.navigator).toBe(true);
  });

  it("protects a newly opened panel, reading, search focus, menus and resizing", async () => {
    await singleClick();
    await vi.advanceTimersByTimeAsync(1900);
    expect(layout.layout.collapsed.navigator).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(layout.layout.collapsed.navigator).toBe(true);

    await singleClick();
    await panel().trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(3000);
    expect(layout.layout.collapsed.navigator).toBe(false);
    const search = wrapper.get<HTMLInputElement>(".session-search input");
    search.element.focus();
    await panel().trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(3000);
    expect(layout.layout.collapsed.navigator).toBe(false);
    search.element.blur();
    await nextTick();

    const navigator = wrapper.getComponent(SessionNavigator);
    navigator.vm.$emit("menuOpenChange", true);
    await nextTick();
    await vi.advanceTimersByTimeAsync(3000);
    expect(layout.layout.collapsed.navigator).toBe(false);
    navigator.vm.$emit("menuOpenChange", false);
    await nextTick();

    const resize = wrapper.get<HTMLElement>(".navigator-resize");
    resize.element.setPointerCapture = vi.fn();
    resize.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 248 }));
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 312 }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(layout.layout.collapsed.navigator).toBe(false);
    expect(layout.layout.widths.navigator).toBe(312);
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(layout.layout.collapsed.navigator).toBe(true);
  });

  it("outside clicks close only auto-hide, and keyboard activation preserves the mode", async () => {
    await clickEvent(0);
    expect(layout.layout.collapsed.navigator).toBe(false);
    await wrapper.get(".graph-test").trigger("pointerdown");
    expect(layout.layout.collapsed.navigator).toBe(true);
    expect(layout.layout.navigatorPinned).toBe(false);
    await singleClick();
    await pin().trigger("click");
    await clickEvent(0);
    expect(layout.layout.collapsed.navigator).toBe(true);
    expect(layout.layout.navigatorPinned).toBe(true);
  });

  it("cleans up hide timers on unmount", async () => {
    await clickEvent(1);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(layout.layout.collapsed.navigator).toBe(false);
  });
});
