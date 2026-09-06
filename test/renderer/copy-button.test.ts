import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import CopyButton from "../../src/renderer/components/CopyButton.vue";
import { i18n } from "../../src/renderer/i18n";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("reports clipboard failure, allows retry, and resets feedback", async () => {
  vi.useFakeTimers();
  const copy = vi.spyOn(window.pix!, "copy").mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(undefined);
  const wrapper = mount(CopyButton, { props: { text: "reply" }, global: { plugins: [i18n] } });
  try {
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toBe("Copy failed. Please try again.");
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(copy).toHaveBeenCalledTimes(2);
    expect(wrapper.find(".lucide-check").exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(wrapper.get("button").attributes("aria-label")).toBe("Copy");
  } finally { wrapper.unmount(); }
});

it("uses the browser clipboard when the desktop copy API is unavailable", async () => {
  const copy = window.pix!.copy;
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn().mockResolvedValue(undefined);
  window.pix!.copy = undefined;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const wrapper = mount(CopyButton, { props: { text: "**full**\nresponse" }, global: { plugins: [i18n] } });
  try {
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("**full**\nresponse");
    expect(wrapper.get("button").attributes("aria-label")).toBe("Copied");
  } finally {
    wrapper.unmount();
    window.pix!.copy = copy;
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
