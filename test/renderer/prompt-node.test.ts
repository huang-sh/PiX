import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphNode } from "../../src/shared/types";
import { i18n } from "../../src/renderer/i18n";
import DraftNode, { type DraftNodeData } from "../../src/renderer/features/graph/DraftNode.vue";
import PromptNode, { type PromptNodeData } from "../../src/renderer/features/graph/PromptNode.vue";

function nodeData(overrides: Partial<PromptNodeData> = {}): PromptNodeData {
  return {
    node: {
      id: "turn:1",
      parentId: null,
      title: "Prompt",
      timestamp: new Date().toISOString(),
      footer: {
        contextUsage: { tokens: 41_000, contextWindow: 128_000, percent: 32 },
        model: { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
        thinkingLevel: "high",
      },
    } as GraphNode,
    active: true,
    current: true,
    runnable: true,
    blockedReason: "",
    content: () => ({ user: "Prompt", assistant: "Response" }),
    onCompose: vi.fn(),
    ...overrides,
  };
}

describe("PromptNode branch action", () => {
  it("explains and blocks branching while the runtime is busy", async () => {
    const onCompose = vi.fn();
    const data: PromptNodeData = {
      node: {
        id: "turn:1",
        parentId: null,
        title: "Prompt",
        timestamp: new Date().toISOString(),
        footer: {
          contextUsage: { tokens: 41_000, contextWindow: 128_000, percent: 32 },
          model: { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
          thinkingLevel: "high",
        },
      } as GraphNode,
      active: true,
      current: true,
      runnable: false,
      blockedReason: "等待完成或先停止当前任务",
      content: () => ({ user: "Prompt", assistant: "Response" }),
      onCompose,
    };
    const wrapper = mount(PromptNode, {
      props: { id: "turn:1", data, selected: true },
      global: { plugins: [i18n], stubs: { Handle: true, Teleport: true, MarkdownRenderer: true } },
    });
    const add = wrapper.get(".node-add");

    expect(wrapper.get(".prompt-node").classes()).toContain("selected");
    expect(wrapper.get(".prompt-node").classes()).not.toContain("running");
    await wrapper.setProps({ data: { ...data, active: false, running: true, node: { ...data.node, preview: "Partial response" } } });
    expect(wrapper.get(".prompt-node").classes()).toContain("running");
    expect(wrapper.get(".prompt-node").classes()).not.toContain("active");
    expect(wrapper.find('.node-run-state').exists()).toBe(true);
    expect(wrapper.get('.turn-copy p').text()).toBe('Partial response');
    await wrapper.setProps({ selected: false });
    expect(wrapper.get(".prompt-node").classes()).toContain("running");
    expect(wrapper.get(".prompt-node").classes()).not.toContain("selected");
    await wrapper.setProps({ data: { ...data, running: true, node: { ...data.node, preview: "" } } });
    expect(wrapper.find('.node-run-state').exists()).toBe(true);
    await wrapper.setProps({ data });
    expect(wrapper.find('.node-run-state').exists()).toBe(false);
    expect(wrapper.get(".prompt-node").classes()).not.toContain("running");
    await wrapper.setProps({ selected: false });
    expect(wrapper.get(".prompt-node").classes()).not.toContain("selected");

    expect(add.attributes("aria-disabled")).toBe("true");
    expect(add.attributes("title")).toBe("等待完成或先停止当前任务");
    expect(wrapper.get(".node-context-usage").text()).toContain("32%128K");
    expect(wrapper.get(".node-model-value").text()).toContain("OpenAI / GPT-5.4");
    expect(wrapper.get(".node-thinking-value").text()).toContain("high");
    expect(wrapper.find(".node-footer button").exists()).toBe(false);
    expect(wrapper.find(".node-footer select").exists()).toBe(false);
    await add.trigger("click");
    await wrapper.get('[data-direction="up"]').trigger("click");
    await wrapper.get('[data-direction="down"]').trigger("click");
    expect(onCompose).not.toHaveBeenCalled();
    await wrapper.setProps({ data: { ...data, runnable: true } });
    expect(wrapper.findAll(".node-add")).toHaveLength(1);
    expect(add.find(".lucide-plus").exists()).toBe(true);
    const controls = wrapper.get(".node-branch-controls");
    const up = wrapper.get('[data-direction="up"]');
    const down = wrapper.get('[data-direction="down"]');
    const box = vi.spyOn(controls.element, "getBoundingClientRect").mockReturnValue({ top: 100, height: 82 } as DOMRect);
    await controls.trigger("mousemove", { clientY: 105 });
    expect(up.classes()).toContain("is-visible");
    expect(down.classes()).not.toContain("is-visible");
    expect(up.find(".lucide-arrow-up").exists()).toBe(true);
    expect(add.find(".lucide-plus").exists()).toBe(true);
    await up.trigger("click");
    await controls.trigger("mousemove", { clientY: 175 });
    expect(down.classes()).toContain("is-visible");
    expect(up.classes()).not.toContain("is-visible");
    expect(down.find(".lucide-arrow-down").exists()).toBe(true);
    expect(add.find(".lucide-plus").exists()).toBe(true);
    await down.trigger("click");
    await controls.trigger("mouseleave");
    expect(up.classes()).not.toContain("is-visible");
    expect(down.classes()).not.toContain("is-visible");
    expect(add.find(".lucide-plus").exists()).toBe(true);
    await add.trigger("click");
    expect(onCompose.mock.calls).toEqual([["up"], ["down"], ["down"]]);
    await add.trigger("keydown", { key: "ArrowUp" });
    await up.trigger("click");
    expect(onCompose).toHaveBeenLastCalledWith("up");
    box.mockRestore();
    wrapper.unmount();
  });

  it("chooses model and thinking for the draft", async () => {
    const onModel = vi.fn();
    const onThinking = vi.fn();
    const data: DraftNodeData = {
      parentId: "turn:1",
      runnable: true,
      model: { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true, thinkingLevels: ["off", "low", "high"] },
      thinkingLevel: "high",
      models: [
        { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true, thinkingLevels: ["off", "low", "high"] },
        { provider: "openai", id: "gpt-5.4-mini", name: "GPT-5.4 mini", reasoning: true, thinkingLevels: ["off", "low", "high"] },
        { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", reasoning: true },
      ],
      onModel,
      onThinking,
      onSubmit: vi.fn(),
    };

    const menu = mount(DraftNode, {
      props: { id: "draft:turn:1", data },
      global: { plugins: [i18n], stubs: { Handle: true, MarkdownRenderer: true } },
      attachTo: document.body,
    });
    expect(menu.get(".composer-settings").element.parentElement).toBe(menu.get(".prompt-composer > footer").element);
    expect(menu.get(".composer-submit").text()).toBe("");
    expect(menu.get(".node-model-select").attributes("disabled")).toBeUndefined();
    await menu.get(".node-model-select").trigger("click");
    await flushPromises();

    expect([...document.querySelectorAll("[data-model-provider]")].map((item) => item.textContent)).toEqual(["OpenAI", "Anthropic"]);
    expect(document.querySelectorAll("[data-model-id]")).toHaveLength(0);
    (document.querySelector('[data-model-provider="openai"]') as HTMLElement).click();
    await flushPromises();
    expect([...document.querySelectorAll("[data-model-id]")].map((item) => item.getAttribute("data-model-id"))).toEqual([
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
    (document.querySelector('[data-model-id="gpt-5.4-mini"]') as HTMLElement).click();
    await flushPromises();
    expect(onModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai", id: "gpt-5.4-mini" }));
    await menu.get('button[aria-label="Draft thinking level"]').trigger("click");
    await flushPromises();
    expect([...document.querySelectorAll("[data-thinking-level]")].map((item) => item.getAttribute("data-thinking-level")))
      .toEqual(["off", "low", "high"]);
    (document.querySelector('[data-thinking-level="low"]') as HTMLElement).click();
    expect(onThinking).toHaveBeenCalledWith("low", true);
    menu.unmount();
  });
});

describe("PromptNode hover card", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("stays closed while a mouse button is held and closes on press outside the card", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PromptNode, {
      props: { id: "turn:1", data: nodeData(), selected: true },
      global: { plugins: [i18n], stubs: { Handle: true, MarkdownRenderer: true } },
      attachTo: document.body,
    });
    const node = wrapper.get(".prompt-node");

    // Hovering mid-drag (button held) must not open the card.
    await node.trigger("mouseenter", { buttons: 1 });
    await vi.advanceTimersByTimeAsync(280);
    expect(document.querySelector(".node-hover-card")).toBeNull();

    // A plain hover opens it.
    await node.trigger("mouseenter", { buttons: 0 });
    await vi.advanceTimersByTimeAsync(280);
    expect(document.querySelector(".node-hover-card")).not.toBeNull();

    // Pressing (and holding) outside the card closes it immediately.
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(document.querySelector(".node-hover-card")).toBeNull();

    // Pressing inside the card (links, text selection) keeps it open.
    await node.trigger("mouseenter", { buttons: 0 });
    await vi.advanceTimersByTimeAsync(280);
    document.querySelector(".node-hover-card")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.querySelector(".node-hover-card")).not.toBeNull();

    wrapper.unmount();
  });

  it("keeps the card open anywhere on the node and closes it 0.5s after leaving the node", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PromptNode, {
      props: { id: "turn:1", data: nodeData(), selected: true },
      global: { plugins: [i18n], stubs: { Handle: true, MarkdownRenderer: true } },
      attachTo: document.body,
    });
    const node = wrapper.get(".prompt-node");

    await node.trigger("mouseenter", { buttons: 0 });
    await vi.advanceTimersByTimeAsync(280);
    expect(document.querySelector(".node-hover-card")).not.toBeNull();

    // Moving to the footer or branch controls (still on the node) keeps it open.
    await wrapper.get(".node-footer").trigger("mouseenter");
    await wrapper.get(".node-branch-controls").trigger("mousemove", { clientY: 105 });
    await vi.advanceTimersByTimeAsync(600);
    expect(document.querySelector(".node-hover-card")).not.toBeNull();

    // The 0.5s close delay starts only when the pointer leaves the node.
    await node.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(499);
    expect(document.querySelector(".node-hover-card")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector(".node-hover-card")).toBeNull();

    wrapper.unmount();
  });

  it("treats the branch pill as a control: landing on it never opens the card", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PromptNode, {
      props: { id: "turn:1", data: nodeData(), selected: true },
      global: { plugins: [i18n], stubs: { Handle: true, MarkdownRenderer: true } },
      attachTo: document.body,
    });
    const node = wrapper.get(".prompt-node");
    const controls = wrapper.get(".node-branch-controls");

    // Entering the node straight onto the pill (article enter fires first,
    // then the pill's) cancels the pending open.
    await node.trigger("mouseenter", { buttons: 0 });
    await controls.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(280);
    expect(document.querySelector(".node-hover-card")).toBeNull();

    // Leaving the pill toward the node body re-arms the open.
    await controls.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(280);
    expect(document.querySelector(".node-hover-card")).not.toBeNull();

    // Reaching the pill from the node body keeps an open card open.
    await controls.trigger("mouseenter", { relatedTarget: node.element });
    await vi.advanceTimersByTimeAsync(600);
    expect(document.querySelector(".node-hover-card")).not.toBeNull();

    // Reaching the pill from the card (outside the node) counts as leaving:
    // the open card runs its 0.5s close delay.
    const card = document.querySelector(".node-hover-card")!;
    await controls.trigger("mouseenter", { relatedTarget: card });
    await vi.advanceTimersByTimeAsync(499);
    expect(document.querySelector(".node-hover-card")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector(".node-hover-card")).toBeNull();

    wrapper.unmount();
  });
});
