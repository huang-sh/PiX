import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { reactive } from "vue";
import { expect, it } from "vitest";
import PromptComposer, { type ComposerDraft } from "../../src/renderer/components/PromptComposer.vue";
import { i18n } from "../../src/renderer/i18n";

it.each(["success", "rejected", "error"])("settles a %s submission on its original draft after the editor changes", async outcome => {
  const original = reactive<ComposerDraft>({ text: "old question", images: [], busy: false, readingImages: false, error: "" });
  let finish!: (value: boolean) => void, fail!: (error: Error) => void;
  const pending = new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject; });
  const wrapper = mount(PromptComposer, { props: {
    draftState: original, runnable: true, model: null, models: [], thinkingLevel: "off",
    onModel: () => {}, onThinking: () => {}, onSubmit: () => pending,
  }, global: { plugins: [createPinia(), i18n] } });
  try {
    await wrapper.get(".composer-submit").trigger("click");
    expect(original.busy).toBe(true);
    const next = reactive<ComposerDraft>({ text: "new question", images: [], busy: true, readingImages: false, error: "new error" });
    await wrapper.setProps({ draftState: next });
    if (outcome === "error") fail(new Error("old error"));
    else finish(outcome === "success");
    await flushPromises();
    expect(next).toMatchObject({ text: "new question", busy: true, error: "new error" });
    expect(original.busy).toBe(false);
    expect(original.text).toBe(outcome === "success" ? "" : "old question");
    expect(original.error).toBe(outcome === "error" ? "old error" : "");
  } finally { finish(true); await flushPromises(); wrapper.unmount(); }
});
