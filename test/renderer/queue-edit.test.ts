import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { reactive } from "vue";
import { expect, it, vi } from "vitest";
import PromptComposer, { type ComposerDraft } from "../../src/renderer/components/PromptComposer.vue";
import { i18n } from "../../src/renderer/i18n";
import type { QueuedMessage } from "../../src/shared/types";

function setup(draftState = reactive<ComposerDraft>({ text: "unsent draft", images: [], busy: false, readingImages: false, error: "" })) {
  const onQueuedAction = vi.fn().mockResolvedValue(undefined), onQueue = vi.fn().mockResolvedValue(true);
  const props = { draftState, runnable: true, running: true, model: null, models: [], thinkingLevel: "off",
    onModel: vi.fn(), onThinking: vi.fn(), onSubmit: vi.fn(), onQueue, onQueuedAction,
    queuedMessages: [{ id: "q1", kind: "followUp", text: "original queued text", imageCount: 1 }] as QueuedMessage[],
  };
  const wrapper = mount(PromptComposer, { props, global: { plugins: [createPinia(), i18n] } });
  return { wrapper, props, onQueuedAction, onQueue, draftState };
}

it("edits in place, cancels without mutation, and saves without sending the ordinary draft", async () => {
  const { wrapper, onQueuedAction, onQueue, draftState } = setup();
  try {
    await wrapper.get(".composer-queue-edit").trigger("click");
    expect(wrapper.get<HTMLTextAreaElement>(".composer-queue-editor textarea").element.value).toBe("original queued text");
    await wrapper.get(".composer-queue-editor textarea").setValue("discarded edits");
    await wrapper.get(".composer-queue-edit-cancel").trigger("click");
    expect(onQueuedAction).not.toHaveBeenCalled();
    expect(wrapper.get(".composer-queue-text").text()).toContain("original queued text");
    await wrapper.get(".composer-queue-edit").trigger("click");
    await wrapper.get(".composer-queue-editor textarea").setValue("edited text\nsecond line");
    await wrapper.get(".composer-queue-editor textarea").trigger("keydown", { key: "Enter" });
    expect(onQueue).not.toHaveBeenCalled();
    await wrapper.get(".composer-queue-editor").trigger("submit");
    await flushPromises();
    expect(onQueuedAction).toHaveBeenCalledExactlyOnceWith("q1", "edit", "edited text\nsecond line");
    expect(wrapper.find(".composer-queue-editor").exists()).toBe(false);
    expect(draftState.text).toBe("unsent draft");
    expect(onQueue).not.toHaveBeenCalled();
  } finally { wrapper.unmount(); }
});

it("retains edits on a rejected save and when the message leaves the queue", async () => {
  const { wrapper, onQueuedAction } = setup();
  try {
    await wrapper.get(".composer-queue-edit").trigger("click");
    await wrapper.get(".composer-queue-editor textarea").setValue("keep these edits");
    onQueuedAction.mockRejectedValueOnce(new Error("This message is already being processed"));
    await wrapper.get(".composer-queue-editor").trigger("submit");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("already being processed");
    expect(wrapper.get<HTMLTextAreaElement>(".composer-queue-editor textarea").element.value).toBe("keep these edits");
    await wrapper.setProps({ queuedMessages: [], running: false });
    expect(wrapper.get<HTMLTextAreaElement>(".composer-queue-editor textarea").element.value).toBe("keep these edits");
    expect(wrapper.get(".composer-queue-edit-save").attributes("disabled")).toBeDefined();
    await wrapper.get(".composer-queue-editor").trigger("submit");
    expect(onQueuedAction).toHaveBeenCalledTimes(1);
  } finally { wrapper.unmount(); }
});

it("keeps a queue edit through pinned-column remounts and permits image-only edits", async () => {
  const { wrapper, props, draftState } = setup();
  await wrapper.get(".composer-queue-edit").trigger("click");
  await wrapper.get(".composer-queue-editor textarea").setValue("");
  wrapper.unmount();
  const next = mount(PromptComposer, { props, global: { plugins: [createPinia(), i18n] } });
  try {
    expect(next.get<HTMLTextAreaElement>(".composer-queue-editor textarea").element.value).toBe("");
    expect(next.get(".composer-queue-edit-save").attributes("disabled")).toBeUndefined();
    await next.setProps({ queuedMessages: [{ ...props.queuedMessages[0]!, imageCount: 0 }] });
    expect(next.get(".composer-queue-edit-save").attributes("disabled")).toBeDefined();
    expect(draftState.text).toBe("unsent draft");
  } finally { next.unmount(); }
});

it.each([true, false])("keeps an in-flight save bound to its original draft after switching branches (success: %s)", async succeeds => {
  const { wrapper, onQueuedAction, draftState } = setup();
  let resolve!: () => void, reject!: (error: Error) => void;
  onQueuedAction.mockImplementationOnce(() => new Promise<void>((done, fail) => { resolve = done; reject = fail; }));
  try {
    await wrapper.get(".composer-queue-edit").trigger("click");
    await wrapper.get(".composer-queue-editor textarea").setValue("edited branch A input");
    await wrapper.get(".composer-queue-editor").trigger("submit");
    const otherDraft = reactive<ComposerDraft>({ text: "branch B draft", images: [], busy: false, readingImages: false, error: "",
      queueEdit: { id: "q2", text: "edited branch B input", saving: false, error: "" } });
    await wrapper.setProps({ draftState: otherDraft, queuedMessages: [{ id: "q2", kind: "followUp", text: "branch B input", imageCount: 0 }] });
    if (succeeds) resolve(); else reject(new Error("branch A save failed"));
    await flushPromises();
    expect(onQueuedAction).toHaveBeenCalledExactlyOnceWith("q1", "edit", "edited branch A input");
    expect(otherDraft.queueEdit).toEqual({ id: "q2", text: "edited branch B input", saving: false, error: "" });
    expect(wrapper.get<HTMLTextAreaElement>(".composer-queue-editor textarea").element.value).toBe("edited branch B input");
    expect(otherDraft.text).toBe("branch B draft");
    if (succeeds) expect(draftState.queueEdit).toBeUndefined();
    else expect(draftState.queueEdit).toMatchObject({ text: "edited branch A input", saving: false, error: "branch A save failed" });
  } finally { wrapper.unmount(); }
});
