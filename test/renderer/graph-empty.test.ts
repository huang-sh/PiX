import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { nextTick } from "vue";
import { VueFlow } from "@vue-flow/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import PromptComposer from "../../src/renderer/components/PromptComposer.vue";
import { i18n } from "../../src/renderer/i18n";
import { useSessionStore } from "../../src/renderer/stores/session";
import { projectSession } from "../../src/shared/session";
import type { SessionSnapshot } from "../../src/shared/types";

describe("GraphPanel empty state", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("shows one emphasized Start action without the redundant heading", async () => {
    i18n.global.locale.value = "en";
    const pinia = createPinia();
    useSessionStore(pinia).loading = false;
    const wrapper = mount(GraphPanel, {
      global: { plugins: [pinia, i18n] },
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

  it("shows progress and prevents duplicate starts while the session is loading", async () => {
    i18n.global.locale.value = "en";
    const wrapper = mount(GraphPanel, { global: { plugins: [createPinia(), i18n] } });
    const start = wrapper.get(".graph-empty > button");
    expect(start.text()).toBe("Starting…");
    expect(start.attributes("disabled")).toBeDefined();
    await start.trigger("click");
    expect(wrapper.emitted("newSession")).toBeUndefined();
  });

  it("shows an editable draft before creation returns and retains it in the real session", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const pinia = createPinia();
    const session = useSessionStore(pinia);
    session.activeProjectId = "ssh:host:/project";
    session.creation = { request: 1, status: "pending" };
    const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n] } });
    const draft = () => wrapper.getComponent(VueFlow).props("nodes").find(node => node.id === "draft:root")!;
    expect(wrapper.find(".graph-empty").exists()).toBe(false);
    expect(draft().data.runnable).toBe(false);
    draft().data.draftState.text = "typed while creating";
    session.applySnapshot({ session: { path: "/project/new.jsonl", id: "new" }, entries: [],
      projection: projectSession([], null), runtime: { available: true } } as SessionSnapshot);
    session.creation = { request: 1, status: "ready", path: "/project/new.jsonl" };
    await nextTick();
    expect(draft().data.runnable).toBe(true);
    expect(draft().data.draftState.text).toBe("typed while creating");
    wrapper.unmount();
  });

  it("accepts typing during initialization without sending it", async () => {
    const submit = vi.fn();
    const wrapper = mount(PromptComposer, {
      props: { runnable: false, editable: true, model: null, thinkingLevel: "off", models: [],
        onModel: vi.fn(), onThinking: vi.fn(), onSubmit: submit },
      global: { plugins: [createPinia(), i18n] },
    });
    expect(wrapper.get("textarea").attributes("disabled")).toBeUndefined();
    await wrapper.get("textarea").setValue("typed before initialization");
    await wrapper.get("textarea").trigger("keydown", { key: "Enter", ctrlKey: true });
    expect(submit).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
