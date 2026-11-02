import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, getActivePinia, setActivePinia } from "pinia";
import { reactive } from "vue";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import PromptComposer, { type ComposerDraft } from "../../src/renderer/components/PromptComposer.vue";
import SystemPromptSection from "../../src/renderer/features/settings/SystemPromptSection.vue";
import PersonasPanel from "../../src/renderer/features/settings/PersonasPanel.vue";
import BranchContextPanel from "../../src/renderer/features/branch-context/BranchContextPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import { desktop } from "../../src/renderer/api";
import { i18n } from "../../src/renderer/i18n";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot, SettingsBundle, SystemPromptPreview } from "../../src/shared/types";

vi.mock("../../src/renderer/lib/frame", () => ({ nextFrame: async () => {}, whenVisible: async () => {}, whenTransitionsSettle: async () => {} }));
enableAutoUnmount(afterEach);
beforeEach(() => {
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  vi.mocked(desktop.invoke).mockReset().mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const session = useSessionStore(), layout = useLayoutStore();
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: "first" } },
    { type: "message", id: "u2", parentId: "u1", timestamp: "", message: { role: "user", content: "second" } },
  ];
  const projection = projectSession(entries, "u2");
  projection.nodes.forEach(node => { node.branchId = "main"; });
  projection.activePromptOverride = { mode: "replace", name: "reviewer" };
  session.current = { session: { id: "review", path: "review.jsonl" }, entries, projection,
    runtime: { available: true, isStreaming: false }, graph: { id: "review.jsonl", epoch: "one", revision: 1, runs: [] } } as SessionSnapshot;
  layout.settings = { app: { personas: [{ name: "reviewer", text: "Review code" }] } } as SettingsBundle;
  return { session, layout };
}

it("keeps the persona picker on main, historical and side-branch drafts with correct inheritance", async () => {
  const { session } = setup();
  const wrapper = mount(GraphPanel, { global: { plugins: [i18n], stubs: { VueFlow: true } } });
  const graph = (wrapper.vm as any).$.setupState;
  const draft = () => graph.nodes.find((node: any) => node.type === "draft").data;
  await graph.compose("turn:u2", "down"); await flushPromises();
  expect(draft().personas).toHaveLength(1);
  expect(draft().promptOverride).toEqual({ mode: "replace", name: "reviewer" });
  await graph.compose("turn:u1", "down"); await flushPromises();
  expect(draft().personas).toHaveLength(1);
  expect(draft().promptOverride).toBeNull();
  session.current!.projection.nodes[0]!.branchId = "side";
  session.current!.projection.nodes[0]!.promptOverride = { mode: "strict", name: "writer" };
  graph.rebuild();
  expect(draft().personas).toHaveLength(1);
  expect(draft().promptOverride).toEqual({ mode: "strict", name: "writer" });
});

it("submits a graph draft's persona together with its branch target", async () => {
  const { session } = setup();
  const wrapper = mount(GraphPanel, { global: { plugins: [i18n], stubs: { VueFlow: true } } });
  const graph = (wrapper.vm as any).$.setupState;
  await graph.compose("turn:u1", "down");
  graph.draftState.promptOverride = { mode: "strict", name: "reviewer" };
  const submit = vi.spyOn(session, "promptAt").mockResolvedValue("turn:new");
  await graph.submitDraft("hello");
  expect(submit).toHaveBeenCalledWith("turn:u1", "hello", null, "off", undefined,
    expect.objectContaining({ promptOverride: { mode: "strict", name: "reviewer" } }));
});

it("offers the same persona control in the chat composer", async () => {
  const { session } = setup();
  session.focusedNode = "turn:u2";
  const wrapper = mount(BranchContextPanel, { global: { plugins: [i18n] } });
  await wrapper.get(".composer-collapsed").trigger("click");
  expect(wrapper.getComponent(PromptComposer).props("personas")).toHaveLength(1);
  expect(wrapper.find(".node-persona-select").exists()).toBe(true);
});

