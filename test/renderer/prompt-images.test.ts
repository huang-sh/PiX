import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";
import PromptComposer from "../../src/renderer/components/PromptComposer.vue";
import { i18n } from "../../src/renderer/i18n";
import type { RuntimeModel } from "../../src/shared/types";

const vision: RuntimeModel = { provider: "custom", id: "vision", input: ["text", "image"] };
const png = () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "test.png", { type: "image/png" });

function setup(onSubmit = vi.fn().mockResolvedValue(true)) {
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  const wrapper = mount(PromptComposer, {
    props: { model: vision, models: [vision], runnable: true, thinkingLevel: "off", onModel: vi.fn(), onThinking: vi.fn(), onSubmit },
    global: { plugins: [i18n] },
  });
  return { wrapper, onSubmit };
}

describe("image prompts", () => {
  it("selects, previews and sends images without requiring text", async () => {
    const { wrapper, onSubmit } = setup();
    const picker = wrapper.get('input[type="file"]');
    Object.defineProperty(picker.element, "files", { value: [png()], configurable: true });
    await picker.trigger("change");
    await vi.waitFor(() => expect(wrapper.findAll(".composer-images img")).toHaveLength(1));
    expect(wrapper.get(".composer-images img").attributes("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    await wrapper.get(".composer-submit").trigger("click");
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledWith("", [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
    expect(wrapper.find(".composer-images").exists()).toBe(false);
    wrapper.unmount();
  });

  it("pastes images, retains them after failure, blocks text-only models and removes attachments", async () => {
    const { wrapper, onSubmit } = setup(vi.fn().mockRejectedValue(new Error("offline")));
    await wrapper.get("textarea").setValue("describe this");
    await wrapper.get("textarea").trigger("paste", { clipboardData: { files: [png()] } });
    await vi.waitFor(() => expect(wrapper.findAll(".composer-images img")).toHaveLength(1));
    await wrapper.get(".composer-submit").trigger("click");
    await flushPromises();
    expect(wrapper.get("[role=alert]").text()).toBe("offline");
    expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe("describe this");
    expect(wrapper.findAll(".composer-images img")).toHaveLength(1);
    await wrapper.setProps({ model: { ...vision, id: "text-only", input: ["text"] } });
    expect(wrapper.get(".composer-submit").attributes("disabled")).toBeDefined();
    await wrapper.get(".composer-submit").trigger("click");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await wrapper.get(".composer-image-remove").trigger("click");
    expect(wrapper.get(".composer-submit").attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("rejects unsupported files and handles dropped images", async () => {
    const { wrapper } = setup();
    await wrapper.trigger("drop", { dataTransfer: { files: [new File(["x"], "x.svg", { type: "image/svg+xml" })] } });
    expect(wrapper.get("[role=alert]").text()).toContain("PNG");
    expect(wrapper.find(".composer-images").exists()).toBe(false);
    await wrapper.trigger("drop", { dataTransfer: { files: [png()] } });
    await vi.waitFor(() => expect(wrapper.findAll(".composer-images img")).toHaveLength(1));
    wrapper.unmount();
  });
});
