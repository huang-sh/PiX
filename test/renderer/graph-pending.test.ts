import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import GraphPanel from "../../src/renderer/features/graph/GraphPanel.vue";
import { useSessionStore } from "../../src/renderer/stores/session";
import { i18n } from "../../src/renderer/i18n";
import type { SessionSnapshot } from "../../src/shared/types";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const now = new Date().toISOString();

function snapshot(withTurn: boolean): SessionSnapshot {
  return {
    session: {
      id: "s1",
      path: "C:/tmp/s1.jsonl",
      name: "s1",
      cwd: "C:/tmp",
      created: now,
      modified: now,
      messageCount: withTurn ? 2 : 0,
      firstMessage: "hello",
    },
    entries: withTurn
      ? [
          { type: "user", id: "e1", parentId: null, timestamp: now, text: "hello" },
          { type: "assistant", id: "e2", parentId: "e1", timestamp: now, text: "world" },
        ]
      : [],
    projection: {
      nodes: withTurn
        ? [
            {
              id: "turn-1",
              userEntryId: "e1",
              parentId: null,
              title: "hello",
              preview: "world",
              timestamp: now,
              rawEntryIds: ["e1", "e2"],
              leafEntryId: "e2",
              toolCallCount: 0,
              hasError: false,
              depth: 0,
            },
          ]
        : [],
      edges: [],
      activeBranchNodeIds: withTurn ? ["turn-1"] : [],
      activeBranchEntryIds: withTurn ? ["e1", "e2"] : [],
      messages: [],
      leafId: withTurn ? "e2" : null,
      activeNodeId: withTurn ? "turn-1" : null,
    },
    runtime: {
      available: true,
      model: null,
      thinkingLevel: "off",
      availableThinkingLevels: [],
      isStreaming: false,
      isCompacting: false,
      isRetrying: false,
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      steeringMode: "all",
      followUpMode: "all",
      pendingMessageCount: 0,
    },
  };
}

// The store synthesizes `pending:<ts>` ids for submitted-but-unprocessed prompts.
let pendingEntryId = `pending:${Date.now()}`;

function setPendingPrompt(targetNodeId: string | null) {
  const session = useSessionStore();
  pendingEntryId = `pending:${Date.now()}`;
  session.pendingPrompt = {
    message: {
      entryId: pendingEntryId,
      turnId: pendingEntryId,
      role: "user",
      text: "Next step please",
      timestamp: new Date().toISOString(),
    },
    knownEntryIds: ["e1", "e2"],
    targetNodeId,
    model: { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
    thinkingLevel: "high",
  };
}

function setup(withTurn: boolean): Pinia {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSessionStore().current = snapshot(withTurn);
  return pinia;
}

async function mountPanel(pinia: Pinia) {
  const wrapper = mount(GraphPanel, { global: { plugins: [pinia, i18n] } });
  await flushPromises();
  return wrapper;
}

describe("GraphPanel pending prompt", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  });

  beforeEach(() => {
    i18n.global.locale.value = "en";
  });

  it("replaces the root draft with a running node for a submitted prompt", async () => {
    const pinia = setup(false);
    const wrapper = await mountPanel(pinia);
    expect(wrapper.find(".draft-node").exists()).toBe(true);

    setPendingPrompt(null);
    await flushPromises();

    expect(wrapper.find(".draft-node").exists()).toBe(false);
    const running = wrapper.find(`[data-id="${pendingEntryId}"] .prompt-node`);
    expect(running.exists()).toBe(true);
    expect(running.get("strong").text()).toBe("Next step please");
    expect(running.get(".node-running").text()).toContain("Pi is working…");
    expect(running.get(".node-model-value").text()).toContain("OpenAI / GPT-5.4");
    expect(running.get(".node-thinking-value").text()).toContain("high");
    // The node cannot be branched from while its own run is in flight.
    expect(running.get(".node-add").attributes("aria-disabled")).toBe("true");
    wrapper.unmount();
  });

  it("replaces an open child draft and blocks branching while pending", async () => {
    const pinia = setup(true);
    const wrapper = await mountPanel(pinia);
    expect(wrapper.find(".draft-node").exists()).toBe(false);

    // Opening the branch composer attaches the draft to the existing node.
    await wrapper.get(`[data-id="turn-1"] .node-add`).trigger("click");
    await flushPromises();
    expect(wrapper.find(".draft-node").exists()).toBe(true);
    expect(wrapper.get(`[data-id="turn-1"] .node-add`).attributes("aria-disabled")).toBe("false");

    setPendingPrompt("turn-1");
    await flushPromises();

    expect(wrapper.find(".draft-node").exists()).toBe(false);
    expect(wrapper.find(`[data-id="${pendingEntryId}"] .prompt-node`).exists()).toBe(true);
    expect(wrapper.get(`[data-id="turn-1"] .node-add`).attributes("aria-disabled")).toBe("true");
    wrapper.unmount();
  });

  it("restores the draft when the pending prompt fails to deliver", async () => {
    const pinia = setup(false);
    const session = useSessionStore();
    const wrapper = await mountPanel(pinia);

    setPendingPrompt(null);
    await flushPromises();
    expect(wrapper.find(".draft-node").exists()).toBe(false);

    session.pendingPrompt = undefined;
    await flushPromises();
    expect(wrapper.find(".draft-node").exists()).toBe(true);
    expect(wrapper.find(`[data-id="${pendingEntryId}"]`).exists()).toBe(false);
    wrapper.unmount();
  });
});