it.each([undefined, "append", "strict"] as const)("defaults to replace while respecting an inherited %s mode and preserving failed drafts", async inherited => {
  const state = reactive<ComposerDraft>({ text: "hello", images: [], busy: false, readingImages: false, error: "" });
  const send = vi.fn().mockResolvedValue(false);
  const wrapper = mount(PromptComposer, { props: { draftState: state, runnable: true, models: [], model: null, thinkingLevel: "off",
    personas: [{ name: "reviewer", text: "Review code" }], promptOverride: inherited ? { name: "previous", mode: inherited } : undefined,
    onModel: vi.fn(), onThinking: vi.fn(), onSubmit: send },
    global: { plugins: [getActivePinia()!, i18n], stubs: {
      DropdownMenuContent: { template: "<div><slot /></div>" }, DropdownMenuPortal: { template: "<div><slot /></div>" },
      DropdownMenuItem: { emits: ["select"], template: '<button @click="$emit(\'select\')"><slot /></button>' },
      DropdownMenuSubTrigger: { template: "<div><slot /></div>" }, DropdownMenuSubContent: { template: "<div><slot /></div>" },
    } } });
  await wrapper.get('[data-persona-option="reviewer"]').trigger("click");
  expect(state.promptOverride).toEqual({ mode: inherited ?? "replace", name: "reviewer" });
  expect(desktop.invoke).not.toHaveBeenCalled();
  await wrapper.get("textarea").trigger("keydown", { key: "Enter", ctrlKey: true }); await flushPromises();
  expect(send).toHaveBeenCalledWith("hello");
  expect(state.promptOverride?.name).toBe("reviewer");
  send.mockResolvedValue(true);
  await wrapper.get("textarea").trigger("keydown", { key: "Enter", ctrlKey: true }); await flushPromises();
  expect(state.promptOverride).toBeUndefined();
});

it("snapshots explicit personas in promptAt and distinguishes inherit from off", async () => {
  const { session } = setup();
  vi.mocked(desktop.invoke).mockResolvedValue(session.current);
  await session.promptAt("turn:u1", "hello", undefined, undefined, undefined, { promptOverride: { mode: "replace", name: "reviewer" } });
  expect(desktop.invoke).toHaveBeenLastCalledWith("agent.control", expect.objectContaining({
    action: "promptAt", nodeId: "turn:u1", promptOverride: { mode: "replace", name: "reviewer", text: "Review code" },
  }));
  await session.promptAt("turn:u1", "off", undefined, undefined, undefined, { promptOverride: null });
  expect(desktop.invoke).toHaveBeenLastCalledWith("agent.control", expect.objectContaining({ promptOverride: { off: true } }));
  await session.promptAt("turn:u1", "inherit");
  expect(vi.mocked(desktop.invoke).mock.calls.at(-1)![1]).not.toHaveProperty("promptOverride");
});

it("renders each editable section once and refreshes the effective preview after saving", async () => {
  const layout = useLayoutStore();
  layout.settings = { app: { promptCustomization: { preamble: "Custom preamble" } } } as SettingsBundle;
  const value: SystemPromptPreview = { text: "Custom preamble", preamble: "Custom preamble", sections: [{ name: "rules", content: "<docs>\nExample\n</docs>" }] };
  const preview = vi.spyOn(useSessionStore(), "promptPreview").mockResolvedValue(value);
  const save = vi.spyOn(layout, "updateAppSettings").mockResolvedValue();
  const wrapper = mount(SystemPromptSection, { global: { plugins: [i18n] } });
  await flushPromises();
  expect(wrapper.findAll('[data-prompt-block="preamble"]')).toHaveLength(1);
  expect(wrapper.get('[data-prompt-block="rules"] pre').text()).toBe("<docs>\nExample\n</docs>");
  await wrapper.get('[data-prompt-block="rules"] button').trigger("click");
  await wrapper.get("textarea").setValue("New rules");
  await wrapper.get("form").trigger("submit"); await flushPromises();
  expect(save).toHaveBeenCalledWith({ promptCustomization: { preamble: "Custom preamble", rules: "New rules" } });
  expect(preview).toHaveBeenCalledTimes(2);
});

