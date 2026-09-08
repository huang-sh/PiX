import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { reactive } from "vue";
import { describe, expect, it, vi } from "vitest";
import PromptComposer, { type ComposerDraft } from "../../src/renderer/components/PromptComposer.vue";
import { i18n } from "../../src/renderer/i18n";

// jsdom Files carry no real location; attach one so the mocked preload
// webUtils.getPathForFile (setup.ts) can resolve it like Electron would.
function localFile(name: string, path: string) {
  const file = new File(["ignored"], name);
  Object.defineProperty(file, "path", { value: path });
  return file;
}

function mountComposer(onSubmit: ReturnType<typeof vi.fn>, draftState?: ComposerDraft) {
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  const props = { model: { provider: "custom", id: "text", input: ["text"] }, models: [], runnable: true,
    thinkingLevel: "off", onModel: vi.fn(), onThinking: vi.fn(), onSubmit };
  return draftState
    ? mount(PromptComposer, { props: { ...props, draftState }, global: { plugins: [i18n] } })
    : mount(PromptComposer, { props, global: { plugins: [i18n] } });
}

describe("document attachments", () => {
  it("attaches non-image files by path on a text-only model; retains them on failure and removes them", async () => {
    const draftState = reactive<ComposerDraft>({ text: "", images: [], files: [], busy: false, readingImages: false, error: "" });
    const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    let wrapper = mountComposer(onSubmit, draftState);
    expect(wrapper.get(".composer-attach").attributes("disabled")).toBeUndefined();
    const picker = wrapper.get('input[type="file"]');
    expect(picker.attributes("accept")).toBeUndefined();
    Object.defineProperty(picker.element, "files", { configurable: true, value: [
      localFile("example.ts", "D:/dev/PiX/test/workspace/src/example.ts"),
      localFile("说明.txt", "D:/docs/说明.txt"),
    ] });
    await picker.trigger("change");
    // Paths resolve synchronously; no reading spinner is involved.
    expect(draftState.files).toEqual([
      { name: "example.ts", path: "D:/dev/PiX/test/workspace/src/example.ts" },
      { name: "说明.txt", path: "D:/docs/说明.txt" },
    ]);
    expect(wrapper.findAll(".composer-file")).toHaveLength(2);
    expect(wrapper.get(".composer-file").attributes("title")).toBe("D:/dev/PiX/test/workspace/src/example.ts");
    wrapper.unmount();
    wrapper = mountComposer(onSubmit, draftState);
    expect(wrapper.findAll(".composer-file")).toHaveLength(2);
    await wrapper.get("textarea").setValue("Review these");
    await wrapper.get(".composer-submit").trigger("click");
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledWith('Review these\n\nAttached file: D:/dev/PiX/test/workspace/src/example.ts\n\nAttached file: D:/docs/说明.txt');
    // The first submission failed, so text and files are restored to the draft.
    expect(draftState.files).toHaveLength(2);
    expect(draftState.text).toBe("Review these");
    await wrapper.get('.composer-file button[aria-label="Remove example.ts"]').trigger("click");
    await wrapper.get("textarea").setValue("");
    await wrapper.get(".composer-submit").trigger("click");
    await flushPromises();
    expect(onSubmit.mock.calls[1][0]).not.toContain("example.ts");
    expect(onSubmit.mock.calls[1][0]).toContain('Attached file: D:/docs/说明.txt');
    expect(wrapper.find(".composer-files").exists()).toBe(false);
    wrapper.unmount();
  });

  it("rejects files without a resolvable path and enforces the document limit", async () => {
    const draftState = reactive<ComposerDraft>({ text: "", images: [], files: [], busy: false, readingImages: false, error: "" });
    const onSubmit = vi.fn().mockResolvedValue(true);
    const wrapper = mountComposer(onSubmit, draftState);
    const picker = wrapper.get('input[type="file"]');
    // No hidden path property -> webUtils returns "" -> localized error, nothing attached.
    Object.defineProperty(picker.element, "files", { configurable: true, value: [new File(["x"], "virtual.txt")] });
    await picker.trigger("change");
    expect(draftState.files).toHaveLength(0);
    expect(draftState.error).toBe(i18n.global.t("draft.filesPath"));
    expect(wrapper.get(".composer-image-error").text()).toBe(i18n.global.t("draft.filesPath"));
    // Nine documents at once exceeds the limit of eight.
    Object.defineProperty(picker.element, "files", { configurable: true, value: Array.from({ length: 9 }, (_, i) => localFile(`f${i}.txt`, `D:/f${i}.txt`)) });
    await picker.trigger("change");
    expect(draftState.files).toHaveLength(0);
    expect(draftState.error).toBe(i18n.global.t("draft.filesLimit"));
    expect(onSubmit).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
