import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useLayoutStore } from "../../src/renderer/stores/layout";
import type { GraphNode, SettingsBundle } from "../../src/shared/types";
import { i18n } from "../../src/renderer/i18n";
import DraftNode, { type DraftNodeData } from "../../src/renderer/features/graph/DraftNode.vue";
import PromptNode, { type PromptNodeData } from "../../src/renderer/features/graph/PromptNode.vue";

beforeEach(() => {
  setActivePinia(createPinia());
  useLayoutStore().settings = { app: { nodeCardFields: ["branch", "context"] } } as SettingsBundle;
});

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

describe("PromptNode information", () => {
  it("uses the global priority, shows complete details, and honors subscription billing", async () => {
    vi.useFakeTimers();
    const layout = useLayoutStore();
    delete layout.settings!.app.nodeCardFields;
    const data = nodeData();
    data.node.gitBranch = "main";
    data.node.metrics = {
      usage: { input: 1200, output: 300, cacheRead: 800, cacheWrite: 100, cost: 0.0123 },
      costs: { openai: 0.0123 }, durationMs: 83_000,
    };
    const wrapper = mount(PromptNode, {
      props: { id: "turn:1", data },
      global: { plugins: [i18n], stubs: { Handle: true, MarkdownRenderer: true } },
      attachTo: document.body,
    });
    try {
      expect(wrapper.findAll('[data-node-info]').map(item => item.attributes('data-node-info'))).toEqual(["branch", "context", "model", "thinking"]);
      expect((wrapper.get(".node-footer").element as HTMLElement).style.gridTemplateColumns).toBe("auto minmax(0,1fr) minmax(0,auto) auto");
      expect(wrapper.get("[data-node-info=\"model\"]").find("svg").exists()).toBe(false);
      expect(wrapper.find(".node-info-more").exists()).toBe(false);
      layout.settings!.app.nodeCardFields = ["duration", "cost"];
      await flushPromises();
      expect(wrapper.get('[data-node-info="duration"]').text()).toBe("1m 23s");
      expect(wrapper.get('[data-node-info="cost"]').text()).toBe("≈$0.0123");
      await wrapper.get('.node-footer').trigger('mouseenter', { buttons: 0 });
      await vi.advanceTimersByTimeAsync(280);
      const details = document.querySelector('.node-info-details')!;
      expect(details.textContent).toContain("Tokens2,400");
      expect(details.textContent).toContain("Input tokens1,200");
      expect(details.textContent).toContain("Cache read tokens800");
      expect(details.textContent).toContain("Context usage41,000 / 128,000 (32%)");
      expect(document.querySelector('.node-hover-card .agent-markdown')).toBeNull();

      layout.settings!.app.nodeCardFields = ["cost", "tokens"];
      layout.settings!.app.usage = { unbilledProviders: ["OpenAI"] };
      await flushPromises();
      expect(wrapper.findAll('[data-node-info]').map(item => item.attributes('data-node-info'))).toEqual(["cost", "tokens", "model", "thinking"]);
      expect(wrapper.get('[data-node-info="cost"]').text()).toBe("$0.0000");
      expect(wrapper.get('[data-node-info="tokens"]').text()).toBe("2.4K");

      await wrapper.setProps({ data: { ...data, node: { ...data.node, metrics: { usage: data.node.metrics.usage, costs: { openai: null } } } } });
      delete layout.settings!.app.usage;
      await flushPromises();
      expect(wrapper.get('[data-node-info="cost"]').text()).toBe("—");
      layout.settings!.app.nodeCardFields = [];
      await flushPromises();
      expect(wrapper.findAll('[data-node-info]').map(item => item.attributes('data-node-info'))).toEqual(["model", "thinking"]);
      await wrapper.get('.node-footer').trigger('focus');
      expect(document.querySelector('.node-info-details')).not.toBeNull();
      await wrapper.get('.node-footer').trigger('keydown', { key: 'Escape' });
      expect(document.querySelector('.node-hover-card')).toBeNull();
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
    }
  });

  it("fits information in priority order and updates duration while running", async () => {
    vi.useFakeTimers();
    const observers: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observers.push(callback); }
      observe() {}
      disconnect() {}
    });
    const layout = useLayoutStore();
    layout.settings!.app.nodeCardFields = ["duration", "tokens", "model"];
    const data = nodeData({ running: true });
    const wrapper = mount(PromptNode, {
      props: { id: "turn:1", data },
      global: { plugins: [i18n], stubs: { Handle: true, MarkdownRenderer: true } },
      attachTo: document.body,
    });
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(180);
    const itemWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(70);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(wrapper.get('[data-node-info="duration"]').text()).toBe("1s");
      expect(wrapper.findAll('[data-node-info]').filter(item => item.isVisible()).map(item => item.attributes('data-node-info'))).toEqual(["model", "thinking"]);
      width.mockReturnValue(260);
      observers.forEach(resize => resize());
      await flushPromises();
      expect(wrapper.findAll('[data-node-info]').filter(item => item.isVisible()).map(item => item.attributes('data-node-info'))).toEqual(["duration", "model", "thinking"]);
      width.mockReturnValue(80);
      observers.forEach(resize => resize());
      await flushPromises();
      expect(wrapper.findAll('[data-node-info]').filter(item => item.isVisible()).map(item => item.attributes('data-node-info'))).toEqual(["model", "thinking"]);
      await wrapper.setProps({ data: { ...data, running: false, node: { ...data.node, metrics: { durationMs: 2300 } } } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(wrapper.get('[data-node-info="duration"]').text()).toBe("2s");
    } finally {
      width.mockRestore();
      itemWidth.mockRestore();
      wrapper.unmount();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("PromptNode branch action", () => {
  it("shows the recorded Git branch and commit, preserves legacy branches and hides missing history", async () => {
    const data = nodeData();
    const branch = "feature/Case-Sensitive-Long-Branch-Name";
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const wrapper = mount(PromptNode, {
      props: { id: "turn:1", data: { ...data, node: { ...data.node, gitBranch: branch, gitCommit: commit } } },
      global: { plugins: [i18n], stubs: { Handle: true, Teleport: true, MarkdownRenderer: true } },
    });
    expect(wrapper.get('[data-node-info="branch"]').text()).toBe(`${branch} · ${commit.slice(0, 7)}`);
    expect(wrapper.get('[data-node-info="branch"]').attributes("title")).toContain(commit);
    useLayoutStore().settings!.app.nodeCardShowCommit = false;
    await flushPromises();
    expect(wrapper.get('[data-node-info="branch"]').text()).toBe(branch);
    expect(wrapper.find('.node-git-commit').exists()).toBe(false);
    expect(wrapper.get('[data-node-info="branch"]').attributes("title")).toContain(commit);
    useLayoutStore().settings!.app.nodeCardShowCommit = true;
    await flushPromises();
    expect(wrapper.get('[data-node-info="branch"]').text()).toBe(`${branch} · ${commit.slice(0, 7)}`);
    await wrapper.setProps({ data: { ...data, node: { ...data.node, gitBranch: branch } } });
    expect(wrapper.get('[data-node-info="branch"]').text()).toBe(branch);
    expect(wrapper.get('[data-node-info="branch"]').attributes("title")).toContain(branch);
    await wrapper.setProps({ data: { ...data, node: { ...data.node } } });
    expect(wrapper.find('[data-node-info="branch"]').exists()).toBe(false);
    wrapper.unmount();
  });

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
    expect(wrapper.get(".node-context-value").text()).toContain("32%128K");
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

  it("closes keyboard-opened details after focus leaves when the card is not hovered", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PromptNode, {
      props: { id: "turn:1", data: nodeData() },
      global: { plugins: [i18n], stubs: { Handle: true, MarkdownRenderer: true } },
      attachTo: document.body,
    });
    try {
      const footer = wrapper.get('.node-footer').element as HTMLElement;
      footer.focus();
      await flushPromises();
      expect(document.querySelector('.node-info-details')).not.toBeNull();
      footer.blur();
      await vi.advanceTimersByTimeAsync(499);
      expect(document.querySelector('.node-info-details')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(document.querySelector('.node-hover-card')).toBeNull();
    } finally { wrapper.unmount(); }
  });

  it("keeps footer details open after both footer and node leave events, then closes after leaving the card", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PromptNode, {
      props: { id: "turn:1", data: nodeData() },
      global: { plugins: [i18n], stubs: { Handle: true, MarkdownRenderer: true } },
      attachTo: document.body,
    });
    try {
      const node = wrapper.get('.prompt-node');
      const footer = wrapper.get('.node-footer');
      await node.trigger('mouseenter', { buttons: 0 });
      await footer.trigger('mouseenter', { buttons: 0 });
      await vi.advanceTimersByTimeAsync(280);
      const card = document.querySelector('.node-hover-card')!;
      expect(card.querySelector('.node-info-details')).not.toBeNull();

      await footer.trigger('mouseleave', { relatedTarget: card });
      await node.trigger('mouseleave', { relatedTarget: card });
      await vi.advanceTimersByTimeAsync(20);
      card.dispatchEvent(new MouseEvent('mouseenter'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(document.querySelector('.node-hover-card')).toBe(card);

      card.dispatchEvent(new MouseEvent('mouseleave'));
      await vi.advanceTimersByTimeAsync(499);
      expect(document.querySelector('.node-hover-card')).toBe(card);
      await vi.advanceTimersByTimeAsync(1);
      expect(document.querySelector('.node-hover-card')).toBeNull();
    } finally { wrapper.unmount(); }
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