it.each(["preamble", "rules", "docs"])("opens the %s editor inside its section and focuses it", async name => {
  vi.spyOn(useSessionStore(), "promptPreview").mockResolvedValue({ text: "Stock", preamble: "Stock preamble", sections: [
    { name: "rules", content: "Stock rules" }, { name: "docs", content: "Stock docs" },
  ] });
  const wrapper = mount(SystemPromptSection, { attachTo: document.body, global: { plugins: [i18n] } });
  await flushPromises();
  const block = wrapper.get(`[data-prompt-block="${name}"]`);
  await block.get("button").trigger("click");
  const editor = block.get<HTMLTextAreaElement>("textarea");
  expect(editor.element.value).toBe(`Stock ${name}`);
  expect(document.activeElement).toBe(editor.element);
  expect(block.find("pre").exists()).toBe(false);
  await editor.setValue("Unsaved edit");
  await block.get('button[type="button"]').trigger("click");
  expect(block.find("textarea").exists()).toBe(false);
  expect(block.get("pre").text()).toBe(`Stock ${name}`);
});

it("surfaces synchronization failures from saving settings", async () => {
  vi.spyOn(useSessionStore(), "promptPreview").mockResolvedValue({ text: "Stock", preamble: "Stock", sections: [] });
  vi.spyOn(useLayoutStore(), "updateAppSettings").mockRejectedValue(new Error("remote sync failed"));
  const wrapper = mount(SystemPromptSection, { global: { plugins: [i18n] } });
  await flushPromises();
  await wrapper.get('[data-prompt-block="preamble"] button').trigger("click");
  await wrapper.get("textarea").setValue("Custom");
  await wrapper.get("form").trigger("submit"); await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("remote sync failed");
  expect(wrapper.find("form").exists()).toBe(true);
});

it.each(["prompt", "persona"])("does not submit a %s twice while its save is pending", async kind => {
  vi.spyOn(useSessionStore(), "promptPreview").mockResolvedValue({ text: "Stock", preamble: "Stock", sections: [] });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const save = vi.spyOn(useLayoutStore(), "updateAppSettings").mockReturnValue(pending);
  const wrapper = mount(kind === "prompt" ? SystemPromptSection : PersonasPanel, { global: { plugins: [i18n] } });
  await flushPromises();
  if (kind === "prompt") await wrapper.get('[data-prompt-block="preamble"] button').trigger("click");
  else {
    await wrapper.get('[data-persona-new]').trigger("click");
    await wrapper.get('input').setValue("Reviewer");
    await wrapper.get('textarea').setValue("Review code");
  }
  try {
    await wrapper.get('form').trigger("submit");
    await wrapper.get('form').trigger("submit");
    expect(save).toHaveBeenCalledTimes(1);
    expect(wrapper.get('textarea').attributes('disabled')).toBeDefined();
    expect(wrapper.get('button[type="button"]').attributes('disabled')).toBeDefined();
  } finally { finish(); await flushPromises(); }
});

it("does not replace the saved prompt preview with an older pending response", async () => {
  useLayoutStore().settings = { app: { promptCustomization: { preamble: "Original" } } } as SettingsBundle;
  let finish!: (value: SystemPromptPreview) => void;
  const pending = new Promise<SystemPromptPreview>(resolve => { finish = resolve; });
  vi.spyOn(useSessionStore(), "promptPreview").mockReturnValueOnce(pending)
    .mockResolvedValue({ text: "New", preamble: "New", sections: [] });
  vi.spyOn(useLayoutStore(), "updateAppSettings").mockResolvedValue();
  const wrapper = mount(SystemPromptSection, { global: { plugins: [i18n] } });
  await wrapper.get('[data-prompt-block="preamble"] button').trigger("click");
  await wrapper.get('textarea').setValue("New");
  await wrapper.get('form').trigger("submit"); await flushPromises();
  expect(wrapper.get('[data-prompt-block="preamble"] pre').text()).toBe("New");
  finish({ text: "Old", preamble: "Old", sections: [] }); await flushPromises();
  expect(wrapper.get('[data-prompt-block="preamble"] pre').text()).toBe("New");
});

