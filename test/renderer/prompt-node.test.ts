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
      selected: true,
      runnable: false,
      blockedReason: "等待完成或先停止当前任务",
      content: () => ({ user: "Prompt", assistant: "Response" }),
      onCompose,
    };
    const wrapper = mount(PromptNode, {
      props: { id: "turn:1", data },
      global: { plugins: [i18n], stubs: { Handle: true, Teleport: true, MarkdownRenderer: true } },
    });
    const add = wrapper.get(".node-add");

    expect(wrapper.get(".prompt-node").classes()).not.toContain("running");
    await wrapper.setProps({ data: { ...data, active: false, running: true } });
    expect(wrapper.get(".prompt-node").classes()).toContain("running");
    expect(wrapper.get(".prompt-node").classes()).not.toContain("active");
    await wrapper.setProps({ data: { ...data, active: false, running: true, selected: false } });
    expect(wrapper.get(".prompt-node").classes()).toContain("running");
    expect(wrapper.get(".prompt-node").classes()).not.toContain("selected");
    await wrapper.setProps({ data });
    expect(wrapper.get(".prompt-node").classes()).not.toContain("running");

    expect(add.attributes("aria-disabled")).toBe("true");
    expect(add.attributes("title")).toBe("等待完成或先停止当前任务");
    expect(wrapper.get(".node-context-usage").text()).toContain("32%128K");
    expect(wrapper.get(".node-model-value").text()).toContain("OpenAI / GPT-5.4");
    expect(wrapper.get(".node-thinking-value").text()).toContain("high");
    expect(wrapper.find(".node-footer button").exists()).toBe(false);
    expect(wrapper.find(".node-footer select").exists()).toBe(false);
    await add.trigger("click");
    expect(onCompose).not.toHaveBeenCalled();
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
