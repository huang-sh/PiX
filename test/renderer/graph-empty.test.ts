import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { describe, expect, it } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { i18n } from "../../src/renderer/i18n";

describe("GraphPanel empty state", () => {
  it("shows one emphasized Start action without the redundant heading", async () => {
    i18n.global.locale.value = "en";
    const wrapper = mount(GraphPanel, {
      global: { plugins: [createPinia(), i18n] },
    });

    expect(wrapper.text()).not.toContain("No session selected");
    expect(wrapper.text()).not.toContain("Session graph");
    expect(wrapper.text()).not.toContain("Read-only");
    expect(wrapper.text()).toContain("Start a new session or choose an existing one.");
    const start = wrapper.get(".graph-empty > button");
    expect(start.text()).toBe("Start");
    await start.trigger("click");
    expect(wrapper.emitted("newSession")).toHaveLength(1);
  });
});