it("copies an Agent prompt into the preamble editor and saves only that section", async () => {
  const { layout, session } = setup();
  layout.settings!.app.promptCustomization = { rules: "Keep rules", docs: "Keep docs" };
  const preview = vi.spyOn(session, "promptPreview").mockResolvedValue({ text: "Stock", preamble: "Stock", sections: [] });
  const save = vi.spyOn(layout, "updateAppSettings").mockResolvedValue();
  const wrapper = mount(SystemPromptSection, { attachTo: document.body, global: { plugins: [i18n] } });
  await flushPromises();
  expect(wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element.selectedOptions[0]?.text).toBe("Default preamble");
  await wrapper.get('[data-prompt-persona]').setValue("persona:reviewer");
  await flushPromises();
  expect(wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element.selectedOptions[0]?.text).toBe("reviewer");
  expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe("Review code");
  expect(document.activeElement).toBe(wrapper.get('textarea').element);
  expect(save).not.toHaveBeenCalled();
  await wrapper.get('textarea').setValue("Review code carefully");
  expect(wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element.selectedOptions[0]?.text).toBe("Custom preamble");
  await wrapper.get('form').trigger("submit"); await flushPromises();
  expect(save).toHaveBeenCalledWith({ promptCustomization: { preamble: "Review code carefully", preamblePersona: null, rules: "Keep rules", docs: "Keep docs" } });
  expect(layout.settings!.app.personas).toEqual([{ name: "reviewer", text: "Review code" }]);
  expect(preview).toHaveBeenCalledTimes(2);
});

it("updates the preamble choices with the library and preserves other unsaved sections", async () => {
  const { layout, session } = setup();
  vi.spyOn(session, "promptPreview").mockResolvedValue({ text: "Stock", preamble: "Stock", sections: [] });
  const wrapper = mount(SystemPromptSection, { global: { plugins: [i18n] } });
  await flushPromises();
  layout.settings!.app.personas!.push({ name: "writer", text: "Write prose" });
  await flushPromises();
  expect(wrapper.get('[data-prompt-persona]').findAll('option').map(option => option.text())).toContain("writer");
  await wrapper.get('[data-prompt-block="rules"] button').trigger("click");
  await wrapper.get('textarea').setValue("Unsaved rules");
  expect(wrapper.get('[data-prompt-persona]').attributes('disabled')).toBeDefined();
  session.promptPreviewRevision++;
  await flushPromises();
  expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe("Unsaved rules");
});

it("keeps the selected prompt name after saving and shows custom or default state accurately", async () => {
  const { layout, session } = setup();
  layout.settings!.app.promptCustomization = { rules: "Keep rules", docs: "Keep docs" };
  vi.spyOn(session, "promptPreview").mockImplementation(async () => {
    const preamble = layout.settings!.app.promptCustomization?.preamble ?? "Stock";
    return { text: preamble, preamble, sections: [] };
  });
  vi.spyOn(layout, "updateAppSettings").mockImplementation(async patch => {
    Object.assign(layout.settings!.app, patch);
  });
  const wrapper = mount(SystemPromptSection, { global: { plugins: [i18n] } });
  await flushPromises();
  const select = () => wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element;
  const defaultOption = () => wrapper.get('[data-prompt-persona] option[value=""]');
  await wrapper.get('[data-prompt-persona]').setValue("persona:reviewer"); await flushPromises();
  await wrapper.get('form').trigger("submit"); await flushPromises();
  expect(select().selectedOptions[0]?.text).toBe("reviewer");
  expect(defaultOption().text()).toBe("Default preamble");
  expect(defaultOption().attributes('disabled')).toBeUndefined();
  await wrapper.get('[data-prompt-block="preamble"] button').trigger("click");
  await wrapper.get('textarea').setValue("Handwritten persona");
  expect(select().selectedOptions[0]?.text).toBe("Custom preamble");
  expect(defaultOption().text()).toBe("Default preamble");
  expect(defaultOption().attributes('disabled')).toBeUndefined();
  await wrapper.get('form button[type="button"]').trigger("click");
  expect(select().selectedOptions[0]?.text).toBe("reviewer");
  await wrapper.get('[data-prompt-persona]').setValue("");
  await flushPromises();
  expect(select().selectedOptions[0]?.text).toBe("Default preamble");
  expect(wrapper.get('[data-prompt-block="preamble"] pre').text()).toBe("Stock");
  expect(layout.settings!.app.promptCustomization).toEqual({ rules: "Keep rules", docs: "Keep docs" });
});

