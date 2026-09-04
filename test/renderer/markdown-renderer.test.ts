import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MarkdownRenderer from "../../src/renderer/components/MarkdownRenderer.vue";

describe("MarkdownRenderer", () => {
  it("updates one safe Markdown surface from streaming to final", async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: "# Res",
        customId: "assistant:1",
        streaming: true,
      },
    });
    const surface = wrapper.get(".agent-markdown").element;

    await wrapper.setProps({
      content: "# Result\n\n- **done**\n\n<script>window.unsafe = true</script>",
      streaming: false,
    });
    await flushPromises();

    expect(wrapper.get(".agent-markdown").element).toBe(surface);
    expect(wrapper.get("h1").text()).toBe("Result");
    expect(wrapper.get("strong").text()).toBe("done");
    expect(wrapper.find("script").exists()).toBe(false);
  });
});
