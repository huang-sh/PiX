import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { GraphNode } from "../../src/shared/types";
import { i18n } from "../../src/renderer/i18n";
import DraftNode, { type DraftNodeData } from "../../src/renderer/features/graph/DraftNode.vue";
import PromptNode, { type PromptNodeData } from "../../src/renderer/features/graph/PromptNode.vue";

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