it("restores the default from a custom draft even when the prompt library is empty", async () => {
  const { layout, session } = setup();
  layout.settings!.app.personas = [];
  layout.settings!.app.promptCustomization = { preamble: "Saved custom persona", rules: "Keep rules" };
  vi.spyOn(session, "promptPreview").mockResolvedValue({ text: "Stock", preamble: "Stock", sections: [] });
  const save = vi.spyOn(layout, "updateAppSettings").mockImplementation(async patch => { Object.assign(layout.settings!.app, patch); });
  const wrapper = mount(SystemPromptSection, { global: { plugins: [i18n] } });
  await flushPromises();
  await wrapper.get('[data-prompt-block="preamble"] button').trigger("click");
  await wrapper.get('textarea').setValue("Unsaved custom persona");
  expect(wrapper.get('[data-prompt-persona]').attributes('disabled')).toBeUndefined();
  await wrapper.get('[data-prompt-persona]').setValue(""); await flushPromises();
  expect(save).toHaveBeenCalledWith({ promptCustomization: { rules: "Keep rules" } });
  expect(wrapper.find('textarea').exists()).toBe(false);
  expect(wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element.selectedOptions[0]?.text).toBe("Default preamble");
});

it("keeps the selected persona when restoring default fails", async () => {
  const { layout, session } = setup();
  layout.settings!.app.promptCustomization = { preamble: "Review code" };
  vi.spyOn(session, "promptPreview").mockResolvedValue({ text: "Review code", preamble: "Review code", sections: [] });
  vi.spyOn(layout, "updateAppSettings").mockRejectedValue(new Error("remote sync failed"));
  const wrapper = mount(SystemPromptSection, { global: { plugins: [i18n] } });
  await flushPromises();
  await wrapper.get('[data-prompt-persona]').setValue(""); await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain("remote sync failed");
  expect(wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element.selectedOptions[0]?.text).toBe("reviewer");
});

it("preserves the chosen name for identical prompt texts through save, reopening and cancel", async () => {
  const { layout, session } = setup();
  layout.settings!.app.personas = [{ name: "first", text: "Same body" }, { name: "second", text: "Same body" }];
  layout.settings!.app.promptCustomization = { rules: "Keep rules" };
  vi.spyOn(session, "promptPreview").mockImplementation(async () => {
    const preamble = layout.settings!.app.promptCustomization?.preamble ?? "Stock";
    return { text: preamble, preamble, sections: [] };
  });
  const save = vi.spyOn(layout, "updateAppSettings").mockImplementation(async patch => { Object.assign(layout.settings!.app, patch); });
  const create = () => mount(SystemPromptSection, { global: { plugins: [i18n] } });
  let wrapper = create(); await flushPromises();
  const selected = () => wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element.selectedOptions[0]?.text;
  await wrapper.get('[data-prompt-persona]').setValue("persona:second"); await flushPromises();
  expect(selected()).toBe("second");
  expect(wrapper.get('[data-prompt-persona]').findAll('option').map(option => option.text())).toEqual(["Default preamble", "first", "second"]);
  await wrapper.get('form').trigger("submit"); await flushPromises();
  expect(save).toHaveBeenCalledWith({ promptCustomization: { preamble: "Same body", preamblePersona: "second", rules: "Keep rules" } });
  wrapper.unmount(); wrapper = create(); await flushPromises();
  expect(selected()).toBe("second");
  await wrapper.get('[data-prompt-persona]').setValue("persona:first"); await flushPromises();
  expect(selected()).toBe("first");
  await wrapper.get('form button[type="button"]').trigger("click");
  expect(selected()).toBe("second");
  await wrapper.get('[data-prompt-block="preamble"] button').trigger("click");
  await wrapper.get('textarea').setValue("Handwritten text");
  expect(selected()).toBe("Custom preamble");
  await wrapper.get('form').trigger("submit"); await flushPromises();
  expect(layout.settings!.app.promptCustomization).toEqual({ preamble: "Handwritten text", preamblePersona: null, rules: "Keep rules" });
});

