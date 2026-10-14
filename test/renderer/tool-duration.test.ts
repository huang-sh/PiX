import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { expect, it, vi } from "vitest";
import ToolDuration from "../../src/renderer/features/branch-context/ToolDuration.vue";
import { i18n } from "../../src/renderer/i18n";

it("updates elapsed time locally, freezes at the SDK duration and releases its timer", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
  const locale = i18n.global.locale.value;
  i18n.global.locale.value = "en";
  const wrapper = mount(ToolDuration, { props: { running: true, startedAt: new Date().toISOString() }, global: { plugins: [i18n] } });
  try {
    expect(wrapper.text()).toBe("0ms");
    vi.advanceTimersByTime(2000); await nextTick();
    expect(wrapper.text()).toBe("2.0s");
    expect(wrapper.get("span").attributes("aria-label")).toBe("Elapsed 2.0s");
    await wrapper.setProps({ running: false, durationMs: 1234 });
    expect(wrapper.text()).toBe("1.2s");
    expect(wrapper.get("span").attributes("title")).toBe("Took 1.2s");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000); await nextTick();
    expect(wrapper.text()).toBe("1.2s");
    await wrapper.setProps({ running: true });
    expect(vi.getTimerCount()).toBe(1);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally { wrapper.unmount(); vi.useRealTimers(); i18n.global.locale.value = locale; }
});

it("hides unknown or invalid durations, handles zero and localizes completed timings", async () => {
  const locale = i18n.global.locale.value;
  i18n.global.locale.value = "zh-CN";
  const wrapper = mount(ToolDuration, { props: { running: true }, global: { plugins: [i18n] } });
  try {
    expect(wrapper.find("span").exists()).toBe(false);
    await wrapper.setProps({ running: false, durationMs: 0 });
    expect(wrapper.text()).toBe("0 毫秒");
    expect(wrapper.get("span").attributes("title")).toBe("耗时 0 毫秒");
    await wrapper.setProps({ durationMs: 61500 });
    expect(wrapper.text()).toBe("1 分钟 1 秒");
    for (const durationMs of [undefined, -1, NaN, Infinity]) {
      await wrapper.setProps({ durationMs });
      expect(wrapper.find("span").exists()).toBe(false);
    }
  } finally { wrapper.unmount(); i18n.global.locale.value = locale; }
});