it("keeps an untouched default dynamic while editing and saving", async () => {
  const { layout, session } = setup();
  layout.settings!.app.promptCustomization = { rules: "Keep rules" };
  const preview = vi.spyOn(session, "promptPreview").mockResolvedValue({ text: "Stock", preamble: "Stock", sections: [] });
  const save = vi.spyOn(layout, "updateAppSettings").mockImplementation(async patch => { Object.assign(layout.settings!.app, patch); });
  const wrapper = mount(SystemPromptSection, { global: { plugins: [i18n] } }); await flushPromises();
  const selected = () => wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element.selectedOptions[0]?.text;
  await wrapper.get('[data-prompt-block="preamble"] button').trigger("click");
  expect(selected()).toBe("Default preamble");
  await wrapper.get('textarea').setValue("Changed"); expect(selected()).toBe("Custom preamble");
  await wrapper.get('textarea').setValue("Stock"); expect(selected()).toBe("Default preamble");
  preview.mockResolvedValue({ text: "New stock", preamble: "New stock", sections: [] });
  session.promptPreviewRevision++; await flushPromises();
  expect(selected()).toBe("Default preamble");
  expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe("Stock");
  await wrapper.get('form').trigger("submit"); await flushPromises();
  expect(save).toHaveBeenCalledWith({ promptCustomization: { rules: "Keep rules" } });
  expect(wrapper.get('[data-prompt-block="preamble"] pre').text()).toBe("New stock");
});

it("keeps a removed source custom after saving, reopening and later library changes", async () => {
  const { layout, session } = setup();
  layout.settings!.app.personas = [{ name: "first", text: "Same body" }, { name: "second", text: "Same body" }];
  layout.settings!.app.promptCustomization = { preamble: "Same body", preamblePersona: "second" };
  vi.spyOn(session, "promptPreview").mockResolvedValue({ text: "Same body", preamble: "Same body", sections: [] });
  vi.spyOn(layout, "updateAppSettings").mockImplementation(async patch => { Object.assign(layout.settings!.app, patch); });
  const create = () => mount(SystemPromptSection, { global: { plugins: [i18n] } });
  let wrapper = create(); await flushPromises();
  const selected = () => wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element.selectedOptions[0]?.text;
  expect(selected()).toBe("second");
  await wrapper.get('[data-prompt-block="preamble"] button').trigger("click");
  layout.settings!.app.personas.pop(); await flushPromises();
  expect(selected()).toBe("Custom preamble");
  expect(wrapper.get<HTMLTextAreaElement>('textarea').element.value).toBe("Same body");
  await wrapper.get('form').trigger("submit"); await flushPromises();
  expect(selected()).toBe("Custom preamble");
  expect(layout.settings!.app.promptCustomization).toEqual({ preamble: "Same body", preamblePersona: null });
  wrapper.unmount(); wrapper = create(); await flushPromises();
  expect(selected()).toBe("Custom preamble");
  layout.settings!.app.personas.push({ name: "second", text: "Same body" }); await flushPromises();
  expect(selected()).toBe("Custom preamble");
  await wrapper.get('[data-prompt-persona]').setValue("persona:first"); await flushPromises();
  await wrapper.get('form').trigger("submit"); await flushPromises();
  expect(selected()).toBe("first");
  expect(layout.settings!.app.promptCustomization.preamblePersona).toBe("first");
  await wrapper.get('[data-prompt-persona]').setValue(""); await flushPromises();
  expect(selected()).toBe("Default preamble");
  expect(layout.settings!.app.promptCustomization).toEqual({});
});

it("does not infer a persona for explicitly custom text that matches a library prompt", async () => {
  const { layout, session } = setup();
  layout.settings!.app.promptCustomization = { preamble: "Handwritten text", preamblePersona: null };
  vi.spyOn(session, "promptPreview").mockResolvedValue({ text: "Handwritten text", preamble: "Handwritten text", sections: [] });
  vi.spyOn(layout, "updateAppSettings").mockImplementation(async patch => { Object.assign(layout.settings!.app, patch); });
  const wrapper = mount(SystemPromptSection, { global: { plugins: [i18n] } }); await flushPromises();
  await wrapper.get('[data-prompt-block="preamble"] button').trigger("click");
  await wrapper.get('textarea').setValue("Review code");
  await wrapper.get('form').trigger("submit"); await flushPromises();
  expect(wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element.selectedOptions[0]?.text).toBe("Custom preamble");
  expect(layout.settings!.app.promptCustomization).toEqual({ preamble: "Review code", preamblePersona: null });
});

it("still recognizes an unambiguous legacy preamble without provenance", async () => {
  const { layout, session } = setup();
  layout.settings!.app.promptCustomization = { preamble: "Review code" };
  vi.spyOn(session, "promptPreview").mockResolvedValue({ text: "Review code", preamble: "Review code", sections: [] });
  const wrapper = mount(SystemPromptSection, { global: { plugins: [i18n] } }); await flushPromises();
  expect(wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element.selectedOptions[0]?.text).toBe("reviewer");
});

it("sends cloneable prompt libraries when creating, editing and deleting among multiple entries", async () => {
  const layout = useLayoutStore();
  const stored = { app: { language: "en", theme: "light", density: "comfortable", personas: [
    { name: "first", text: "First body" }, { name: "second", text: "Second body" },
  ] }, piGlobal: {}, piProject: {}, effective: {}, paths: {} } as SettingsBundle;
  layout.settings = structuredClone(stored);
  vi.mocked(desktop.invoke).mockImplementation(async (route, raw) => {
    if (route !== "settings.update") return {};
    // Electron's IPC rejects Vue proxies, even when nested inside a plain array.
    const { patch } = structuredClone(raw) as { patch: Record<string, unknown> };
    Object.assign(stored.app, patch);
    return structuredClone(stored);
  });
  const wrapper = mount(PersonasPanel, { global: { plugins: [i18n] } });
  await wrapper.get('[data-persona="first"] button[title="Edit prompt"]').trigger("click");
  await wrapper.get('[data-persona-text]').setValue("Edited body");
  await wrapper.get('form').trigger("submit"); await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(layout.settings!.app.personas).toEqual([{ name: "first", text: "Edited body" }, { name: "second", text: "Second body" }]);
  await wrapper.get('[data-persona-new]').trigger("click");
  await wrapper.get('[data-persona-name]').setValue("third");
  await wrapper.get('[data-persona-text]').setValue("Third body");
  await wrapper.get('form').trigger("submit"); await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(layout.settings!.app.personas?.map(persona => persona.name)).toEqual(["first", "second", "third"]);
  await wrapper.get('[data-persona-delete="second"]').trigger("click");
  await wrapper.get('[data-persona-delete="second"]').trigger("click"); await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(layout.settings!.app.personas).toEqual([{ name: "first", text: "Edited body" }, { name: "third", text: "Third body" }]);
});

it("retains the chosen duplicate prompt draft after a failed save", async () => {
  const { layout, session } = setup();
  layout.settings!.app.personas = [{ name: "first", text: "Same body" }, { name: "second", text: "Same body" }];
  layout.settings!.app.promptCustomization = { preamble: "Same body", preamblePersona: "first" };
  vi.spyOn(session, "promptPreview").mockResolvedValue({ text: "Same body", preamble: "Same body", sections: [] });
  vi.spyOn(layout, "updateAppSettings").mockRejectedValue(new Error("save failed"));
  const wrapper = mount(SystemPromptSection, { global: { plugins: [i18n] } }); await flushPromises();
  await wrapper.get('[data-prompt-persona]').setValue("persona:second"); await flushPromises();
  await wrapper.get('form').trigger("submit"); await flushPromises();
  expect(wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element.selectedOptions[0]?.text).toBe("second");
  expect(wrapper.get('[role="alert"]').text()).toContain("save failed");
  expect(layout.settings!.app.promptCustomization.preamblePersona).toBe("first");
  await wrapper.get('form button[type="button"]').trigger("click");
  expect(wrapper.get<HTMLSelectElement>('[data-prompt-persona]').element.selectedOptions[0]?.text).toBe("first");
});

it("refreshes after a completed reload and ignores reload replies from a previous view", async () => {
  const { session } = setup();
  let finish!: () => void;
  vi.mocked(desktop.invoke).mockImplementation(() => new Promise(resolve => { finish = () => resolve({}); }));
  const reload = session.control({ action: "reload" });
  expect(session.promptPreviewRevision).toBe(0);
  finish(); await reload;
  expect(session.promptPreviewRevision).toBe(1);
  const oldReload = session.control({ action: "reload" });
  session.viewRequest++;
  finish(); await oldReload;
  expect(session.promptPreviewRevision).toBe(1);
});
